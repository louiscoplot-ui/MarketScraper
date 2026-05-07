"""Background scrape workers — extracted from app.py to keep that
module under the MCP push size limit.

Holds two module-level state collections shared with route handlers:
  scrape_jobs  — dict[suburb_id, {status, progress, started_at, ...}]
  scrape_cancel — set[suburb_id] of cancellation requests

Single Flask process (gunicorn worker) → in-memory state is fine.
"""

import json
import logging
import re as _re
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from database import (
    get_db, upsert_listing, mark_withdrawn, create_scrape_log,
    update_scrape_log, get_existing_urls, trim_sold_listings,
    take_market_snapshot,
)
from scraper import scrape_suburb, verify_disappeared_listings

logger = logging.getLogger(__name__)


def _parse_price(price_text):
    """Best-effort dollar amount from a free-text REIWA price string.
    Handles m/k suffixes — "low $1m" → 1_000_000, "from $775k" → 775_000.
    The previous regex r'\\$([\\d,]+)' silently dropped suffixes so
    "low $1m" was read as $1 and corrupted market_snapshots.median_price."""
    if not price_text:
        return None
    s = price_text.lower().replace(',', '')
    m = _re.search(
        r'\$?\s*(\d+(?:\.\d+)?)\s*(m(?:il(?:lion)?)?|k|thousand)?\b',
        s,
    )
    if not m:
        return None
    try:
        val = float(m.group(1))
    except ValueError:
        return None
    suffix = (m.group(2) or '')
    if suffix.startswith('m'):
        val *= 1_000_000
    elif suffix.startswith('k') or suffix == 'thousand':
        val *= 1_000
    return int(round(val))


scrape_jobs = {}
scrape_cancel = set()


def run_scrape_all(suburbs):
    """Run scrape for suburbs in parallel (up to 8 at a time)."""
    max_workers = min(8, len(suburbs))
    for s in suburbs:
        scrape_cancel.discard(s['id'])

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(run_scrape, s['id'], s['slug'], s['name']): s
            for s in suburbs
        }
        for future in as_completed(futures):
            s = futures[future]
            try:
                future.result()
            except Exception as e:
                logger.error(f"Scrape thread error for {s['name']}: {e}")


def run_scrape(suburb_id, slug, name):
    """Execute the scraping process for a single suburb."""
    log_id = create_scrape_log(suburb_id)
    scrape_jobs[suburb_id] = {
        'status': 'running',
        'progress': f'Starting scrape for {name}...',
        'started_at': datetime.utcnow().isoformat(),
    }

    def progress_cb(msg):
        scrape_jobs[suburb_id]['progress'] = msg
        logger.info(f"[{name}] {msg}")

    try:
        known_urls = get_existing_urls(suburb_id)
        logger.info(f"[{name}] {len(known_urls)} known URLs in DB, will skip their detail pages")

        def cancel_check():
            return suburb_id in scrape_cancel

        result = scrape_suburb(slug, suburb_id, progress_callback=progress_cb,
                               known_urls=known_urls, cancel_check=cancel_check)

        if suburb_id in scrape_cancel:
            scrape_cancel.discard(suburb_id)
            scrape_jobs[suburb_id] = {
                'status': 'cancelled',
                'progress': 'Scrape cancelled by user',
                'completed_at': datetime.utcnow().isoformat(),
            }
            update_scrape_log(log_id, completed_at=datetime.utcnow().isoformat(),
                              errors='Cancelled by user')
            logger.info(f"Scrape cancelled for {name}")
            return

        new_count = 0
        updated_count = 0
        forsale_urls = []
        sold_urls = []

        progress_cb('Saving for-sale listings to database...')
        for listing in result['forsale_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            forsale_urls.append(url)
            action = upsert_listing(suburb_id, url, listing)
            if action == 'new':
                new_count += 1
            else:
                updated_count += 1

        progress_cb('Saving sold listings to database...')
        saved_sold = 0
        for listing in result['sold_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            sold_urls.append(url)
            upsert_listing(suburb_id, url, listing)
            saved_sold += 1

        # Pre-withdrawn verification — rescue listings that disappeared from
        # the for-sale grid AND fell past page 10 of sold (so they weren't in
        # sold_urls either). Visit each candidate's detail page; REIWA usually
        # still serves the page with a clear SOLD or UNDER OFFER badge.
        progress_cb('Verifying disappeared listings...')
        conn = get_db()
        db_active_rows = conn.execute(
            "SELECT reiwa_url FROM listings WHERE suburb_id = ? "
            "AND status IN ('active', 'under_offer') AND reiwa_url IS NOT NULL",
            (suburb_id,)
        ).fetchall()
        conn.close()
        db_active_urls = {r['reiwa_url'].rstrip('/') for r in db_active_rows}
        seen_set = {u.rstrip('/') for u in (forsale_urls + sold_urls)}
        candidates = list(db_active_urls - seen_set)

        rescued_sold = 0
        rescued_active = 0
        if candidates:
            logger.info(f"[{name}] Verifying {len(candidates)} disappeared URL(s) via detail pages")
            verify = verify_disappeared_listings(candidates)
            for url, info in verify.items():
                status = info.get('status')
                if status == 'sold':
                    # Pass sold_price/sold_date through if REIWA's
                    # "Last Sold on …" block was parseable. NULL stays
                    # NULL when missing — never invent a price.
                    payload = {'status': 'sold'}
                    if info.get('sold_price'):
                        payload['sold_price'] = info['sold_price']
                    if info.get('sold_date'):
                        payload['sold_date'] = info['sold_date']
                    upsert_listing(suburb_id, url, payload)
                    sold_urls.append(url)
                    rescued_sold += 1
                elif status in ('active', 'under_offer'):
                    upsert_listing(suburb_id, url, {'status': status})
                    forsale_urls.append(url)
                    rescued_active += 1
            if rescued_sold:
                logger.info(f"[{name}] Rescued {rescued_sold} from withdrawn → marked SOLD")
            if rescued_active:
                logger.info(f"[{name}] Rescued {rescued_active} from withdrawn → still active")

        progress_cb('Checking for withdrawn listings...')
        reiwa_total = result['stats'].get('reiwa_total', 0)
        our_count = len(forsale_urls)
        if reiwa_total > 0:
            confident = our_count >= reiwa_total or (
                our_count >= reiwa_total * 0.95 and reiwa_total - our_count <= 3
            )
        else:
            confident = False
        if candidates:
            confident = True
        if confident:
            logger.info(f"[{name}] Confident scrape (verified): {our_count} found vs {reiwa_total} REIWA total — checking withdrawals")
        else:
            logger.info(f"[{name}] Incomplete scrape: {our_count} found vs {reiwa_total} REIWA total — skipping withdrawals")
        withdrawn_count = mark_withdrawn(suburb_id, forsale_urls, sold_urls, confident=confident)

        trimmed = trim_sold_listings(suburb_id, keep=40)
        if trimmed:
            logger.info(f"[{name}] Trimmed {trimmed} old sold listings (keeping 40 most recent)")

        actual_forsale = len(forsale_urls)
        update_scrape_log(
            log_id,
            completed_at=datetime.utcnow().isoformat(),
            forsale_count=actual_forsale,
            sold_count=saved_sold,
            new_count=new_count,
            updated_count=updated_count,
            withdrawn_count=withdrawn_count,
            errors=json.dumps(result['errors']) if result['errors'] else None
        )

        try:
            snap_conn = get_db()
            snap_rows = snap_conn.execute(
                "SELECT status, price_text, listing_date, first_seen "
                "FROM listings WHERE suburb_id = ?",
                (suburb_id,)
            ).fetchall()
            snap_conn.close()

            snap_active = [r for r in snap_rows if r['status'] == 'active']
            snap_uo = [r for r in snap_rows if r['status'] == 'under_offer']
            snap_sold = [r for r in snap_rows if r['status'] == 'sold']
            snap_wd = [r for r in snap_rows if r['status'] == 'withdrawn']

            snap_prices = []
            for r in snap_active:
                pt = r['price_text']
                p = _parse_price(pt)
                if p and p >= 100000:
                    snap_prices.append(p)
            snap_prices.sort()
            median_p = snap_prices[len(snap_prices)//2] if snap_prices else None

            snap_doms = []
            for r in snap_active:
                ds = r['listing_date'] or ''
                dm = _re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', ds)
                try:
                    if dm:
                        start = datetime(int(dm.group(3)), int(dm.group(2)), int(dm.group(1)))
                    else:
                        start = datetime.fromisoformat(ds.replace('Z', ''))
                    snap_doms.append(max(0, (datetime.utcnow() - start).days))
                except (ValueError, TypeError):
                    pass
            avg_d = round(sum(snap_doms) / len(snap_doms)) if snap_doms else None

            take_market_snapshot(suburb_id, {
                'active': len(snap_active),
                'under_offer': len(snap_uo),
                'sold': len(snap_sold),
                'withdrawn': len(snap_wd),
                'new': new_count,
                'median_price': median_p,
                'avg_dom': avg_d,
            })
            logger.info(f"[{name}] Market snapshot saved")
        except Exception as snap_err:
            logger.warning(f"[{name}] Failed to save snapshot: {snap_err}")

        scrape_jobs[suburb_id] = {
            'status': 'completed',
            'progress': f'Done! {actual_forsale} active, {saved_sold} sold, {new_count} new, {withdrawn_count} withdrawn',
            'completed_at': datetime.utcnow().isoformat(),
            'stats': result['stats'],
        }
        logger.info(f"Scrape completed for {name}: {result['stats']}")

        # Auto-generate pipeline targets from the freshly-scraped sold
        # listings. 30-day window catches enough recent sales to be
        # useful without re-mailing addresses from months ago. ACL is
        # bypassed because this runs as a background daemon thread, not
        # a user request — the scraper has implicit permission to write
        # for any suburb it just scraped. Errors are caught + logged
        # only — a pipeline-gen failure must NEVER fail the scrape.
        try:
            from pipeline_api import _generate_pipeline_for_suburb
            pg = _generate_pipeline_for_suburb(name, days=30, enforce_acl=False)
            logger.info(
                f"Pipeline auto-generated for {name}: "
                f"{pg.get('generated', 0)} new entries from "
                f"{pg.get('sold_count', 0)} sales"
            )
        except Exception as e:
            logger.warning(f"Pipeline auto-gen failed for {name}: {e}")

    except Exception as e:
        logger.error(f"Scrape failed for {name}: {e}")
        update_scrape_log(log_id, completed_at=datetime.utcnow().isoformat(),
                          errors=str(e))
        scrape_jobs[suburb_id] = {
            'status': 'error',
            'progress': f'Error: {str(e)}',
            'error': str(e),
        }

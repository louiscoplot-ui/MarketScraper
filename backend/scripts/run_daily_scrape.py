"""Headless daily scrape — entry point used by GitHub Actions.

Reads every active suburb from the DB, scrapes each one sequentially with
randomised polite delays, runs the same withdrawn-verification pass as
the Flask UI, and writes everything back through the dual-driver
database layer (Postgres in production, SQLite for local dev).

No Flask, no HTTP — just data + scraper. Safe to run from cron.

Usage (locally, against Postgres):
    cd backend
    $env:DATABASE_URL = "postgresql://..."
    python scripts/run_daily_scrape.py

Usage (in GitHub Actions):
    python backend/scripts/run_daily_scrape.py
    (DATABASE_URL is provided by repo secret)
"""

import os
import sys
import time
import random
import logging
from pathlib import Path
from datetime import datetime


HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
sys.path.insert(0, str(BACKEND_DIR))


# Monkey-patch Playwright Page.goto BEFORE importing scraper, so every
# page.goto() call inside scraper.py uses domcontentloaded instead of
# networkidle. The networkidle wait fails repeatedly on GHA→AU links
# because REIWA loads analytics/ad pixels that keep the network active
# for >40s, killing every list-page load with a Timeout. The downstream
# wait_for_selector('p-card', timeout=8000) inside _load_listing_page
# already gives us a real "page is ready" signal, so we don't need
# networkidle at all. Local dev (UI scrape) is unaffected — this only
# applies when run_daily_scrape.py is the entry point.
from playwright.sync_api import Page as _PWPage  # noqa: E402

_orig_goto = _PWPage.goto

def _patched_goto(self, url, **kwargs):
    if kwargs.get('wait_until') == 'networkidle':
        kwargs['wait_until'] = 'domcontentloaded'
        if kwargs.get('timeout', 0) > 20000:
            kwargs['timeout'] = 20000
    return _orig_goto(self, url, **kwargs)

_PWPage.goto = _patched_goto


import database  # noqa: E402
from database import (  # noqa: E402
    get_db,
    upsert_listing,
    mark_withdrawn,
    create_scrape_log,
    update_scrape_log,
    get_existing_urls,
    trim_sold_listings,
)
from scraper import scrape_suburb, verify_disappeared_listings  # noqa: E402


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('daily_scrape')

# Politeness — random sleep between suburbs to look human and dodge
# rate-limit fingerprinting. Adjust if REIWA tightens anti-scrape.
INTER_SUBURB_DELAY = (5, 15)  # seconds

# How many sold listings to retain per suburb in the DB. Scraper already
# walks up to 10 sold pages (~200 listings) per run, but the DB was being
# trimmed to 40 — wasted history. 200 keeps the full window the scraper
# actually pulls, with no extra scrape time.
SOLD_KEEP = 200


def scrape_one(suburb):
    """Scrape one suburb end-to-end. Mirrors app.py's `_run_scrape`."""
    name = suburb['name']
    suburb_id = suburb['id']
    slug = suburb['slug']
    log.info(f"=== {name} (suburb_id={suburb_id}) ===")
    log_id = create_scrape_log(suburb_id)

    try:
        known = get_existing_urls(suburb_id)
        result = scrape_suburb(slug, suburb_id, known_urls=known)
    except Exception as e:
        log.exception(f"[{name}] scrape_suburb crashed: {e}")
        update_scrape_log(
            log_id,
            completed_at=datetime.utcnow().isoformat(),
            forsale_count=0, sold_count=0, withdrawn_count=0,
            new_count=0, errors=str(e),
        )
        return {'name': name, 'error': str(e)}

    forsale_urls = []
    sold_urls = []
    new_count = 0

    for listing in result.get('forsale_listings', []):
        url = (listing.get('reiwa_url') or '').strip()
        if not url:
            continue
        forsale_urls.append(url)
        if upsert_listing(suburb_id, url, listing) == 'new':
            new_count += 1

    saved_sold = 0
    for listing in result.get('sold_listings', []):
        url = (listing.get('reiwa_url') or '').strip()
        if not url:
            continue
        sold_urls.append(url)
        upsert_listing(suburb_id, url, listing)
        saved_sold += 1

    # Pre-withdrawn verification — see app.py for rationale.
    conn = get_db()
    db_active_rows = conn.execute(
        "SELECT reiwa_url FROM listings WHERE suburb_id = ? "
        "AND status IN ('active', 'under_offer') AND reiwa_url IS NOT NULL",
        (suburb_id,)
    ).fetchall()
    conn.close()
    db_active = {r['reiwa_url'].rstrip('/') for r in db_active_rows}
    seen = {u.rstrip('/') for u in (forsale_urls + sold_urls)}
    candidates = list(db_active - seen)

    rescued_sold = rescued_active = 0
    if candidates:
        log.info(f"[{name}] verifying {len(candidates)} disappeared URLs")
        verify = verify_disappeared_listings(candidates)
        for url, info in verify.items():
            status = info.get('status')
            if status == 'sold':
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

    reiwa_total = result.get('stats', {}).get('reiwa_total', 0)
    our_count = len(forsale_urls)
    if reiwa_total > 0:
        confident = (our_count >= reiwa_total
                     or (our_count >= reiwa_total * 0.95 and reiwa_total - our_count <= 3))
    else:
        confident = False
    if candidates:
        # Every candidate was individually verified — coverage % no longer matters.
        confident = True

    withdrawn_count = mark_withdrawn(suburb_id, forsale_urls, sold_urls, confident=confident)
    trim_sold_listings(suburb_id, keep=SOLD_KEEP)

    update_scrape_log(
        log_id,
        completed_at=datetime.utcnow().isoformat(),
        forsale_count=len(forsale_urls),
        sold_count=saved_sold,
        withdrawn_count=withdrawn_count,
        new_count=new_count,
        errors=None,
    )

    log.info(
        f"[{name}] done — active={len(forsale_urls)} sold={saved_sold} "
        f"withdrawn={withdrawn_count} new={new_count} "
        f"(rescued_sold={rescued_sold}, rescued_active={rescued_active})"
    )
    return {
        'name': name,
        'active': len(forsale_urls),
        'sold': saved_sold,
        'withdrawn': withdrawn_count,
        'new': new_count,
    }


def main():
    log.info(f"DATABASE_URL set: {bool(os.environ.get('DATABASE_URL'))}")
    log.info(f"Driver: {'postgres' if database.USE_POSTGRES else 'sqlite (local)'}")

    database.init_db()

    conn = get_db()
    suburbs = conn.execute(
        "SELECT id, name, slug FROM suburbs WHERE active = 1 ORDER BY name"
    ).fetchall()
    conn.close()

    if not suburbs:
        log.warning("No active suburbs in DB — nothing to scrape. "
                    "Add some via the UI or seed the suburbs table.")
        return

    log.info(f"Starting daily scrape across {len(suburbs)} suburb(s)")
    started = time.time()
    summary = []

    for i, suburb in enumerate(suburbs, 1):
        log.info(f"--- {i}/{len(suburbs)}: {suburb['name']} ---")
        try:
            summary.append(scrape_one(suburb))
        except Exception as e:
            log.exception(f"[{suburb['name']}] unexpected: {e}")
            summary.append({'name': suburb['name'], 'error': str(e)})

        if i < len(suburbs):
            delay = random.uniform(*INTER_SUBURB_DELAY)
            log.info(f"sleeping {delay:.1f}s (polite delay)")
            time.sleep(delay)

    elapsed = (time.time() - started) / 60.0
    log.info(f"=== Daily scrape finished in {elapsed:.1f} min ===")
    log.info("Summary:")
    for s in summary:
        if 'error' in s:
            log.info(f"  {s['name']}: ERROR — {s['error']}")
        else:
            log.info(
                f"  {s['name']}: active={s['active']} sold={s['sold']} "
                f"withdrawn={s['withdrawn']} new={s['new']}"
            )


if __name__ == '__main__':
    main()

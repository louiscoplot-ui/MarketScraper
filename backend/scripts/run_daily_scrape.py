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
from concurrent.futures import ThreadPoolExecutor, as_completed


HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
sys.path.insert(0, str(BACKEND_DIR))


# The Page.goto monkey-patch that used to live here is gone — the same
# behaviour (wait_until='domcontentloaded', timeout=20000) is now baked
# directly into scraper_browser.load_listing_page so the cron and the
# Flask manual scrape go through identical code. Previously the patch
# only applied to the cron path, leaving the manual scrape stuck on
# networkidle waits that timed out on REIWA's analytics pixels.


import database  # noqa: E402
from database import (  # noqa: E402
    get_db,
    upsert_listing,
    mark_withdrawn,
    create_scrape_log,
    update_scrape_log,
    get_existing_urls,
    get_sold_urls,
    trim_sold_listings,
)
from scraper import scrape_suburb, verify_disappeared_listings  # noqa: E402
from scraper_detail import fetch_detail  # noqa: E402
from scraper_utils import UA, CHROMIUM_PATH, get_scrape_proxy, route_filter, proxy_forced  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
import healing_loop  # noqa: E402


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('daily_scrape')

# Politeness — random sleep between suburbs to look human and dodge
# rate-limit fingerprinting. Adjust if REIWA tightens anti-scrape.
INTER_SUBURB_DELAY = (5, 15)  # seconds

# How many suburbs to scrape concurrently. The old cron was strictly
# sequential (datacenter IP — parallel hits got challenged fast). With
# the residential proxy in place, a modest fan-out is safe and cuts the
# total run time ~3x. Kept low (3) to avoid hammering REIWA. Detail-page
# fetches WITHIN each suburb stay sequential — REIWA aborts burst detail
# requests (see fetch_details_batch).
SCRAPE_CONCURRENCY = 3

# How many sold listings to retain per suburb in the DB. Scraper already
# walks up to 10 sold pages (~200 listings) per run, but the DB was being
# trimmed to 40 — wasted history. 200 keeps the full window the scraper
# actually pulls, with no extra scrape time.
SOLD_KEEP = 200

# Day of week (Mon=0 .. Sun=6, UTC) on which the sold_date backfill runs its
# proxy-heavy detail-page fetches. Historical-data cleanup → weekly is plenty,
# and it cuts residential-proxy bandwidth ~85% vs running every night.
BACKFILL_WEEKDAY = 0


def _backfill_sold_dates(suburb_id, suburb_name):
    """Fix the legacy <time>-tag bug fallout: re-fetch up to 30 sold
    listings whose sold_date is missing or matches a suspicious bulk
    date (>10 listings sharing the same date in this suburb — symptom
    of every sold being stamped with the scrape day). Errors logged,
    never raised — backfill must never break the parent scrape."""
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT id, reiwa_url, address, sold_date FROM listings "
            "WHERE suburb_id = ? AND status = 'sold' "
            "AND reiwa_url IS NOT NULL AND reiwa_url != '' "
            "AND (sold_date IS NULL OR sold_date = '' "
            "     OR sold_date IN (SELECT sold_date FROM listings "
            "                      WHERE suburb_id = ? AND status = 'sold' "
            "                      AND sold_date IS NOT NULL "
            "                      GROUP BY sold_date HAVING COUNT(*) > 10)) "
            "ORDER BY id DESC LIMIT 30",
            (suburb_id, suburb_id)
        ).fetchall()
        conn.close()
    except Exception as e:
        log.warning(f"[{suburb_name}] backfill query failed: {e}")
        return

    if not rows:
        return

    log.info(f"[{suburb_name}] backfilling sold_date for {len(rows)} listing(s)")
    today_iso = datetime.utcnow().strftime("%Y-%m-%d")

    try:
        launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
        if CHROMIUM_PATH:
            launch_opts['executable_path'] = CHROMIUM_PATH
        # Proxy only when the night has already escalated to it — this
        # backfill is best-effort (a failed fetch just skips the row and
        # retries another night), so it never forces the proxy itself.
        _proxy = get_scrape_proxy()
        if _proxy and proxy_forced():
            launch_opts['proxy'] = _proxy
        with sync_playwright() as p:
            browser = p.chromium.launch(**launch_opts)
            context = browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800},
                                          locale='en-AU')
            page = context.new_page()
            page.route("**/*", route_filter)

            for i, row in enumerate(rows):
                if i > 0:
                    time.sleep(random.uniform(5, 8))
                try:
                    detail = fetch_detail(page, row['reiwa_url']) or {}
                    new_sd = detail.get('sold_date') or ''
                    old_sd = row['sold_date'] or ''
                    if not new_sd or new_sd == today_iso or new_sd == old_sd:
                        continue
                    upd = get_db()
                    upd.execute(
                        "UPDATE listings SET sold_date = ? WHERE id = ?",
                        (new_sd, row['id'])
                    )
                    upd.commit()
                    upd.close()
                    log.info(f"[{suburb_name}] backfill "
                             f"{row['address'] or row['reiwa_url']}: "
                             f"{old_sd or 'NULL'} -> {new_sd}")
                except Exception as fe:
                    log.warning(f"[{suburb_name}] backfill fetch failed "
                                f"for {row['reiwa_url']}: {fe}")
                    continue
            browser.close()
    except Exception as e:
        log.warning(f"[{suburb_name}] backfill aborted: {e}")


def scrape_one(suburb):
    """Scrape one suburb end-to-end. Mirrors app.py's `_run_scrape`."""
    name = suburb['name']
    suburb_id = suburb['id']
    slug = suburb['slug']
    log.info(f"=== {name} (suburb_id={suburb_id}) ===")
    log_id = create_scrape_log(suburb_id)

    try:
        known = get_existing_urls(suburb_id)
        known_sold = get_sold_urls(suburb_id)
        result = scrape_suburb(slug, suburb_id, known_urls=known,
                               known_sold_urls=known_sold)
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
    from scraper_utils import normalize_reiwa_url

    for listing in result.get('forsale_listings', []):
        url = normalize_reiwa_url(listing.get('reiwa_url'))
        if not url:
            continue
        forsale_urls.append(url)
        if upsert_listing(suburb_id, url, listing) == 'new':
            new_count += 1

    saved_sold = 0
    for listing in result.get('sold_listings', []):
        url = normalize_reiwa_url(listing.get('reiwa_url'))
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
    # NOTE: confidence comes ONLY from full grid coverage (our_count vs
    # REIWA's stated total), never from "candidates were verified". A
    # disappeared listing now resolves to 'gone' (verify_disappeared_listings)
    # and is withdrawn by the sweep — but only when we actually saw REIWA's
    # whole grid, so a partial-miss scrape can never wrongly withdraw a
    # still-listed property. (Forcing confident=True here is what let the
    # rescue mask every withdrawal → counts never came back down.)

    # Safety guards against wrongful mass-withdraw:
    #   1. ZERO actives + 5+ candidates → parser fault (DOM rename,
    #      Playwright blanket timeout).
    #   2. COVERAGE < 50% with non-trivial volume → scrape returned
    #      suspiciously few cards vs DB. Catches lazy-load truncation
    #      (saw exactly this on Cottesloe: 4 scraped vs 45 in DB →
    #      `if candidates: confident=True` wiped 41 real listings).
    total_known = our_count + len(candidates)
    coverage_low = (total_known >= 5 and our_count < total_known * 0.5)
    abort_withdraw = (
        (our_count == 0 and len(candidates) >= 5)
        or coverage_low
    )
    if abort_withdraw:
        log.error(
            "[%s] ABORT withdraw sweep — %d active scraped vs %d "
            "candidates (%d%% coverage). Likely incomplete scrape, "
            "status flips deferred.",
            name, our_count, len(candidates),
            our_count * 100 // max(total_known, 1)
        )
        withdrawn_count = 0
    else:
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

    # Market Trends datapoint — only the manual UI scrape recorded one,
    # so the Report's tiles froze at the last manual scrape while the
    # nightly kept updating listings. Same helper, one row per suburb
    # per day, idempotent; never fails the scrape.
    try:
        from scrape_runner import record_market_snapshot
        record_market_snapshot(suburb_id, name, new_count)
    except Exception as e:
        log.warning(f"[{name}] market snapshot failed: {e}")

    # LOOP-1: detect listing transitions for the signal loops. Compares the
    # freshly-scraped state against the previous run's snapshot and records
    # withdrawn / sale_fallen / sold_price_revealed / price_drop / relisted
    # into listing_transitions. Errors are swallowed inside run_diff — a diff
    # failure must never fail the suburb's scrape.
    try:
        from signals.diff_engine import run_diff
        trans = run_diff(name)
        if trans:
            log.info(f"[{name}] {len(trans)} listing transition(s) detected")
    except Exception as e:
        log.warning(f"[{name}] diff engine failed: {e}")

    # Post-pass: backfill sold_date for listings stuck on the old bulk-date
    # bug or with NULL date. ~10s per listing × up to 30 = ~5 min/suburb.
    #
    # PROXY COST: each backfill listing = one full REIWA detail page through
    # the residential proxy (~540 page loads/night across all suburbs). The
    # data it fixes is HISTORICAL (old sold_date), never time-sensitive — new
    # sales already get their date from the normal scrape. So we run it only
    # ONCE A WEEK (Monday UTC) instead of nightly: ~85% less proxy bandwidth,
    # zero data loss (the backlog still clears, just over a few Mondays).
    if datetime.utcnow().weekday() == BACKFILL_WEEKDAY:
        _backfill_sold_dates(suburb_id, name)
    else:
        log.info(f"[{name}] sold_date backfill skipped (weekly — runs Mondays UTC)")

    # Auto-generate pipeline targets from the freshly-scraped sales —
    # same call the Flask-side scrape worker makes (scrape_runner.py:282).
    # Without this step the GHA daily cron updates `listings` but never
    # refreshes `pipeline_tracking`, so the Pipeline page stays frozen
    # on yesterday's targets until the operator clicks Generate manually.
    # ACL bypassed because cron has no request context. Errors logged
    # only — pipeline-gen failure must NEVER fail the suburb's scrape.
    try:
        from pipeline_api import _generate_pipeline_for_suburb
        pg = _generate_pipeline_for_suburb(name, days=30, enforce_acl=False)
        log.info(
            f"Pipeline generated for {name}: "
            f"{pg.get('generated', 0)} targets from {pg.get('sold_count', 0)} sales"
        )
    except Exception as e:
        log.warning(f"[{name}] pipeline auto-gen failed: {e}")

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

    max_workers = min(SCRAPE_CONCURRENCY, len(suburbs))
    log.info(f"Starting daily scrape across {len(suburbs)} suburb(s), "
             f"{max_workers} in parallel")
    started = time.time()
    summary = []

    # Fan out across suburbs. Each scrape_one owns its own Playwright
    # browser + DB connections, so the threads don't share state; Postgres
    # handles the concurrent writes. Mirrors the Flask manual-scrape path
    # (scrape_runner.run_scrape_all), proven to work with sync Playwright
    # in a thread pool.
    # Each suburb scrape runs through the self-healing wrapper instead of
    # calling scrape_one directly: it detects/classifies failures, retries
    # transient ones with backoff, and emails an alert on structural breaks
    # (layout change, CAPTCHA) or exhausted retries. scrape_one's own logic
    # is untouched — healing_loop only wraps the call.
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(healing_loop.run_with_recovery, s, scrape_one): s
            for s in suburbs
        }
        for fut in as_completed(futures):
            s = futures[fut]
            try:
                summary.append(fut.result())
            except Exception as e:
                log.exception(f"[{s['name']}] unexpected: {e}")
                summary.append({'name': s['name'], 'error': str(e)})

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

    # Hard failure: Playwright couldn't launch a browser at all (e.g. the
    # CI runner is missing the Chromium binary). The healing loop already
    # alerted; fail the cron with a non-zero exit so GitHub Actions marks
    # the run red instead of green-with-no-data.
    if any(s.get('fatal') for s in summary):
        log.error("Browser launch failed — exiting with code 1")
        sys.exit(1)

    # LOOP-2: withdrawn-orphan detection. Runs after the scrape (fresh
    # withdrawn_date values) and BEFORE the digest so new orphan leads
    # surface in this morning's email. Generates Pipeline targets only —
    # no outbound email here. Never fails the cron.
    try:
        from signals.withdrawn_orphan import process_withdrawn_orphans
        wo = process_withdrawn_orphans()
        log.info(
            "Withdrawn orphans: %d new lead(s) across %s",
            wo.get('detected', 0), ', '.join(wo.get('suburbs_covered') or []) or '—'
        )
    except Exception as e:
        log.warning(f"withdrawn-orphan pass failed: {e}")

    # LOOP-3: sale-fallen alerts (under_offer → active). Sends are gated
    # behind SIGNALS_LIVE — dry-run by default (logs intent, sends nothing,
    # leaves the signal unprocessed so it fires once enabled). Also ages out
    # alerts older than 14 days. Never fails the cron.
    try:
        from signals.sale_fallen import (
            process_sale_fallen_alerts, expire_old_sale_fallen)
        sf = process_sale_fallen_alerts()
        sf_expired = expire_old_sale_fallen()
        log.info(
            "Sale-fallen: sent=%d would_send=%d no_recipient=%d expired=%d (dry_run=%s)",
            sf.get('sent', 0), sf.get('would_send', 0), sf.get('no_recipient', 0),
            sf_expired, sf.get('dry_run')
        )
    except Exception as e:
        log.warning(f"sale-fallen pass failed: {e}")

    # LOOP-4: sold-price reveals. Detection is handled by the diff engine;
    # this only logs how many are fresh (neighbour letters are generated on
    # demand via the signals route, not in cron). Never fails the cron.
    try:
        from signals.sold_reveal import process_sold_reveals
        sr = process_sold_reveals()
        log.info("Sold reveals: %d fresh in last 24h", sr.get('fresh', 0))
    except Exception as e:
        log.warning(f"sold-reveal pass failed: {e}")

    # LOOP-6: strata contagion. Records each strata unit sale into
    # strata_complexes (neighbour-unit letters generated on demand). Never
    # fails the cron.
    try:
        from signals.strata_contagion import process_strata_sales
        st = process_strata_sales()
        log.info("Strata contagion: %d complex sale(s) recorded", st.get('complexes', 0))
    except Exception as e:
        log.warning(f"strata-contagion pass failed: {e}")

    # LOOP-5: appraisal follow-ups (J+30/60/90). Sends are gated behind
    # SIGNALS_LIVE — dry-run by default (logs intent, leaves pending). Never
    # fails the cron.
    try:
        from signals.appraisal_followup import send_due_followups
        af = send_due_followups()
        log.info(
            "Appraisal follow-ups: sent=%d would_send=%d no_email=%d (dry_run=%s)",
            af.get('sent', 0), af.get('would_send', 0), af.get('no_email', 0),
            af.get('dry_run')
        )
    except Exception as e:
        log.warning(f"appraisal-followup pass failed: {e}")

    # SENTINEL S2: vendor signal engine — scores candidate vendor addresses
    # from the listing_events ledger (+ RP-Data long-hold owners) and writes
    # explainable vendor_signals. Runs after every event-producing pass so
    # tonight's events feed tonight's signals. Never fails the cron.
    try:
        from signals.signal_engine import rebuild_signals
        sg = rebuild_signals()
        log.info(
            "Vendor signals: created=%d refreshed=%d cooldown=%d across %d suburb(s)",
            sg.get('created', 0), sg.get('refreshed', 0),
            sg.get('skipped_cooldown', 0), sg.get('suburbs', 0),
        )
    except Exception as e:
        log.warning(f"signal-engine pass failed: {e}")

    # SENTINEL S3: prediction ledger — write predictions for strong signals,
    # then let the scrape self-label past predictions (listed / not_listed).
    # Runs right after the signal engine so tonight's strong signals become
    # tonight's predictions. Never fails the cron.
    try:
        from signals.prediction_ledger import (
            write_predictions_from_signals, verify_predictions)
        pw = write_predictions_from_signals()
        pv = verify_predictions()
        log.info(
            "Predictions: +%d new (%d pending kept) | verified: %d listed, %d expired",
            pw.get('created', 0), pw.get('already_pending', 0),
            pv.get('listed', 0), pv.get('not_listed', 0),
        )
    except Exception as e:
        log.warning(f"prediction-ledger pass failed: {e}")

    # SENTINEL S4: morning brief — top 5 signals per opted-in user
    # (users.digest_enabled, same consent as the digest), narrated and
    # emailed; the Today view reads the same stored items. Never fails
    # the cron; brief rows are written even when email isn't configured.
    try:
        from signals.brief_builder import send_morning_briefs
        br = send_morning_briefs()
        log.info(
            "Morning briefs: built=%d sent=%d already=%d empty=%d",
            br.get('built', 0), br.get('sent', 0),
            br.get('skipped', 0), br.get('no_items', 0),
        )
    except Exception as e:
        log.warning(f"brief pass failed: {e}")

    # Morning digest pass — one email per opt-in user with their
    # assigned suburbs' overnight stats. Skipped entirely when
    # EMAIL_FROM isn't set so the cron is silent on first-deploy
    # environments. send_morning_digest() respects users.digest_enabled
    # and writes one row per attempt to digest_logs for audit.
    if not (os.environ.get('EMAIL_FROM') or '').strip():
        log.warning("EMAIL_FROM not set — skipping morning digest pass")
    else:
        try:
            from email_digest import send_morning_digest
            result = send_morning_digest()
            log.info(
                "Morning digest: sent=%d skipped=%d failed=%d",
                result.get('sent', 0), result.get('skipped', 0),
                result.get('failed', 0),
            )
        except Exception as e:
            log.exception(f"Digest pass aborted: {e}")


if __name__ == '__main__':
    main()

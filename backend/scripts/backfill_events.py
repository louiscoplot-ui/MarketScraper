"""SENTINEL S1 — one-shot historical backfill of listing_events.

Replays the append-only history that actually survived (price_history,
listings.sold_date, listings.withdrawn_date) into the listing_events
ledger, chronologically, VALID SCRAPE WINDOWS ONLY. No relisted events are
reconstructed — that history was destroyed by the scraper (see
docs/sentinel-decisions.md D4) and inventing it would poison the ledger.

Data-hole windows (UTC, from docs/sentinel-handoff.md — absence of scrape,
not absence of listings; NOTHING is generated inside them):
  1) 2026-06-17 19:01  ->  2026-06-19 05:48   (Cloudflare break / firefight)
  2) 2026-06-24 00:00  ->  2026-07-01 00:00   (Neon quota crash, runs 45-51)
  3) 2026-07-01 18:49  ->  2026-07-03 17:38   (IPRoyal balance, run 53)

Idempotent: an event is only inserted if no row with the same
(listing_id, event_type, detected_at) exists — safe to re-run. The whole
run is additionally marked in schema_migrations ('sentinel_backfill_events_v1')
so the nightly boot never re-triggers it implicitly; re-running the script
manually is allowed (the per-row check makes it a no-op).

Usage:
    DATABASE_URL=postgres://... python scripts/backfill_events.py [--dry-run]
"""
import os
import sys
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('backfill_events')

# (start, end) ISO UTC — events whose timestamp falls inside are skipped.
DATA_HOLES = (
    ('2026-06-17T19:01:00', '2026-06-19T05:48:00'),
    ('2026-06-24T00:00:00', '2026-07-01T00:00:00'),
    ('2026-07-01T18:49:00', '2026-07-03T17:38:00'),
)


def _in_hole(ts):
    """True when ISO timestamp `ts` falls inside a data hole. Naive string
    comparison is safe: everything is ISO-8601 UTC, zero-padded."""
    if not ts:
        return False
    t = str(ts)[:19]
    return any(start <= t < end for start, end in DATA_HOLES)


def _exists(conn, listing_id, event_type, detected_at):
    return conn.execute(
        "SELECT 1 FROM listing_events WHERE listing_id = ? "
        "AND event_type = ? AND detected_at = ?",
        (listing_id, event_type, detected_at)
    ).fetchone() is not None


def _insert(conn, listing_id, suburb_id, address, etype, old, new, detected_at):
    conn.execute(
        "INSERT INTO listing_events (listing_id, suburb_id, address, "
        "event_type, old_value, new_value, detected_at, source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill')",
        (listing_id, suburb_id, address,
         etype, None if old is None else str(old),
         None if new is None else str(new), detected_at)
    )


def main(dry_run=False):
    if not os.environ.get('DATABASE_URL', '').strip():
        log.warning("DATABASE_URL not set — running against the LOCAL SQLite "
                    "file. Fine for a smoke test, NOT a prod backfill.")

    import database
    database.init_db()
    from database import get_db

    conn = get_db()
    try:
        listings = {r['id']: dict(r) for r in conn.execute(
            "SELECT id, suburb_id, address, status, sold_date, sold_price, "
            "price_text, withdrawn_date, first_seen FROM listings"
        ).fetchall()}
        suburb_names = {d['id']: d['name'] for d in
                        (dict(r) for r in conn.execute(
                            "SELECT id, name FROM suburbs").fetchall())}

        per_suburb = {}

        def bump(sid, etype, skipped=False):
            s = per_suburb.setdefault(sid, {'inserted': 0, 'skipped_hole': 0,
                                            'skipped_dupe': 0})
            if skipped:
                s[etype] += 1
            else:
                s['inserted'] += 1

        inserted = holes = dupes = 0

        # ---- 1. price events from price_history (append-only) -----------
        rows = conn.execute(
            "SELECT listing_id, old_price, new_price, changed_at "
            "FROM price_history ORDER BY changed_at"
        ).fetchall()
        from signals.diff_engine import _price_to_int
        for r in rows:
            d = dict(r)
            lst = listings.get(d['listing_id'])
            if lst is None:
                continue
            ts = str(d['changed_at'])[:19]
            if _in_hole(ts):
                holes += 1; bump(lst['suburb_id'], 'skipped_hole', True); continue
            old_p, new_p = _price_to_int(d['old_price']), _price_to_int(d['new_price'])
            if not old_p or not new_p or old_p == new_p:
                continue
            etype = 'price_drop' if new_p < old_p else 'price_rise'
            if _exists(conn, lst['id'], etype, ts):
                dupes += 1; bump(lst['suburb_id'], 'skipped_dupe', True); continue
            if not dry_run:
                _insert(conn, lst['id'], lst['suburb_id'], lst['address'],
                        etype, old_p, new_p, ts)
            inserted += 1; bump(lst['suburb_id'], 'inserted')

        # ---- 2. sold events from listings.sold_date ----------------------
        for lst in listings.values():
            sd = (lst.get('sold_date') or '').strip()
            if lst.get('status') != 'sold' or not sd:
                continue
            ts = sd[:10] + 'T00:00:00'
            if _in_hole(ts):
                # sold_date is a market fact (not a scrape timestamp) — holes
                # don't invalidate it, but flag-count for the report anyway.
                pass
            etype = 'sold'
            if _exists(conn, lst['id'], etype, ts):
                dupes += 1; bump(lst['suburb_id'], 'skipped_dupe', True); continue
            if not dry_run:
                _insert(conn, lst['id'], lst['suburb_id'], lst['address'],
                        etype, lst.get('price_text'),
                        lst.get('sold_price') or sd, ts)
            inserted += 1; bump(lst['suburb_id'], 'inserted')

        # ---- 3. withdrawn events — ONLY rows still withdrawn, with a date,
        # outside holes (a withdrawn_date stamped inside a hole is exactly
        # the false-cascade signature the guards were built against) -------
        for lst in listings.values():
            wd = (lst.get('withdrawn_date') or '').strip()
            if lst.get('status') != 'withdrawn' or not wd:
                continue
            ts = wd[:19] if 'T' in wd else wd[:10] + 'T00:00:00'
            if _in_hole(ts):
                holes += 1; bump(lst['suburb_id'], 'skipped_hole', True); continue
            etype = 'withdrawn'
            if _exists(conn, lst['id'], etype, ts):
                dupes += 1; bump(lst['suburb_id'], 'skipped_dupe', True); continue
            if not dry_run:
                _insert(conn, lst['id'], lst['suburb_id'], lst['address'],
                        etype, 'active', wd, ts)
            inserted += 1; bump(lst['suburb_id'], 'inserted')

        if not dry_run:
            conn.commit()
            try:
                from db_schema import _mark_migration
                _mark_migration(conn, 'sentinel_backfill_events_v1')
            except Exception:
                pass

        log.info("=== backfill %s ===", "DRY-RUN" if dry_run else "DONE")
        for sid, s in sorted(per_suburb.items()):
            log.info("  %-20s inserted=%-4d holes=%-3d dupes=%d",
                     suburb_names.get(sid, f'suburb#{sid}'),
                     s['inserted'], s['skipped_hole'], s['skipped_dupe'])
        log.info("TOTAL inserted=%d skipped_hole=%d skipped_dupe=%d",
                 inserted, holes, dupes)
        total = conn.execute("SELECT COUNT(*) AS c FROM listing_events").fetchone()
        log.info("listing_events row count now: %s", dict(total)['c'])
        return inserted
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(0 if main(dry_run='--dry-run' in sys.argv) >= 0 else 1)

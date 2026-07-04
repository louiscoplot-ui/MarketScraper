"""SENTINEL S3 — one-shot signal backtest against the real event history.

Replays listing_events chronologically (valid scrape windows only — the
backfill already excluded data holes, and the same hole filter is applied
again here defensively) and asks, for every point where a signal feature
WOULD have fired: did that address actually come to market within the
horizon? Prints per-feature precision vs the suburb's base rate and writes
a CSV. THE NUMBERS ARE MEASURED, NEVER ESTIMATED — they go in front of
Louis's principal (docs/sentinel-handoff.md §3).

Honest-sample warning: granular events only exist since ~June 2026
(price_history) / 01-03 July (live diff). With a 180-day outcome horizon,
early runs will have FEW resolvable triggers — the report separates
'resolved' from 'unresolved (horizon still open)' rather than padding.

Features backtested: withdrawn_recent, relisted_other_agency,
competitor_price_drops, street_momentum. long_hold_gain is static RP-Data
(no trigger date) — excluded, stated in the output.

Usage:
    DATABASE_URL=postgres://... python scripts/backtest_signals.py \
        [--horizon-days 180] [--csv backtest_results.csv]
"""
import csv
import os
import sys
import logging
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('backtest')

DATA_HOLES = (
    ('2026-06-17T19:01:00', '2026-06-19T05:48:00'),
    ('2026-06-24T00:00:00', '2026-07-01T00:00:00'),
    ('2026-07-01T18:49:00', '2026-07-03T17:38:00'),
)


def _in_hole(ts):
    t = str(ts)[:19]
    return any(a <= t < b for a, b in DATA_HOLES)


def _iso_listing_date(listing_date, first_seen):
    """listings.listing_date is DD/MM/YYYY (REIWA format, mixed by design);
    first_seen is ISO. Return the best ISO appearance date."""
    ld = (listing_date or '').strip()
    if ld:
        try:
            return datetime.strptime(ld, '%d/%m/%Y').strftime('%Y-%m-%d')
        except ValueError:
            pass
    fs = (first_seen or '').strip()
    return fs[:10] if fs else None


def _street(norm):
    parts = norm.split(' ', 1)
    return parts[1] if len(parts) == 2 else norm


def main(horizon_days=180, csv_path='backtest_results.csv'):
    if not os.environ.get('DATABASE_URL', '').strip():
        log.warning("DATABASE_URL not set — LOCAL SQLite (smoke test only).")

    import database
    database.init_db()
    from database import get_db
    from signals.event_detector import normalize_address

    conn = get_db()
    try:
        suburb_names = {dict(r)['id']: dict(r)['name'] for r in conn.execute(
            "SELECT id, name FROM suburbs").fetchall()}

        # ---- market appearances per (suburb, normalized address) --------
        appearances = {}     # (sid, key) -> sorted list of ISO dates
        all_keys_by_suburb = {}
        for r in conn.execute(
            "SELECT suburb_id, address, listing_date, first_seen FROM listings"
        ).fetchall():
            d = dict(r)
            key = normalize_address(d['address'], suburb_names.get(d['suburb_id']))
            if not key:
                continue
            app = _iso_listing_date(d['listing_date'], d['first_seen'])
            if app:
                appearances.setdefault((d['suburb_id'], key), []).append(app)
            all_keys_by_suburb.setdefault(d['suburb_id'], set()).add(key)
        for v in appearances.values():
            v.sort()

        def listed_within(sid, key, t_iso, days):
            end = (datetime.strptime(t_iso[:10], '%Y-%m-%d')
                   + timedelta(days=days)).strftime('%Y-%m-%d')
            return any(t_iso[:10] < a <= end
                       for a in appearances.get((sid, key), []))

        # ---- events, grouped chronologically ----------------------------
        events = [dict(r) for r in conn.execute(
            "SELECT id, suburb_id, address, event_type, detected_at "
            "FROM listing_events ORDER BY detected_at"
        ).fetchall()]
        events = [e for e in events if not _in_hole(e['detected_at'])]

        by_key = {}
        for e in events:
            k = normalize_address(e['address'], suburb_names.get(e['suburb_id']))
            if k:
                by_key.setdefault((e['suburb_id'], k), []).append(e)

        street_sold = {}   # (sid, street) -> sorted sold dates w/ key
        for (sid, k), evs in by_key.items():
            for e in evs:
                if e['event_type'] == 'sold':
                    street_sold.setdefault((sid, _street(k)), []).append(
                        (e['detected_at'][:10], k))
        for v in street_sold.values():
            v.sort()

        now_iso = datetime.utcnow().strftime('%Y-%m-%d')
        horizon_closed_cut = (datetime.utcnow()
                              - timedelta(days=horizon_days)).strftime('%Y-%m-%d')

        results = {f: {'triggers': 0, 'hits': 0, 'unresolved': 0}
                   for f in ('withdrawn_recent', 'relisted_other_agency',
                             'competitor_price_drops', 'street_momentum')}

        def record(feat, sid, key, t):
            r = results[feat]
            if listed_within(sid, key, t, horizon_days):
                r['triggers'] += 1
                r['hits'] += 1
            elif t[:10] > horizon_closed_cut:
                r['unresolved'] += 1     # horizon still open — don't judge
            else:
                r['triggers'] += 1

        for (sid, key), evs in by_key.items():
            drops = []
            for i, e in enumerate(evs):
                t = e['detected_at']
                et = e['event_type']
                if et == 'withdrawn':
                    record('withdrawn_recent', sid, key, t)
                elif et == 'relisted':
                    same_day_agc = any(
                        x['event_type'] == 'agency_change'
                        and abs((datetime.strptime(x['detected_at'][:10], '%Y-%m-%d')
                                 - datetime.strptime(t[:10], '%Y-%m-%d')).days) <= 7
                        for x in evs)
                    if same_day_agc:
                        # outcome for a relist trigger = a FURTHER appearance
                        # (does the relisted-with-new-agency property churn
                        # again) — measured but interpret with care
                        record('relisted_other_agency', sid, key, t)
                elif et == 'price_drop':
                    drops = [d for d in drops
                             if (datetime.strptime(t[:10], '%Y-%m-%d')
                                 - datetime.strptime(d[:10], '%Y-%m-%d')).days <= 180]
                    drops.append(t)
                    if len(drops) == 2:
                        record('competitor_price_drops', sid, key, t)

        # street momentum: 2nd sale in a street within 180d triggers for
        # every OTHER known address in that street
        for (sid, street), sales in street_sold.items():
            for i in range(1, len(sales)):
                d1 = datetime.strptime(sales[i - 1][0], '%Y-%m-%d')
                d2 = datetime.strptime(sales[i][0], '%Y-%m-%d')
                if (d2 - d1).days > 180:
                    continue
                t = sales[i][0]
                sold_keys = {k for _, k in sales}
                others = [k for k in all_keys_by_suburb.get(sid, ())
                          if _street(k) == street and k not in sold_keys]
                for k in others:
                    record('street_momentum', sid, k, t)
                break   # one trigger per street — avoid double counting

        # ---- baseline: P(random known address lists within horizon) ----
        base_triggers = base_hits = 0
        for sid, keys in all_keys_by_suburb.items():
            for k in keys:
                base_triggers += 1
                if listed_within(sid, k, horizon_closed_cut, horizon_days):
                    base_hits += 1
        baseline = (base_hits / base_triggers) if base_triggers else 0.0

        # ---- report ------------------------------------------------------
        log.info("=== BACKTEST (horizon %dd, %d valid events, baseline %.1f%% "
                 "over %d addresses) ===",
                 horizon_days, len(events), baseline * 100, base_triggers)
        rows = []
        for feat, r in results.items():
            resolved = r['triggers']
            prec = (r['hits'] / resolved) if resolved else None
            log.info("  %-24s triggers=%-4d hits=%-4d unresolved=%-4d "
                     "precision=%s  vs baseline %.1f%%",
                     feat, resolved, r['hits'], r['unresolved'],
                     f"{prec * 100:.1f}%" if prec is not None else "n/a",
                     baseline * 100)
            rows.append({'feature': feat, 'triggers': resolved,
                         'hits': r['hits'], 'unresolved': r['unresolved'],
                         'precision': round(prec, 4) if prec is not None else '',
                         'baseline': round(baseline, 4)})
        log.info("long_hold_gain: NOT backtested (static RP-Data, no trigger "
                 "date) — stated, not estimated.")

        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=['feature', 'triggers', 'hits',
                                              'unresolved', 'precision',
                                              'baseline'])
            w.writeheader()
            w.writerows(rows)
        log.info("CSV written: %s", csv_path)
        return rows
    finally:
        conn.close()


if __name__ == '__main__':
    hz, out = 180, 'backtest_results.csv'
    argv = sys.argv[1:]
    if '--horizon-days' in argv:
        hz = int(argv[argv.index('--horizon-days') + 1])
    if '--csv' in argv:
        out = argv[argv.index('--csv') + 1]
    main(horizon_days=hz, csv_path=out)

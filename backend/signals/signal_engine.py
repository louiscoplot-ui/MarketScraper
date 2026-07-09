"""SENTINEL S2 — explainable vendor signal engine v1.

Reads the listing_events ledger (S1) + the existing Hot Vendors RP-Data
table, scores candidate vendor addresses, and writes vendor_signals rows.
Every score is the capped sum of triggered feature weights (signal_weights
table, seeded by db_schema, operator-tunable) and ALWAYS carries its
plain-language reason_codes — a score without reasons must never exist
(explainability requirement, docs/sentinel-handoff.md §3).

Feature set v1 (weights are DB-seeded defaults):
  withdrawn_recent        0.35  withdrawn < 18 months, not re-listed since
  relisted_other_agency   0.30  relisted with an agency change
  long_hold_gain          0.20  RP-Data hold > 10y with latent gain —
                                GRADUATED ×1.0..×3.0 by hold length and
                                gain size (_long_hold_factor), so 32y/300%
                                scores ~60, not the flat 20 it used to
  street_momentum         0.15  2+ sales in the same street < 6 months
  competitor_price_drops  0.25  2+ price drops on the same listing < 6 months

Autonomous decisions (documented in docs/sentinel-decisions.md D6):
- street_momentum counts SALES (sold events); true "record" detection
  needs a price benchmark that v1 doesn't have — conservative reading.
- an address currently listed as 'active' only scores on
  competitor_price_drops (the other features target off-market owners).
- refresh policy: one live signal per (suburb_id, normalized_address);
  status 'new' rows are refreshed in place; 'dismissed' suppresses
  re-creation for 30 days, 'actioned' for 90 days.

Never raises out of rebuild_signals() — the cron must survive anything.
"""
import json
import logging
from datetime import datetime, timedelta

from database import get_db
from signals.event_detector import normalize_address

logger = logging.getLogger(__name__)

LOOKBACK_MONTHS = 18
STREET_WINDOW_DAYS = 180
DROPS_WINDOW_DAYS = 180
DISMISSED_COOLDOWN_DAYS = 30
ACTIONED_COOLDOWN_DAYS = 90


def _load_weights(conn):
    rows = conn.execute(
        "SELECT feature_name, weight FROM signal_weights").fetchall()
    return {dict(r)['feature_name']: float(dict(r)['weight'] or 0)
            for r in rows}


def _fmt_date(iso):
    """'2026-05-12T…' -> '12/05/2026' for human reason codes."""
    try:
        return datetime.strptime(str(iso)[:10], '%Y-%m-%d').strftime('%d/%m/%Y')
    except Exception:
        return str(iso)[:10]


def _street_key(norm_addr):
    """'2/80 marine pde' / '110a rochdale rd' -> street part for grouping."""
    parts = norm_addr.split(' ', 1)
    return parts[1] if len(parts) == 2 else norm_addr


def _cutoff(days):
    return (datetime.utcnow() - timedelta(days=days)).strftime('%Y-%m-%d')


def _long_hold_factor(years, gain_pct):
    """Graduate the long_hold_gain weight by hold length × latent gain.

    The old trigger was binary: any hold > 10y with any gain fired a flat
    +0.20 — a 32-year owner with a 300% latent gain scored exactly like a
    bare 11-year hold, and (0.20 being the weakest weight) the product's
    flagship lead type was permanently buried under transient market
    events. The factor scales the DB weight (still operator-tunable):

      ×1.0 at 10y  → ×2.5 at 30y+ on hold length
      +0.1..0.5 on the size of the latent gain

    With the default 0.20 weight: 11y/50% ≈ 24, 20y/100% ≈ 39,
    32y/300%+ ≈ 60 — long enough holds now cross the prediction
    threshold (0.5) on their own, as the thesis says they should."""
    hold_f = min(1.5, max(0.0, (float(years) - 10.0) / 10.0) * 0.75)
    g = float(gain_pct or 0)
    if g >= 300:
        gain_f = 0.5
    elif g >= 150:
        gain_f = 0.35
    elif g >= 75:
        gain_f = 0.2
    else:
        gain_f = 0.1   # positive-but-small or dollars-only gain
    return 1.0 + hold_f + gain_f


def rebuild_signals(suburb_ids=None):
    """Recompute vendor_signals. Returns a summary dict; never raises."""
    summary = {'suburbs': 0, 'created': 0, 'refreshed': 0,
               'skipped_cooldown': 0}
    conn = get_db()
    try:
        weights = _load_weights(conn)
        if suburb_ids is None:
            suburb_ids = [dict(r)['id'] for r in conn.execute(
                "SELECT id FROM suburbs WHERE active = 1").fetchall()]
        suburb_names = {dict(r)['id']: dict(r)['name'] for r in conn.execute(
            "SELECT id, name FROM suburbs").fetchall()}

        lookback = _cutoff(LOOKBACK_MONTHS * 30)

        for sid in suburb_ids:
            sname = suburb_names.get(sid, '')
            events = [dict(r) for r in conn.execute(
                "SELECT id, listing_id, address, event_type, old_value, "
                "new_value, detected_at FROM listing_events "
                "WHERE suburb_id = ? AND detected_at >= ? "
                "ORDER BY detected_at",
                (sid, lookback)
            ).fetchall()]
            # RP-Data long-hold owners (existing Hot Vendors upload data).
            # Loaded BEFORE the empty-events guard: a suburb with an RP
            # Data upload but no recent market events must still produce
            # long_hold signals. The old `if not events: continue` dropped
            # every RP-Data-only suburb — Ellenbrook had its CSV uploaded
            # but no Sentinel events yet (the ledger only fills over a few
            # nightly scrapes), so it silently produced zero signals.
            hv = {}
            for r in conn.execute(
                "SELECT p.normalized_address, p.address, p.holding_years, "
                "p.owner_gain_pct, p.owner_gain_dollars "
                "FROM hot_vendor_properties p "
                "JOIN hot_vendor_uploads u ON u.id = p.upload_id "
                "WHERE LOWER(TRIM(u.suburb)) = LOWER(TRIM(?))", (sname,)
            ).fetchall():
                d = dict(r)
                k = normalize_address(d['address'], sname)
                if k:
                    hv[k] = d

            if not events and not hv:
                summary['suburbs'] += 1
                continue

            # group events by sentinel-normalized address
            by_addr = {}
            for e in events:
                key = normalize_address(e['address'], sname)
                if not key:
                    continue
                by_addr.setdefault(key, []).append(e)

            # street-level sold momentum
            sold_cut = _cutoff(STREET_WINDOW_DAYS)
            street_sales = {}
            for key, evs in by_addr.items():
                for e in evs:
                    if e['event_type'] == 'sold' and e['detected_at'] >= sold_cut:
                        street_sales.setdefault(_street_key(key), []).append(e)

            # current listing status per normalized address (off-market vs on)
            active_keys = set()
            for r in conn.execute(
                "SELECT address FROM listings WHERE suburb_id = ? "
                "AND status IN ('active','under_offer')", (sid,)
            ).fetchall():
                k = normalize_address(dict(r)['address'], sname)
                if k:
                    active_keys.add(k)

            candidates = set(by_addr) | set(hv)
            for key in candidates:
                evs = by_addr.get(key, [])
                feats, reasons, src_ids = [], [], []
                # Per-feature score multipliers (default 1.0 = the plain DB
                # weight). long_hold_gain graduates by hold×gain instead of
                # firing flat — see _long_hold_factor.
                feat_mult = {}
                is_active = key in active_keys

                # ---- withdrawn_recent -------------------------------
                wd = [e for e in evs if e['event_type'] == 'withdrawn']
                relisted_after = any(
                    e['event_type'] in ('relisted', 'sold') and wd
                    and e['detected_at'] > wd[-1]['detected_at']
                    for e in evs)
                if wd and not relisted_after and not is_active:
                    last = wd[-1]
                    feats.append('withdrawn_recent')
                    reasons.append(
                        f"Withdrawn {_fmt_date(last['detected_at'])} "
                        f"without selling")
                    src_ids.append(last['id'])

                # ---- relisted_other_agency --------------------------
                rel = [e for e in evs if e['event_type'] == 'relisted']
                agc = [e for e in evs if e['event_type'] == 'agency_change']
                if rel and agc:
                    feats.append('relisted_other_agency')
                    a = agc[-1]
                    reasons.append(
                        f"Relisted {_fmt_date(rel[-1]['detected_at'])} with a "
                        f"different agency ({a['old_value']} → {a['new_value']})")
                    src_ids.extend([rel[-1]['id'], a['id']])

                # ---- long_hold_gain (off-market only) ----------------
                h = hv.get(key)
                if h and not is_active:
                    years = float(h.get('holding_years') or 0)
                    gain_pct = h.get('owner_gain_pct')
                    gain_dol = h.get('owner_gain_dollars')
                    if years > 10 and ((gain_pct or 0) > 0 or (gain_dol or 0) > 0):
                        feats.append('long_hold_gain')
                        feat_mult['long_hold_gain'] = _long_hold_factor(
                            years, gain_pct)
                        gtxt = (f"{gain_pct:.0f}% latent gain" if gain_pct
                                else "latent gain")
                        reasons.append(
                            f"Owner holding {years:.1f} years with {gtxt} "
                            f"(RP Data)")

                # ---- street_momentum (off-market only) ---------------
                sales = street_sales.get(_street_key(key), [])
                own_sold = any(e['event_type'] == 'sold' for e in evs)
                if len(sales) >= 2 and not is_active and not own_sold:
                    feats.append('street_momentum')
                    reasons.append(
                        f"{len(sales)} sales in the street in the last "
                        f"{STREET_WINDOW_DAYS // 30} months")
                    src_ids.extend(e['id'] for e in sales[:4])

                # ---- competitor_price_drops (on-market) --------------
                drops_cut = _cutoff(DROPS_WINDOW_DAYS)
                drops = [e for e in evs if e['event_type'] == 'price_drop'
                         and e['detected_at'] >= drops_cut]
                if len(drops) >= 2 and is_active:
                    feats.append('competitor_price_drops')
                    reasons.append(
                        f"{len(drops)} price drops since "
                        f"{_fmt_date(drops[0]['detected_at'])} — campaign "
                        f"struggling")
                    src_ids.extend(e['id'] for e in drops)

                if not feats:
                    continue
                score = round(min(1.0, sum(
                    weights.get(f, 0) * feat_mult.get(f, 1.0)
                    for f in feats)), 3)
                if score <= 0:
                    continue

                display_addr = (evs[-1]['address'] if evs
                                else (h or {}).get('address') or key)

                existing = conn.execute(
                    "SELECT id, status, created_at FROM vendor_signals "
                    "WHERE suburb_id = ? AND normalized_address = ? "
                    "ORDER BY created_at DESC LIMIT 1", (sid, key)
                ).fetchone()
                if existing:
                    ex = dict(existing)
                    if ex['status'] == 'new':
                        conn.execute(
                            "UPDATE vendor_signals SET score = ?, "
                            "reason_codes = ?, source_event_ids = ?, "
                            "address = ? WHERE id = ?",
                            (score, json.dumps(reasons),
                             json.dumps(sorted(set(src_ids))),
                             display_addr, ex['id'])
                        )
                        summary['refreshed'] += 1
                        continue
                    cooldown = (DISMISSED_COOLDOWN_DAYS
                                if ex['status'] == 'dismissed'
                                else ACTIONED_COOLDOWN_DAYS)
                    if str(ex['created_at'])[:10] >= _cutoff(cooldown):
                        summary['skipped_cooldown'] += 1
                        continue

                conn.execute(
                    "INSERT INTO vendor_signals (address, normalized_address, "
                    "suburb_id, score, reason_codes, source_event_ids) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (display_addr, key, sid, score, json.dumps(reasons),
                     json.dumps(sorted(set(src_ids))))
                )
                summary['created'] += 1

            summary['suburbs'] += 1

        conn.commit()
        logger.info("signal engine: %(created)d created, %(refreshed)d "
                    "refreshed, %(skipped_cooldown)d on cooldown "
                    "across %(suburbs)d suburb(s)", summary)
        return summary
    except Exception:
        conn.rollback()
        logger.exception("signal engine failed")
        summary['error'] = True
        return summary
    finally:
        conn.close()

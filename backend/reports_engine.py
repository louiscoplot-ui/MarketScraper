"""Reports engine — pure per-suburb metric calculations for the Reports
feature (Suburb Intelligence / Director Dashboard / Monthly Deep Dive /
Vendor Benchmark).

Design rules (from the feature spec):
  * Raw SQL through the existing _Conn wrapper (database.get_db) — no ORM.
  * Postgres (Neon prod) AND SQLite (local dev) must both work: every
    driver call is wrapped, and ALL date handling is done in Python on
    the mixed formats already in the DB (listing_date = DD/MM/YYYY,
    first_seen/last_seen/withdrawn_date = ISO, sold_date = either).
    We deliberately do NOT uniformise the stored formats.
  * NEVER invent a number. Every metric carries its sample_size and a
    flags list; a metric that can't be computed honestly is None with a
    flag saying why (the narrative layer repeats the absence verbatim).
  * Small samples (Peppermint Grove ≈ 20 sales/yr): medians are only
    published at n >= MIN_MEDIAN_N; the discount window auto-widens from
    90d to 180d ("médiane glissante 6 mois") with an explicit flag.
  * Competitive stats are AGENCY-level only — agent names never leave
    this module.
"""

import logging
from datetime import datetime, timedelta
from statistics import median as _median

from database import get_db
# Same price / DOM parsing as the existing Market Report so the two
# screens can never disagree on what a price string means
# (report_api.py:15 _parse_price, report_api.py:58 _calc_dom).
from report_api import _parse_price, _calc_dom

logger = logging.getLogger(__name__)

# Never publish a median computed on fewer than 5 observations —
# feature-spec rule ("Ne jamais sortir une médiane sur volume < 5").
MIN_MEDIAN_N = 5

# Price bands for the western-suburbs premium market (vendor benchmark
# + deep dive group by these).
PRICE_BANDS = [
    ('Under $1m', 0, 1_000_000),
    ('$1m – $2m', 1_000_000, 2_000_000),
    ('$2m – $3m', 2_000_000, 3_000_000),
    ('$3m – $5m', 3_000_000, 5_000_000),
    ('$5m+', 5_000_000, None),
]


def _parse_date_any(s):
    """datetime from the mixed date formats stored in listings:
    'DD/MM/YYYY' (REIWA-scraped) or ISO 'YYYY-MM-DD[THH:MM:SS...]'.
    Returns None when unparseable — callers must treat None as 'absent',
    never substitute a guess."""
    s = (s or '').strip()
    if not s:
        return None
    if '/' in s:
        parts = s.split('/')
        if len(parts) == 3:
            try:
                return datetime(int(parts[2]), int(parts[1]), int(parts[0]))
            except (ValueError, TypeError):
                return None
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '').split('+')[0][:26])
    except (ValueError, TypeError):
        return None


def _median_or_none(values, flags, label):
    """Median guarded by the small-sample rule. Appends an explanatory
    flag instead of publishing a fragile number."""
    vals = [v for v in values if v is not None]
    if len(vals) >= MIN_MEDIAN_N:
        return round(_median(vals), 1)
    if vals:
        flags.append(f"{label}: sample too small (n={len(vals)} < "
                     f"{MIN_MEDIAN_N}) — median withheld")
    else:
        flags.append(f"{label}: no data")
    return None


def _fetch_suburb_rows(conn, suburb_id):
    """One lean pass over listings for a suburb (every metric below is
    computed in Python from this set — no per-metric queries)."""
    rows = conn.execute(
        "SELECT id, status, price_text, sold_price, sold_date, "
        "withdrawn_date, first_seen, last_seen, listing_date, agency, "
        "listing_type, address "
        "FROM listings WHERE suburb_id = ?",
        (suburb_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def _fetch_price_history(conn, suburb_id):
    """listing_id → ordered [(old, new, changed_at)] for the suburb."""
    rows = conn.execute(
        "SELECT ph.listing_id, ph.old_price, ph.new_price, ph.changed_at "
        "FROM price_history ph JOIN listings l ON l.id = ph.listing_id "
        "WHERE l.suburb_id = ? ORDER BY ph.changed_at ASC",
        (suburb_id,)
    ).fetchall()
    hist = {}
    for r in rows:
        d = dict(r)
        hist.setdefault(d['listing_id'], []).append(
            (d.get('old_price'), d.get('new_price'), d.get('changed_at')))
    return hist


# ---------------------------------------------------------------- blocks

def _months_of_supply(rows, now):
    """actives ÷ (ventes 90j / 3). None + flag when no sales recorded."""
    flags = []
    active_n = sum(1 for r in rows if r['status'] in ('active', 'under_offer'))
    cutoff = now - timedelta(days=90)
    sold_90 = 0
    for r in rows:
        if r['status'] != 'sold':
            continue
        d = _parse_date_any(r.get('sold_date')) or _parse_date_any(r.get('last_seen'))
        if d and d >= cutoff:
            sold_90 += 1
    value = None
    if sold_90 > 0:
        value = round(active_n / (sold_90 / 3.0), 1)
    else:
        flags.append("no recorded sales in the last 90 days — "
                     "months of supply unavailable")
    if 0 < sold_90 < MIN_MEDIAN_N:
        flags.append(f"low sales volume (n={sold_90} in 90 days) — "
                     "treat months of supply as indicative only")
    return {'value': value, 'active_count': active_n,
            'sold_90d': sold_90, 'flags': flags}


def _velocity(rows, now):
    """DOM + acceleration between the last-30-days cohort of new listings
    and the previous 30-day cohort (via first_seen / sold_date), plus the
    21-day absorption share."""
    flags = []
    # Suburb DOM median of current actives — REIWA listing_date only
    # (same rule as the Market Report: first_seen would invent a number).
    doms = [d for d in (_calc_dom(r) for r in rows if r['status'] == 'active')
            if d is not None]
    dom_median = _median_or_none(doms, flags, 'DOM median (active listings)')

    def cohort(start, end):
        members = []
        for r in rows:
            fs = _parse_date_any(r.get('first_seen'))
            if fs and start <= fs < end:
                members.append((r, fs))
        n = len(members)
        exit_days = []
        absorbed = 0
        eligible_21 = 0
        for r, fs in members:
            sold_d = _parse_date_any(r.get('sold_date')) if r['status'] == 'sold' else None
            age = (now - fs).days
            if sold_d and sold_d >= fs:
                exit_days.append((sold_d - fs).days)
            if age >= 21:
                eligible_21 += 1
                # Under-offer transition dates aren't tracked — a listing
                # currently under offer inside a <=60-day-old cohort is
                # counted as absorbed (flagged below as an approximation).
                if r['status'] == 'under_offer':
                    absorbed += 1
                elif sold_d and (sold_d - fs).days <= 21:
                    absorbed += 1
        med_exit = round(_median(exit_days), 1) if len(exit_days) >= 3 else None
        pct_21 = round(absorbed / eligible_21 * 100, 1) if eligible_21 else None
        return {'n': n, 'median_days_to_sale': med_exit,
                'sales_observed': len(exit_days),
                'pct_absorbed_21d': pct_21, 'eligible_21d': eligible_21}

    recent = cohort(now - timedelta(days=30), now + timedelta(days=1))
    prev = cohort(now - timedelta(days=60), now - timedelta(days=30))

    accel = None
    if recent['median_days_to_sale'] is not None and prev['median_days_to_sale']:
        accel = round((recent['median_days_to_sale'] - prev['median_days_to_sale'])
                      / prev['median_days_to_sale'] * 100, 1)
    else:
        flags.append("DOM acceleration unavailable — fewer than 3 observed "
                     "sales in one of the 30-day cohorts")
    if recent['pct_absorbed_21d'] is not None or prev['pct_absorbed_21d'] is not None:
        flags.append("21-day absorption counts current under-offer listings "
                     "as absorbed (under-offer transition dates not tracked)")
    return {'dom_median_active': dom_median, 'dom_sample': len(doms),
            'dom_acceleration_pct': accel,
            'recent_cohort': recent, 'previous_cohort': prev,
            'flags': flags}


def _stock_aging(rows, now):
    """Active stock bucketed by campaign age (first_seen)."""
    buckets = {'under_30d': 0, 'd30_60': 0, 'd60_90': 0, 'over_90d': 0}
    unknown = 0
    for r in rows:
        if r['status'] != 'active':
            continue
        fs = _parse_date_any(r.get('first_seen'))
        if not fs:
            unknown += 1
            continue
        age = (now - fs).days
        if age < 30:
            buckets['under_30d'] += 1
        elif age < 60:
            buckets['d30_60'] += 1
        elif age < 90:
            buckets['d60_90'] += 1
        else:
            buckets['over_90d'] += 1
    total = sum(buckets.values())
    flags = []
    if unknown:
        flags.append(f"{unknown} active listing(s) without a first-seen "
                     "date excluded from aging buckets")
    return {'buckets': buckets, 'total_active_aged': total, 'flags': flags}


def _original_ask(row, hist):
    """Asking price at first sighting. price_history rows are ordered
    ASC, so the earliest old_price is the pre-change (original) ask; a
    listing with NO history rows never changed price, so its stored
    price_text IS the original ask. Returns None when the original
    price was never captured in a parseable form — callers flag the
    absence instead of substituting anything."""
    h = hist.get(row['id'])
    if h:
        return _parse_price(h[0][0])
    return _parse_price(row.get('price_text'))


def _discount(rows, hist, now):
    """List-to-sale discount: sold price vs the ask at first sighting.
    Window auto-widens 90d → 180d on small samples (flagged)."""
    flags = []

    def collect(days):
        cutoff = now - timedelta(days=days)
        pcts = []
        uncaptured = 0
        for r in rows:
            if r['status'] != 'sold':
                continue
            sold_d = _parse_date_any(r.get('sold_date')) or _parse_date_any(r.get('last_seen'))
            if not sold_d or sold_d < cutoff:
                continue
            sold_p = _parse_price(r.get('sold_price'))
            ask = _original_ask(r, hist)
            if not sold_p or not ask:
                uncaptured += 1
                continue
            pcts.append(round((ask - sold_p) / ask * 100, 1))
        return pcts, uncaptured

    window = 90
    pcts, uncaptured = collect(90)
    if len(pcts) < MIN_MEDIAN_N:
        window = 180
        pcts, uncaptured = collect(180)
        flags.append("small sample — discount window widened to a rolling "
                     "6 months")
    median_pct = _median_or_none(pcts, flags, 'list-to-sale discount')
    available = median_pct is not None
    if not available and uncaptured:
        flags.append(f"original asking price not captured for {uncaptured} "
                     "sale(s) — discount unavailable, not estimated")
    return {'median_pct': median_pct,
            'sample_size': len(pcts),
            'window_days': window,
            'sales_without_captured_ask': uncaptured,
            'available': available,
            'flags': flags}


def _agency_share(rows, now):
    """% of NEW listings (first_seen) per agency — current calendar month
    vs rolling 3 months. AGENCY level only; agents are never named."""
    flags = []
    month_start = datetime(now.year, now.month, 1)
    cutoff_90 = now - timedelta(days=90)

    def share(since):
        counts = {}
        total = 0
        for r in rows:
            fs = _parse_date_any(r.get('first_seen'))
            if not fs or fs < since:
                continue
            agency = (r.get('agency') or '').strip() or 'Unknown agency'
            counts[agency] = counts.get(agency, 0) + 1
            total += 1
        out = sorted(
            ({'agency': a, 'count': c, 'pct': round(c / total * 100, 1)}
             for a, c in counts.items()),
            key=lambda x: -x['count'])
        return out[:10], total

    current, cur_total = share(month_start)
    rolling, roll_total = share(cutoff_90)
    if cur_total == 0:
        flags.append("no new listings recorded this calendar month")
    if roll_total < MIN_MEDIAN_N:
        flags.append(f"low new-listing volume over 3 months (n={roll_total}) "
                     "— shares are indicative only")
    return {'current_month': current, 'current_month_total': cur_total,
            'rolling_90d': rolling, 'rolling_90d_total': roll_total,
            'flags': flags}


def _stale_flags(rows, hist, dom_median, now):
    """Actives sitting > 1.5× the suburb DOM median with at least one
    recorded price cut — the motivated-vendor shortlist."""
    flags = []
    if dom_median:
        threshold = round(dom_median * 1.5)
    else:
        threshold = 90
        flags.append("suburb DOM median unavailable — stale threshold "
                     "defaulted to 90 days")
    items = []
    for r in rows:
        if r['status'] != 'active':
            continue
        dom = _calc_dom(r)
        if dom is None:
            fs = _parse_date_any(r.get('first_seen'))
            dom = (now - fs).days if fs else None
        if dom is None or dom <= threshold:
            continue
        drops = 0
        for old, new, _at in hist.get(r['id'], []):
            po, pn = _parse_price(old), _parse_price(new)
            if po and pn and pn < po:
                drops += 1
        if drops >= 1:
            items.append({'address': r.get('address'),
                          'dom': dom,
                          'price_text': r.get('price_text'),
                          'price_cuts': drops,
                          'agency': (r.get('agency') or '').strip() or None})
    items.sort(key=lambda x: -(x['dom'] or 0))
    return {'threshold_days': threshold, 'count': len(items),
            'items': items[:20], 'flags': flags}


def _price_bands(rows, hist, now):
    """Active count + DOM median + discount median per price band.
    Medians follow the same small-sample rule as everywhere else."""
    out = []
    for label, lo, hi in PRICE_BANDS:
        def in_band(p):
            return p is not None and p >= lo and (hi is None or p < hi)
        actives = [r for r in rows if r['status'] == 'active'
                   and in_band(_parse_price(r.get('price_text')))]
        doms = [d for d in (_calc_dom(r) for r in actives) if d is not None]
        cutoff = now - timedelta(days=180)
        disc = []
        for r in rows:
            if r['status'] != 'sold':
                continue
            sold_d = _parse_date_any(r.get('sold_date')) or _parse_date_any(r.get('last_seen'))
            if not sold_d or sold_d < cutoff:
                continue
            sold_p = _parse_price(r.get('sold_price'))
            ask = _original_ask(r, hist)
            if sold_p and ask and in_band(ask):
                disc.append(round((ask - sold_p) / ask * 100, 1))
        band_flags = []
        out.append({
            'band': label,
            'active_count': len(actives),
            'dom_median': _median_or_none(doms, band_flags, f'DOM ({label})'),
            'dom_sample': len(doms),
            'discount_median_pct': _median_or_none(
                disc, band_flags, f'discount ({label})'),
            'discount_sample': len(disc),
            'flags': band_flags,
        })
    return out


def _monthly_sales_history(rows, now):
    """month 'YYYY-MM' → sales count over the trailing 12 months.
    Drives the momentum baseline + the 'partial baseline' flag."""
    counts = {}
    cutoff = now - timedelta(days=365)
    for r in rows:
        if r['status'] != 'sold':
            continue
        d = _parse_date_any(r.get('sold_date')) or _parse_date_any(r.get('last_seen'))
        if d and d >= cutoff:
            counts[d.strftime('%Y-%m')] = counts.get(d.strftime('%Y-%m'), 0) + 1
    return counts


def _momentum(rows, hist, mos, velocity, discount, now, conn, suburb_id):
    """Composite 0-100 vs the suburb's own trailing-12-month baseline.
    Weights per spec: dom_accel 25%, MoS Δ 25%, discount Δ 20%,
    21d absorption 20%, withdrawal rate 10%. A component that can't be
    computed is dropped and the remaining weights renormalised — the
    missing pieces are listed in flags, never silently faked."""
    flags = []
    components = {}

    history = _monthly_sales_history(rows, now)
    months_covered = len(history)
    if months_covered < 12:
        flags.append(f"partial baseline — only {months_covered} month(s) of "
                     "sales history available (12 needed for a full baseline)")

    # Baseline monthly sales + active stock (snapshots when available).
    monthly_sales = sorted(history.values())
    baseline_monthly_sales = (_median(monthly_sales)
                              if len(monthly_sales) >= 3 else None)
    baseline_active = None
    try:
        snaps = conn.execute(
            "SELECT active_count FROM market_snapshots "
            "WHERE suburb_id = ? ORDER BY snapshot_date DESC LIMIT 365",
            (suburb_id,)
        ).fetchall()
        actives = [dict(s)['active_count'] for s in snaps
                   if dict(s).get('active_count') is not None]
        if len(actives) >= 30:
            baseline_active = _median(actives)
    except Exception as e:
        # Snapshot history is optional for momentum — works on both
        # drivers, but a missing/odd table must not sink the report.
        # Postgres aborts the whole transaction on a failed statement:
        # roll back so the remaining suburbs on this shared connection
        # still compute (SQLite's rollback here is a harmless no-op).
        try:
            conn.rollback()
        except Exception:
            pass
        logger.warning("momentum snapshots read failed for suburb %s: %s",
                       suburb_id, e)
        flags.append("market snapshot history unavailable — months-of-supply "
                     "baseline from sales history only")

    def hotter_when_lower(current, baseline):
        if current is None or not baseline:
            return None
        return max(0.0, min(100.0, 50 + 50 * (baseline - current) / baseline))

    def hotter_when_higher(current, baseline):
        if current is None or not baseline:
            return None
        return max(0.0, min(100.0, 50 + 50 * (current - baseline) / baseline))

    # 1. DOM acceleration (25%) — negative accel (selling faster) is hot.
    accel = velocity.get('dom_acceleration_pct')
    if accel is not None:
        components['dom_acceleration'] = {
            'weight': 0.25,
            'score': max(0.0, min(100.0, 50 - float(accel))),
            'value': accel,
        }
    else:
        flags.append("momentum: DOM acceleration component unavailable")

    # 2. Months of supply vs baseline (25%).
    mos_now = mos.get('value')
    baseline_mos = None
    if baseline_monthly_sales:
        base_active = baseline_active if baseline_active is not None \
            else mos.get('active_count')
        if base_active:
            baseline_mos = round(base_active / baseline_monthly_sales, 1)
    s = hotter_when_lower(mos_now, baseline_mos)
    if s is not None:
        components['months_of_supply'] = {
            'weight': 0.25, 'score': round(s, 1),
            'value': mos_now, 'baseline': baseline_mos,
        }
    else:
        flags.append("momentum: months-of-supply component unavailable "
                     "(missing current value or baseline)")

    # 3. Discount spread vs baseline (20%) — baseline = trailing 12mo
    # median discount; a narrowing spread is hot.
    disc_now = discount.get('median_pct')
    baseline_disc = None
    try:
        cutoff = now - timedelta(days=365)
        pcts = []
        for r in rows:
            if r['status'] != 'sold':
                continue
            sd = _parse_date_any(r.get('sold_date')) or _parse_date_any(r.get('last_seen'))
            if not sd or sd < cutoff:
                continue
            sp = _parse_price(r.get('sold_price'))
            ask = _original_ask(r, hist)
            if sp and ask:
                pcts.append((ask - sp) / ask * 100)
        if len(pcts) >= MIN_MEDIAN_N:
            baseline_disc = round(_median(pcts), 1)
    except Exception as e:
        logger.warning("momentum discount baseline failed: %s", e)
    s = hotter_when_lower(disc_now, baseline_disc)
    if s is not None:
        components['discount_spread'] = {
            'weight': 0.20, 'score': round(s, 1),
            'value': disc_now, 'baseline': baseline_disc,
        }
    else:
        flags.append("momentum: discount-spread component unavailable")

    # 4. 21-day absorption (20%) — recent cohort vs previous cohort as
    # its own short baseline (transition dates older than 60d aren't
    # reconstructable from the data we store).
    ab_now = velocity['recent_cohort'].get('pct_absorbed_21d')
    ab_prev = velocity['previous_cohort'].get('pct_absorbed_21d')
    s = hotter_when_higher(ab_now, ab_prev)
    if s is not None:
        components['absorption_21d'] = {
            'weight': 0.20, 'score': round(s, 1),
            'value': ab_now, 'baseline': ab_prev,
        }
    else:
        flags.append("momentum: 21-day absorption component unavailable")

    # 5. Withdrawal rate (10%) — withdrawn / new listings, 90d vs 12mo.
    def withdrawal_rate(days):
        cutoff = now - timedelta(days=days)
        w = n = 0
        for r in rows:
            fs = _parse_date_any(r.get('first_seen'))
            if fs and fs >= cutoff:
                n += 1
            wd = _parse_date_any(r.get('withdrawn_date')) \
                if r['status'] == 'withdrawn' else None
            if wd and wd >= cutoff:
                w += 1
        return (w / n) if n else None

    wr_now = withdrawal_rate(90)
    wr_base = withdrawal_rate(365)
    s = hotter_when_lower(wr_now, wr_base)
    if s is not None:
        components['withdrawal_rate'] = {
            'weight': 0.10, 'score': round(s, 1),
            'value': round(wr_now * 100, 1),
            'baseline': round(wr_base * 100, 1),
        }
    else:
        flags.append("momentum: withdrawal-rate component unavailable")

    total_w = sum(c['weight'] for c in components.values())
    score = None
    if total_w > 0:
        score = round(sum(c['score'] * c['weight']
                          for c in components.values()) / total_w)
    else:
        flags.append("momentum score unavailable — no component computable")
    return {'score': score, 'components': components,
            'baseline_months': months_covered, 'flags': flags}


# ---------------------------------------------------------------- entry

def compute_suburb_metrics(conn, suburb_id, suburb_name, now=None):
    """All metric blocks for one suburb. Never raises — a driver error
    (either Postgres or SQLite) degrades to an 'error' entry the docx
    layer renders as 'data unavailable' rather than sinking the report."""
    now = now or datetime.utcnow()
    try:
        rows = _fetch_suburb_rows(conn, suburb_id)
        hist = _fetch_price_history(conn, suburb_id)
    except Exception as e:
        logger.exception("reports_engine: fetch failed for suburb %s", suburb_id)
        # Recover the shared connection for the next suburb — a failed
        # statement poisons the whole Postgres transaction otherwise.
        try:
            conn.rollback()
        except Exception:
            pass
        return {'suburb_id': suburb_id, 'suburb': suburb_name,
                'error': f'data fetch failed: {e}'}

    try:
        counts = {
            'active': sum(1 for r in rows if r['status'] == 'active'),
            'under_offer': sum(1 for r in rows if r['status'] == 'under_offer'),
            'sold': sum(1 for r in rows if r['status'] == 'sold'),
            'withdrawn': sum(1 for r in rows if r['status'] == 'withdrawn'),
        }
        mos = _months_of_supply(rows, now)
        velocity = _velocity(rows, now)
        discount = _discount(rows, hist, now)
        momentum = _momentum(rows, hist, mos, velocity, discount,
                             now, conn, suburb_id)
        return {
            'suburb_id': suburb_id,
            'suburb': suburb_name,
            'generated_at': now.isoformat(),
            'total_rows': len(rows),
            'counts': counts,
            'momentum': momentum,
            'months_of_supply': mos,
            'velocity': velocity,
            'stock_aging': _stock_aging(rows, now),
            'discount': discount,
            'agency_share': _agency_share(rows, now),
            'stale_flags': _stale_flags(
                rows, hist, velocity.get('dom_median_active'), now),
            'price_bands': _price_bands(rows, hist, now),
        }
    except Exception as e:
        logger.exception("reports_engine: compute failed for suburb %s", suburb_id)
        return {'suburb_id': suburb_id, 'suburb': suburb_name,
                'error': f'metric computation failed: {e}'}


def compute_metrics_for_suburbs(suburb_ids):
    """Metrics for a list of suburb IDs (one shared connection). Unknown
    IDs are skipped. Returns a list ordered by suburb name."""
    conn = get_db()
    try:
        if not suburb_ids:
            return []
        ph = ','.join(['?'] * len(suburb_ids))
        rows = conn.execute(
            f"SELECT id, name FROM suburbs WHERE id IN ({ph}) ORDER BY name",
            list(suburb_ids)
        ).fetchall()
        out = []
        now = datetime.utcnow()
        for r in rows:
            d = dict(r)
            out.append(compute_suburb_metrics(conn, d['id'], d['name'], now=now))
        return out
    finally:
        conn.close()

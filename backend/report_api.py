"""Market report endpoint — extracted from app.py to keep that module
under the MCP push size limit. Wired via register_report_routes(app)."""

import re as _re
import logging
from datetime import datetime
from statistics import median as _median
from flask import request, jsonify

from database import get_listings, get_price_changes, get_market_snapshots

logger = logging.getLogger(__name__)


def _parse_price(price_text):
    r"""Best-effort dollar amount from a free-text REIWA price string.

    Handles the common shapes agents type:
      "$1,100,000"     → 1100000
      "low $1m"        → 1000000   (used to read as $1)
      "mid $1.5m"      → 1500000
      "from $775k"     → 775000
      "$2.05M"         → 2050000
      "Offers from $1,250,000"   → 1250000

    The previous version matched ``\$([\d,]+)`` which dropped the "m"/"k"
    suffix, so "low $1m" was read as $1 and reported as a 100% drop
    against an "Offers from $1,100,000" listing.
    """
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
    # round, not int(), to avoid float-precision truncation:
    # 2.05 * 1_000_000 == 2049999.9999... → would truncate to 2049999.
    val = int(round(val))
    # Plausibility floor — free-text like "Auction 12 July" or "From 4
    # offers" matches a bare digit and produced absurd medians/deltas
    # (a "$12" listing skews a suburb median hard). No Perth dwelling
    # trades under $10k.
    return val if val >= 10_000 else None


def _calc_dom(l):
    """Days on market — only counted when REIWA published a listing date.
    Falling back to first_seen would invent a number based on when we
    started scraping, not the real listing day."""
    date_str = l.get('listing_date') or ''
    if not date_str:
        return None
    ddmm = _re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', date_str)
    try:
        if ddmm:
            start = datetime(int(ddmm.group(3)), int(ddmm.group(2)), int(ddmm.group(1)))
        else:
            start = datetime.fromisoformat(date_str.replace('Z', ''))
    except (ValueError, TypeError):
        return None
    return max(0, (datetime.utcnow() - start).days)


def _fetch_listings_for_report(suburb_ids):
    """Lean SELECT for the market report — only the columns the
    aggregations below actually read. Skips listing_notes / large
    text columns to keep the row size small enough that 5k+ listings
    don't blow past the worker's memory or the Vercel 25s budget.

    Previously this path used get_listings(...) which LEFT JOINs
    listing_notes and SELECTs `l.*` — every row carried the free-text
    note plus every audit column the report doesn't touch."""
    from database import get_db
    conn = get_db()
    try:
        sql = (
            "SELECT l.status, l.agent, l.agency, l.listing_type, "
            "l.listing_date, l.last_seen, l.sold_date, l.price_text, "
            "l.sold_price, l.address, l.reiwa_url, "
            "s.name as suburb_name "
            "FROM listings l "
            "JOIN suburbs s ON l.suburb_id = s.id"
        )
        if suburb_ids:
            placeholders = ','.join(['?'] * len(suburb_ids))
            sql += f" WHERE l.suburb_id IN ({placeholders})"
            rows = conn.execute(sql, tuple(suburb_ids)).fetchall()
        else:
            rows = conn.execute(sql).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def market_report():
    """Generate market report stats for selected suburbs."""
    from admin_api import resolve_request_scope
    suburb_ids_str = request.args.get('suburb_ids', '')
    suburb_ids = None
    if suburb_ids_str:
        try:
            suburb_ids = [int(x) for x in suburb_ids_str.split(',') if x.strip()]
        except ValueError:
            pass

    # Per-user suburb scoping. Non-admins can only see suburbs assigned
    # to them — silently intersect their requested set with allowed,
    # matching the same behaviour as /api/listings.
    _, allowed = resolve_request_scope()
    if allowed is not None:
        if not allowed:
            return jsonify({'error': 'No listings found'}), 404
        if suburb_ids:
            suburb_ids = [s for s in suburb_ids if s in allowed]
            if not suburb_ids:
                return jsonify({'error': 'No listings found'}), 404
        else:
            suburb_ids = list(allowed)

    listings = _fetch_listings_for_report(suburb_ids)
    if not listings:
        return jsonify({'error': 'No listings found'}), 404

    active = [l for l in listings if l['status'] == 'active']
    under_offer = [l for l in listings if l['status'] == 'under_offer']
    sold = [l for l in listings if l['status'] == 'sold']
    withdrawn = [l for l in listings if l['status'] == 'withdrawn']

    prices = [p for p in (_parse_price(l.get('price_text')) for l in active)
              if p and p >= 100000]
    prices.sort()

    doms = [d for d in (_calc_dom(l) for l in active) if d is not None]
    doms.sort()

    stale = [l for l in active if (_calc_dom(l) or 0) >= 60]

    agent_stats = {}
    for l in listings:
        a = l.get('agent') or 'Unknown'
        if a not in agent_stats:
            agent_stats[a] = {'active': 0, 'under_offer': 0, 'sold': 0,
                              'withdrawn': 0, 'total': 0}
        s = l.get('status', 'active')
        if s in agent_stats[a]:
            agent_stats[a][s] += 1
        agent_stats[a]['total'] += 1

    agency_stats = {}
    for l in listings:
        a = l.get('agency') or 'Unknown'
        if a not in agency_stats:
            agency_stats[a] = {'active': 0, 'under_offer': 0, 'sold': 0,
                               'withdrawn': 0, 'total': 0}
        s = l.get('status', 'active')
        if s in agency_stats[a]:
            agency_stats[a][s] += 1
        agency_stats[a]['total'] += 1

    suburb_stats = {}
    for l in listings:
        sn = l.get('suburb_name', 'Unknown')
        if sn not in suburb_stats:
            suburb_stats[sn] = {'active': 0, 'under_offer': 0, 'sold': 0,
                                'withdrawn': 0, 'total': 0}
        s = l.get('status', 'active')
        if s in suburb_stats[sn]:
            suburb_stats[sn][s] += 1
        suburb_stats[sn]['total'] += 1

    type_stats = {}
    for l in active:
        t = l.get('listing_type') or 'Unknown'
        type_stats[t] = type_stats.get(t, 0) + 1

    total_active = len(active)
    market_share = []
    if total_active > 0:
        agency_active = {}
        for l in active:
            a = l.get('agency') or 'Unknown'
            agency_active[a] = agency_active.get(a, 0) + 1
        market_share = sorted([
            {'agency': name, 'count': count,
             'pct': round(count / total_active * 100, 1)}
            for name, count in agency_active.items()
        ], key=lambda x: x['count'], reverse=True)

    suburb_market_share = {}
    for l in active:
        sn = l.get('suburb_name', 'Unknown')
        a = l.get('agency') or 'Unknown'
        if sn not in suburb_market_share:
            suburb_market_share[sn] = {}
        suburb_market_share[sn][a] = suburb_market_share[sn].get(a, 0) + 1

    for sn in suburb_market_share:
        total_in_suburb = sum(suburb_market_share[sn].values())
        suburb_market_share[sn] = sorted([
            {'agency': name, 'count': count,
             'pct': round(count / total_in_suburb * 100, 1)}
            for name, count in suburb_market_share[sn].items()
        ], key=lambda x: x['count'], reverse=True)

    # Cap the recent-changes pull, but scale it with the number of scoped
    # suburbs. get_price_changes applies a single ORDER BY changed_at DESC
    # LIMIT over the whole suburb_ids IN (...) set, so a flat 15 let one busy
    # suburb evict every other suburb's movements — a per-suburb-scoped view
    # then showed nothing for an evicted suburb. ~15 per suburb keeps each one
    # represented; the frontend still scopes + slices to the active suburb.
    n_scope = len(suburb_ids) if suburb_ids else 8
    price_changes = get_price_changes(suburb_ids=suburb_ids, limit=15 * n_scope)
    price_drops = []
    for pc in price_changes:
        old_p = _parse_price(pc.get('old_price'))
        new_p = _parse_price(pc.get('new_price'))
        drop_amount = None
        drop_pct = None
        if old_p and new_p and new_p < old_p:
            drop_amount = old_p - new_p
            drop_pct = round((drop_amount / old_p) * 100, 1)
        # Signed delta for ANY parseable change (drop OR rise). A cut and
        # a rise read very differently to an agent (a cut signals a vendor
        # who's moving), so the UI shows the direction, never a generic
        # "Changed". Negative = price cut, positive = price rise; null only
        # when a price can't be parsed ("Offers over $X" → "Under
        # negotiation"), where the UI falls back to raw old→new text.
        # drop_* stay untouched for any existing consumer.
        delta_amount = None
        delta_pct = None
        if old_p and new_p:
            delta_amount = new_p - old_p
            delta_pct = round((delta_amount / old_p) * 100, 1)
        # Robust fallback chain so the 'When' column is NEVER blank.
        # Order: explicit changed_at → SQL-side COALESCE
        # (effective_changed_at) → listing's last_seen → first_seen →
        # current UTC as a last resort. listings.last_seen is
        # NOT NULL DEFAULT in the schema, so the chain almost always
        # resolves before the last hop.
        when = (
            pc.get('changed_at')
            or pc.get('effective_changed_at')
            or pc.get('last_seen')
            or pc.get('first_seen')
            or datetime.utcnow().isoformat()
        )
        price_drops.append({
            'address': pc.get('address'),
            'suburb': pc.get('suburb_name'),
            'old_price': pc.get('old_price'),
            'new_price': pc.get('new_price'),
            'drop_amount': drop_amount,
            'drop_pct': drop_pct,
            'delta_amount': delta_amount,
            'delta_pct': delta_pct,
            'changed_at': when,
            'agent': pc.get('agent'),
            'agency': pc.get('agency'),
            'status': pc.get('status'),
            'reiwa_url': pc.get('reiwa_url'),
        })

    # 90 rows is ~5 days across an 18-suburb portfolio (one row per suburb
    # per night) — too short for the Dashboard's 7-day deltas. Scale the
    # window to the scope: 120 nights x suburb count, capped for payload
    # size (rows are 9 small columns; 2200 rows ≈ a few hundred KB).
    snap_limit = min(2200, 120 * max(1, len(suburb_ids) if suburb_ids else 20))
    snapshots = get_market_snapshots(suburb_ids=suburb_ids, limit=snap_limit)

    # Sales-based Market pulse — RAW sold-price points so the frontend can
    # recompute the median over ANY time window (1/3/6/12 months) and per
    # suburb. Everything derives from the scrape: a sold listing's price is
    # the published sale price when there is one, else its last listed price
    # (REIWA lists "Contact agent" for many premium sales, so the last
    # listed price is the only figure the scrape ever saw for them). Points
    # with no numeric price at all ("Contact form") simply can't contribute.
    #   disclosed=1 → real published sale price · disclosed=0 → last listed.
    def _ym(s):
        """Year-month 'YYYY-MM' from an ISO ('YYYY-MM-DD…') or AU
        ('DD/MM/YYYY') date string; None if unparseable."""
        s = (s or '').strip()
        if len(s) >= 7 and s[4] == '-':
            return s[:7]
        m = _re.match(r'^\d{1,2}/(\d{1,2})/(\d{4})$', s)
        if m:
            return f"{m.group(2)}-{int(m.group(1)):02d}"
        return None

    sold_series = []
    for l in sold:
        disclosed = _parse_price(l.get('sold_price'))
        price = disclosed or _parse_price(l.get('price_text'))
        if not price:
            continue
        mo = _ym(l.get('sold_date')) or _ym(l.get('last_seen'))
        if not mo:
            continue
        sold_series.append({
            'suburb_name': l.get('suburb_name') or 'Unknown',
            'month': mo, 'price': price,
            'disclosed': 1 if disclosed else 0,
        })
    # Newest first, capped for payload safety (rolling backlog ≈ 200/suburb).
    sold_series.sort(key=lambda x: x['month'], reverse=True)
    sold_series = sold_series[:5000]

    report = {
        'generated_at': datetime.utcnow().isoformat(),
        'total_listings': len(listings),
        'summary': {
            'active': len(active),
            'under_offer': len(under_offer),
            'sold': len(sold),
            'withdrawn': len(withdrawn),
        },
        'price': {
            'count_with_price': len(prices),
            'min': min(prices) if prices else None,
            'max': max(prices) if prices else None,
            # statistics.median — the old prices[n//2] indexed an
            # UNSORTED list, so the "median" was whatever listing
            # happened to sit mid-array and disagreed with the snapshot
            # median for the same suburb on the same day.
            'median': round(_median(prices)) if prices else None,
            'avg': round(sum(prices) / len(prices)) if prices else None,
        },
        'dom': {
            'count': len(doms),
            'min': min(doms) if doms else None,
            'max': max(doms) if doms else None,
            'median': round(_median(doms)) if doms else None,
            'avg': round(sum(doms) / len(doms)) if doms else None,
            'stale_count': len(stale),
        },
        'market_share': market_share,
        'suburb_market_share': suburb_market_share,
        'price_drops': price_drops,
        'snapshots': snapshots,
        'sold_series': sold_series,
        'stale_listings': [{
            'address': l.get('address'),
            'suburb': l.get('suburb_name'),
            'price': l.get('price_text'),
            'agent': l.get('agent'),
            'agency': l.get('agency'),
            'dom': _calc_dom(l),
            'listing_date': l.get('listing_date'),
            'reiwa_url': l.get('reiwa_url'),
        } for l in sorted(stale, key=lambda x: _calc_dom(x) or 0, reverse=True)],
        'agents': sorted(agent_stats.items(), key=lambda x: x[1]['total'], reverse=True),
        'agencies': sorted(agency_stats.items(), key=lambda x: x[1]['total'], reverse=True),
        'suburbs': sorted(suburb_stats.items(), key=lambda x: x[1]['total'], reverse=True),
        'property_types': sorted(type_stats.items(), key=lambda x: x[1], reverse=True),
        'withdrawn_listings': [{
            'address': l.get('address'),
            'suburb': l.get('suburb_name'),
            'price': l.get('price_text'),
            'agent': l.get('agent'),
            'agency': l.get('agency'),
            'listing_date': l.get('listing_date'),
            'reiwa_url': l.get('reiwa_url'),
        } for l in withdrawn],
    }

    return jsonify(report)


STALE_DOM_DAYS = 90          # a campaign this long signals a motivated vendor
ORPHAN_MANDATE_LO = 60       # LOOP-2 expired-mandate window (days withdrawn)
ORPHAN_MANDATE_HI = 120


def build_orphan_report(suburb_ids):
    """Motivated-vendor hit-list for a suburb scope (None = all): withdrawn
    listings (expired mandates) + long-campaign actives (DOM >= 90). Pure
    function — the /api/report/orphans endpoint calls it with the caller's
    scope, and the weekly Monday email will reuse it per user. Returns
    {items, counts, generated_at} with items sorted hottest-first."""
    from database import get_db
    conn = get_db()
    try:
        sql = (
            "SELECT l.id, l.status, l.address, l.price_text, l.listing_date, "
            "l.withdrawn_date, l.agent, l.agency, l.reiwa_url, l.bedrooms, "
            "l.bathrooms, l.land_size, l.internal_size, s.name AS suburb_name "
            "FROM listings l JOIN suburbs s ON l.suburb_id = s.id "
            "WHERE l.status IN ('active', 'under_offer', 'withdrawn')"
        )
        params = ()
        if suburb_ids:
            ph = ','.join(['?'] * len(suburb_ids))
            sql += f" AND l.suburb_id IN ({ph})"
            params = tuple(suburb_ids)
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()

    now = datetime.utcnow()
    items = []
    for l in rows:
        dom = _calc_dom(l)
        status = l.get('status')
        cat = reason = None
        heat = 0.0
        if status == 'withdrawn':
            wd = (l.get('withdrawn_date') or '')[:10]
            days_wd = None
            if wd:
                try:
                    days_wd = (now - datetime.fromisoformat(wd)).days
                except ValueError:
                    days_wd = None
            if days_wd is not None and ORPHAN_MANDATE_LO <= days_wd <= ORPHAN_MANDATE_HI:
                cat, reason = 'expired_mandate', f'Withdrawn {days_wd} days ago — mandate window just expired'
                heat = 100 + (30 - abs(days_wd - 90))   # peak at ~90 days
            elif days_wd is not None and days_wd < ORPHAN_MANDATE_LO:
                cat, reason, heat = 'withdrawn_recent', f'Withdrawn {days_wd} days ago', 80.0
            else:
                cat = 'withdrawn'
                reason = f'Withdrawn {days_wd} days ago' if days_wd is not None else 'Withdrawn'
                heat = 60.0
        elif dom is not None and dom >= STALE_DOM_DAYS:
            cat, reason = 'stale', f'{dom} days on market — long campaign, mandate likely near renewal'
            heat = 40 + min(dom, 400) / 10.0
        if cat is None:
            continue
        items.append({
            'id': l['id'], 'address': l['address'], 'suburb': l['suburb_name'],
            'status': status, 'category': cat, 'reason': reason,
            'dom': dom, 'withdrawn_date': (l.get('withdrawn_date') or '')[:10] or None,
            'price_text': l.get('price_text'), 'agent': l.get('agent'),
            'agency': l.get('agency'), 'reiwa_url': l.get('reiwa_url'),
            'bedrooms': l.get('bedrooms'), 'bathrooms': l.get('bathrooms'),
            'land_size': l.get('land_size'), 'internal_size': l.get('internal_size'),
            'heat': round(heat, 1),
        })
    items.sort(key=lambda x: (-x['heat'], -(x['dom'] or 0)))
    return {
        'items': items,
        'generated_at': now.isoformat(),
        'counts': {
            'total': len(items),
            'expired_mandate': sum(1 for i in items if i['category'] == 'expired_mandate'),
            'withdrawn': sum(1 for i in items if i['category'] in ('withdrawn', 'withdrawn_recent')),
            'stale': sum(1 for i in items if i['category'] == 'stale'),
        },
    }


def orphan_report():
    """GET /api/report/orphans — the caller's motivated-vendor hit-list,
    scoped to their assigned suburbs (admins = all)."""
    from admin_api import resolve_request_scope
    _, allowed = resolve_request_scope()
    if allowed is not None and not allowed:
        return jsonify({'items': [], 'counts': {'total': 0, 'expired_mandate': 0,
                       'withdrawn': 0, 'stale': 0}, 'generated_at': datetime.utcnow().isoformat()})
    suburb_ids = None if allowed is None else list(allowed)
    return jsonify(build_orphan_report(suburb_ids))


def register_report_routes(app):
    app.add_url_rule(
        '/api/report',
        endpoint='market_report',
        view_func=market_report,
        methods=['GET'],
    )
    app.add_url_rule(
        '/api/report/orphans',
        endpoint='orphan_report',
        view_func=orphan_report,
        methods=['GET'],
    )
    logger.info("Report routes registered: /api/report, /api/report/orphans")

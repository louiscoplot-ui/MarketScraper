"""Market report endpoint — extracted from app.py to keep that module
under the MCP push size limit. Wired via register_report_routes(app)."""

import re as _re
import logging
from datetime import datetime
from flask import request, jsonify

from database import get_listings, get_price_changes, get_market_snapshots

logger = logging.getLogger(__name__)


def _parse_price(price_text):
    """Best-effort dollar amount from a free-text REIWA price string.

    Handles the common shapes agents type:
      "$1,100,000"     → 1100000
      "low $1m"        → 1000000   (used to read as $1)
      "mid $1.5m"      → 1500000
      "from $775k"     → 775000
      "$2.05M"         → 2050000
      "Offers from $1,250,000"   → 1250000

    The previous version matched `\$([\\d,]+)` which dropped the "m"/"k"
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
    return int(round(val))


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

    listings = get_listings(suburb_ids=suburb_ids)
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

    # Cap to the 15 most-recent price changes — older ones drop off so
    # the agent's eye stays on what's actively moving. ORDER BY changed_at
    # DESC in get_price_changes() means we take the freshest 15.
    price_changes = get_price_changes(suburb_ids=suburb_ids, limit=15)
    price_drops = []
    for pc in price_changes:
        old_p = _parse_price(pc.get('old_price'))
        new_p = _parse_price(pc.get('new_price'))
        drop_amount = None
        drop_pct = None
        if old_p and new_p and new_p < old_p:
            drop_amount = old_p - new_p
            drop_pct = round((drop_amount / old_p) * 100, 1)
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
            'changed_at': when,
            'agent': pc.get('agent'),
            'agency': pc.get('agency'),
            'status': pc.get('status'),
            'reiwa_url': pc.get('reiwa_url'),
        })

    snapshots = get_market_snapshots(suburb_ids=suburb_ids, limit=90)

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
            'median': prices[len(prices)//2] if prices else None,
            'avg': round(sum(prices) / len(prices)) if prices else None,
        },
        'dom': {
            'count': len(doms),
            'min': min(doms) if doms else None,
            'max': max(doms) if doms else None,
            'median': doms[len(doms)//2] if doms else None,
            'avg': round(sum(doms) / len(doms)) if doms else None,
            'stale_count': len(stale),
        },
        'market_share': market_share,
        'suburb_market_share': suburb_market_share,
        'price_drops': price_drops,
        'snapshots': snapshots,
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


def register_report_routes(app):
    app.add_url_rule(
        '/api/report',
        endpoint='market_report',
        view_func=market_report,
        methods=['GET'],
    )
    logger.info("Report routes registered: /api/report")

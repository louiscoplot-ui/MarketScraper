"""LOOP-1 diff engine — detects listing state transitions between scrape
runs and records them in listing_transitions for the downstream signal
loops (withdrawn orphan, sale fallen, sold reveal, strata contagion).

Why a snapshot table: listings.status is overwritten in place by the
scraper, so the previous run's state is gone by the time run_diff() runs.
listing_snapshots holds the prior per-listing state; run_diff compares the
current listings row against its snapshot, emits any transition, then
rewrites the snapshot to the current state for the next run. The first run
for a suburb has no snapshots → no transitions, just an initial snapshot.
"""
import re
import json
import logging
from datetime import datetime

from database import get_db

logger = logging.getLogger(__name__)

# Price-list reduction threshold for a 'price_drop' transition.
PRICE_DROP_THRESHOLD = 0.03  # 3% — per the LOOP-1 spec.


def _price_to_int(text):
    """Best-effort '$1,250,000' / 'Offers above $999k' / '1.2m' → int dollars.
    Returns None when there's no usable figure (auction / 'Contact agent').
    Local to the diff engine on purpose — keeps it free of any Flask-side
    import (pipeline_api pulls the app context)."""
    if text is None:
        return None
    s = str(text).lower().replace(',', '').strip()
    if not s:
        return None
    m = re.search(r'(\d+(?:\.\d+)?)\s*([km])?', s)
    if not m:
        return None
    try:
        val = float(m.group(1))
    except ValueError:
        return None
    suffix = m.group(2)
    if suffix == 'k':
        val *= 1_000
    elif suffix == 'm':
        val *= 1_000_000
    elif val < 10_000:
        # a bare "950" almost certainly means 950k for WA residential
        val *= 1_000
    return int(val)


def _date_only(val):
    if not val:
        return None
    try:
        return datetime.strptime(str(val)[:10], '%Y-%m-%d').date()
    except Exception:
        return None


def _days_between(start, end):
    d1 = _date_only(start)
    if not d1:
        return None
    d2 = _date_only(end) or datetime.utcnow().date()
    return (d2 - d1).days


def detect_strata(address):
    """Return (is_strata, unit_number, complex_address) for a unit address.
    Handles '2/80 Mooro Drive' and 'Unit 5, 12 Stirling Hwy'. complex_address
    is the building address with the unit portion stripped, used to group
    sales in the same strata complex (LOOP-6)."""
    if not address:
        return (False, None, None)
    a = str(address).strip()
    m = re.match(r'^\s*(\d+)\s*/\s*(\d+.*)$', a)   # "2/80 Mooro Drive"
    if m:
        return (True, m.group(1), m.group(2).strip())
    m = re.match(r'^\s*unit\s+(\d+)[,\s]+(.*)$', a, re.I)  # "Unit 5, 12 ..."
    if m:
        return (True, m.group(1), m.group(2).strip())
    return (False, None, None)


def _t(lid, suburb, address, ttype, frm, to, metadata):
    return {
        'listing_id': lid, 'suburb': suburb, 'address': address,
        'transition_type': ttype, 'from_status': frm, 'to_status': to,
        'metadata': metadata,
    }


def _classify(cur, old, suburb):
    """Return a single transition dict for a listing whose state changed
    vs its snapshot, or None. One transition per listing per run — withdrawn
    takes priority, then relist, sale-fallen, sold-reveal, price-drop."""
    old_status = old['status']
    new_status = cur['status']
    address = cur['address']
    lid = cur['id']

    # active/under_offer → withdrawn
    if old_status in ('active', 'under_offer') and new_status == 'withdrawn':
        return _t(lid, suburb, address, 'withdrawn', old_status, new_status, {
            'withdrawn_date': cur['withdrawn_date'],
            'days_listed': _days_between(cur['first_seen'], cur['withdrawn_date']),
            'last_price': cur['price_text'],
        })

    # withdrawn → active/under_offer : relisted
    if old_status == 'withdrawn' and new_status in ('active', 'under_offer'):
        return _t(lid, suburb, address, 'relisted', old_status, new_status, {
            # withdrawn_date is cleared on relist, so days_withdrawn is
            # best-effort: only available if the snapshot kept it (it does
            # not today) — left null rather than guessed.
            'days_withdrawn': None,
        })

    # under_offer → active : sale fell through
    if old_status == 'under_offer' and new_status == 'active':
        return _t(lid, suburb, address, 'sale_fallen', old_status, new_status, {
            'property_address': address,
            'original_price': cur['price_text'],
        })

    # sold_price NULL/empty → value : sold price revealed
    old_sp = (old['sold_price'] or '').strip()
    new_sp = (cur['sold_price'] or '').strip()
    if not old_sp and new_sp:
        is_strata, unit_no, complex_addr = detect_strata(address)
        return _t(lid, suburb, address, 'sold_price_revealed', old_status, new_status, {
            'sold_price': cur['sold_price'],
            'sold_date': cur['sold_date'],
            'suburb': suburb,
            'is_strata': is_strata,
            'strata_unit': unit_no,
            'complex_address': complex_addr,
        })

    # list price reduced > 3%
    old_p = _price_to_int(old['price_text'])
    new_p = _price_to_int(cur['price_text'])
    if old_p and new_p and new_p < old_p:
        pct = (old_p - new_p) / old_p
        if pct > PRICE_DROP_THRESHOLD:
            return _t(lid, suburb, address, 'price_drop', old_status, new_status, {
                'old_price': old_p,
                'new_price': new_p,
                'pct_change': round(-pct * 100, 1),
            })

    return None


def run_diff(suburb):
    """Compare the current listings for `suburb` (name) against the previous
    snapshot, persist any detected transitions into listing_transitions, then
    refresh the snapshot to the current state. Returns the list of detected
    transition dicts (empty on first run / unknown suburb / any error —
    never raises, so it can't break the parent scrape)."""
    conn = get_db()
    try:
        srow = conn.execute(
            "SELECT id FROM suburbs WHERE name = ?", (suburb,)
        ).fetchone()
        if not srow:
            logger.warning("run_diff: unknown suburb %r — skipping", suburb)
            return []
        suburb_id = srow['id']

        current = conn.execute(
            "SELECT id, address, status, sold_price, sold_date, price_text, "
            "withdrawn_date, first_seen FROM listings WHERE suburb_id = ?",
            (suburb_id,)
        ).fetchall()

        snaps = conn.execute(
            "SELECT listing_id, status, sold_price, price_text "
            "FROM listing_snapshots WHERE suburb = ?",
            (suburb,)
        ).fetchall()
        prev = {r['listing_id']: r for r in snaps}

        transitions = []
        for row in current:
            old = prev.get(row['id'])
            if old is None:
                continue  # new listing — nothing to diff against yet
            t = _classify(row, old, suburb)
            if t:
                transitions.append(t)

        for t in transitions:
            conn.execute(
                "INSERT INTO listing_transitions "
                "(listing_id, suburb, address, transition_type, from_status, "
                " to_status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (t['listing_id'], t['suburb'], t['address'], t['transition_type'],
                 t['from_status'], t['to_status'], json.dumps(t['metadata']))
            )

        # Refresh the snapshot to the current state. Delete-then-insert for
        # this suburb so listings that disappeared drop out and new ones
        # appear — next run diffs against exactly what we saw this run.
        conn.execute("DELETE FROM listing_snapshots WHERE suburb = ?", (suburb,))
        for row in current:
            conn.execute(
                "INSERT INTO listing_snapshots "
                "(listing_id, suburb, status, sold_price, price_text) "
                "VALUES (?, ?, ?, ?, ?)",
                (row['id'], suburb, row['status'], row['sold_price'], row['price_text'])
            )

        conn.commit()
        logger.info("run_diff[%s]: %d transition(s) detected", suburb, len(transitions))
        return transitions
    except Exception:
        conn.rollback()
        logger.exception("run_diff[%s] failed", suburb)
        return []
    finally:
        conn.close()

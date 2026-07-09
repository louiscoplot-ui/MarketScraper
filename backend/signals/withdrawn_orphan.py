"""LOOP-2 — Withdrawn Orphan loop.

In WA the standard exclusive agency agreement runs ~90 days. A property
withdrawn 60–120 days ago and never relisted is therefore the textbook
motivated-vendor signal: expired mandate, an agent who has gone quiet, and
the exact window where a cold approach is welcomed. This detects those
orphans off the listings table (status='withdrawn' + withdrawn_date),
dedupes via listing_transitions (LOOP-1), turns each new one into a Pipeline
target, and exposes a withdrawn-specific letter for download.

No emails are sent here — orphans surface in the existing morning digest
(opt-in) and the Pipeline UI. Letters are generated on demand.
"""
import json
import logging
import statistics
from datetime import datetime, timedelta

from database import get_db
from signals.diff_engine import _price_to_int, _days_between

logger = logging.getLogger(__name__)

ORPHAN_MIN_DAYS = 60
ORPHAN_MAX_DAYS = 120


def _detect_orphans(conn):
    """Withdrawn 60–120 days ago and still withdrawn (a relist flips status
    back to active, so status='withdrawn' already excludes relisted ones)."""
    now = datetime.utcnow()
    lo = (now - timedelta(days=ORPHAN_MAX_DAYS)).strftime('%Y-%m-%d')
    hi = (now - timedelta(days=ORPHAN_MIN_DAYS)).strftime('%Y-%m-%d')
    rows = conn.execute(
        "SELECT l.id, l.address, l.price_text, l.withdrawn_date, l.first_seen, "
        "l.suburb_id, s.name AS suburb "
        "FROM listings l JOIN suburbs s ON s.id = l.suburb_id "
        "WHERE l.status = 'withdrawn' "
        "AND l.withdrawn_date IS NOT NULL AND l.withdrawn_date <> '' "
        "AND substr(l.withdrawn_date, 1, 10) BETWEEN ? AND ?",
        (lo, hi)
    ).fetchall()
    return [dict(r) for r in rows]


def _suburb_stats(conn, suburb_id):
    """Live active count + median active list price for a suburb — used to
    make the letter concrete. Median is best-effort (price_text is fuzzy);
    returns (active_count, median_text|None)."""
    rows = conn.execute(
        "SELECT price_text FROM listings WHERE suburb_id = ? AND status = 'active'",
        (suburb_id,)
    ).fetchall()
    active_count = len(rows)
    prices = [p for p in (_price_to_int(dict(r)['price_text']) for r in rows) if p]
    median_text = None
    if prices:
        med = int(statistics.median(prices))
        median_text = f"${med:,}"
    return active_count, median_text


def process_withdrawn_orphans():
    """Detect new withdrawn orphans, create a Pipeline target for each, and
    mark its 'withdrawn' transition processed so it's handled exactly once.
    A missing transition row is created retroactively (orphans that withdrew
    before LOOP-1 shipped have no diff-engine record). Returns counts."""
    conn = get_db()
    detected = 0
    suburbs = set()
    try:
        orphans = _detect_orphans(conn)
        for o in orphans:
            lid = o['id']
            tr = conn.execute(
                "SELECT id, processed FROM listing_transitions "
                "WHERE listing_id = ? AND transition_type = 'withdrawn' "
                "ORDER BY id DESC LIMIT 1",
                (lid,)
            ).fetchone()

            if tr is not None and dict(tr).get('processed'):
                continue  # already turned into a lead — skip

            if tr is None:
                # Retroactive transition record for pre-LOOP-1 withdrawals.
                conn.execute(
                    "INSERT INTO listing_transitions "
                    "(listing_id, suburb, address, transition_type, from_status, "
                    " to_status, metadata, processed) VALUES (?,?,?,?,?,?,?,0)",
                    (lid, o['suburb'], o['address'], 'withdrawn', 'active', 'withdrawn',
                     json.dumps({
                         'withdrawn_date': o['withdrawn_date'],
                         'days_listed': _days_between(o['first_seen'], o['withdrawn_date']),
                         'last_price': o['price_text'],
                         'retroactive': True,
                     }))
                )

            today = datetime.utcnow().strftime('%Y-%m-%d')
            # source_suburb_lower must be set at INSERT time — every scoped
            # Pipeline read filters on it, and the boot-time backfill only
            # runs on restart, so NULL here means the lead is invisible to
            # the agent until the next reboot.
            conn.execute(
                "INSERT INTO pipeline_tracking "
                "(source_address, source_suburb, source_suburb_lower, "
                " target_address, target_owner_name, "
                " status, sent_date, notes) VALUES (?,?,?,?,?,?,?,?) "
                "ON CONFLICT (target_address, sent_date) DO NOTHING",
                (o['address'], o['suburb'],
                 (o['suburb'] or '').strip().lower(),
                 o['address'], None,
                 'withdrawn_orphan', today,
                 f"Withdrawn {str(o['withdrawn_date'])[:10]} — orphan lead (LOOP-2)")
            )
            conn.execute(
                "UPDATE listing_transitions SET processed = 1, processed_at = ? "
                "WHERE listing_id = ? AND transition_type = 'withdrawn'",
                (datetime.utcnow().isoformat(), lid)
            )
            detected += 1
            suburbs.add(o['suburb'])

        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("process_withdrawn_orphans failed")
        return {'detected': 0, 'letters_generated': 0, 'suburbs_covered': []}
    finally:
        conn.close()

    logger.info("withdrawn-orphans: %d new lead(s) across %d suburb(s)",
                detected, len(suburbs))
    # Every detected orphan has a downloadable letter, so letters_generated
    # mirrors detected (letters render on demand via the signals route).
    return {'detected': detected, 'letters_generated': detected,
            'suburbs_covered': sorted(suburbs)}


def build_orphan_letter(listing_id):
    """Render the withdrawn-orphan .docx for one listing. Returns (Document,
    safe_filename) or (None, None) if the listing isn't an eligible orphan."""
    from pipeline_letter import render_withdrawn_letter_docx
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT l.id, l.address, l.withdrawn_date, l.first_seen, l.suburb_id, "
            "l.status, s.name AS suburb "
            "FROM listings l JOIN suburbs s ON s.id = l.suburb_id WHERE l.id = ?",
            (listing_id,)
        ).fetchone()
        if not row:
            return None, None
        row = dict(row)
        active_count, median_text = _suburb_stats(conn, row['suburb_id'])
    finally:
        conn.close()

    days = _days_between(row['withdrawn_date'], None)
    doc = render_withdrawn_letter_docx(
        target_address=row['address'],
        suburb=row['suburb'],
        withdrawn_date=row['withdrawn_date'],
        days_withdrawn=days,
        active_count=active_count,
        median_text=median_text,
    )
    safe = ''.join(c for c in (row['address'] or 'letter')
                   if c.isalnum() or c in (' ', '-')).strip().replace(' ', '_')[:60]
    return doc, f"withdrawn_{safe or row['id']}.docx"

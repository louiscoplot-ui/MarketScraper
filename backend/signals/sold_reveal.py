"""LOOP-4 — Sold Price Reveal loop.

When a sold price becomes public, the neighbours who watched the property go
"under offer" are primed to think about their own home — the ideal moment for
an appraisal letter. Detection is already handled by the LOOP-1 diff engine
(transition_type='sold_price_revealed' on a sold_price NULL→value flip), so
this loop turns each reveal into a bundle of neighbour letters, on demand.

Letters are generated when an agent downloads them (build_sold_reveal_zip) —
NOT in the cron — because finding neighbours hits OSM and Render's filesystem
is ephemeral. The cron only logs how many reveals are fresh; they surface in
the morning digest and via the signals route.
"""
import io
import json
import logging
import zipfile
import statistics
from datetime import datetime, timedelta

from database import get_db
from signals.diff_engine import _price_to_int

logger = logging.getLogger(__name__)

REVEAL_WINDOW_DAYS = 14


def _suburb_median(conn, suburb_name):
    rows = conn.execute(
        "SELECT l.price_text FROM listings l JOIN suburbs s ON s.id = l.suburb_id "
        "WHERE s.name = ? AND l.status = 'active'",
        (suburb_name,)
    ).fetchall()
    prices = [p for p in (_price_to_int(dict(r)['price_text']) for r in rows) if p]
    return int(statistics.median(prices)) if prices else None


def _pct_text(sold_price_int, median_int):
    if not sold_price_int or not median_int:
        return None
    pct = (sold_price_int - median_int) / median_int * 100
    sign = '+' if pct >= 0 else '−'
    return f"{sign}{abs(round(pct, 1))}%"


def list_sold_reveals(allowed_ids=None, since_iso=None):
    """Recent sold-price reveals, scoped to allowed suburb_ids (None = all).
    Used by the digest and the dashboard. Returns dicts with parsed metadata."""
    conn = get_db()
    cutoff = since_iso or (datetime.utcnow() - timedelta(days=1)).isoformat()
    try:
        rows = conn.execute(
            "SELECT t.id, t.listing_id, t.suburb, t.address, t.detected_at, "
            "t.metadata, l.suburb_id "
            "FROM listing_transitions t "
            "LEFT JOIN listings l ON l.id = t.listing_id "
            "WHERE t.transition_type = 'sold_price_revealed' AND t.detected_at >= ? "
            "ORDER BY t.detected_at DESC",
            (cutoff,)
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        r = dict(r)
        if allowed_ids is not None and r.get('suburb_id') not in allowed_ids:
            continue
        try:
            meta = json.loads(r['metadata']) if r.get('metadata') else {}
        except Exception:
            meta = {}
        out.append({
            'transition_id': r['id'],
            'listing_id': r['listing_id'],
            'suburb': r['suburb'],
            'address': r['address'],
            'sold_price': meta.get('sold_price'),
            'sold_date': meta.get('sold_date'),
            'detected_at': r['detected_at'],
        })
    return out


def build_sold_reveal_zip(transition_id):
    """For one sold-price reveal, render an appraisal letter to each nearby
    neighbour and bundle them into a ZIP. Marks the transition processed.
    Returns (zip_bytes, filename, suburb_id) or (None, None, None)."""
    from pipeline_api import _real_neighbours
    from pipeline_letter import render_sold_reveal_letter_docx

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT t.id, t.listing_id, t.suburb, t.address, t.metadata, l.suburb_id "
            "FROM listing_transitions t "
            "LEFT JOIN listings l ON l.id = t.listing_id "
            "WHERE t.id = ? AND t.transition_type = 'sold_price_revealed'",
            (transition_id,)
        ).fetchone()
        if not row:
            return None, None, None
        row = dict(row)
        try:
            meta = json.loads(row['metadata']) if row.get('metadata') else {}
        except Exception:
            meta = {}
        sold_price = meta.get('sold_price')
        suburb = row['suburb']
        sold_address = row['address']

        median = _suburb_median(conn, suburb)
        pct = _pct_text(_price_to_int(sold_price), median)

        neighbours = _real_neighbours(conn, sold_address, suburb, has_hv=True)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for naddr in neighbours:
                doc = render_sold_reveal_letter_docx(
                    neighbour_address=naddr, sold_address=sold_address,
                    sold_price=sold_price, suburb=suburb, pct_text=pct)
                docbuf = io.BytesIO()
                doc.save(docbuf)
                safe = ''.join(c for c in naddr if c.isalnum() or c in (' ', '-')
                               ).strip().replace(' ', '_')[:60] or 'neighbour'
                zf.writestr(f"{safe}.docx", docbuf.getvalue())

        conn.execute(
            "UPDATE listing_transitions SET processed = 1, processed_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), transition_id)
        )
        conn.commit()
        buf.seek(0)
        safe_sub = (suburb or 'suburb').replace(' ', '_')
        return buf.getvalue(), f"sold_reveal_{safe_sub}_{transition_id}.zip", row.get('suburb_id')
    except Exception:
        conn.rollback()
        logger.exception("build_sold_reveal_zip failed")
        return None, None, None
    finally:
        conn.close()


def process_sold_reveals():
    """Cron-light pass — just reports how many fresh reveals exist (letters
    are generated on demand). Kept so the nightly run logs the signal."""
    fresh = list_sold_reveals(allowed_ids=None,
                              since_iso=(datetime.utcnow() - timedelta(days=1)).isoformat())
    logger.info("sold-reveals: %d fresh in last 24h", len(fresh))
    return {'fresh': len(fresh)}

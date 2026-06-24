"""LOOP-6 — Strata Contagion loop.

When one unit sells well in a 1960s–70s strata complex (Claremont / Mosman
Park), 2–3 neighbours typically list within six months — price anchoring plus
fear of special levies. One sale in a complex → letters to the whole building,
high volume for minimal effort.

Detection rides on the diff engine's sold_price_revealed transitions, which now
carry is_strata / complex_address (see diff_engine.detect_strata). The cron
pass records each strata sale into strata_complexes; neighbour-unit letters are
generated on demand via the signals route (no OSM, no ephemeral-FS in cron).
"""
import io
import json
import logging
import zipfile
from datetime import datetime, timedelta

from database import get_db

logger = logging.getLogger(__name__)

STRATA_WINDOW_DAYS = 30


def _strata_transitions(conn, since_iso):
    rows = conn.execute(
        "SELECT t.id, t.listing_id, t.suburb, t.address, t.metadata, l.suburb_id "
        "FROM listing_transitions t LEFT JOIN listings l ON l.id = t.listing_id "
        "WHERE t.transition_type = 'sold_price_revealed' AND t.detected_at >= ? "
        "ORDER BY t.detected_at DESC",
        (since_iso,)
    ).fetchall()
    out = []
    for r in rows:
        r = dict(r)
        try:
            meta = json.loads(r['metadata']) if r.get('metadata') else {}
        except Exception:
            meta = {}
        if not meta.get('is_strata'):
            continue
        r['meta'] = meta
        out.append(r)
    return out


def process_strata_sales():
    """Cron pass — upsert each recent strata sale into strata_complexes so the
    complex's latest anchor sale is known. Idempotent via UNIQUE(street_address).
    Returns the number of complexes touched."""
    conn = get_db()
    since = (datetime.utcnow() - timedelta(days=STRATA_WINDOW_DAYS)).isoformat()
    touched = 0
    try:
        for t in _strata_transitions(conn, since):
            meta = t['meta']
            complex_addr = meta.get('complex_address')
            if not complex_addr:
                continue
            conn.execute(
                "INSERT INTO strata_complexes "
                "(street_address, suburb, last_sale_date, last_sale_price, last_unit_address) "
                "VALUES (?,?,?,?,?) "
                "ON CONFLICT (street_address) DO UPDATE SET "
                "last_sale_date = excluded.last_sale_date, "
                "last_sale_price = excluded.last_sale_price, "
                "last_unit_address = excluded.last_unit_address",
                (complex_addr, t['suburb'], meta.get('sold_date'),
                 meta.get('sold_price'), t['address'])
            )
            touched += 1
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("process_strata_sales failed")
        return {'complexes': 0}
    finally:
        conn.close()
    logger.info("strata contagion: %d complex sale(s) recorded", touched)
    return {'complexes': touched}


def list_strata_sales(allowed_ids=None, since_iso=None):
    """Recent strata sales for the digest/dashboard, scoped to suburb_ids."""
    conn = get_db()
    since = since_iso or (datetime.utcnow() - timedelta(days=1)).isoformat()
    try:
        rows = _strata_transitions(conn, since)
    finally:
        conn.close()
    out = []
    for r in rows:
        if allowed_ids is not None and r.get('suburb_id') not in allowed_ids:
            continue
        out.append({
            'transition_id': r['id'],
            'suburb': r['suburb'],
            'sold_unit': r['address'],
            'complex_address': r['meta'].get('complex_address'),
            'sold_price': r['meta'].get('sold_price'),
        })
    return out


def build_strata_letters_zip(transition_id):
    """For one strata sale, render a letter to every OTHER unit in the same
    complex and bundle them into a ZIP. Returns (zip_bytes, filename,
    suburb_id) or (None, None, None)."""
    from pipeline_letter import render_strata_letter_docx
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT t.id, t.listing_id, t.suburb, t.address, t.metadata, l.suburb_id "
            "FROM listing_transitions t LEFT JOIN listings l ON l.id = t.listing_id "
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
        complex_addr = meta.get('complex_address')
        if not complex_addr:
            return None, None, None

        # Other units in the same complex (address contains the complex
        # street address), excluding the unit that just sold.
        units = conn.execute(
            "SELECT DISTINCT l.address FROM listings l "
            "JOIN suburbs s ON s.id = l.suburb_id "
            "WHERE l.address LIKE ? AND LOWER(s.name) = LOWER(?) "
            "AND LOWER(l.address) <> LOWER(?)",
            (f"%{complex_addr}%", row['suburb'] or '', row['address'])
        ).fetchall()

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for u in units:
                uaddr = dict(u)['address']
                doc = render_strata_letter_docx(
                    unit_address=uaddr, sold_unit_address=row['address'],
                    sold_price=meta.get('sold_price'), suburb=row['suburb'])
                docbuf = io.BytesIO()
                doc.save(docbuf)
                safe = ''.join(c for c in uaddr if c.isalnum() or c in (' ', '-')
                               ).strip().replace(' ', '_')[:60] or 'unit'
                zf.writestr(f"{safe}.docx", docbuf.getvalue())
        buf.seek(0)
        safe_c = ''.join(c for c in complex_addr if c.isalnum() or c in (' ', '-')
                         ).strip().replace(' ', '_')[:50] or 'complex'
        return buf.getvalue(), f"strata_{safe_c}.zip", row.get('suburb_id')
    except Exception:
        logger.exception("build_strata_letters_zip failed")
        return None, None, None
    finally:
        conn.close()

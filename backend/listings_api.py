"""Listings update API — inline date editing.

Lets the agent override listing_date / sold_date / withdrawn_date on
any listings row from the UI. Useful when:
- The scraper guessed a date wrong (REIWA's "Sold X days ago" badge
  decays over time, can be off by ±2 days)
- A sold listing has no sold_date because it was never seen as
  active first (REIWA published it directly to /sold/, scraper
  never had a 'recently active' period to extract a date from)
- A withdrawn listing's withdrawn_date isn't quite right

Wire into app.py with two lines:
    from listings_api import register_listings_routes
    register_listings_routes(app)

PATCH /api/listings/<id>
    JSON body — all fields optional, only provided ones updated:
        listing_date     (str)  e.g. "15/04/2026" (DD/MM/YYYY) or null
        sold_date        (str)  e.g. "2025-08-08" (ISO) or null
        withdrawn_date   (str)  ISO datetime or null
        sold_price       (str|int)  free-form OK; coerced to int when possible

    Setting a field to null clears it (lets the scraper re-populate
    on next run if it discovers a value).

    Returns the updated row.
"""

import re
import logging
from datetime import datetime, date
from flask import request, jsonify

from database import get_db
from admin_api import resolve_request_scope

logger = logging.getLogger(__name__)


# Allow only these columns to be patched. `status` deliberately not in
# this list — a manual status flip would confuse the withdraw / re-list
# detector. If we ever need it, add a separate /listings/<id>/status
# endpoint with its own validation.
ALLOWED_FIELDS = {
    'listing_date', 'sold_date', 'withdrawn_date', 'sold_price',
    'price_text', 'agent', 'agency',
}


def _coerce_value(field, value):
    """Light validation — keep dates / prices in a consistent shape."""
    if value is None or value == '':
        return None  # explicit clear

    s = str(value).strip()
    if not s:
        return None

    if field == 'sold_date':
        # Accept ISO 'YYYY-MM-DD' or DD/MM/YYYY → store as ISO
        m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
            except ValueError:
                pass
        m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', s)
        if m:
            try:
                return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
            except ValueError:
                pass
        # Last resort: pass through; user might be entering something we
        # don't recognise but it's their data.
        return s

    if field == 'listing_date':
        # listing_date is stored as DD/MM/YYYY in the DB (REIWA's format).
        # Accept either format on input, normalise to DD/MM/YYYY.
        m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
        if m:
            try:
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                return d.strftime('%d/%m/%Y')
            except ValueError:
                pass
        m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', s)
        if m:
            return s  # already correct
        return s

    if field == 'withdrawn_date':
        # Stored as ISO datetime ('2026-04-24T05:30:00'). User probably
        # provides just a date — extend to noon UTC so the column type
        # stays consistent.
        m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
        if m:
            return f"{s}T12:00:00"
        m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', s)
        if m:
            try:
                d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
                return f"{d.isoformat()}T12:00:00"
            except ValueError:
                pass
        return s

    if field == 'sold_price':
        digits = re.sub(r'[^\d]', '', s)
        if digits:
            try:
                return str(int(digits))
            except ValueError:
                pass
        return s

    return s


def patch_listing(id):
    data = request.get_json(silent=True) or {}

    sets = []
    params = []
    for key in ALLOWED_FIELDS:
        if key in data:
            value = _coerce_value(key, data[key])
            sets.append(f"{key} = ?")
            params.append(value)

    if not sets:
        return jsonify({
            'error': 'No updatable fields provided. Allowed: '
                     + ', '.join(sorted(ALLOWED_FIELDS))
        }), 400

    params.append(id)

    conn = get_db()
    existing = conn.execute(
        "SELECT id, suburb_id FROM listings WHERE id = ?", (id,)
    ).fetchone()
    if not existing:
        conn.close()
        return jsonify({'error': 'Listing not found'}), 404
    _user, allowed_ids = resolve_request_scope()
    if allowed_ids is not None and existing['suburb_id'] not in allowed_ids:
        conn.close()
        return jsonify({'error': 'Not authorised for that listing'}), 403

    # last_seen always bumped so the listings UI sorts manually-edited
    # rows to the top of the recent-activity views.
    sets.append("last_seen = ?")
    params.insert(-1, datetime.utcnow().isoformat())

    sql = f"UPDATE listings SET {', '.join(sets)} WHERE id = ?"
    conn.execute(sql, params)
    conn.commit()

    row = conn.execute(
        "SELECT l.*, s.name as suburb_name FROM listings l "
        "JOIN suburbs s ON l.suburb_id = s.id WHERE l.id = ?",
        (id,)
    ).fetchone()
    conn.close()

    if not row:
        return jsonify({'error': 'Not found after update'}), 404

    return jsonify(dict(row))


def patch_listing_note():
    """UPSERT a free-text note on a listing, keyed on normalized_address
    so the note follows the property across re-listings / re-scrapes.

    Body: {address: str, note: str}    — empty / blank note clears the row."""
    from flask import request, jsonify
    from database import get_db, normalize_address, USE_POSTGRES

    body = request.get_json(silent=True) or {}
    addr = (body.get('address') or '').strip()
    note = (body.get('note') or '').strip()
    if not addr:
        return jsonify({'error': 'address required'}), 400

    norm = normalize_address(addr)
    if not norm:
        return jsonify({'error': 'address normalises to empty'}), 400

    conn = get_db()
    # Multi-tenant scope: the note table is keyed on normalized_address
    # alone, so without a check any user could overwrite a competitor
    # agency's notes. Require that at least one listings row matching
    # this normalized_address is in the caller's allowed suburbs.
    _user, allowed_ids = resolve_request_scope()
    if allowed_ids is not None:
        suburb_rows = conn.execute(
            "SELECT DISTINCT suburb_id FROM listings WHERE normalized_address = ?",
            (norm,)
        ).fetchall()
        owning_ids = {r['suburb_id'] for r in suburb_rows}
        if not owning_ids or not (owning_ids & set(allowed_ids)):
            conn.close()
            return jsonify({'error': 'Not authorised for that listing'}), 403
    try:
        if not note:
            conn.execute(
                "DELETE FROM listing_notes WHERE normalized_address = ?",
                (norm,)
            )
        else:
            if USE_POSTGRES:
                conn.execute(
                    "INSERT INTO listing_notes (normalized_address, note, updated_at) "
                    "VALUES (?, ?, CURRENT_TIMESTAMP) "
                    "ON CONFLICT (normalized_address) DO UPDATE SET "
                    "note = EXCLUDED.note, updated_at = CURRENT_TIMESTAMP",
                    (norm, note)
                )
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO listing_notes "
                    "(normalized_address, note, updated_at) VALUES (?, ?, datetime('now'))",
                    (norm, note)
                )
        conn.commit()
        return jsonify({'normalized_address': norm, 'note': note or None})
    finally:
        conn.close()


def register_listings_routes(app):
    app.add_url_rule(
        '/api/listings/<int:id>',
        endpoint='patch_listing',
        view_func=patch_listing,
        methods=['PATCH']
    )
    app.add_url_rule(
        '/api/listings/note',
        endpoint='patch_listing_note',
        view_func=patch_listing_note,
        methods=['PATCH']
    )
    logger.info("Listings routes registered: PATCH /api/listings/<id>, PATCH /api/listings/note")

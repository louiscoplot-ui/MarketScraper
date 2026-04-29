"""Appraisal Pipeline routes — 3 endpoints + helper functions.

Lives in its own module so app.py doesn't bloat further. Wire it into
app.py with two extra lines:

    from pipeline_api import register_pipeline_routes
    register_pipeline_routes(app)

Routes:
- GET  /api/pipeline/generate?suburb=X&days=N
    Reads recent sold listings, generates ±1/±2 neighbour addresses,
    inserts new pipeline_tracking rows. Returns counts + entries.
- GET  /api/pipeline/tracking?suburb=X&status=Y&limit=N
    Lists tracking rows newest first. All filters optional.
- PATCH /api/pipeline/tracking/<id>
    Updates status / response_date / notes / target_owner_name on
    one tracking row. Only provided fields are updated.

Owner-name + hot-vendor-score matching is intentionally a soft fail:
the codebase doesn't have a hot_vendors table yet (Hot Vendor scoring
is currently in-browser only via SheetJS). When matching, we look for
a `hot_vendors` table at runtime and skip silently if absent — the
columns stay NULL and the user fills target_owner_name manually
inline. As soon as Hot Vendor data lands in DB, this picks it up
without code changes.
"""

import re
import logging
from datetime import datetime, timedelta, date
from flask import request, jsonify

from database import get_db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

# Matches "12 Marine Parade", "12A The Avenue", but not strata "1/24 ..."
# Strata addresses skip neighbour generation — same building, not relevant.
_ADDR_RE = re.compile(r'^(\d+)([A-Za-z]?)\s+(.+)$')


def _parse_address(addr):
    """Return (street_number_int, suffix_letter, street_name) or None."""
    if not addr:
        return None
    addr = addr.strip()
    if '/' in addr.split()[0]:  # strata "1/24 Main Rd" — skip
        return None
    m = _ADDR_RE.match(addr)
    if not m:
        return None
    try:
        num = int(m.group(1))
    except ValueError:
        return None
    return num, m.group(2), m.group(3).strip()


def _generate_neighbours(addr):
    """Yield neighbour addresses at offsets -2, -1, +1, +2 on same street."""
    parsed = _parse_address(addr)
    if not parsed:
        return []
    num, _suffix, street = parsed
    out = []
    for offset in (-2, -1, 1, 2):
        target = num + offset
        if target <= 0:
            continue
        out.append(f"{target} {street}")
    return out


def _hot_vendors_table_exists(conn):
    """Best-effort presence check that works on both SQLite + Postgres."""
    try:
        # Cross-driver way: try a no-op SELECT and treat any error as 'not there'
        conn.execute("SELECT 1 FROM hot_vendors LIMIT 1").fetchone()
        return True
    except Exception:
        try:
            conn.commit()  # reset aborted txn on Postgres
        except Exception:
            pass
        return False


def _match_hot_vendor(conn, target_address):
    """Return (owner_name, score) for a target address, or (None, None).

    Tries case-insensitive LIKE on a future `hot_vendors` table if it
    exists. Silently returns (None, None) if the table or columns are
    missing — the user fills in owner_name manually in the UI.
    """
    if not _hot_vendors_table_exists(conn):
        return None, None
    try:
        row = conn.execute(
            "SELECT * FROM hot_vendors WHERE LOWER(address) LIKE LOWER(?) LIMIT 1",
            (f"%{target_address}%",)
        ).fetchone()
        if not row:
            return None, None
        d = dict(row)
        # Try a few likely column names so we don't have to guess at schema time.
        owner = d.get('owner_name') or d.get('owner') or d.get('current_owner')
        score = d.get('score') or d.get('final_score') or d.get('hot_score')
        return owner, score
    except Exception:
        try:
            conn.commit()
        except Exception:
            pass
        return None, None


def _row_to_dict(row):
    return dict(row) if row else None


def _serialize_entries(rows):
    out = []
    for r in rows:
        d = dict(r)
        # Coerce date / datetime objects to ISO strings for JSON safety.
        for k, v in list(d.items()):
            if isinstance(v, (date, datetime)):
                d[k] = v.isoformat()
        out.append(d)
    return out


# ---------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------

def pipeline_generate():
    """POST-equivalent GET — generates letters from recent sold properties."""
    suburb = (request.args.get('suburb') or '').strip()
    if not suburb:
        return jsonify({'error': 'suburb is required'}), 400

    try:
        days = int(request.args.get('days') or 7)
    except ValueError:
        days = 7
    days = max(1, min(days, 90))

    cutoff_iso = (datetime.utcnow() - timedelta(days=days)).isoformat()
    today_iso = date.today().isoformat()

    conn = get_db()

    # last_seen is updated whenever the scraper flips a status, so for
    # listings that recently transitioned to sold it's a reliable proxy
    # for "sold within last X days". sold_date column is rarely populated
    # by REIWA so we don't rely on it.
    sold_rows = conn.execute(
        """
        SELECT l.address, l.sold_price, l.price_text, l.sold_date,
               l.last_seen, s.name AS suburb_name
        FROM listings l
        JOIN suburbs s ON l.suburb_id = s.id
        WHERE l.status = 'sold'
          AND LOWER(s.name) = LOWER(?)
          AND l.last_seen >= ?
        ORDER BY l.last_seen DESC
        """,
        (suburb, cutoff_iso)
    ).fetchall()

    sold_count = len(sold_rows)
    generated = 0

    def _price_to_int(*candidates):
        for c in candidates:
            if c is None or c == '':
                continue
            s = str(c)
            digits = re.sub(r'[^\d]', '', s)
            if digits:
                try:
                    return int(digits)
                except ValueError:
                    pass
        return None

    for r in sold_rows:
        source_address = r['address']
        source_suburb = r['suburb_name']
        source_price = _price_to_int(r['sold_price'], r['price_text'])
        source_sold_date = r['sold_date'] or (
            r['last_seen'][:10] if r['last_seen'] else None
        )

        for target in _generate_neighbours(source_address):
            owner, score = _match_hot_vendor(conn, target)
            try:
                conn.execute(
                    """
                    INSERT INTO pipeline_tracking (
                        source_address, source_suburb, source_sold_date,
                        source_price, target_address, target_owner_name,
                        hot_vendor_score, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')
                    """,
                    (source_address, source_suburb, source_sold_date,
                     source_price, target, owner, score)
                )
                generated += 1
            except Exception:
                # UNIQUE(target_address, sent_date) hit — already generated
                # today, skip silently. Reset txn on Postgres.
                try:
                    conn.commit()
                except Exception:
                    pass

    conn.commit()

    rows = conn.execute(
        """
        SELECT * FROM pipeline_tracking
        WHERE LOWER(source_suburb) = LOWER(?)
        ORDER BY created_at DESC
        LIMIT 500
        """,
        (suburb,)
    ).fetchall()
    entries = _serialize_entries(rows)
    conn.close()

    return jsonify({
        'generated': generated,
        'sold_count': sold_count,
        'suburb': suburb,
        'entries': entries,
    })


def pipeline_tracking_list():
    """GET /api/pipeline/tracking?suburb=&status=&limit="""
    suburb = (request.args.get('suburb') or '').strip()
    status = (request.args.get('status') or '').strip()
    try:
        limit = int(request.args.get('limit') or 100)
    except ValueError:
        limit = 100
    limit = max(1, min(limit, 1000))

    conn = get_db()
    sql = "SELECT * FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND LOWER(source_suburb) = LOWER(?)"
        params.append(suburb)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return jsonify({'entries': _serialize_entries(rows)})


def pipeline_tracking_update(id):
    """PATCH /api/pipeline/tracking/<id>"""
    data = request.get_json(silent=True) or {}
    allowed = ('status', 'response_date', 'notes', 'target_owner_name')

    sets = []
    params = []
    for key in allowed:
        if key in data:
            sets.append(f"{key} = ?")
            params.append(data[key])

    if not sets:
        return jsonify({'error': 'No updatable fields provided'}), 400

    params.append(id)

    conn = get_db()
    conn.execute(
        f"UPDATE pipeline_tracking SET {', '.join(sets)} WHERE id = ?",
        params
    )
    conn.commit()

    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    conn.close()

    if not row:
        return jsonify({'error': 'Not found'}), 404

    return jsonify(_serialize_entries([row])[0])


# ---------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------

def register_pipeline_routes(app):
    """Attach the 3 pipeline endpoints to a Flask app instance."""
    app.add_url_rule(
        '/api/pipeline/generate',
        endpoint='pipeline_generate',
        view_func=pipeline_generate,
        methods=['GET']
    )
    app.add_url_rule(
        '/api/pipeline/tracking',
        endpoint='pipeline_tracking_list',
        view_func=pipeline_tracking_list,
        methods=['GET']
    )
    app.add_url_rule(
        '/api/pipeline/tracking/<int:id>',
        endpoint='pipeline_tracking_update',
        view_func=pipeline_tracking_update,
        methods=['PATCH']
    )
    logger.info("Pipeline routes registered: /api/pipeline/{generate,tracking,tracking/<id>}")

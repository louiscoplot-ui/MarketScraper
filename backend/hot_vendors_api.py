"""Hot Vendor uploads — persist RP Data scoring outputs in Postgres
so they're shared across devices (no more localStorage-only) and
joinable to pipeline_tracking for owner_name auto-match.

Frontend keeps its existing scoring logic and POSTs the already-scored
rows here. Backend does no scoring — it stores and indexes.

Endpoints:
    POST   /api/hot-vendors/uploads          create upload + insert rows
    GET    /api/hot-vendors/uploads          list all uploads (metadata)
    GET    /api/hot-vendors/uploads/<id>     upload + properties
    DELETE /api/hot-vendors/uploads/<id>     cascade delete
    GET    /api/hot-vendors/lookup           lookup by normalized address
"""

import logging
from flask import jsonify, request

from database import get_db, normalize_address, USE_POSTGRES

log = logging.getLogger(__name__)


_PROP_COLUMNS = [
    'address', 'suburb', 'type', 'bedrooms', 'bathrooms',
    'last_sale_price', 'owner_purchase_price', 'owner_purchase_date',
    'holding_years', 'sales_count', 'owner_gain_dollars', 'owner_gain_pct',
    'cagr', 'hold_score', 'type_score', 'gain_score', 'final_score',
    'category', 'current_owner', 'agency', 'agent',
]


def _safe_int(v):
    try:
        return int(v) if v not in (None, '', 'N/A') else None
    except (ValueError, TypeError):
        return None


def _safe_float(v):
    try:
        return float(v) if v not in (None, '', 'N/A') else None
    except (ValueError, TypeError):
        return None


def _coerce_property_row(p):
    """Best-effort type coercion. Frontend may send strings; DB wants ints/floats."""
    return {
        'address': (p.get('address') or '').strip(),
        'suburb': p.get('suburb'),
        'type': p.get('type'),
        'bedrooms': _safe_int(p.get('bedrooms')),
        'bathrooms': _safe_int(p.get('bathrooms')),
        'last_sale_price': _safe_int(p.get('last_sale_price')),
        'owner_purchase_price': _safe_int(p.get('owner_purchase_price')),
        'owner_purchase_date': p.get('owner_purchase_date'),
        'holding_years': _safe_float(p.get('holding_years')),
        'sales_count': _safe_int(p.get('sales_count')),
        'owner_gain_dollars': _safe_int(p.get('owner_gain_dollars')),
        'owner_gain_pct': _safe_float(p.get('owner_gain_pct')),
        'cagr': _safe_float(p.get('cagr')),
        'hold_score': _safe_int(p.get('hold_score')),
        'type_score': _safe_int(p.get('type_score')),
        'gain_score': _safe_int(p.get('gain_score')),
        'final_score': _safe_int(p.get('final_score')),
        'category': p.get('category'),
        'current_owner': p.get('current_owner'),
        'agency': p.get('agency'),
        'agent': p.get('agent'),
    }


def _create_upload_row(conn, meta):
    """INSERT into hot_vendor_uploads, return new id."""
    if USE_POSTGRES:
        cur = conn.execute(
            "INSERT INTO hot_vendor_uploads (agency, uploaded_by, suburb, filename, "
            "row_count, median_holding_years) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
            (meta.get('agency'), meta.get('uploaded_by'), meta.get('suburb'),
             meta.get('filename'), meta.get('row_count', 0),
             _safe_float(meta.get('median_holding_years')))
        )
        return cur.fetchone()['id']
    cur = conn.execute(
        "INSERT INTO hot_vendor_uploads (agency, uploaded_by, suburb, filename, "
        "row_count, median_holding_years) VALUES (?, ?, ?, ?, ?, ?)",
        (meta.get('agency'), meta.get('uploaded_by'), meta.get('suburb'),
         meta.get('filename'), meta.get('row_count', 0),
         _safe_float(meta.get('median_holding_years')))
    )
    return cur.lastrowid


def register_hot_vendors_routes(app):
    @app.route('/api/hot-vendors/uploads', methods=['POST'])
    def create_upload():
        body = request.get_json(silent=True) or {}
        properties = body.get('properties') or []
        if not isinstance(properties, list) or not properties:
            return jsonify({'error': 'properties array is required'}), 400

        rows = [_coerce_property_row(p) for p in properties if (p.get('address') or '').strip()]
        if not rows:
            return jsonify({'error': 'no valid rows after coercion'}), 400

        meta = {
            'agency': body.get('agency'),
            'uploaded_by': body.get('uploaded_by'),
            'suburb': body.get('suburb'),
            'filename': body.get('filename'),
            'row_count': len(rows),
            'median_holding_years': body.get('median_holding_years'),
        }

        conn = get_db()
        try:
            upload_id = _create_upload_row(conn, meta)
            insert_sql = (
                "INSERT INTO hot_vendor_properties (upload_id, address, normalized_address, "
                + ", ".join(_PROP_COLUMNS[1:])
                + ") VALUES ("
                + ", ".join(['?'] * (3 + len(_PROP_COLUMNS) - 1))
                + ")"
            )
            for r in rows:
                conn.execute(insert_sql, (
                    upload_id, r['address'], normalize_address(r['address']),
                    r['suburb'], r['type'], r['bedrooms'], r['bathrooms'],
                    r['last_sale_price'], r['owner_purchase_price'],
                    r['owner_purchase_date'], r['holding_years'],
                    r['sales_count'], r['owner_gain_dollars'], r['owner_gain_pct'],
                    r['cagr'], r['hold_score'], r['type_score'], r['gain_score'],
                    r['final_score'], r['category'], r['current_owner'],
                    r['agency'], r['agent'],
                ))
            conn.commit()
        finally:
            conn.close()

        return jsonify({'upload_id': upload_id, 'count': len(rows)}), 201

    @app.route('/api/hot-vendors/uploads', methods=['GET'])
    def list_uploads():
        conn = get_db()
        rows = conn.execute(
            "SELECT id, agency, uploaded_by, suburb, filename, row_count, "
            "median_holding_years, uploaded_at "
            "FROM hot_vendor_uploads ORDER BY uploaded_at DESC"
        ).fetchall()
        conn.close()
        return jsonify({'uploads': [dict(r) for r in rows]})

    @app.route('/api/hot-vendors/uploads/<int:upload_id>', methods=['GET'])
    def get_upload(upload_id):
        conn = get_db()
        upload = conn.execute(
            "SELECT * FROM hot_vendor_uploads WHERE id = ?", (upload_id,)
        ).fetchone()
        if not upload:
            conn.close()
            return jsonify({'error': 'upload not found'}), 404
        props = conn.execute(
            "SELECT * FROM hot_vendor_properties WHERE upload_id = ? "
            "ORDER BY final_score DESC NULLS LAST, address ASC"
            if USE_POSTGRES else
            "SELECT * FROM hot_vendor_properties WHERE upload_id = ? "
            "ORDER BY final_score DESC, address ASC",
            (upload_id,)
        ).fetchall()
        conn.close()
        return jsonify({
            'upload': dict(upload),
            'properties': [dict(p) for p in props],
        })

    @app.route('/api/hot-vendors/uploads/<int:upload_id>', methods=['DELETE'])
    def delete_upload(upload_id):
        conn = get_db()
        # FK ON DELETE CASCADE removes properties automatically
        conn.execute("DELETE FROM hot_vendor_uploads WHERE id = ?", (upload_id,))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})

    @app.route('/api/hot-vendors/lookup', methods=['GET'])
    def lookup_by_address():
        """Return the highest-scored hot_vendor_property matching the given
        address (normalized). Used by pipeline_api to auto-fill owner_name +
        score on letter generation."""
        addr = (request.args.get('address') or '').strip()
        if not addr:
            return jsonify({'error': 'address query param required'}), 400
        norm = normalize_address(addr)
        conn = get_db()
        row = conn.execute(
            "SELECT current_owner, final_score, category, holding_years, "
            "owner_purchase_date, owner_purchase_price, last_sale_price "
            "FROM hot_vendor_properties WHERE normalized_address = ? "
            "ORDER BY final_score DESC LIMIT 1",
            (norm,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'match': None})
        return jsonify({'match': dict(row)})

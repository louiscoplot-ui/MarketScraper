"""Hot Vendor uploads + scoring API.

  POST   /api/hot-vendors/score-csv         upload CSV → v4 pipeline → persist
  GET    /api/hot-vendors/uploads/<id>/excel rebuild .xlsx report from DB
  POST   /api/hot-vendors/uploads           legacy: insert pre-scored rows
  GET    /api/hot-vendors/uploads           list all uploads
  GET    /api/hot-vendors/uploads/<id>      one upload + its properties
  DELETE /api/hot-vendors/uploads/<id>      cascade delete
  GET    /api/hot-vendors/lookup            normalized-address lookup for pipeline auto-match
"""

import json
import logging
from flask import jsonify, request, send_file

from database import get_db, normalize_address, USE_POSTGRES

logger = logging.getLogger(__name__)


_PROP_COLUMNS = [
    'address', 'suburb', 'type', 'bedrooms', 'bathrooms',
    'last_sale_price', 'owner_purchase_price', 'owner_purchase_date',
    'holding_years', 'sales_count', 'owner_gain_dollars', 'owner_gain_pct',
    'cagr', 'hold_score', 'type_score', 'gain_score', 'cagr_score',
    'freq_score', 'prof_score', 'final_score', 'category',
    'estimated_value', 'potential_profit', 'potential_profit_pct', 'rank',
    'current_owner', 'agency', 'agent',
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
        'cagr_score': _safe_int(p.get('cagr_score')),
        'freq_score': _safe_int(p.get('freq_score')),
        'prof_score': _safe_int(p.get('prof_score')),
        'final_score': _safe_float(p.get('final_score')),
        'category': p.get('category'),
        'estimated_value': _safe_int(p.get('estimated_value')),
        'potential_profit': _safe_int(p.get('potential_profit')),
        'potential_profit_pct': _safe_float(p.get('potential_profit_pct')),
        'rank': _safe_int(p.get('rank')),
        'current_owner': p.get('current_owner'),
        'agency': p.get('agency'),
        'agent': p.get('agent'),
    }


def _create_upload_row(conn, meta):
    if USE_POSTGRES:
        cur = conn.execute(
            "INSERT INTO hot_vendor_uploads (agency, uploaded_by, suburb, filename, "
            "row_count, median_holding_years, metadata) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (meta.get('agency'), meta.get('uploaded_by'), meta.get('suburb'),
             meta.get('filename'), meta.get('row_count', 0),
             _safe_float(meta.get('median_holding_years')),
             meta.get('metadata'))
        )
        return cur.fetchone()['id']
    cur = conn.execute(
        "INSERT INTO hot_vendor_uploads (agency, uploaded_by, suburb, filename, "
        "row_count, median_holding_years, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (meta.get('agency'), meta.get('uploaded_by'), meta.get('suburb'),
         meta.get('filename'), meta.get('row_count', 0),
         _safe_float(meta.get('median_holding_years')),
         meta.get('metadata'))
    )
    return cur.lastrowid


_INSERT_COLS = ['upload_id', 'address', 'normalized_address'] + _PROP_COLUMNS[1:]
_INSERT_SQL = (
    f"INSERT INTO hot_vendor_properties ({', '.join(_INSERT_COLS)}) "
    f"VALUES ({', '.join(['?'] * len(_INSERT_COLS))})"
)


def _insert_property_rows(conn, upload_id, rows):
    for r in rows:
        params = [upload_id, r['address'], normalize_address(r['address'])]
        for col in _PROP_COLUMNS[1:]:
            params.append(r.get(col))
        conn.execute(_INSERT_SQL, params)


def register_hot_vendors_routes(app):

    # ------------------------------------------------------------------
    # NEW: backend pipeline — upload raw CSV, get scored result back
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/score-csv', methods=['POST'])
    def score_csv_upload():
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded — use multipart "file" field'}), 400
        file = request.files['file']
        if not file or file.filename == '':
            return jsonify({'error': 'Empty file'}), 400

        suburb_override = (request.form.get('suburb') or '').strip() or None
        agency = (request.form.get('agency') or '').strip() or None
        uploaded_by = (request.form.get('uploaded_by') or '').strip() or None

        # Wrap import + pipeline in a single try so ANY failure (missing dep,
        # syntax error, runtime exception) returns JSON instead of an HTML
        # 500 page that the frontend can't parse.
        try:
            from hot_vendor_scoring import score_csv as run_pipeline
            file_bytes = file.read()
            result = run_pipeline(file_bytes, suburb=suburb_override)
        except ImportError as e:
            logger.exception("Hot vendor scoring module failed to import")
            return jsonify({
                'error': f'Backend dependency missing: {e}. '
                         f'Add to requirements.txt and redeploy.'
            }), 500
        except Exception as e:
            logger.exception("Hot vendor scoring failed")
            return jsonify({'error': f'Scoring failed: {e}'}), 500

        # Persist
        rows = [_coerce_property_row(p) for p in result['properties']]
        metadata = {
            'profile': result['profile'],
            'weights': result['weights'],
            'rationale': result['rationale'],
            'thresholds': result['thresholds'],
            'q_hot': result['q_hot'],
            'q_warm': result['q_warm'],
            'q_medium': result['q_medium'],
            'median_m2_house': result['median_m2_house'],
            'median_m2_apt': result['median_m2_apt'],
            'today': result['today'],
            'raw_count': result['raw_count'],
            'kept_count': result['kept_count'],
            'excluded_count': result['excluded_count'],
            'excluded': result['excluded'],
        }
        meta = {
            'agency': agency,
            'uploaded_by': uploaded_by,
            'suburb': result['suburb'],
            'filename': file.filename,
            'row_count': len(rows),
            'median_holding_years': result['profile'].get('median_hold'),
            'metadata': json.dumps(metadata),
        }

        conn = get_db()
        try:
            upload_id = _create_upload_row(conn, meta)
            _insert_property_rows(conn, upload_id, rows)
            conn.commit()
        finally:
            conn.close()

        return jsonify({'upload_id': upload_id, **result}), 201


    # ------------------------------------------------------------------
    # NEW: download Excel report for an upload
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/uploads/<int:upload_id>/excel', methods=['GET'])
    def download_excel(upload_id):
        try:
            from hot_vendor_excel import build_workbook, workbook_filename
        except ImportError as e:
            logger.exception("hot_vendor_excel failed to import")
            return jsonify({
                'error': f'Excel generator unavailable: {e}'
            }), 500

        conn = get_db()
        upload = conn.execute(
            "SELECT * FROM hot_vendor_uploads WHERE id = ?", (upload_id,)
        ).fetchone()
        if not upload:
            conn.close()
            return jsonify({'error': 'Upload not found'}), 404

        order_clause = ("ORDER BY final_score DESC NULLS LAST, address ASC"
                        if USE_POSTGRES else "ORDER BY final_score DESC, address ASC")
        props_rows = conn.execute(
            f"SELECT * FROM hot_vendor_properties WHERE upload_id = ? {order_clause}",
            (upload_id,)
        ).fetchall()
        conn.close()

        upload_d = dict(upload)
        meta_raw = upload_d.get('metadata')
        try:
            meta = json.loads(meta_raw) if meta_raw else {}
        except (TypeError, ValueError):
            meta = {}

        # Reconstruct the result dict shape that build_workbook expects
        properties = []
        for i, p in enumerate(props_rows, 1):
            d = dict(p)
            properties.append({
                'rank': d.get('rank') or i,
                'address': d.get('address'),
                'type': d.get('type'),
                'bedrooms': d.get('bedrooms'),
                'bathrooms': d.get('bathrooms'),
                'last_sale_price': d.get('last_sale_price'),
                'owner_purchase_price': d.get('owner_purchase_price'),
                'owner_purchase_date': d.get('owner_purchase_date'),
                'holding_years': d.get('holding_years'),
                'sales_count': d.get('sales_count'),
                'owner_gain_pct': d.get('owner_gain_pct'),
                'cagr': d.get('cagr'),
                'estimated_value': d.get('estimated_value'),
                'potential_profit': d.get('potential_profit'),
                'potential_profit_pct': d.get('potential_profit_pct'),
                'hold_score': d.get('hold_score'),
                'type_score': d.get('type_score'),
                'gain_score': d.get('gain_score'),
                'cagr_score': d.get('cagr_score'),
                'freq_score': d.get('freq_score'),
                'prof_score': d.get('prof_score'),
                'final_score': d.get('final_score'),
                'category': d.get('category'),
                'current_owner': d.get('current_owner'),
                'agency': d.get('agency'),
                'agent': d.get('agent'),
                'suburb': d.get('suburb'),
            })

        result = {
            'suburb': upload_d.get('suburb') or 'UNKNOWN',
            'today': meta.get('today', ''),
            'raw_count': meta.get('raw_count', len(properties)),
            'kept_count': meta.get('kept_count', len(properties)),
            'excluded_count': meta.get('excluded_count', 0),
            'profile': meta.get('profile', {
                'median_hold': upload_d.get('median_holding_years') or 0,
                'pct_long_hold': 0, 'pct_high_gain': 0, 'pct_1sale': 0,
                'med_price': 0, 'median_gain_pct': 0,
                'is_premium': False, 'is_mature': False, 'is_high_gain': False,
            }),
            'weights': meta.get('weights', {
                'hold': 0.50, 'type': 0.15, 'gain': 0.20,
                'cagr': 0.10, 'freq': 0.05, 'profit': 0.05,
            }),
            'rationale': meta.get('rationale', []),
            'q_hot': meta.get('q_hot', 80),
            'q_warm': meta.get('q_warm', 60),
            'q_medium': meta.get('q_medium', 40),
            'median_m2_house': meta.get('median_m2_house', 0),
            'median_m2_apt': meta.get('median_m2_apt', 0),
            'properties': properties,
        }

        try:
            buf = build_workbook(result)
        except Exception as e:
            logger.exception("Excel build failed")
            return jsonify({'error': f'Excel build failed: {e}'}), 500

        return send_file(
            buf,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=workbook_filename(result['suburb']),
        )


    # ------------------------------------------------------------------
    # LEGACY: pre-scored upload (kept for backward compat, optional)
    # ------------------------------------------------------------------
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
            'metadata': None,
        }

        conn = get_db()
        try:
            upload_id = _create_upload_row(conn, meta)
            _insert_property_rows(conn, upload_id, rows)
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
        order = "ORDER BY final_score DESC NULLS LAST, address ASC" if USE_POSTGRES \
                else "ORDER BY final_score DESC, address ASC"
        props = conn.execute(
            f"SELECT * FROM hot_vendor_properties WHERE upload_id = ? {order}",
            (upload_id,)
        ).fetchall()
        conn.close()
        u = dict(upload)
        try:
            u['metadata'] = json.loads(u['metadata']) if u.get('metadata') else None
        except (TypeError, ValueError):
            u['metadata'] = None
        return jsonify({'upload': u, 'properties': [dict(p) for p in props]})


    @app.route('/api/hot-vendors/uploads/<int:upload_id>', methods=['DELETE'])
    def delete_upload(upload_id):
        conn = get_db()
        conn.execute("DELETE FROM hot_vendor_uploads WHERE id = ?", (upload_id,))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})


    @app.route('/api/hot-vendors/lookup', methods=['GET'])
    def lookup_by_address():
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

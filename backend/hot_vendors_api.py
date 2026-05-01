"""Hot Vendor uploads + scoring API.

  POST   /api/hot-vendors/score-csv         upload CSV → v4 pipeline → persist (UPSERT)
  PATCH  /api/hot-vendors/status            set user-flag for an address (green/yellow/red)
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


# Columns in hot_vendor_properties that we actually score / persist.
# Order matters: this drives the INSERT VALUES tuple.
_PROP_COLUMNS = [
    'address', 'suburb', 'type', 'bedrooms', 'bathrooms',
    'last_sale_price', 'owner_purchase_price', 'owner_purchase_date',
    'holding_years', 'sales_count', 'owner_gain_dollars', 'owner_gain_pct',
    'cagr', 'hold_score', 'type_score', 'gain_score', 'cagr_score',
    'freq_score', 'prof_score', 'final_score', 'category',
    'estimated_value', 'potential_profit', 'potential_profit_pct', 'rank',
    'current_owner', 'agency', 'agent',
]

# Status values shown in the UI dropdown.
_VALID_STATUSES = {'listed', 'pending', 'declined', '', None}


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


def _clean_address(raw):
    """Strip CSV scrape artefacts. Currently handles the duplicate-
    number prefix ("18 18 Timmi Lane" → "18 Timmi Lane") that some
    RP Data exports produce when the source field is concatenated
    twice. Idempotent on clean addresses."""
    if not raw:
        return ''
    s = str(raw).strip()
    parts = s.split()
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit() and parts[0] == parts[1]:
        s = ' '.join([parts[0]] + parts[2:])
    return s


def _coerce_property_row(p):
    return {
        'address': _clean_address(p.get('address')),
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


# Bulk UPSERT the scored properties.
#
# Two changes vs. the previous plain-INSERT version:
#   1. Speed — execute_values batches 500 rows per round-trip (vs.
#      3,012 individual INSERTs that took >2 min and tripped the
#      gunicorn 120s timeout).
#   2. Re-upload safety — ON CONFLICT (normalized_address) DO UPDATE
#      so re-uploading the same suburb 6/12 months later REFRESHES
#      the existing rows (sale_date, owner, agency, agent, scores)
#      rather than creating duplicates. The user-status table
#      (hot_vendor_property_status) is keyed on the same address and
#      is untouched by this UPSERT, so colour flags survive.
def _insert_property_rows(conn, upload_id, rows):
    if not rows:
        return

    cols = ['upload_id', 'address', 'normalized_address'] + _PROP_COLUMNS[1:]
    # Mutable columns refreshed on conflict — everything except the address
    # identity columns (address text + normalized_address key).
    update_cols = ['upload_id'] + _PROP_COLUMNS[1:]

    def row_values(r):
        return tuple(
            [upload_id, r['address'], normalize_address(r['address'])] +
            [r.get(c) for c in _PROP_COLUMNS[1:]]
        )

    if USE_POSTGRES:
        from psycopg2.extras import execute_values
        set_clause = ', '.join(f"{c} = EXCLUDED.{c}" for c in update_cols)
        sql = (
            f"INSERT INTO hot_vendor_properties ({', '.join(cols)}) "
            f"VALUES %s "
            f"ON CONFLICT (normalized_address) DO UPDATE SET "
            f"{set_clause}, last_updated_at = CURRENT_TIMESTAMP"
        )
        cur = conn._conn.cursor()
        try:
            execute_values(cur, sql, [row_values(r) for r in rows], page_size=500)
        finally:
            cur.close()
    else:
        # SQLite 3.24+ supports the same ON CONFLICT … DO UPDATE syntax.
        set_clause = ', '.join(f"{c} = excluded.{c}" for c in update_cols)
        sql = (
            f"INSERT INTO hot_vendor_properties ({', '.join(cols)}) "
            f"VALUES ({', '.join(['?'] * len(cols))}) "
            f"ON CONFLICT(normalized_address) DO UPDATE SET "
            f"{set_clause}, last_updated_at = datetime('now')"
        )
        conn._conn.executemany(sql, [list(row_values(r)) for r in rows])


def _fetch_status_map(conn, normalized_addresses):
    """Return {normalized_address: status} for the given addresses."""
    if not normalized_addresses:
        return {}
    addrs = [a for a in normalized_addresses if a]
    if not addrs:
        return {}
    placeholders = ','.join(['?'] * len(addrs))
    rows = conn.execute(
        f"SELECT normalized_address, status FROM hot_vendor_property_status "
        f"WHERE normalized_address IN ({placeholders})",
        addrs
    ).fetchall()
    return {r['normalized_address']: r['status'] for r in rows if r['status']}


def _attach_user_status(conn, properties):
    """Mutate `properties` to include a `user_status` field per row."""
    addrs = [normalize_address(p.get('address') or '') for p in properties]
    status_map = _fetch_status_map(conn, addrs)
    for p, na in zip(properties, addrs):
        p['user_status'] = status_map.get(na) or ''


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

        try:
            from hot_vendor_scoring import score_csv as run_pipeline
            file_bytes = file.read()
            result = run_pipeline(file_bytes, suburb=suburb_override)
        except ImportError as e:
            logger.exception("Hot vendor scoring module failed to import")
            return jsonify({'error': f'Backend dep missing: {e}'}), 500
        except Exception as e:
            logger.exception("Hot vendor scoring failed")
            return jsonify({'error': f'Scoring failed: {e}'}), 500

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
            _attach_user_status(conn, result['properties'])
        except Exception as e:
            logger.exception("Persist failed after scoring")
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({
                'upload_id': None,
                'persist_error': f'DB persist failed: {e}',
                **result,
            }), 200
        finally:
            try:
                conn.close()
            except Exception:
                pass

        return jsonify({'upload_id': upload_id, **result}), 201


    # ------------------------------------------------------------------
    # NEW: PATCH user-status for an address (UI dropdown writes here)
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/status', methods=['PATCH'])
    def patch_status():
        body = request.get_json(silent=True) or {}
        addr = (body.get('address') or '').strip()
        status = (body.get('status') or '').strip().lower() or None
        note = (body.get('note') or '').strip() or None

        if not addr:
            return jsonify({'error': 'address required'}), 400
        if status not in _VALID_STATUSES:
            return jsonify({
                'error': f'invalid status — use one of: listed, pending, declined, or empty',
            }), 400

        norm = normalize_address(addr)
        if not norm:
            return jsonify({'error': 'address normalises to empty'}), 400

        conn = get_db()
        try:
            if status is None:
                conn.execute(
                    "DELETE FROM hot_vendor_property_status WHERE normalized_address = ?",
                    (norm,)
                )
            else:
                if USE_POSTGRES:
                    conn.execute(
                        "INSERT INTO hot_vendor_property_status "
                        "(normalized_address, status, note, updated_at) "
                        "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
                        "ON CONFLICT (normalized_address) DO UPDATE SET "
                        "status = EXCLUDED.status, note = EXCLUDED.note, "
                        "updated_at = CURRENT_TIMESTAMP",
                        (norm, status, note)
                    )
                else:
                    conn.execute(
                        "INSERT INTO hot_vendor_property_status "
                        "(normalized_address, status, note, updated_at) "
                        "VALUES (?, ?, ?, datetime('now')) "
                        "ON CONFLICT(normalized_address) DO UPDATE SET "
                        "status = excluded.status, note = excluded.note, "
                        "updated_at = datetime('now')",
                        (norm, status, note)
                    )
            conn.commit()
        finally:
            conn.close()

        return jsonify({
            'address': addr,
            'normalized_address': norm,
            'status': status or '',
            'note': note or '',
        })


    # ------------------------------------------------------------------
    # GET all per-address statuses (for hydrating the UI on a fresh load)
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/statuses', methods=['GET'])
    def list_statuses():
        conn = get_db()
        rows = conn.execute(
            "SELECT normalized_address, status, note, updated_at "
            "FROM hot_vendor_property_status WHERE status IS NOT NULL"
        ).fetchall()
        conn.close()
        return jsonify({'statuses': [dict(r) for r in rows]})


    # ------------------------------------------------------------------
    # Excel report rebuild
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/uploads/<int:upload_id>/excel', methods=['GET'])
    def download_excel(upload_id):
        try:
            from hot_vendor_excel import build_workbook, workbook_filename
        except ImportError as e:
            logger.exception("hot_vendor_excel failed to import")
            return jsonify({'error': f'Excel generator unavailable: {e}'}), 500

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

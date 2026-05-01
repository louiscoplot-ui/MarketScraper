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
import threading
import time
import uuid
from flask import jsonify, request, send_file

from database import get_db, normalize_address, USE_POSTGRES

logger = logging.getLogger(__name__)


# In-memory job registry for async CSV scoring. Free-tier Render only
# gives gunicorn 120s of wall time per request; large suburbs (Ellenbrook,
# Mandurah) blow through that. The async route reads the file bytes,
# returns a job_id immediately, and a background thread does the heavy
# lifting. Worker restart drops in-flight jobs — fine for beta, the
# user retries.
_hv_jobs = {}
_hv_jobs_lock = threading.Lock()
_HV_JOB_TTL_SECONDS = 3600  # 1h

# Same pattern for Excel report generation — `build_workbook` on a 9k-
# property upload can take 1-3 min on free-tier Render and blow the
# gateway timeout. We build in a thread, return 202 + job_id, and let
# the frontend poll then download from the worker once it's ready.
_hv_excel_jobs = {}
_hv_excel_jobs_lock = threading.Lock()
_HV_EXCEL_TTL_SECONDS = 600  # 10 min — file bytes evicted after that


def _hv_excel_set(job_id, **fields):
    with _hv_excel_jobs_lock:
        cur = _hv_excel_jobs.get(job_id) or {}
        cur.update(fields)
        cur['updated_at'] = time.time()
        _hv_excel_jobs[job_id] = cur


def _hv_excel_get(job_id):
    with _hv_excel_jobs_lock:
        return dict(_hv_excel_jobs.get(job_id) or {})


def _hv_excel_purge_expired():
    cutoff = time.time() - _HV_EXCEL_TTL_SECONDS
    with _hv_excel_jobs_lock:
        for k in [k for k, v in _hv_excel_jobs.items() if v.get('updated_at', 0) < cutoff]:
            _hv_excel_jobs.pop(k, None)


def _hv_job_set(job_id, **fields):
    with _hv_jobs_lock:
        cur = _hv_jobs.get(job_id) or {}
        cur.update(fields)
        cur['updated_at'] = time.time()
        _hv_jobs[job_id] = cur


def _hv_job_get(job_id):
    with _hv_jobs_lock:
        return dict(_hv_jobs.get(job_id) or {})


def _hv_jobs_purge_expired():
    cutoff = time.time() - _HV_JOB_TTL_SECONDS
    with _hv_jobs_lock:
        for k in [k for k, v in _hv_jobs.items() if v.get('updated_at', 0) < cutoff]:
            _hv_jobs.pop(k, None)


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
        # Coerce empty-string normalized_address to NULL so multiple
        # bad-address rows don't trip the (now non-partial) unique index.
        norm = normalize_address(r['address']) or None
        return tuple(
            [upload_id, r['address'], norm] +
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


def _build_upload_payload(conn, upload_id):
    """Score-csv-shaped JSON for a saved upload. Used by the Excel
    rebuild AND the UI hydration on mount, so the table sticks even
    when the user closes the browser. Returns None on missing id."""
    upload = conn.execute(
        "SELECT * FROM hot_vendor_uploads WHERE id = ?", (upload_id,)
    ).fetchone()
    if not upload:
        return None

    order_clause = ("ORDER BY final_score DESC NULLS LAST, address ASC"
                    if USE_POSTGRES else "ORDER BY final_score DESC, address ASC")
    props_rows = conn.execute(
        f"SELECT * FROM hot_vendor_properties WHERE upload_id = ? {order_clause}",
        (upload_id,)
    ).fetchall()

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

    _attach_user_status(conn, properties)

    return {
        'upload_id': upload_id,
        'id': upload_id,
        'suburb': upload_d.get('suburb') or 'UNKNOWN',
        'uploaded_at': str(upload_d.get('uploaded_at') or ''),
        'filename': upload_d.get('filename') or '',
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


def register_hot_vendors_routes(app):

    # ------------------------------------------------------------------
    # NEW: backend pipeline — upload raw CSV, get scored result back
    # ------------------------------------------------------------------
    def _score_csv_worker(job_id, file_bytes, filename, suburb_override, agency, uploaded_by):
        """Background worker — heavy lifting for big suburbs (Ellenbrook).
        Updates job state at each stage so the frontend can show progress."""
        t0 = time.time()
        try:
            size_mb = len(file_bytes) / (1024 * 1024)
            logger.info(f"[score-csv {job_id}] start — {filename} {size_mb:.2f} MB")
            _hv_job_set(job_id, status='running', stage=f'Parsing CSV ({size_mb:.1f} MB)…')
            from hot_vendor_scoring import score_csv as run_pipeline
            t_score_start = time.time()
            result = run_pipeline(file_bytes, suburb=suburb_override)
            logger.info(f"[score-csv {job_id}] scoring took "
                        f"{time.time() - t_score_start:.1f}s "
                        f"({len(result.get('properties') or [])} rows)")

            _hv_job_set(job_id, stage=f"Coercing {len(result['properties'])} rows…")
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
                'filename': filename,
                'row_count': len(rows),
                'median_holding_years': result['profile'].get('median_hold'),
                'metadata': json.dumps(metadata),
            }

            _hv_job_set(job_id, stage=f'Saving {len(rows)} rows to database…')
            t_db_start = time.time()
            conn = get_db()
            try:
                upload_id = _create_upload_row(conn, meta)
                _insert_property_rows(conn, upload_id, rows)
                conn.commit()
                _attach_user_status(conn, result['properties'])
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            logger.info(f"[score-csv {job_id}] DB persist took {time.time() - t_db_start:.1f}s")

            total = time.time() - t0
            logger.info(f"[score-csv {job_id}] DONE in {total:.1f}s — upload_id={upload_id}")
            _hv_job_set(
                job_id,
                status='done',
                stage='Done',
                result={'upload_id': upload_id, 'id': upload_id, **result},
            )
        except Exception as e:
            logger.exception(f"[score-csv job {job_id}] failed after {time.time() - t0:.1f}s")
            _hv_job_set(job_id, status='error', error=f'{type(e).__name__}: {e}')


    @app.route('/api/hot-vendors/score-csv', methods=['POST'])
    def score_csv_upload():
        """Async upload — returns 202 + job_id immediately. Frontend polls
        /api/hot-vendors/score-csv/job/<id> until status=done|error."""
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded — use multipart "file" field'}), 400
        file = request.files['file']
        if not file or file.filename == '':
            return jsonify({'error': 'Empty file'}), 400

        # Read into memory now — request scope ends as soon as we return,
        # so the file stream is gone by the time the worker thread runs.
        file_bytes = file.read()
        filename = file.filename
        suburb_override = (request.form.get('suburb') or '').strip() or None
        agency = (request.form.get('agency') or '').strip() or None
        uploaded_by = (request.form.get('uploaded_by') or '').strip() or None

        _hv_jobs_purge_expired()
        job_id = uuid.uuid4().hex[:12]
        _hv_job_set(job_id, status='running', stage='Queued', filename=filename)
        threading.Thread(
            target=_score_csv_worker,
            args=(job_id, file_bytes, filename, suburb_override, agency, uploaded_by),
            daemon=True,
        ).start()
        logger.info(f"[score-csv] queued job {job_id} for {filename}")
        return jsonify({'job_id': job_id, 'status': 'running'}), 202


    @app.route('/api/hot-vendors/score-csv/job/<job_id>', methods=['GET'])
    def score_csv_job_status(job_id):
        job = _hv_job_get(job_id)
        if not job:
            return jsonify({
                'error': 'Job not found — server may have restarted. Re-upload the CSV.',
                'status': 'lost',
            }), 404
        # Echo a slim view; the result blob is only included on success.
        out = {
            'status': job.get('status'),
            'stage': job.get('stage'),
            'filename': job.get('filename'),
        }
        if job.get('status') == 'done' and job.get('result'):
            out['result'] = job['result']
        if job.get('status') == 'error':
            out['error'] = job.get('error')
        return jsonify(out)


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
    # GET list of past uploads (one row per suburb, latest first).
    # Used by HotVendorScoring on mount so previously-uploaded reports
    # rehydrate without forcing the user to re-upload the CSV.
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/uploads', methods=['GET'])
    def list_uploads():
        conn = get_db()
        if USE_POSTGRES:
            rows = conn.execute("""
                SELECT DISTINCT ON (suburb)
                    id, suburb, filename, row_count, uploaded_at,
                    agency, uploaded_by
                FROM hot_vendor_uploads
                WHERE suburb IS NOT NULL AND suburb <> ''
                ORDER BY suburb, uploaded_at DESC
            """).fetchall()
        else:
            rows = conn.execute("""
                SELECT u.id, u.suburb, u.filename, u.row_count,
                       u.uploaded_at, u.agency, u.uploaded_by
                FROM hot_vendor_uploads u
                INNER JOIN (
                    SELECT suburb, MAX(uploaded_at) AS max_at
                    FROM hot_vendor_uploads
                    WHERE suburb IS NOT NULL AND suburb <> ''
                    GROUP BY suburb
                ) m ON u.suburb = m.suburb AND u.uploaded_at = m.max_at
                ORDER BY u.uploaded_at DESC
            """).fetchall()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            out.append({
                'id': d.get('id'),
                'suburb': d.get('suburb'),
                'filename': d.get('filename'),
                'row_count': d.get('row_count'),
                'uploaded_at': str(d.get('uploaded_at') or ''),
                'agency': d.get('agency'),
                'uploaded_by': d.get('uploaded_by'),
            })
        return jsonify({'uploads': out})


    # ------------------------------------------------------------------
    # GET a single upload's full scored payload (same shape as score-csv
    # response, minus the persist_error key). Frontend uses this to
    # restore an existing upload without re-running the pipeline.
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/uploads/<int:upload_id>', methods=['GET'])
    def get_upload(upload_id):
        conn = get_db()
        try:
            payload = _build_upload_payload(conn, upload_id)
        finally:
            conn.close()
        if not payload:
            return jsonify({'error': 'Upload not found'}), 404
        return jsonify(payload)


    # ------------------------------------------------------------------
    # Async Excel build — POST starts a job, GET status, GET file once done.
    # Synchronous /excel route below kept as a fallback for tiny suburbs.
    # ------------------------------------------------------------------
    def _excel_worker(job_id, upload_id):
        try:
            _hv_excel_set(job_id, status='running', stage='Loading data…')
            from hot_vendor_excel import build_workbook, workbook_filename
            conn = get_db()
            try:
                result = _build_upload_payload(conn, upload_id)
            finally:
                try: conn.close()
                except Exception: pass
            if not result:
                _hv_excel_set(job_id, status='error', error='Upload not found')
                return
            suburb = result.get('suburb', 'report')
            n_props = len(result.get('properties') or [])
            _hv_excel_set(job_id, stage=f'Building workbook ({n_props} rows)…')
            logger.info(f"[Excel job {job_id}] building for {suburb} ({n_props} rows)")
            t = time.time()
            buf = build_workbook(result)
            buf.seek(0)
            file_bytes = buf.read()
            try:
                fname = workbook_filename(suburb)
            except Exception:
                fname = f"hot-vendors-{suburb}.xlsx"
            logger.info(
                f"[Excel job {job_id}] DONE in {time.time() - t:.1f}s "
                f"({len(file_bytes)} bytes) — {fname}"
            )
            _hv_excel_set(
                job_id, status='done', stage='Done',
                file_bytes=file_bytes, filename=fname,
            )
        except Exception as e:
            logger.exception(f"[Excel job {job_id}] failed")
            _hv_excel_set(job_id, status='error', error=f'{type(e).__name__}: {e}')


    @app.route('/api/hot-vendors/uploads/<int:upload_id>/excel-job', methods=['POST'])
    def excel_job_start(upload_id):
        _hv_excel_purge_expired()
        job_id = uuid.uuid4().hex[:12]
        _hv_excel_set(job_id, status='running', stage='Queued', upload_id=upload_id)
        threading.Thread(
            target=_excel_worker, args=(job_id, upload_id), daemon=True,
        ).start()
        logger.info(f"[Excel] queued job {job_id} for upload_id={upload_id}")
        return jsonify({'job_id': job_id, 'status': 'running'}), 202


    @app.route('/api/hot-vendors/excel-job/<job_id>', methods=['GET'])
    def excel_job_status(job_id):
        job = _hv_excel_get(job_id)
        if not job:
            return jsonify({
                'status': 'lost',
                'error': 'Job not found — server may have restarted',
            }), 404
        return jsonify({
            'status': job.get('status'),
            'stage': job.get('stage'),
            'filename': job.get('filename'),
            'error': job.get('error'),
            'has_file': bool(job.get('file_bytes')),
        })


    @app.route('/api/hot-vendors/excel-job/<job_id>/file', methods=['GET'])
    def excel_job_file(job_id):
        job = _hv_excel_get(job_id)
        if not job:
            return jsonify({'error': 'Job not found'}), 404
        if not job.get('file_bytes'):
            return jsonify({'error': 'File not ready', 'status': job.get('status')}), 404
        from io import BytesIO
        return send_file(
            BytesIO(job['file_bytes']),
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=job.get('filename', 'hot-vendors.xlsx'),
        )


    # ------------------------------------------------------------------
    # Excel report rebuild (sync — kept for tiny suburbs, large ones
    # should use the async /excel-job pattern above to avoid 502s).
    # ------------------------------------------------------------------
    @app.route('/api/hot-vendors/uploads/<int:upload_id>/excel', methods=['GET'])
    def download_excel(upload_id):
        logger.info(f"[Excel] Download requested for upload_id={upload_id}")
        try:
            from hot_vendor_excel import build_workbook, workbook_filename
        except ImportError as e:
            logger.exception("hot_vendor_excel failed to import")
            return jsonify({'error': f'Excel generator unavailable: {e}'}), 500

        conn = get_db()
        result = _build_upload_payload(conn, upload_id)
        conn.close()
        if not result:
            logger.warning(f"[Excel] upload_id={upload_id} not found")
            return jsonify({'error': 'Upload not found'}), 404

        logger.info(f"[Excel] Building workbook: suburb={result.get('suburb')}, "
                    f"properties={len(result.get('properties') or [])}")
        try:
            buf = build_workbook(result)
        except Exception as e:
            logger.exception("Excel build failed")
            return jsonify({'error': f'Excel build failed: {type(e).__name__}: {e}'}), 500

        try:
            fname = workbook_filename(result['suburb'])
        except Exception as e:
            logger.exception("workbook_filename failed")
            fname = f"hot-vendors-{result.get('suburb', 'report')}.xlsx"
        logger.info(f"[Excel] Sending {fname}")

        return send_file(
            buf,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=fname,
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

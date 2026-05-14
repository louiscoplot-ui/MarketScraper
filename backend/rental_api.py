"""Rental module API — separate from sales pipeline.

Wired into app.py via register_rental_routes(app). All rental data
lives in rental_listings / rental_owners / rental_suburbs; the users
table has a per-user rental_access flag gating these endpoints.

Routes:
  GET    /api/rentals/suburbs                       — list user's allowed rental suburbs
  GET    /api/rentals/<suburb>                      — listings + joined owners
  PATCH  /api/rentals/owner                         — UPSERT operator notes
  POST   /api/rentals/import                        — multipart .xlsx → bulk merge
  GET    /api/admin/rental-suburbs                  — admin allowlist read
  POST   /api/admin/rental-suburbs                  — admin add
  PATCH  /api/admin/rental-suburbs/<id>             — admin toggle/rename
  DELETE /api/admin/rental-suburbs/<id>             — admin cascade delete
  PATCH  /api/admin/users/<id>/rental-access        — admin toggle flag
"""

import io
import logging
from datetime import datetime
from flask import request, jsonify

from database import get_db, USE_POSTGRES
from admin_api import (
    get_current_user, _require_admin,
    get_user_allowed_suburb_names,
)


logger = logging.getLogger(__name__)


# 10 MB upload cap — same ballpark as the RP Data import. Larger files
# almost certainly indicate the wrong template was uploaded.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

# Excel header → DB column. Matches the spec's column list exactly.
# Lowercased for case-insensitive lookup.
_EXCEL_COLUMNS = {
    'status': 'status',
    'date listed': 'date_listed',
    'days on market': 'days_on_market',
    'date leased': 'date_leased',
    'address': 'address',
    'suburb': 'suburb',
    'price/week': 'price_week',
    'type': 'property_type',
    'bedrooms': 'beds',
    'bathrooms': 'baths',
    'parking': 'cars',
    'agency': 'agency',
    'agent': 'agent',
    'owner name': 'owner_name',
    'owner phone': 'owner_phone',
    'notes': 'notes',
    'link': 'url',
}


def _user_has_rental_access(user):
    """Admin → True. Non-admin → True only if users.rental_access is
    truthy (DB stores 0/1 in SQLite, bool in psycopg2)."""
    if not user:
        return False
    if (user.get('role') or '').lower() == 'admin':
        return True
    return bool(user.get('rental_access'))


def _resolve_rental_scope():
    """(user, allowed_names_or_None). None = admin (no filter). Empty
    set = rental_access user with no overlapping sales suburbs (sees
    nothing). Honours the rental_access gate — non-rental users get
    (user, None_with_403_intent) which the caller must convert."""
    user = get_current_user()
    if not user:
        return None, None
    if (user.get('role') or '').lower() == 'admin':
        return user, None
    if not _user_has_rental_access(user):
        return user, False  # signal "denied, not just empty"
    _, sales_names = get_user_allowed_suburb_names()
    return user, sales_names or set()


def _allowed_rental_suburb_rows(conn, scope_names):
    """Filter rental_suburbs (active=1) by scope. scope_names is None
    for admin (no filter), else a lower-cased set of suburb names the
    user's sales scope grants — rental coverage piggy-backs on sales
    coverage. Returns list of dicts {id, name, active}."""
    if scope_names is None:
        rows = conn.execute(
            "SELECT id, name, active FROM rental_suburbs WHERE active = 1 ORDER BY name"
        ).fetchall()
    elif not scope_names:
        return []
    else:
        rows = conn.execute(
            "SELECT id, name, active FROM rental_suburbs WHERE active = 1 ORDER BY name"
        ).fetchall()
        rows = [r for r in rows if dict(r)['name'].strip().lower() in scope_names]
    return [dict(r) for r in rows]


def register_rental_routes(app):

    # ------------------------------------------------------------------
    # GET /api/rentals/suburbs — user-facing dropdown source
    # ------------------------------------------------------------------
    @app.route('/api/rentals/suburbs', methods=['GET'])
    def rentals_list_suburbs():
        user, scope = _resolve_rental_scope()
        if not user:
            return jsonify({'error': 'Unauthenticated — provide X-Access-Key'}), 401
        if scope is False:
            return jsonify({'error': 'Rental access not granted'}), 403
        conn = get_db()
        rows = _allowed_rental_suburb_rows(conn, scope)
        conn.close()
        return jsonify({
            'suburbs': [{'id': r['id'], 'name': r['name']} for r in rows]
        })

    # ------------------------------------------------------------------
    # GET /api/rentals/<suburb> — table content
    # ------------------------------------------------------------------
    @app.route('/api/rentals/<path:suburb>', methods=['GET'])
    def rentals_get_suburb(suburb):
        user, scope = _resolve_rental_scope()
        if not user:
            return jsonify({'error': 'Unauthenticated — provide X-Access-Key'}), 401
        if scope is False:
            return jsonify({'error': 'Rental access not granted'}), 403
        suburb_clean = (suburb or '').strip()
        if not suburb_clean:
            return jsonify({'error': 'suburb required'}), 400
        if scope is not None and suburb_clean.lower() not in scope:
            return jsonify({'error': 'Not authorised for that suburb'}), 403
        # Status sort: New (0), Active (1), Leased (2) — ORDER BY CASE.
        # Then date_listed DESC so the freshest within each bucket lands
        # at the top. Coalesce owner fields from rental_owners so the UI
        # can render every column without a second round-trip.
        conn = get_db()
        # SELECT only the columns the UI actually renders — first_seen
        # / last_seen / id are unused on the rental page and trimming
        # them shaves a few KB off the payload on busy suburbs.
        rows = conn.execute(
            """
            SELECT
              l.address, l.suburb, l.status, l.price_week,
              l.property_type, l.beds, l.baths, l.cars,
              l.agency, l.agent, l.date_listed, l.days_on_market,
              l.date_leased, l.url,
              COALESCE(o.owner_name, '')  AS owner_name,
              COALESCE(o.owner_phone, '') AS owner_phone,
              COALESCE(o.notes, '')       AS notes
            FROM rental_listings l
            LEFT JOIN rental_owners o
              ON o.address = l.address AND o.suburb = l.suburb
            WHERE LOWER(l.suburb) = LOWER(?)
            ORDER BY
              CASE l.status WHEN 'New' THEN 0 WHEN 'Active' THEN 1 ELSE 2 END,
              l.date_listed DESC
            """,
            (suburb_clean,)
        ).fetchall()
        conn.close()
        return jsonify({
            'suburb': suburb_clean,
            'count': len(rows),
            'listings': [dict(r) for r in rows],
        })

    # ------------------------------------------------------------------
    # PATCH /api/rentals/owner — UPSERT operator data on rental_owners
    # ------------------------------------------------------------------
    @app.route('/api/rentals/owner', methods=['PATCH'])
    def rentals_patch_owner():
        user, scope = _resolve_rental_scope()
        if not user:
            return jsonify({'error': 'Unauthenticated — provide X-Access-Key'}), 401
        if scope is False:
            return jsonify({'error': 'Rental access not granted'}), 403
        body = request.get_json(silent=True) or {}
        address = (body.get('address') or '').strip()
        suburb = (body.get('suburb') or '').strip()
        if not address or not suburb:
            return jsonify({'error': 'address and suburb required'}), 400
        if scope is not None and suburb.lower() not in scope:
            return jsonify({'error': 'Not authorised for that suburb'}), 403
        owner_name = (body.get('owner_name') or '').strip()
        owner_phone = (body.get('owner_phone') or '').strip()
        notes = (body.get('notes') or '').strip()

        conn = get_db()
        try:
            if USE_POSTGRES:
                conn.execute(
                    "INSERT INTO rental_owners "
                    "(address, suburb, owner_name, owner_phone, notes, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
                    "ON CONFLICT (address, suburb) DO UPDATE SET "
                    "owner_name = EXCLUDED.owner_name, "
                    "owner_phone = EXCLUDED.owner_phone, "
                    "notes = EXCLUDED.notes, "
                    "updated_at = CURRENT_TIMESTAMP",
                    (address, suburb, owner_name, owner_phone, notes)
                )
            else:
                conn.execute(
                    "INSERT INTO rental_owners "
                    "(address, suburb, owner_name, owner_phone, notes, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, datetime('now')) "
                    "ON CONFLICT(address, suburb) DO UPDATE SET "
                    "owner_name = excluded.owner_name, "
                    "owner_phone = excluded.owner_phone, "
                    "notes = excluded.notes, "
                    "updated_at = datetime('now')",
                    (address, suburb, owner_name, owner_phone, notes)
                )
            conn.commit()
        finally:
            conn.close()
        return jsonify({'success': True})

    # ------------------------------------------------------------------
    # POST /api/rentals/import — multipart Excel bulk merge
    # ------------------------------------------------------------------
    @app.route('/api/rentals/import', methods=['POST'])
    def rentals_import_excel():
        user, scope = _resolve_rental_scope()
        if not user:
            return jsonify({'error': 'Unauthenticated — provide X-Access-Key'}), 401
        if scope is False:
            return jsonify({'error': 'Rental access not granted'}), 403
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded. Use multipart field "file".'}), 400
        f = request.files['file']
        name = (f.filename or '').lower()
        if not (name.endswith('.xlsx') or name.endswith('.xls')):
            return jsonify({'error': 'Only .xlsx / .xls accepted'}), 400
        raw = f.read()
        if not raw:
            return jsonify({'error': 'Empty file'}), 400
        if len(raw) > MAX_UPLOAD_BYTES:
            return jsonify({'error': f'File too large (>{MAX_UPLOAD_BYTES // (1024 * 1024)} MB)'}), 400
        try:
            from openpyxl import load_workbook
        except ImportError:
            return jsonify({'error': 'openpyxl not installed on the server'}), 500
        try:
            wb = load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
        except Exception as e:
            return jsonify({'error': f'Could not parse workbook: {e}'}), 400

        # Non-destructive merge counters surfaced in the toast:
        #   inserted = brand-new rental_listings rows
        #   enriched = existing rows where AT LEAST ONE empty field
        #              (listing or owner) got filled by this import
        #   skipped  = invalid row (no address) OR fully-populated row
        #              that this Excel had nothing new to add to.
        # Listing columns that can be filled (status / price_week etc.).
        # `status` is included so a 'Leased' row from the Excel can
        # populate an existing 'Active' row IF the existing row's
        # status field is empty — which it shouldn't be in practice
        # (the scraper writes one of New/Active/Leased on every row),
        # so this is effectively a no-op safety net.
        FILLABLE = (
            'status', 'price_week', 'property_type', 'beds', 'baths',
            'cars', 'agency', 'agent', 'date_listed', 'days_on_market',
            'date_leased', 'url',
        )

        inserted = 0
        enriched = 0
        skipped = 0
        suburbs_seen = []
        conn = get_db()
        try:
            for sheet_name in wb.sheetnames:
                if sheet_name.strip().upper() == 'SUMMARY':
                    continue
                ws = wb[sheet_name]
                # Sheet name is the suburb. Honour scope — silently skip
                # sheets outside the caller's allowed suburbs.
                if scope is not None and sheet_name.strip().lower() not in scope:
                    continue

                header_idx = None
                col_map = {}
                # Scan first 5 rows for a header containing 'address'.
                rows_iter = list(ws.iter_rows(values_only=True))
                for i, row in enumerate(rows_iter[:5]):
                    cells = [('' if c is None else str(c)).strip().lower() for c in row]
                    if 'address' in cells and 'suburb' in cells:
                        header_idx = i
                        for j, cell in enumerate(cells):
                            if cell in _EXCEL_COLUMNS:
                                col_map[_EXCEL_COLUMNS[cell]] = j
                        break
                if header_idx is None:
                    # Sheet has no usable header — count once as skipped
                    # so the operator sees a non-zero number explaining
                    # the missing rows.
                    skipped += 1
                    continue
                suburbs_seen.append(sheet_name)

                for row in rows_iter[header_idx + 1:]:
                    def cell(key):
                        idx = col_map.get(key)
                        if idx is None or idx >= len(row):
                            return ''
                        v = row[idx]
                        return '' if v is None else str(v).strip()

                    addr = cell('address')
                    sub = cell('suburb') or sheet_name.strip()
                    if not addr or not sub:
                        skipped += 1
                        continue

                    # Snapshot of the existing listing — drives the
                    # field-level "fill empty only" merge below. None
                    # means we'll INSERT.
                    existing = conn.execute(
                        "SELECT status, price_week, property_type, beds, baths, "
                        "       cars, agency, agent, date_listed, days_on_market, "
                        "       date_leased, url FROM rental_listings "
                        "WHERE address = ? AND suburb = ?",
                        (addr, sub)
                    ).fetchone()

                    row_inserted = False
                    row_enriched = False

                    if existing is None:
                        # Brand-new row — full INSERT. status defaults to
                        # 'Active' when the Excel didn't carry one so the
                        # NOT NULL constraint stays satisfied.
                        conn.execute(
                            "INSERT INTO rental_listings "
                            "(address, suburb, status, price_week, property_type, "
                            " beds, baths, cars, agency, agent, date_listed, "
                            " days_on_market, date_leased, url) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (
                                addr, sub,
                                cell('status') or 'Active',
                                cell('price_week'), cell('property_type'),
                                cell('beds'), cell('baths'), cell('cars'),
                                cell('agency'), cell('agent'),
                                cell('date_listed'), cell('days_on_market'),
                                cell('date_leased'), cell('url'),
                            )
                        )
                        row_inserted = True
                    else:
                        # Field-level merge — only fill columns the DB
                        # has as NULL or empty. Never overwrite a
                        # populated cell. status is in FILLABLE but
                        # rental_listings.status defaults 'Active', so
                        # the DB value is virtually always non-empty
                        # and the status column stays untouched here.
                        existing_d = dict(existing)
                        sets = []
                        params = []
                        for field in FILLABLE:
                            db_val = (existing_d.get(field) or '').strip()
                            if db_val:
                                continue
                            excel_val = cell(field)
                            if not excel_val:
                                continue
                            sets.append(f"{field} = ?")
                            params.append(excel_val)
                        if sets:
                            # last_seen bumps because we touched the row,
                            # so the listings UI sorts the freshly-merged
                            # rows toward the recent end.
                            sets.append("last_seen = ?")
                            params.append(datetime.utcnow().isoformat())
                            params.extend([addr, sub])
                            conn.execute(
                                f"UPDATE rental_listings SET {', '.join(sets)} "
                                "WHERE address = ? AND suburb = ?",
                                params
                            )
                            row_enriched = True

                    # rental_owners — same fill-empty-only contract,
                    # field by field. Operator-typed values in the UI
                    # are sacred; the Excel only writes into gaps.
                    owner_name = cell('owner_name')
                    owner_phone = cell('owner_phone')
                    notes_text = cell('notes')
                    if owner_name or owner_phone or notes_text:
                        o_row = conn.execute(
                            "SELECT owner_name, owner_phone, notes FROM rental_owners "
                            "WHERE address = ? AND suburb = ?",
                            (addr, sub)
                        ).fetchone()
                        if o_row is None:
                            conn.execute(
                                "INSERT INTO rental_owners "
                                "(address, suburb, owner_name, owner_phone, notes) "
                                "VALUES (?, ?, ?, ?, ?)",
                                (addr, sub, owner_name, owner_phone, notes_text)
                            )
                            row_enriched = True
                        else:
                            od = dict(o_row)
                            o_sets = []
                            o_params = []
                            for field, val in (
                                ('owner_name',  owner_name),
                                ('owner_phone', owner_phone),
                                ('notes',       notes_text),
                            ):
                                if not val:
                                    continue
                                if (od.get(field) or '').strip():
                                    continue
                                o_sets.append(f"{field} = ?")
                                o_params.append(val)
                            if o_sets:
                                if USE_POSTGRES:
                                    o_sets.append("updated_at = CURRENT_TIMESTAMP")
                                else:
                                    o_sets.append("updated_at = datetime('now')")
                                o_params.extend([addr, sub])
                                conn.execute(
                                    f"UPDATE rental_owners SET {', '.join(o_sets)} "
                                    "WHERE address = ? AND suburb = ?",
                                    o_params
                                )
                                row_enriched = True

                    if row_inserted:
                        inserted += 1
                    elif row_enriched:
                        enriched += 1
                    else:
                        skipped += 1
            conn.commit()
        except Exception as e:
            logger.exception("Rental import failed")
            return jsonify({'error': f'Import crashed: {e}'}), 500
        finally:
            conn.close()
        return jsonify({
            'inserted': inserted,
            'enriched': enriched,
            'skipped': skipped,
            'suburbs': suburbs_seen,
        })

    # ------------------------------------------------------------------
    # Admin allowlist CRUD
    # ------------------------------------------------------------------
    @app.route('/api/admin/rental-suburbs', methods=['GET'])
    def admin_list_rental_suburbs():
        _u, err = _require_admin()
        if err:
            return err
        conn = get_db()
        rows = conn.execute(
            "SELECT id, name, active, created_at FROM rental_suburbs ORDER BY name"
        ).fetchall()
        conn.close()
        return jsonify({'suburbs': [dict(r) for r in rows]})

    @app.route('/api/admin/rental-suburbs', methods=['POST'])
    def admin_add_rental_suburb():
        _u, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        name = (body.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO rental_suburbs (name) VALUES (?)", (name,)
            )
            conn.commit()
        except Exception as e:
            conn.close()
            return jsonify({'error': f'Could not add: {e}'}), 400
        row = conn.execute(
            "SELECT id, name, active FROM rental_suburbs WHERE name = ?", (name,)
        ).fetchone()
        conn.close()
        return jsonify(dict(row) if row else {'name': name})

    @app.route('/api/admin/rental-suburbs/<int:sid>', methods=['PATCH'])
    def admin_patch_rental_suburb(sid):
        _u, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        sets = []
        params = []
        if 'active' in body:
            sets.append("active = ?")
            params.append(1 if body['active'] else 0)
        if 'name' in body:
            new_name = (body.get('name') or '').strip()
            if not new_name:
                return jsonify({'error': 'name cannot be empty'}), 400
            sets.append("name = ?")
            params.append(new_name)
        if not sets:
            return jsonify({'error': 'No fields to update'}), 400
        params.append(sid)
        conn = get_db()
        try:
            conn.execute(
                f"UPDATE rental_suburbs SET {', '.join(sets)} WHERE id = ?", params
            )
            conn.commit()
        except Exception as e:
            conn.close()
            return jsonify({'error': f'Update failed: {e}'}), 400
        row = conn.execute(
            "SELECT id, name, active FROM rental_suburbs WHERE id = ?", (sid,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(dict(row))

    @app.route('/api/admin/rental-suburbs/<int:sid>', methods=['DELETE'])
    def admin_delete_rental_suburb(sid):
        _u, err = _require_admin()
        if err:
            return err
        conn = get_db()
        row = conn.execute(
            "SELECT name FROM rental_suburbs WHERE id = ?", (sid,)
        ).fetchone()
        if not row:
            conn.close()
            return jsonify({'error': 'Not found'}), 404
        name = dict(row)['name']
        # Manual cascade — rental_listings / rental_owners reference
        # suburb by string, not FK, so DROP doesn't sweep them.
        conn.execute(
            "DELETE FROM rental_listings WHERE LOWER(suburb) = LOWER(?)", (name,)
        )
        conn.execute(
            "DELETE FROM rental_owners WHERE LOWER(suburb) = LOWER(?)", (name,)
        )
        conn.execute("DELETE FROM rental_suburbs WHERE id = ?", (sid,))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'deleted_suburb': name})

    @app.route('/api/admin/users/<int:user_id>/rental-access', methods=['PATCH'])
    def admin_patch_user_rental_access(user_id):
        _u, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        if 'rental_access' not in body:
            return jsonify({'error': 'rental_access required'}), 400
        flag = 1 if body['rental_access'] else 0
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row:
            conn.close()
            return jsonify({'error': 'User not found'}), 404
        conn.execute(
            "UPDATE users SET rental_access = ? WHERE id = ?", (flag, user_id)
        )
        conn.commit()
        conn.close()
        return jsonify({'user_id': user_id, 'rental_access': bool(flag)})

    logger.info(
        "Rental routes: /api/rentals/{suburbs,<suburb>,owner,import} + "
        "/api/admin/rental-suburbs[/<id>] + "
        "/api/admin/users/<id>/rental-access"
    )

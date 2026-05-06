"""SuburbDesk admin API — user management.

Endpoints (all admin-gated via X-Access-Key header):
  GET    /api/admin/me                    current user info
  GET    /api/admin/users                 list all users
  POST   /api/admin/users                 create a new user, returns access_key
  PATCH  /api/admin/users/<id>            update name/phone/role
  DELETE /api/admin/users/<id>            revoke access (delete)

Auth model: each user has an access_key (32-char hex). They send it as the
X-Access-Key header on every API call. The current user is identified by
that key. Only users with role='admin' can call /api/admin/* endpoints.

The first admin is seeded from the ADMIN_EMAIL env var the first time the
app boots — so a fresh deploy always has at least one admin who can let
others in. The seeded admin's access_key is logged on startup so you can
copy it into the login screen.
"""

import os
import secrets
import logging
from datetime import datetime
from flask import request, jsonify

from database import get_db, USE_POSTGRES

logger = logging.getLogger(__name__)


def _gen_access_key():
    """32-char hex token. URL-safe, sufficient entropy for a beta product."""
    return secrets.token_hex(16)


def _row_to_dict(row):
    """Strip the access_key from public payloads — admins see it once on
    creation only, never again. Prevents accidental leak in screenshots."""
    if row is None:
        return None
    d = dict(row)
    d.pop('access_key', None)
    return d


def get_current_user():
    """Resolve the request's access_key → user row. Returns None if missing
    or invalid. Bumps last_seen on every successful lookup.

    The user whose email matches ADMIN_EMAIL is ALWAYS returned with
    role='admin', even if the DB row says otherwise. This protects the
    seeded admin from accidentally demoting themselves via the UI's role
    toggle — only direct DB editing or env-var change can lock them out."""
    key = request.headers.get('X-Access-Key') or request.args.get('access_key')
    if not key:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE access_key = ?", (key,)
    ).fetchone()
    if row:
        try:
            conn.execute(
                "UPDATE users SET last_seen = ? WHERE id = ?",
                (datetime.utcnow().isoformat(), row['id'])
            )
            conn.commit()
        except Exception:
            pass
    conn.close()
    if row is None:
        return None
    user = dict(row)
    seed_email = os.environ.get('ADMIN_EMAIL', '').strip().lower()
    if seed_email and (user.get('email') or '').strip().lower() == seed_email:
        user['role'] = 'admin'
    return user


def get_user_suburb_ids(user_id, is_admin=False):
    """Return the list of suburb IDs assigned to a user, or None when the
    caller is an admin (None = no filter, see everything). Existing
    callers that pass only `user_id` get the legacy list-of-ids behaviour."""
    if is_admin:
        return None
    conn = get_db()
    rows = conn.execute(
        "SELECT suburb_id FROM user_suburbs WHERE user_id = ?",
        (user_id,)
    ).fetchall()
    conn.close()
    return [r['suburb_id'] for r in rows]


def resolve_request_scope():
    """Convenience for data routes: returns (user_dict_or_None, suburb_ids).
    `suburb_ids` is None when the caller is admin / unauthenticated (no
    filtering applied — admins see all). For regular users it's the list
    of assigned suburb IDs (possibly empty → they see nothing)."""
    user = get_current_user()
    if not user or user.get('role') == 'admin':
        return user, None
    return user, get_user_suburb_ids(user['id'])


def get_user_allowed_suburb_names():
    """Like resolve_request_scope() but returns lowercased suburb NAMES
    (a set), since the pipeline_tracking and hot_vendor_uploads tables
    store the suburb as a free-text column rather than an FK.

    Returns (user, names_or_None). None means no filter (admin).
    Empty set means the user has no suburbs assigned → see nothing."""
    user, allowed_ids = resolve_request_scope()
    if allowed_ids is None:
        return user, None
    if not allowed_ids:
        return user, set()
    conn = get_db()
    placeholders = ','.join(['?'] * len(allowed_ids))
    rows = conn.execute(
        f"SELECT name FROM suburbs WHERE id IN ({placeholders})",
        allowed_ids
    ).fetchall()
    conn.close()
    return user, {dict(r)['name'].strip().lower() for r in rows}


def user_can_access_suburb(name):
    """True if the calling user is allowed to read/write data for the
    named suburb. Admins always pass; unauthenticated users (which are
    blocked by the global gate anyway) get False."""
    user, allowed = get_user_allowed_suburb_names()
    if user is None:
        return False
    if allowed is None:
        return True  # admin
    return (name or '').strip().lower() in allowed


def _require_admin():
    """Returns (user_dict, None) on success, or (None, error_response) to
    short-circuit the route."""
    user = get_current_user()
    if not user:
        return None, (jsonify({'error': 'Unauthenticated — provide X-Access-Key'}), 401)
    if user.get('role') != 'admin':
        return None, (jsonify({'error': 'Admin role required'}), 403)
    return user, None


def seed_admin_if_needed():
    """Called on app startup. If ADMIN_EMAIL is set in the environment
    and that email isn't already a user, create them as an admin and log
    the access_key so the operator can paste it into the login screen."""
    admin_email = os.environ.get('ADMIN_EMAIL', '').strip().lower()
    if not admin_email:
        logger.warning("ADMIN_EMAIL not set — no admin will be seeded. "
                       "Set ADMIN_EMAIL=you@example.com on Render before next deploy.")
        return
    conn = get_db()
    existing = conn.execute(
        "SELECT id, access_key, role FROM users WHERE LOWER(email) = ?",
        (admin_email,)
    ).fetchone()
    if existing:
        # Already exists — make sure it's an admin (idempotent fix-up
        # if someone manually demoted the seed account).
        if existing['role'] != 'admin':
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (existing['id'],))
            conn.commit()
            logger.info(f"Promoted existing user {admin_email} to admin")
        logger.info(f"Admin already seeded: {admin_email}")
        conn.close()
        return

    key = _gen_access_key()
    if USE_POSTGRES:
        cur = conn.execute(
            "INSERT INTO users (email, role, access_key) VALUES (?, ?, ?) RETURNING id",
            (admin_email, 'admin', key)
        )
        new_id = cur.fetchone()['id']
    else:
        cur = conn.execute(
            "INSERT INTO users (email, role, access_key) VALUES (?, ?, ?)",
            (admin_email, 'admin', key)
        )
        new_id = cur.lastrowid
    conn.commit()
    conn.close()
    logger.warning(
        "═══════════════════════════════════════════════════════════════\n"
        f"  Seeded admin: {admin_email} (id={new_id})\n"
        f"  ACCESS KEY:  {key}\n"
        f"  Paste this into the SuburbDesk login screen.\n"
        "═══════════════════════════════════════════════════════════════"
    )


def register_admin_routes(app):

    @app.route('/api/admin/me', methods=['GET'])
    def admin_me():
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Unauthenticated'}), 401
        return jsonify({'user': _row_to_dict(user)})

    @app.route('/api/admin/users', methods=['GET'])
    def admin_list_users():
        _, err = _require_admin()
        if err:
            return err
        conn = get_db()
        rows = conn.execute(
            "SELECT id, email, first_name, last_name, phone, role, last_seen, created_at "
            "FROM users ORDER BY created_at DESC"
        ).fetchall()
        # Pull every assignment in one query and group by user, so the
        # admin table can show suburbs at a glance without an extra
        # round-trip per row.
        assignments = conn.execute(
            "SELECT us.user_id, s.id AS suburb_id, s.name AS suburb_name "
            "FROM user_suburbs us "
            "JOIN suburbs s ON s.id = us.suburb_id "
            "ORDER BY s.name"
        ).fetchall()
        conn.close()
        by_user = {}
        for a in assignments:
            d = dict(a)
            by_user.setdefault(d['user_id'], []).append(
                {'id': d['suburb_id'], 'name': d['suburb_name']}
            )
        users = []
        for r in rows:
            d = dict(r)
            d['suburbs'] = by_user.get(d['id'], [])
            users.append(d)
        return jsonify({'users': users})

    @app.route('/api/admin/users', methods=['POST'])
    def admin_create_user():
        admin, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        email = (body.get('email') or '').strip().lower()
        if not email or '@' not in email:
            return jsonify({'error': 'Valid email required'}), 400
        first_name = (body.get('first_name') or '').strip() or None
        last_name = (body.get('last_name') or '').strip() or None
        phone = (body.get('phone') or '').strip() or None
        role = body.get('role', 'user')
        if role not in ('admin', 'user'):
            return jsonify({'error': "role must be 'admin' or 'user'"}), 400

        key = _gen_access_key()
        conn = get_db()
        try:
            if USE_POSTGRES:
                cur = conn.execute(
                    "INSERT INTO users (email, first_name, last_name, phone, role, access_key) "
                    "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                    (email, first_name, last_name, phone, role, key)
                )
                new_id = cur.fetchone()['id']
            else:
                cur = conn.execute(
                    "INSERT INTO users (email, first_name, last_name, phone, role, access_key) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (email, first_name, last_name, phone, role, key)
                )
                new_id = cur.lastrowid
            conn.commit()
        except Exception as e:
            conn.close()
            msg = str(e).lower()
            if 'unique' in msg or 'duplicate' in msg:
                return jsonify({'error': f'A user with email {email} already exists'}), 409
            return jsonify({'error': f'DB error: {e}'}), 500
        conn.close()

        # Auto-send the welcome email with the access key + 3-step tutorial.
        # Uses the inviter's name (or email) so the recipient knows who
        # invited them. If Resend isn't configured (RESEND_API_KEY missing)
        # or the send fails, the user is still created — the admin can
        # fall back to the access_key shown in the response banner.
        from email_service import send_welcome_email
        new_user = {
            'email': email, 'first_name': first_name, 'last_name': last_name,
        }
        inviter = (' '.join(filter(None, [
            admin.get('first_name'), admin.get('last_name')
        ])).strip() or admin.get('email'))
        email_ok, email_err = send_welcome_email(new_user, key, inviter_name=inviter)

        # Returns the access_key ONCE on creation — the admin must copy
        # it now if the email failed; on subsequent GET /users calls the
        # key is never returned. The frontend uses email_sent / email_error
        # to decide whether to nag the admin to copy manually.
        return jsonify({
            'id': new_id,
            'email': email,
            'first_name': first_name,
            'last_name': last_name,
            'phone': phone,
            'role': role,
            'access_key': key,
            'email_sent': email_ok,
            'email_error': email_err,
        }), 201

    @app.route('/api/admin/users/<int:user_id>', methods=['PATCH'])
    def admin_update_user(user_id):
        _, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        sets, params = [], []
        for k in ('first_name', 'last_name', 'phone', 'role'):
            if k in body:
                if k == 'role' and body[k] not in ('admin', 'user'):
                    return jsonify({'error': "role must be 'admin' or 'user'"}), 400
                sets.append(f"{k} = ?")
                params.append(body[k] if body[k] != '' else None)
        if not sets:
            return jsonify({'error': 'No updatable fields. Allowed: first_name, last_name, phone, role'}), 400
        params.append(user_id)
        conn = get_db()
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        row = conn.execute(
            "SELECT id, email, first_name, last_name, phone, role, last_seen, created_at "
            "FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'User not found'}), 404
        return jsonify(dict(row))

    @app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
    def admin_delete_user(user_id):
        admin, err = _require_admin()
        if err:
            return err
        # Prevent the last admin from deleting themselves and locking
        # everyone out. If you really need to do that, demote first then
        # delete via SQL — but the UI shouldn't make it easy.
        if admin['id'] == user_id:
            conn = get_db()
            n_admins = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()['n']
            conn.close()
            if n_admins <= 1:
                return jsonify({
                    'error': "You can't delete yourself — you're the only admin. "
                             "Promote another user to admin first."
                }), 400
        conn = get_db()
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})

    @app.route('/api/admin/users/<int:user_id>/suburbs', methods=['GET'])
    def admin_get_user_suburbs(user_id):
        _, err = _require_admin()
        if err:
            return err
        ids = get_user_suburb_ids(user_id)
        # Resolve to {id,name} pairs for the frontend chips. Single query
        # so this stays cheap regardless of how many suburbs the user has.
        suburbs = []
        if ids:
            conn = get_db()
            placeholders = ','.join(['?'] * len(ids))
            rows = conn.execute(
                f"SELECT id, name FROM suburbs WHERE id IN ({placeholders}) ORDER BY name",
                ids
            ).fetchall()
            conn.close()
            suburbs = [dict(r) for r in rows]
        return jsonify({
            'user_id': user_id,
            'suburb_ids': ids,
            'suburbs': suburbs,
        })

    @app.route('/api/admin/users/<int:user_id>/suburbs', methods=['PUT'])
    def admin_set_user_suburbs(user_id):
        """Replace ALL of this user's suburb assignments with the given
        list. Atomic: if any insert fails the whole change is rolled back
        so the assignments never end up in a half-applied state."""
        _, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        ids = body.get('suburb_ids') or []
        if not isinstance(ids, list):
            return jsonify({'error': 'suburb_ids must be a list of integers'}), 400
        try:
            ids = [int(x) for x in ids]
        except (ValueError, TypeError):
            return jsonify({'error': 'suburb_ids must contain integers only'}), 400

        conn = get_db()
        try:
            conn.execute("DELETE FROM user_suburbs WHERE user_id = ?", (user_id,))
            for sid in ids:
                # ON CONFLICT DO NOTHING handles dedup if the caller
                # accidentally sent the same id twice.
                if USE_POSTGRES:
                    conn.execute(
                        "INSERT INTO user_suburbs (user_id, suburb_id) VALUES (?, ?) "
                        "ON CONFLICT DO NOTHING",
                        (user_id, sid)
                    )
                else:
                    conn.execute(
                        "INSERT OR IGNORE INTO user_suburbs (user_id, suburb_id) VALUES (?, ?)",
                        (user_id, sid)
                    )
            conn.commit()
        except Exception as e:
            conn.close()
            return jsonify({'error': f'DB error: {e}'}), 500
        conn.close()
        return jsonify({
            'user_id': user_id,
            'suburb_ids': ids,
            'ok': True,
            'count': len(ids),
        })

    logger.info("Admin routes registered: /api/admin/{me,users[,/<id>[,/suburbs]]}")

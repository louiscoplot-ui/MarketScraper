"""Auth gate routes. Two endpoints:

  POST /api/auth/request-link  body: {email}
    Silently returns 200 regardless of whether the email matches a user
    (no enumeration). If it does match, sends a magic-link email via
    Resend so the recipient can click straight in.

  GET  /api/auth/me
    Returns the calling user (resolved via X-Access-Key) or 401.
    Frontend uses this to validate a key on app load before rendering.

Access control for the rest of /api/* is enforced by the before_request
hook in app.py — anything that isn't auth/ping requires a valid key.
"""

import re
from flask import request, jsonify
from database import get_db
from email_service import send_login_link_email
from admin_api import get_current_user, _row_to_dict


_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def register_auth_routes(app):
    @app.route('/api/auth/request-link', methods=['POST'])
    def request_login_link():
        body = request.get_json(silent=True) or {}
        email = (body.get('email') or '').strip().lower()
        if email and '@' in email:
            conn = get_db()
            row = conn.execute(
                "SELECT id, email, first_name, last_name, access_key "
                "FROM users WHERE LOWER(email) = ?",
                (email,)
            ).fetchone()
            conn.close()
            if row:
                user = dict(row)
                try:
                    send_login_link_email(user, user['access_key'])
                except Exception:
                    pass  # never leak failure to caller
        return jsonify({'ok': True})

    @app.route('/api/auth/me', methods=['GET'])
    def whoami():
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        return jsonify(_row_to_dict(user))

    @app.route('/api/users/me/profile', methods=['PATCH'])
    def update_my_profile():
        """Update the calling user's prospecting-letter profile fields.
        Body: {agency_name, agent_name, agent_phone, agent_email}. Empty
        strings are stored as NULL so the letter renderer can fall through
        to env vars. The global before_request gate already enforces auth,
        so get_current_user() is guaranteed to return a row here."""
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        body = request.get_json(silent=True) or {}

        agent_name = (body.get('agent_name') or '').strip()
        if 'agent_name' in body and not agent_name:
            return jsonify({'error': 'agent_name cannot be empty'}), 400

        agent_email = (body.get('agent_email') or '').strip()
        if agent_email and not _EMAIL_RE.match(agent_email):
            return jsonify({'error': 'agent_email is not a valid email'}), 400

        sets, params = [], []
        for k in ('agency_name', 'agent_name', 'agent_phone', 'agent_email'):
            if k in body:
                v = (body.get(k) or '').strip()
                sets.append(f"{k} = ?")
                params.append(v or None)
        if not sets:
            return jsonify({
                'error': 'No updatable fields. Allowed: agency_name, agent_name, agent_phone, agent_email'
            }), 400
        params.append(user['id'])

        conn = get_db()
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        row = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user['id'],)
        ).fetchone()
        conn.close()
        return jsonify(_row_to_dict(row))

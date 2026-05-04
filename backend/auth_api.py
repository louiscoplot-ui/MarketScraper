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

from flask import request, jsonify
from database import get_db
from email_service import send_login_link_email
from admin_api import get_current_user, _row_to_dict


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

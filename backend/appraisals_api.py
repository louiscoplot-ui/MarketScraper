"""LOOP-5 — Appraisal follow-up routes.

An agent logs an appraisal; the system schedules three follow-ups (J+30/60/90)
each carrying a fresh suburb data point. Routes are scoped per user: an agent
sees and edits only their own appraisals (admins see all). The actual emails
are sent by signals/appraisal_followup.py (cron, gated behind SIGNALS_LIVE).
"""
import logging
from datetime import datetime, timedelta

from flask import request, jsonify

from database import get_db
from admin_api import resolve_request_scope

logger = logging.getLogger(__name__)

FOLLOWUP_DAYS = (30, 60, 90)


def _parse_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(str(s)[:10], '%Y-%m-%d').date()
    except Exception:
        return None


def register_appraisals_routes(app):

    @app.route('/api/appraisals', methods=['POST'])
    def create_appraisal():
        user, _allowed = resolve_request_scope()
        if not user:
            return jsonify({'error': 'unauthenticated'}), 401
        body = request.get_json(silent=True) or {}
        address = (body.get('address') or '').strip()
        appraisal_date = (body.get('appraisal_date') or '').strip()
        d = _parse_date(appraisal_date)
        if not address or not d:
            return jsonify({'error': 'address and appraisal_date (YYYY-MM-DD) required'}), 400

        conn = get_db()
        try:
            cur = conn.execute(
                "INSERT INTO appraisals (user_id, address, suburb, vendor_name, "
                "vendor_email, vendor_phone, appraisal_date, estimated_price, notes) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (user['id'], address, (body.get('suburb') or '').strip() or None,
                 (body.get('vendor_name') or '').strip() or None,
                 (body.get('vendor_email') or '').strip() or None,
                 (body.get('vendor_phone') or '').strip() or None,
                 d.isoformat(), body.get('estimated_price'),
                 (body.get('notes') or '').strip() or None)
            )
            appraisal_id = cur.lastrowid
            if appraisal_id is None:
                row = conn.execute(
                    "SELECT id FROM appraisals WHERE user_id = ? AND address = ? "
                    "ORDER BY id DESC LIMIT 1", (user['id'], address)
                ).fetchone()
                appraisal_id = dict(row)['id'] if row else None

            followup_dates = []
            for nd in FOLLOWUP_DAYS:
                sched = (d + timedelta(days=nd)).isoformat()
                followup_dates.append(sched)
                conn.execute(
                    "INSERT INTO appraisal_followups (appraisal_id, scheduled_for, "
                    "followup_day, status) VALUES (?,?,?,'pending')",
                    (appraisal_id, sched, nd)
                )
            conn.commit()
        except Exception:
            conn.rollback()
            logger.exception("create_appraisal failed")
            return jsonify({'error': 'could not create appraisal'}), 500
        finally:
            conn.close()

        return jsonify({'appraisal_id': appraisal_id, 'followup_dates': followup_dates})

    @app.route('/api/appraisals', methods=['GET'])
    def list_appraisals():
        user, allowed_ids = resolve_request_scope()
        if not user:
            return jsonify({'error': 'unauthenticated'}), 401
        is_admin = allowed_ids is None
        conn = get_db()
        if is_admin:
            rows = conn.execute(
                "SELECT * FROM appraisals ORDER BY created_at DESC LIMIT 500"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM appraisals WHERE user_id = ? "
                "ORDER BY created_at DESC LIMIT 500", (user['id'],)
            ).fetchall()
        appraisals = [dict(r) for r in rows]
        # attach followup summary (next pending date) per appraisal
        for a in appraisals:
            fu = conn.execute(
                "SELECT scheduled_for, followup_day, status FROM appraisal_followups "
                "WHERE appraisal_id = ? ORDER BY followup_day", (a['id'],)
            ).fetchall()
            a['followups'] = [dict(x) for x in fu]
            pending = [dict(x) for x in fu if dict(x)['status'] == 'pending']
            a['next_followup'] = pending[0]['scheduled_for'] if pending else None
        conn.close()
        return jsonify(appraisals)

    @app.route('/api/appraisals/<int:appraisal_id>/status', methods=['PATCH'])
    def update_appraisal_status(appraisal_id):
        user, allowed_ids = resolve_request_scope()
        if not user:
            return jsonify({'error': 'unauthenticated'}), 401
        is_admin = allowed_ids is None
        body = request.get_json(silent=True) or {}
        status = (body.get('status') or '').strip().lower()
        if status not in ('active', 'won', 'lost'):
            return jsonify({'error': 'status must be active, won or lost'}), 400

        conn = get_db()
        row = conn.execute(
            "SELECT user_id FROM appraisals WHERE id = ?", (appraisal_id,)
        ).fetchone()
        if not row:
            conn.close()
            return jsonify({'error': 'not found'}), 404
        if not is_admin and dict(row)['user_id'] != user['id']:
            conn.close()
            return jsonify({'error': 'forbidden'}), 403

        conn.execute("UPDATE appraisals SET status = ? WHERE id = ?",
                     (status, appraisal_id))
        # Once won/lost, stop chasing — cancel any pending follow-ups.
        if status in ('won', 'lost'):
            conn.execute(
                "UPDATE appraisal_followups SET status = 'skipped' "
                "WHERE appraisal_id = ? AND status = 'pending'", (appraisal_id,)
            )
        conn.commit()
        conn.close()
        return jsonify({'ok': True, 'status': status})

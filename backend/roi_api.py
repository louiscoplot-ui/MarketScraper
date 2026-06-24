"""PERF-2 — ROI tracker routes.

Surfaces the one number that kills churn and writes the investor pitch:
commissions generated through SuburbDesk. Scoped per user (admins aggregate
across everyone). The pitch-snapshot optionally calls the Claude API for
punchy bullets — via raw requests (no new dependency) and only when
ANTHROPIC_API_KEY is set; otherwise it returns deterministic bullets.
"""
import os
import json
import logging
from datetime import datetime, timedelta

import requests
from flask import request, jsonify

from database import get_db
from admin_api import resolve_request_scope, _require_admin

logger = logging.getLogger(__name__)

VALID_SOURCES = ('withdrawn_orphan', 'sale_fallen', 'sold_reveal', 'pipeline', 'manual')


def _quarter_start_iso():
    now = datetime.utcnow()
    q_first_month = 3 * ((now.month - 1) // 3) + 1
    return datetime(now.year, q_first_month, 1).strftime('%Y-%m-%d')


def _roi_for(conn, user_id):
    """ROI aggregates for one user (user_id None → all users / admin)."""
    where, params = "status = 'won'", []
    if user_id is not None:
        where += " AND user_id = ?"
        params.append(user_id)

    won = conn.execute(
        f"SELECT COALESCE(commission_value, 0) AS c, mandate_source, created_at "
        f"FROM appraisals WHERE {where}", tuple(params)
    ).fetchall()
    won = [dict(r) for r in won]

    total_commission = sum(int(r['c'] or 0) for r in won)
    q_start = _quarter_start_iso()
    q_rows = [r for r in won if (r.get('created_at') or '') >= q_start]
    q_commission = sum(int(r['c'] or 0) for r in q_rows)

    by_source = {}
    for r in won:
        src = r.get('mandate_source') or 'manual'
        b = by_source.setdefault(src, {'source': src, 'count': 0, 'commission': 0})
        b['count'] += 1
        b['commission'] += int(r['c'] or 0)

    since30 = (datetime.utcnow() - timedelta(days=30)).isoformat()
    sig = conn.execute(
        "SELECT COUNT(*) AS n FROM listing_transitions WHERE detected_at >= ?",
        (since30,)
    ).fetchone()
    signals_30d = dict(sig)['n'] if sig else 0

    return {
        'total_mandates_won': len(won),
        'total_commission_aud': total_commission,
        'this_quarter': {'mandates': len(q_rows), 'commission': q_commission},
        'by_source': sorted(by_source.values(), key=lambda x: -x['commission']),
        'signals_detected_30d': signals_30d,
    }


def _claude_bullets(metrics):
    """3 pitch bullets. Live Claude call when ANTHROPIC_API_KEY is set (raw
    requests, no SDK dependency); deterministic fallback otherwise."""
    key = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    fallback = [
        {'bullet': f"${metrics['total_commission_aud']:,} in commissions tracked "
                   f"across {metrics['total_mandates_won']} won mandates."},
        {'bullet': f"{metrics['signals_detected_30d']} vendor signals surfaced in "
                   f"the last 30 days — leads competitors never see."},
        {'bullet': "Every morning, scored seller leads delivered before the "
                   "first coffee — zero manual research."},
    ]
    if not key:
        return fallback
    try:
        resp = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={'x-api-key': key, 'anthropic-version': '2023-06-01',
                     'content-type': 'application/json'},
            json={
                'model': 'claude-opus-4-8',
                'max_tokens': 300,
                'messages': [{
                    'role': 'user',
                    'content': ('3 bullet points max 20 words each to pitch a B2B '
                                'PropTech to an investor. Return JSON only: '
                                '[{"bullet": "..."}]. Metrics: ' + json.dumps(metrics)),
                }],
            },
            timeout=20,
        )
        if resp.status_code != 200:
            logger.warning("pitch claude call failed: %s", resp.status_code)
            return fallback
        text = resp.json()['content'][0]['text']
        bullets = json.loads(text)
        if isinstance(bullets, list) and bullets:
            return bullets
    except Exception:
        logger.exception("pitch claude call errored — using fallback")
    return fallback


def register_roi_routes(app):

    @app.route('/api/appraisals/<int:appraisal_id>/won', methods=['PATCH'])
    def mark_appraisal_won(appraisal_id):
        """PERF-2 — mark a mandate won with its commission + source."""
        user, allowed_ids = resolve_request_scope()
        if not user:
            return jsonify({'error': 'unauthenticated'}), 401
        is_admin = allowed_ids is None
        body = request.get_json(silent=True) or {}
        commission = body.get('commission_value')
        source = (body.get('mandate_source') or 'manual').strip().lower()
        if source not in VALID_SOURCES:
            source = 'manual'
        try:
            commission = int(commission) if commission is not None else None
        except (TypeError, ValueError):
            return jsonify({'error': 'commission_value must be an integer'}), 400

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
        conn.execute(
            "UPDATE appraisals SET status = 'won', commission_value = ?, "
            "mandate_source = ? WHERE id = ?",
            (commission, source, appraisal_id)
        )
        conn.execute(
            "UPDATE appraisal_followups SET status = 'skipped' "
            "WHERE appraisal_id = ? AND status = 'pending'", (appraisal_id,)
        )
        conn.commit()
        conn.close()
        return jsonify({'ok': True, 'commission_value': commission, 'mandate_source': source})

    @app.route('/api/roi/summary', methods=['GET'])
    def roi_summary():
        user, allowed_ids = resolve_request_scope()
        if not user:
            return jsonify({'error': 'unauthenticated'}), 401
        is_admin = allowed_ids is None
        conn = get_db()
        try:
            data = _roi_for(conn, None if is_admin else user['id'])
        finally:
            conn.close()
        return jsonify(data)

    @app.route('/api/admin/pitch-snapshot', methods=['GET'])
    def pitch_snapshot():
        _u, err = _require_admin()
        if err:
            return err
        conn = get_db()
        try:
            metrics = _roi_for(conn, None)  # all users
        finally:
            conn.close()
        return jsonify({'metrics': metrics, 'bullets': _claude_bullets(metrics)})

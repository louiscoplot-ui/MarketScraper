"""Signal-loop HTTP routes (LOOP-2+). Registered from app.py via
register_signals_routes(app). Every route is scope-gated: admin-only
triggers use _require_admin(); per-property reads use resolve_request_scope().
"""
import io
import json as _json
import logging

from flask import request, jsonify, Response

from database import get_db
from admin_api import _require_admin, resolve_request_scope

logger = logging.getLogger(__name__)

_DOCX_MIME = ('application/vnd.openxmlformats-officedocument'
              '.wordprocessingml.document')


def register_signals_routes(app):

    @app.route('/api/signals/withdrawn-orphans/run', methods=['POST'])
    def run_withdrawn_orphans():
        """LOOP-2 manual trigger — detect withdrawn orphans and create
        Pipeline leads. Admin-only. The nightly cron calls the same
        process function directly."""
        _u, err = _require_admin()
        if err:
            return err
        from signals.withdrawn_orphan import process_withdrawn_orphans
        result = process_withdrawn_orphans()
        return jsonify(result)

    @app.route('/api/signals/withdrawn-orphans/letter/<int:listing_id>',
               methods=['GET'])
    def withdrawn_orphan_letter(listing_id):
        """Download the withdrawn-orphan letter (.docx) for one listing.
        Scope-gated: non-admins may only fetch letters for their suburbs."""
        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        row = conn.execute(
            "SELECT suburb_id FROM listings WHERE id = ?", (listing_id,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'listing not found'}), 404
        if allowed_ids is not None and dict(row)['suburb_id'] not in allowed_ids:
            return jsonify({'error': 'forbidden'}), 403

        from signals.withdrawn_orphan import build_orphan_letter
        doc, filename = build_orphan_letter(listing_id)
        if doc is None:
            return jsonify({'error': 'listing not found'}), 404

        buf = io.BytesIO()
        doc.save(buf)
        buf.seek(0)
        return Response(
            buf.getvalue(),
            mimetype=_DOCX_MIME,
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )

    @app.route('/api/signals/sale-fallen/run', methods=['POST'])
    def run_sale_fallen():
        """LOOP-3 manual trigger — alert agents about sale-fallen listings and
        expire stale ones. Admin-only. Sends are gated behind SIGNALS_LIVE; the
        response reports dry_run=true when the flag is off (nothing sent)."""
        _u, err = _require_admin()
        if err:
            return err
        from signals.sale_fallen import (
            process_sale_fallen_alerts, expire_old_sale_fallen)
        result = process_sale_fallen_alerts()
        result['expired'] = expire_old_sale_fallen()
        return jsonify(result)

    @app.route('/api/signals/sale-fallen', methods=['GET'])
    def sale_fallen_list():
        """LOOP-3 — live sale-fallen details for the sidebar badge panel,
        scoped to the caller's suburbs (admins see all)."""
        _user, allowed_ids = resolve_request_scope()
        from signals.sale_fallen import list_sale_fallen
        return jsonify(list_sale_fallen(allowed_ids))

    @app.route('/api/signals/sale-fallen/count', methods=['GET'])
    def sale_fallen_count():
        """LOOP-3 dashboard badge — live (≤14d) sale-fallen count, scoped to
        the caller's suburbs (admins see all)."""
        _user, allowed_ids = resolve_request_scope()
        from signals.sale_fallen import active_sale_fallen_count
        return jsonify({'count': active_sale_fallen_count(allowed_ids)})

    @app.route('/api/signals/sold-reveals', methods=['GET'])
    def sold_reveals_list():
        """LOOP-4 — recent sold-price reveals, scoped to the caller's suburbs."""
        _user, allowed_ids = resolve_request_scope()
        from signals.sold_reveal import list_sold_reveals
        return jsonify(list_sold_reveals(allowed_ids))

    @app.route('/api/signals/sold-reveals/letters', methods=['GET'])
    def sold_reveal_letters():
        """LOOP-4 — neighbour-letter ZIP for one sold-price reveal. Scope-gated
        on the reveal's suburb. May exceed 25s (OSM), so the frontend must call
        this via BACKEND_DIRECT, not the Vercel proxy."""
        tid = request.args.get('transition_id', type=int)
        if not tid:
            return jsonify({'error': 'transition_id required'}), 400

        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        row = conn.execute(
            "SELECT l.suburb_id FROM listing_transitions t "
            "LEFT JOIN listings l ON l.id = t.listing_id WHERE t.id = ?",
            (tid,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'reveal not found'}), 404
        sub_id = dict(row).get('suburb_id')
        if allowed_ids is not None and sub_id not in allowed_ids:
            return jsonify({'error': 'forbidden'}), 403

        from signals.sold_reveal import build_sold_reveal_zip
        data, filename, _ = build_sold_reveal_zip(tid)
        if data is None:
            return jsonify({'error': 'reveal not found'}), 404
        if not data or len(data) < 30:
            # ZIP with no neighbour letters — OSM had nothing for the street.
            return jsonify({'error': 'no neighbours found for this sale'}), 404
        return Response(
            data, mimetype='application/zip',
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )

    @app.route('/api/signals/strata/letters', methods=['GET'])
    def strata_letters():
        """LOOP-6 — letters to every other unit in the strata complex of a
        sold unit, as a ZIP. Scope-gated on the sale's suburb."""
        tid = request.args.get('transition_id', type=int)
        if not tid:
            return jsonify({'error': 'transition_id required'}), 400
        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        row = conn.execute(
            "SELECT l.suburb_id FROM listing_transitions t "
            "LEFT JOIN listings l ON l.id = t.listing_id WHERE t.id = ?",
            (tid,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'sale not found'}), 404
        if allowed_ids is not None and dict(row).get('suburb_id') not in allowed_ids:
            return jsonify({'error': 'forbidden'}), 403

        from signals.strata_contagion import build_strata_letters_zip
        data, filename, _ = build_strata_letters_zip(tid)
        if data is None:
            return jsonify({'error': 'not a strata sale'}), 404
        if not data or len(data) < 30:
            return jsonify({'error': 'no other units found in this complex'}), 404
        return Response(
            data, mimetype='application/zip',
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )

    @app.route('/api/signals/rebuild', methods=['POST'])
    def rebuild_vendor_signals():
        """SENTINEL S2 manual trigger — recompute vendor_signals from the
        events ledger. Admin-only (the nightly cron calls the same function).
        Optional JSON body: {"suburb_ids": [1,2]}."""
        _u, err = _require_admin()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        sids = body.get('suburb_ids')
        from signals.signal_engine import rebuild_signals
        return jsonify(rebuild_signals(sids))

    @app.route('/api/signals', methods=['GET'])
    def list_vendor_signals():
        """SENTINEL S2 — vendor signals scoped to the caller's suburbs,
        highest score first. Filters: ?suburb=<name>&status=new|actioned|
        dismissed (default new)&limit=(<=200)."""
        _user, allowed_ids = resolve_request_scope()
        status = (request.args.get('status') or 'new').strip().lower()
        if status not in ('new', 'actioned', 'dismissed', 'all'):
            return jsonify({'error': 'invalid status filter'}), 400
        limit = max(1, min(request.args.get('limit', default=100, type=int)
                           or 100, 200))
        suburb_name = (request.args.get('suburb') or '').strip()

        where, params = [], []
        conn = get_db()
        try:
            if suburb_name:
                srow = conn.execute(
                    "SELECT id FROM suburbs WHERE LOWER(name) = ?",
                    (suburb_name.lower(),)
                ).fetchone()
                if not srow:
                    return jsonify({'error': 'unknown suburb'}), 404
                sid = dict(srow)['id']
                if allowed_ids is not None and sid not in allowed_ids:
                    return jsonify({'error': 'forbidden'}), 403
                where.append("v.suburb_id = ?"); params.append(sid)
            elif allowed_ids is not None:
                if not allowed_ids:
                    return jsonify({'signals': []})
                ph = ','.join(['?'] * len(allowed_ids))
                where.append(f"v.suburb_id IN ({ph})"); params.extend(allowed_ids)
            if status != 'all':
                where.append("v.status = ?"); params.append(status)

            clause = (" WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(
                "SELECT v.id, v.address, v.suburb_id, s.name AS suburb, "
                "v.score, v.reason_codes, v.source_event_ids, v.created_at, "
                "v.status FROM vendor_signals v "
                "LEFT JOIN suburbs s ON s.id = v.suburb_id"
                + clause + " ORDER BY v.score DESC, v.created_at DESC LIMIT ?",
                params + [limit]
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                try:
                    d['reason_codes'] = _json.loads(d.get('reason_codes') or '[]')
                except Exception:
                    d['reason_codes'] = []
                out.append(d)
            return jsonify({'signals': out})
        finally:
            conn.close()

    @app.route('/api/signals/<int:signal_id>', methods=['PATCH'])
    def patch_vendor_signal(signal_id):
        """SENTINEL S2 — mark a signal actioned / dismissed (UI buttons).
        Scope-gated on the signal's suburb."""
        body = request.get_json(silent=True) or {}
        new_status = (body.get('status') or '').strip().lower()
        if new_status not in ('new', 'actioned', 'dismissed'):
            return jsonify({'error': 'status must be new|actioned|dismissed'}), 400
        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT suburb_id FROM vendor_signals WHERE id = ?",
                (signal_id,)
            ).fetchone()
            if not row:
                return jsonify({'error': 'signal not found'}), 404
            if allowed_ids is not None and dict(row)['suburb_id'] not in allowed_ids:
                return jsonify({'error': 'forbidden'}), 403
            conn.execute(
                "UPDATE vendor_signals SET status = ? WHERE id = ?",
                (new_status, signal_id)
            )
            conn.commit()
            return jsonify({'id': signal_id, 'status': new_status})
        finally:
            conn.close()

    @app.route('/api/brief/today', methods=['GET'])
    def brief_today():
        """SENTINEL S4 — today's brief for the calling user. Served from the
        stored brief when the cron built one; otherwise built on the fly
        (no email) so the Today view always has content to show."""
        from admin_api import get_current_user
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Unauthenticated'}), 401
        from datetime import datetime as _dt
        today = _dt.utcnow().strftime('%Y-%m-%d')
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT id, items, brief_date, sent_at, opened_at FROM briefs "
                "WHERE user_id = ? ORDER BY brief_date DESC, id DESC LIMIT 1",
                (user['id'],)
            ).fetchone()
            if row and dict(row)['brief_date'] == today:
                d = dict(row)
                try:
                    items = _json.loads(d.get('items') or '[]')
                except Exception:
                    items = []
                return jsonify({'brief_id': d['id'], 'brief_date': d['brief_date'],
                                'items': items, 'live': False})
            # no brief yet today — build items live (no email, no narrative
            # API cost beyond the top-5 calls; falls back to reasons text)
            from signals.brief_builder import build_items
            items = build_items(conn, dict(user))
            return jsonify({'brief_id': None, 'brief_date': today,
                            'items': items, 'live': True})
        finally:
            conn.close()

    @app.route('/api/brief/action', methods=['POST'])
    def brief_action():
        """SENTINEL S4 — record a one-click action on a brief item
        (letter | call_logged | dismissed). Dismissed/actioned also updates
        the underlying vendor_signal so it leaves the working list."""
        from admin_api import get_current_user
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Unauthenticated'}), 401
        body = request.get_json(silent=True) or {}
        signal_id = body.get('signal_id')
        action = (body.get('action_type') or '').strip().lower()
        brief_id = body.get('brief_id')
        if not signal_id or action not in ('letter', 'call_logged', 'dismissed'):
            return jsonify({'error': 'signal_id and valid action_type required'}), 400
        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT suburb_id FROM vendor_signals WHERE id = ?",
                (signal_id,)
            ).fetchone()
            if not row:
                return jsonify({'error': 'signal not found'}), 404
            if allowed_ids is not None and dict(row)['suburb_id'] not in allowed_ids:
                return jsonify({'error': 'forbidden'}), 403
            cur = conn.execute(
                "INSERT INTO brief_actions (brief_id, signal_id, action_type) "
                "VALUES (?, ?, ?)", (brief_id, signal_id, action)
            )
            new_status = ('dismissed' if action == 'dismissed' else 'actioned')
            conn.execute(
                "UPDATE vendor_signals SET status = ? WHERE id = ?",
                (new_status, signal_id)
            )
            conn.commit()
            aid = conn.execute(
                "SELECT id FROM brief_actions WHERE signal_id = ? "
                "AND action_type = ? ORDER BY id DESC LIMIT 1",
                (signal_id, action)
            ).fetchone()
            return jsonify({'action_id': dict(aid)['id'] if aid else None,
                            'signal_status': new_status})
        finally:
            conn.close()

    @app.route('/api/brief/action/<int:action_id>', methods=['PATCH'])
    def brief_action_convert(action_id):
        """SENTINEL S4 — attribution: flag an actioned item as converted to
        an appraisal and/or a listing (the ONE manual input asked of the
        agent). Scope-gated via the action's signal suburb."""
        body = request.get_json(silent=True) or {}
        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT a.id, v.suburb_id FROM brief_actions a "
                "LEFT JOIN vendor_signals v ON v.id = a.signal_id "
                "WHERE a.id = ?", (action_id,)
            ).fetchone()
            if not row:
                return jsonify({'error': 'action not found'}), 404
            if allowed_ids is not None and dict(row)['suburb_id'] not in allowed_ids:
                return jsonify({'error': 'forbidden'}), 403
            sets, params = [], []
            for field in ('converted_to_appraisal', 'converted_to_listing'):
                if field in body:
                    sets.append(f"{field} = ?")
                    params.append(1 if body[field] else 0)
            if not sets:
                return jsonify({'error': 'nothing to update'}), 400
            params.append(action_id)
            conn.execute(
                f"UPDATE brief_actions SET {', '.join(sets)} WHERE id = ?",
                params)
            conn.commit()
            return jsonify({'id': action_id, 'updated': True})
        finally:
            conn.close()

    @app.route('/api/brief/letter/<int:signal_id>', methods=['GET'])
    def brief_letter(signal_id):
        """SENTINEL S4 — .docx letter for one brief item, body adapted to
        the signal type. Scope-gated on the signal's suburb. Frontend must
        download via fetch+blob (window.open bypasses X-Access-Key)."""
        from admin_api import get_current_user
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Unauthenticated'}), 401
        _user, allowed_ids = resolve_request_scope()
        conn = get_db()
        row = conn.execute(
            "SELECT suburb_id FROM vendor_signals WHERE id = ?", (signal_id,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'signal not found'}), 404
        if allowed_ids is not None and dict(row)['suburb_id'] not in allowed_ids:
            return jsonify({'error': 'forbidden'}), 403

        from signals.brief_letter import build_brief_letter
        doc, filename = build_brief_letter(signal_id, dict(user))
        if doc is None:
            return jsonify({'error': 'signal not found'}), 404
        buf = io.BytesIO()
        doc.save(buf)
        buf.seek(0)
        return Response(
            buf.getvalue(), mimetype=_DOCX_MIME,
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )

    @app.route('/api/brief/open/<token>.gif', methods=['GET'])
    def brief_open_pixel(token):
        """SENTINEL S4 — email open-tracking pixel. Auth-exempt (loaded by
        the recipient's mail client): the token is a 24-byte random secret
        per brief, so this endpoint leaks nothing and only ever sets
        opened_at once."""
        conn = get_db()
        try:
            conn.execute(
                "UPDATE briefs SET opened_at = COALESCE(opened_at, ?) "
                "WHERE open_token = ?",
                (__import__('datetime').datetime.utcnow().isoformat(), token)
            )
            conn.commit()
        except Exception:
            conn.rollback()
        finally:
            conn.close()
        # 1x1 transparent GIF
        gif = (b'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\x00\x00\x00'
               b'!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01'
               b'\x00\x00\x02\x02D\x01\x00;')
        return Response(gif, mimetype='image/gif',
                        headers={'Cache-Control': 'no-store'})

    @app.route('/api/precision', methods=['GET'])
    def prediction_precision():
        """SENTINEL S3 — prediction ledger stats (made / confirmed listed /
        expired / hit rate, by month), scoped to the caller's suburbs."""
        _user, allowed_ids = resolve_request_scope()
        from signals.prediction_ledger import precision_stats
        return jsonify(precision_stats(allowed_ids))

    @app.route('/api/events', methods=['GET'])
    def list_events():
        """SENTINEL S1 — the listing_events ledger, scoped to the caller's
        suburbs. Filters: ?suburb=<name>&type=<event_type>&days=30 ;
        pagination via ?limit=(<=100)&offset=."""
        _user, allowed_ids = resolve_request_scope()

        etype = (request.args.get('type') or '').strip().lower()
        days = request.args.get('days', default=30, type=int)
        days = max(1, min(days or 30, 365))
        limit = request.args.get('limit', default=100, type=int)
        limit = max(1, min(limit or 100, 100))
        offset = max(0, request.args.get('offset', default=0, type=int))
        suburb_name = (request.args.get('suburb') or '').strip()

        where, params = [], []
        conn = get_db()
        try:
            if suburb_name:
                srow = conn.execute(
                    "SELECT id FROM suburbs WHERE LOWER(name) = ?",
                    (suburb_name.lower(),)
                ).fetchone()
                if not srow:
                    return jsonify({'error': 'unknown suburb'}), 404
                sid = dict(srow)['id']
                if allowed_ids is not None and sid not in allowed_ids:
                    return jsonify({'error': 'forbidden'}), 403
                where.append("e.suburb_id = ?"); params.append(sid)
            elif allowed_ids is not None:
                if not allowed_ids:
                    return jsonify({'events': [], 'total': 0})
                ph = ','.join(['?'] * len(allowed_ids))
                where.append(f"e.suburb_id IN ({ph})"); params.extend(allowed_ids)

            if etype:
                where.append("e.event_type = ?"); params.append(etype)
            # Cross-driver day window: detected_at is ISO TEXT on both
            # drivers (space- or T-separated). A date-only cutoff string
            # compares correctly against either format.
            from datetime import datetime, timedelta
            cutoff = (datetime.utcnow() - timedelta(days=days)).strftime('%Y-%m-%d')
            where.append("e.detected_at >= ?"); params.append(cutoff)

            clause = (" WHERE " + " AND ".join(where)) if where else ""
            total = dict(conn.execute(
                "SELECT COUNT(*) AS c FROM listing_events e" + clause, params
            ).fetchone())['c']
            rows = conn.execute(
                "SELECT e.id, e.listing_id, e.suburb_id, s.name AS suburb, "
                "e.address, e.event_type, e.old_value, e.new_value, "
                "e.detected_at, e.source "
                "FROM listing_events e LEFT JOIN suburbs s ON s.id = e.suburb_id"
                + clause + " ORDER BY e.detected_at DESC LIMIT ? OFFSET ?",
                params + [limit, offset]
            ).fetchall()
            return jsonify({'events': [dict(r) for r in rows], 'total': total,
                            'limit': limit, 'offset': offset})
        finally:
            conn.close()

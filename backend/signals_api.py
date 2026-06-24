"""Signal-loop HTTP routes (LOOP-2+). Registered from app.py via
register_signals_routes(app). Every route is scope-gated: admin-only
triggers use _require_admin(); per-property reads use resolve_request_scope().
"""
import io
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

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

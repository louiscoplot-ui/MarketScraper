"""Appraisal Pipeline routes — endpoints + helper functions."""

import re
import logging
from datetime import datetime, timedelta, date
from io import BytesIO
from flask import request, jsonify, send_file

from database import get_db, normalize_address, USE_POSTGRES
from pipeline_letter import render_letter_docx

logger = logging.getLogger(__name__)


_ADDR_RE = re.compile(r'^(\d+)([A-Za-z]?)\s+(.+)$')
INSERT_CHUNK = 50


def _source_limit(days):
    return min(max(days * 3, 5), 60)


def _parse_address(addr):
    if not addr:
        return None
    addr = addr.strip()
    if '/' in addr.split()[0]:
        return None
    m = _ADDR_RE.match(addr)
    if not m:
        return None
    try:
        num = int(m.group(1))
    except ValueError:
        return None
    return num, m.group(2), m.group(3).strip()


def _generate_neighbours(addr):
    parsed = _parse_address(addr)
    if not parsed:
        return []
    num, _suffix, street = parsed
    out = []
    for offset in (-2, -1, 1, 2):
        target = num + offset
        if target <= 0:
            continue
        out.append(f"{target} {street}")
    return out


def _hot_vendors_table_exists(conn):
    try:
        if USE_POSTGRES:
            row = conn.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'hot_vendor_properties' LIMIT 1"
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'hot_vendor_properties' LIMIT 1"
            ).fetchone()
        return bool(row)
    except Exception:
        return False


def _match_hot_vendor(conn, target_address):
    try:
        norm = normalize_address(target_address)
        if not norm:
            return None, None
        row = conn.execute(
            "SELECT current_owner, final_score FROM hot_vendor_properties "
            "WHERE normalized_address = ? "
            "ORDER BY final_score DESC LIMIT 1",
            (norm,)
        ).fetchone()
        if not row:
            return None, None
        d = dict(row)
        return d.get('current_owner'), d.get('final_score')
    except Exception:
        return None, None


def _enrich_owner_names(conn, suburb=None):
    """Back-fill pipeline_tracking.target_owner_name from
    hot_vendor_properties.current_owner whenever the pipeline row
    has no owner yet. Matches on normalized_address. Idempotent —
    cheap to call before every read of the pipeline."""
    if not _hot_vendors_table_exists(conn):
        return 0
    try:
        if suburb:
            rows = conn.execute(
                "SELECT id, target_address FROM pipeline_tracking "
                "WHERE (target_owner_name IS NULL OR target_owner_name = '') "
                "AND LOWER(source_suburb) = LOWER(?)",
                (suburb,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, target_address FROM pipeline_tracking "
                "WHERE target_owner_name IS NULL OR target_owner_name = ''"
            ).fetchall()
    except Exception as e:
        logger.warning(f"enrich_owner_names lookup failed: {e}")
        return 0

    updated = 0
    for r in rows:
        target_addr = r['target_address']
        if not target_addr:
            continue
        norm = normalize_address(target_addr)
        if not norm:
            continue
        try:
            match = conn.execute(
                "SELECT current_owner FROM hot_vendor_properties "
                "WHERE normalized_address = ? AND current_owner IS NOT NULL "
                "AND current_owner != '' "
                "ORDER BY final_score DESC LIMIT 1",
                (norm,)
            ).fetchone()
        except Exception:
            continue
        if match and match['current_owner']:
            try:
                conn.execute(
                    "UPDATE pipeline_tracking SET target_owner_name = ? WHERE id = ?",
                    (match['current_owner'], r['id'])
                )
                updated += 1
            except Exception:
                pass
    if updated:
        try:
            conn.commit()
        except Exception:
            pass
        logger.info(f"Enriched {updated} pipeline owner names from hot_vendor_properties")
    return updated


def _serialize_entries(rows):
    out = []
    for r in rows:
        d = dict(r)
        for k, v in list(d.items()):
            if isinstance(v, (date, datetime)):
                d[k] = v.isoformat()
        out.append(d)
    return out


def _price_to_int(*candidates):
    for c in candidates:
        if c is None or c == '':
            continue
        s = str(c)
        digits = re.sub(r'[^\d]', '', s)
        if digits:
            try:
                return int(digits)
            except ValueError:
                pass
    return None


def _bulk_insert_pipeline(conn, rows):
    if not rows:
        return 0

    inserted = 0
    cols = ('source_address', 'source_suburb', 'source_sold_date',
            'source_price', 'target_address', 'target_owner_name',
            'hot_vendor_score')
    n_cols = len(cols)

    for i in range(0, len(rows), INSERT_CHUNK):
        chunk = rows[i:i + INSERT_CHUNK]
        single = '(' + ', '.join(['?'] * n_cols) + ", 'sent')"
        values_clause = ', '.join([single] * len(chunk))
        sql = (
            f"INSERT INTO pipeline_tracking ({', '.join(cols)}, status) "
            f"VALUES {values_clause} "
            f"ON CONFLICT (target_address, sent_date) DO NOTHING"
        )
        flat_params = [v for row in chunk for v in row]
        cur = conn.execute(sql, flat_params)
        if cur.rowcount and cur.rowcount > 0:
            inserted += cur.rowcount

    return inserted


def _gather_sources_for_target(conn, target_address, source_suburb):
    """Distinct nearby sales for a target. Dedupes by source_address so
    duplicate pipeline_tracking rows don't make the letter say
    'sold for X — for X respectively'."""
    rows = conn.execute(
        """
        SELECT source_address, source_price, source_sold_date, target_owner_name
        FROM pipeline_tracking
        WHERE LOWER(target_address) = LOWER(?)
          AND LOWER(source_suburb) = LOWER(?)
        ORDER BY created_at DESC
        """,
        (target_address, source_suburb)
    ).fetchall()
    seen = set()
    deduped = []
    for r in rows:
        d = dict(r)
        key = (d.get('source_address') or '').strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(d)
    deduped.sort(key=lambda d: (d.get('source_address') or '').lower())
    return deduped


# ---------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------

def pipeline_generate():
    suburb = (request.args.get('suburb') or '').strip()
    if not suburb:
        return jsonify({'error': 'suburb is required'}), 400

    try:
        days = int(request.args.get('days') or 7)
    except ValueError:
        days = 7
    days = max(1, min(days, 90))

    cutoff_date = (datetime.utcnow() - timedelta(days=days)).date().isoformat()
    src_limit = _source_limit(days)

    conn = get_db()
    has_hv = _hot_vendors_table_exists(conn)

    sold_rows = conn.execute(
        """
        SELECT l.address, l.sold_price, l.price_text, l.sold_date,
               l.first_seen, l.last_seen, s.name AS suburb_name,
               COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) AS effective_date
        FROM listings l
        JOIN suburbs s ON l.suburb_id = s.id
        WHERE l.status = 'sold'
          AND LOWER(s.name) = LOWER(?)
          AND COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) >= ?
        ORDER BY COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) DESC,
                 l.first_seen DESC
        LIMIT ?
        """,
        (suburb, cutoff_date, src_limit)
    ).fetchall()

    sold_count = len(sold_rows)

    insert_rows = []
    for r in sold_rows:
        source_address = r['address']
        source_suburb = r['suburb_name']
        source_price = _price_to_int(r['sold_price'], r['price_text'])
        source_sold_date = r['effective_date']
        for target in _generate_neighbours(source_address):
            if has_hv:
                owner, score = _match_hot_vendor(conn, target)
            else:
                owner, score = None, None
            insert_rows.append((
                source_address, source_suburb, source_sold_date,
                source_price, target, owner, score,
            ))

    generated = _bulk_insert_pipeline(conn, insert_rows)
    conn.commit()

    rows = conn.execute(
        """
        SELECT * FROM pipeline_tracking
        WHERE LOWER(source_suburb) = LOWER(?)
        ORDER BY created_at DESC
        LIMIT 500
        """,
        (suburb,)
    ).fetchall()
    entries = _serialize_entries(rows)
    conn.close()

    return jsonify({
        'generated': generated,
        'sold_count': sold_count,
        'suburb': suburb,
        'cap_applied': sold_count >= src_limit,
        'entries': entries,
    })


def pipeline_manual_add():
    data = request.get_json(silent=True) or {}
    source_address = (data.get('source_address') or '').strip()
    source_suburb = (data.get('source_suburb') or '').strip()
    if not source_address:
        return jsonify({'error': 'source_address is required'}), 400
    if not source_suburb:
        return jsonify({'error': 'source_suburb is required'}), 400

    source_price = _price_to_int(data.get('source_price'))
    source_sold_date = (data.get('source_sold_date') or '').strip() or \
        date.today().isoformat()

    explicit_targets = data.get('target_addresses') or []
    if not isinstance(explicit_targets, list):
        return jsonify({'error': 'target_addresses must be a list'}), 400
    explicit_targets = [t.strip() for t in explicit_targets
                        if isinstance(t, str) and t.strip()]

    if explicit_targets:
        targets = explicit_targets
    else:
        targets = _generate_neighbours(source_address)
        if not targets:
            return jsonify({
                'error': (
                    f"Couldn't auto-generate neighbours from '{source_address}' "
                    "(strata or non-numeric address). Provide target_addresses "
                    "explicitly."
                )
            }), 400

    conn = get_db()
    has_hv = _hot_vendors_table_exists(conn)

    insert_rows = []
    for target in targets:
        if has_hv:
            owner, score = _match_hot_vendor(conn, target)
        else:
            owner, score = None, None
        insert_rows.append((
            source_address, source_suburb, source_sold_date,
            source_price, target, owner, score,
        ))

    generated = _bulk_insert_pipeline(conn, insert_rows)
    conn.commit()

    rows = conn.execute(
        """
        SELECT * FROM pipeline_tracking
        WHERE LOWER(source_address) = LOWER(?)
          AND LOWER(source_suburb) = LOWER(?)
          AND sent_date = ?
        ORDER BY target_address ASC
        """,
        (source_address, source_suburb, date.today().isoformat())
    ).fetchall()
    entries = _serialize_entries(rows)
    conn.close()

    return jsonify({
        'generated': generated,
        'attempted': len(targets),
        'targets': targets,
        'source_address': source_address,
        'source_suburb': source_suburb,
        'entries': entries,
    })


def pipeline_tracking_list():
    suburb = (request.args.get('suburb') or '').strip()
    status = (request.args.get('status') or '').strip()
    try:
        limit = int(request.args.get('limit') or 100)
    except ValueError:
        limit = 100
    limit = max(1, min(limit, 1000))

    conn = get_db()
    _enrich_owner_names(conn, suburb or None)
    sql = "SELECT * FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND LOWER(source_suburb) = LOWER(?)"
        params.append(suburb)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return jsonify({'entries': _serialize_entries(rows)})


def pipeline_tracking_grouped():
    suburb = (request.args.get('suburb') or '').strip()
    try:
        limit = int(request.args.get('limit') or 200)
    except ValueError:
        limit = 200
    limit = max(1, min(limit, 1000))

    conn = get_db()
    # Auto-fill owner names from latest hot_vendor_properties data
    _enrich_owner_names(conn, suburb or None)

    sql = "SELECT * FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND LOWER(source_suburb) = LOWER(?)"
        params.append(suburb)
    sql += " ORDER BY target_address ASC, created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    groups = {}
    for raw in rows:
        r = dict(raw)
        for k, v in list(r.items()):
            if isinstance(v, (date, datetime)):
                r[k] = v.isoformat()
        key = (r['target_address'].lower().strip(),
               (r.get('source_suburb') or '').lower().strip())
        if key not in groups:
            groups[key] = {
                'target_address': r['target_address'],
                'source_suburb': r.get('source_suburb'),
                'target_owner_name': r.get('target_owner_name'),
                'hot_vendor_score': r.get('hot_vendor_score'),
                'status': r.get('status'),
                'sent_date': r.get('sent_date'),
                'response_date': r.get('response_date'),
                'notes': r.get('notes'),
                'representative_id': r.get('id'),
                'row_ids': [],
                'sources': [],
                '_source_addrs_seen': set(),
            }
        g = groups[key]
        g['row_ids'].append(r['id'])
        src_addr_key = (r.get('source_address') or '').strip().lower()
        if src_addr_key and src_addr_key not in g['_source_addrs_seen']:
            g['_source_addrs_seen'].add(src_addr_key)
            g['sources'].append({
                'source_address': r.get('source_address'),
                'source_price': r.get('source_price'),
                'source_sold_date': r.get('source_sold_date'),
                'row_id': r.get('id'),
            })
        if not g.get('target_owner_name') and r.get('target_owner_name'):
            g['target_owner_name'] = r.get('target_owner_name')
        if g.get('hot_vendor_score') is None and r.get('hot_vendor_score') is not None:
            g['hot_vendor_score'] = r.get('hot_vendor_score')

    grouped = list(groups.values())
    for g in grouped:
        g['sources'].sort(key=lambda s: (s.get('source_address') or '').lower())
        g.pop('_source_addrs_seen', None)
    grouped.sort(key=lambda g: (
        (g['sources'][0].get('source_address') if g['sources'] else g['target_address'] or '').lower()
    ))
    grouped = grouped[:limit]
    return jsonify({'groups': grouped, 'count': len(grouped)})


def pipeline_tracking_update(id):
    data = request.get_json(silent=True) or {}
    allowed = ('status', 'response_date', 'notes', 'target_owner_name')

    sets = []
    params = []
    for key in allowed:
        if key in data:
            sets.append(f"{key} = ?")
            params.append(data[key])

    if not sets:
        return jsonify({'error': 'No updatable fields provided'}), 400

    propagate_owner = 'target_owner_name' in data

    conn = get_db()
    target_row = conn.execute(
        "SELECT target_address, source_suburb FROM pipeline_tracking WHERE id = ?",
        (id,)
    ).fetchone()
    if not target_row:
        conn.close()
        return jsonify({'error': 'Not found'}), 404

    if propagate_owner:
        conn.execute(
            "UPDATE pipeline_tracking SET target_owner_name = ? "
            "WHERE LOWER(target_address) = LOWER(?) AND LOWER(source_suburb) = LOWER(?)",
            (data['target_owner_name'], target_row['target_address'], target_row['source_suburb'])
        )

    other_sets = [s for s in sets if not s.startswith('target_owner_name')]
    if other_sets:
        other_params = []
        for key in allowed:
            if key == 'target_owner_name':
                continue
            if key in data:
                other_params.append(data[key])
        other_params.append(id)
        conn.execute(
            f"UPDATE pipeline_tracking SET {', '.join(other_sets)} WHERE id = ?",
            other_params
        )

    conn.commit()
    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(_serialize_entries([row])[0])


def pipeline_tracking_clear():
    if (request.args.get('confirm') or '').lower() != 'yes':
        return jsonify({
            'error': 'Add ?confirm=yes to actually delete. This is destructive.'
        }), 400

    suburb = (request.args.get('suburb') or '').strip()
    status = (request.args.get('status') or '').strip()
    if not suburb and not status:
        return jsonify({
            'error': 'At least suburb or status must be provided. '
                     'Refusing to wipe the entire table.'
        }), 400

    conn = get_db()
    sql = "DELETE FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND LOWER(source_suburb) = LOWER(?)"
        params.append(suburb)
    if status:
        sql += " AND status = ?"
        params.append(status)
    cur = conn.execute(sql, params)
    deleted = cur.rowcount or 0
    conn.commit()
    conn.close()
    return jsonify({'deleted': deleted, 'suburb': suburb or None, 'status': status or None})


def pipeline_letter_download(id):
    conn = get_db()
    # Make sure the letter uses the freshest owner name from hot_vendor data
    _enrich_owner_names(conn, None)

    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Letter not found'}), 404

    entry = dict(row)
    target_address = entry.get('target_address') or ''
    source_suburb = entry.get('source_suburb') or ''

    sources = _gather_sources_for_target(conn, target_address, source_suburb)
    conn.close()

    if not sources:
        sources = [{
            'source_address': entry.get('source_address'),
            'source_price': entry.get('source_price'),
            'source_sold_date': entry.get('source_sold_date'),
        }]

    owner_name = entry.get('target_owner_name')
    if not owner_name:
        for s in sources:
            n = (s.get('target_owner_name') or '').strip()
            if n:
                owner_name = n
                break

    doc = render_letter_docx(target_address, owner_name, source_suburb, sources)

    buf = BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe = re.sub(r'[^\w\s-]', '', target_address)[:60].strip().replace(' ', '_')
    filename = f"letter_{safe or 'letter'}.docx"
    return send_file(
        buf,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=filename,
    )


def pipeline_enrich_owners():
    """Manual trigger — back-fill owner names across the whole pipeline
    (or one suburb) from the latest hot_vendor_properties data. Useful
    right after uploading a fresh RP Data CSV."""
    suburb = (request.args.get('suburb') or '').strip() or None
    conn = get_db()
    updated = _enrich_owner_names(conn, suburb)
    conn.close()
    return jsonify({'updated': updated, 'suburb': suburb})


# ---------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------

def register_pipeline_routes(app):
    app.add_url_rule('/api/pipeline/generate', endpoint='pipeline_generate',
                     view_func=pipeline_generate, methods=['GET'])
    app.add_url_rule('/api/pipeline/manual-add', endpoint='pipeline_manual_add',
                     view_func=pipeline_manual_add, methods=['POST'])
    app.add_url_rule('/api/pipeline/tracking', endpoint='pipeline_tracking_list',
                     view_func=pipeline_tracking_list, methods=['GET'])
    app.add_url_rule('/api/pipeline/tracking/grouped', endpoint='pipeline_tracking_grouped',
                     view_func=pipeline_tracking_grouped, methods=['GET'])
    app.add_url_rule('/api/pipeline/tracking/<int:id>', endpoint='pipeline_tracking_update',
                     view_func=pipeline_tracking_update, methods=['PATCH'])
    app.add_url_rule('/api/pipeline/tracking', endpoint='pipeline_tracking_clear',
                     view_func=pipeline_tracking_clear, methods=['DELETE'])
    app.add_url_rule('/api/pipeline/letter/<int:id>/download',
                     endpoint='pipeline_letter_download',
                     view_func=pipeline_letter_download, methods=['GET'])
    app.add_url_rule('/api/pipeline/enrich-owners', endpoint='pipeline_enrich_owners',
                     view_func=pipeline_enrich_owners, methods=['POST'])
    logger.info(
        "Pipeline routes: /api/pipeline/{generate,manual-add,tracking,letter/<id>/download,enrich-owners}"
    )

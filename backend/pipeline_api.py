"""Appraisal Pipeline routes — endpoints + helper functions."""

import re
import logging
from datetime import datetime, timedelta, date
from io import BytesIO
from flask import request, jsonify, send_file

from database import get_db, USE_POSTGRES

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
                "WHERE table_schema = 'public' AND table_name = 'hot_vendors' LIMIT 1"
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'hot_vendors' LIMIT 1"
            ).fetchone()
        return bool(row)
    except Exception:
        return False


def _match_hot_vendor(conn, target_address):
    try:
        row = conn.execute(
            "SELECT * FROM hot_vendors WHERE LOWER(address) LIKE LOWER(?) LIMIT 1",
            (f"%{target_address}%",)
        ).fetchone()
        if not row:
            return None, None
        d = dict(row)
        owner = d.get('owner_name') or d.get('owner') or d.get('current_owner')
        score = d.get('score') or d.get('final_score') or d.get('hot_score')
        return owner, score
    except Exception:
        return None, None


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


def pipeline_tracking_list():
    suburb = (request.args.get('suburb') or '').strip()
    status = (request.args.get('status') or '').strip()
    try:
        limit = int(request.args.get('limit') or 100)
    except ValueError:
        limit = 100
    limit = max(1, min(limit, 1000))

    conn = get_db()
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

    params.append(id)

    conn = get_db()
    conn.execute(
        f"UPDATE pipeline_tracking SET {', '.join(sets)} WHERE id = ?",
        params
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
    """DELETE rows by suburb (and optional status). Requires confirm=yes."""
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

    return jsonify({
        'deleted': deleted,
        'suburb': suburb or None,
        'status': status or None,
    })


def pipeline_letter_download(id):
    """Generate a .docx prospecting letter for one tracking entry.

    The user opens it in Word, can manually edit owner_name / tone /
    address details before printing or posting. Branded Belle Property
    Cottesloe — generic enough to swap in any agency template later.
    """
    from docx import Document
    from docx.shared import Pt, RGBColor, Cm

    conn = get_db()
    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    conn.close()

    if not row:
        return jsonify({'error': 'Letter not found'}), 404

    entry = dict(row)
    owner = (entry.get('target_owner_name') or '').strip() or 'Homeowner'
    source_addr = entry.get('source_address') or ''
    target_addr = entry.get('target_address') or ''
    source_suburb = entry.get('source_suburb') or ''
    source_price = entry.get('source_price')
    price_str = f"${int(source_price):,}" if source_price else ''

    doc = Document()

    # Tighter margins so the letter fills a single page.
    for section in doc.sections:
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    # Letterhead — bold all-caps brand line + small grey office address.
    head = doc.add_paragraph()
    r = head.add_run('BELLE PROPERTY  |  Cottesloe')
    r.bold = True
    r.font.size = Pt(20)

    addr = doc.add_paragraph()
    r = addr.add_run('160 Stirling Highway, Nedlands WA 6009')
    r.font.size = Pt(10)
    r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()

    # Date in long form.
    today = datetime.utcnow().strftime('%d %B %Y')
    p = doc.add_paragraph(today)
    p.runs[0].font.size = Pt(11)

    doc.add_paragraph()

    doc.add_paragraph(f'Dear {owner},')
    doc.add_paragraph()

    doc.add_paragraph('I hope this letter finds you well.')

    p = doc.add_paragraph()
    p.add_run('I wanted to reach out personally — your neighbour at ')
    bold = p.add_run(source_addr)
    bold.bold = True
    p.add_run(' recently sold for ')
    bold = p.add_run(price_str)
    bold.bold = True
    p.add_run(f", one of {source_suburb}'s strongest results this season.")

    p = doc.add_paragraph()
    p.add_run(
        f'With buyer demand remaining high across {source_suburb}, this '
        f'could be the ideal moment to understand what your property at '
    )
    bold = p.add_run(target_addr)
    bold.bold = True
    p.add_run(" is truly worth in today's market.")

    doc.add_paragraph(
        'I would love to offer you a complimentary, no-obligation market '
        'appraisal at a time that suits you — no pressure, just clarity.'
    )

    doc.add_paragraph("Please don't hesitate to reach out.")

    doc.add_paragraph()
    doc.add_paragraph('Warm regards,')
    doc.add_paragraph()

    sig = doc.add_paragraph()
    r = sig.add_run('Louis Coplot')
    r.bold = True
    r.font.size = Pt(13)

    doc.add_paragraph('Sales Agent | Belle Property Cottesloe')
    doc.add_paragraph('M: 0400 XXX XXX')
    doc.add_paragraph('E: louis@belleproperty.com.au')
    doc.add_paragraph('W: belleproperty.com.au/cottesloe')

    buf = BytesIO()
    doc.save(buf)
    buf.seek(0)

    # Filename like 'letter_4_Torrens_Street.docx' — sanitised for FS safety.
    safe = re.sub(r'[^\w\s-]', '', target_addr)[:60].strip().replace(' ', '_')
    filename = f"letter_{safe or 'letter'}.docx"

    return send_file(
        buf,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=filename,
    )


# ---------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------

def register_pipeline_routes(app):
    app.add_url_rule(
        '/api/pipeline/generate',
        endpoint='pipeline_generate',
        view_func=pipeline_generate,
        methods=['GET']
    )
    app.add_url_rule(
        '/api/pipeline/tracking',
        endpoint='pipeline_tracking_list',
        view_func=pipeline_tracking_list,
        methods=['GET']
    )
    app.add_url_rule(
        '/api/pipeline/tracking/<int:id>',
        endpoint='pipeline_tracking_update',
        view_func=pipeline_tracking_update,
        methods=['PATCH']
    )
    app.add_url_rule(
        '/api/pipeline/tracking',
        endpoint='pipeline_tracking_clear',
        view_func=pipeline_tracking_clear,
        methods=['DELETE']
    )
    app.add_url_rule(
        '/api/pipeline/letter/<int:id>/download',
        endpoint='pipeline_letter_download',
        view_func=pipeline_letter_download,
        methods=['GET']
    )
    logger.info(
        "Pipeline routes registered: /api/pipeline/{generate,tracking[,/<id>],letter/<id>/download}"
    )

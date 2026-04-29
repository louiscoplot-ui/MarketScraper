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
# Letter rendering helpers
# ---------------------------------------------------------------------

def _format_price(p):
    if p is None or p == '':
        return ''
    try:
        return f"${int(p):,}"
    except (TypeError, ValueError):
        return ''


def _format_sources_inline(sources):
    """Build the human prose listing N source sales.

    1 source : "your neighbour at 28 Lillian Street recently sold for $2,700,000"
    2 source : "your neighbours at 28 Lillian Street and 30 Lillian Street recently
                sold — for $2,700,000 and $2,950,000 respectively"
    3+      : Oxford-comma list, each address with its price.

    Strips the price clause when the price is missing so we never write
    "sold for $". Keeps copy natural for any count.
    """
    if not sources:
        return '', ''

    n = len(sources)
    addrs = [s['source_address'] for s in sources]
    prices = [_format_price(s.get('source_price')) for s in sources]
    has_prices = [bool(p) for p in prices]

    def join_oxford(items):
        if len(items) == 0:
            return ''
        if len(items) == 1:
            return items[0]
        if len(items) == 2:
            return f"{items[0]} and {items[1]}"
        return ', '.join(items[:-1]) + f", and {items[-1]}"

    if n == 1:
        addr_phrase = f"your neighbour at {addrs[0]}"
        if has_prices[0]:
            sale_phrase = f"recently sold for {prices[0]}"
        else:
            sale_phrase = "recently sold"
    else:
        addr_phrase = f"your neighbours at {join_oxford(addrs)}"
        if all(has_prices):
            sale_phrase = (
                f"recently sold — for {join_oxford(prices)} respectively"
            )
        elif any(has_prices):
            paired = [
                f"{a} ({p})" if p else a
                for a, p in zip(addrs, prices)
            ]
            addr_phrase = f"your neighbours at {join_oxford(paired)}"
            sale_phrase = "recently sold"
        else:
            sale_phrase = "recently sold"

    return addr_phrase, sale_phrase


def _render_letter_docx(target_address, owner_name, source_suburb, sources):
    """Build a Belle Property letter as a python-docx Document.

    sources: list of dicts with source_address, source_price (optional).
             N >= 1 — caller filters out empty groups.
    """
    from docx import Document
    from docx.shared import Pt, RGBColor, Cm

    owner = (owner_name or '').strip() or 'Homeowner'
    addr_phrase, sale_phrase = _format_sources_inline(sources)

    # Pitch wording shifts subtly when there's more than one nearby sale:
    # one neighbour = "could be the ideal moment", multi = "with this
    # level of activity on your doorstep" — sounds more compelling.
    multi = len(sources) > 1

    doc = Document()
    for section in doc.sections:
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    head = doc.add_paragraph()
    r = head.add_run('BELLE PROPERTY  |  Cottesloe')
    r.bold = True
    r.font.size = Pt(20)

    addr = doc.add_paragraph()
    r = addr.add_run('160 Stirling Highway, Nedlands WA 6009')
    r.font.size = Pt(10)
    r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()

    today = datetime.utcnow().strftime('%d %B %Y')
    p = doc.add_paragraph(today)
    p.runs[0].font.size = Pt(11)

    doc.add_paragraph()

    doc.add_paragraph(f'Dear {owner},')
    doc.add_paragraph()

    doc.add_paragraph('I hope this letter finds you well.')

    p = doc.add_paragraph()
    p.add_run(f'I wanted to reach out personally — {addr_phrase} {sale_phrase}')
    if source_suburb:
        if multi:
            p.add_run(f", reflecting strong recent results across {source_suburb}.")
        else:
            p.add_run(
                f", one of {source_suburb}'s strongest results this season."
            )
    else:
        p.add_run('.')

    p = doc.add_paragraph()
    if multi:
        p.add_run(
            f'With this level of activity on your doorstep and buyer demand '
            f'remaining high, this could be the ideal moment to understand '
            f'what your property at '
        )
    else:
        p.add_run(
            f'With buyer demand remaining high across {source_suburb}, this '
            f'could be the ideal moment to understand what your property at '
        )
    bold = p.add_run(target_address)
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

    return doc


def _gather_sources_for_target(conn, target_address, source_suburb):
    """Return the list of source sales currently mailed to this target.

    Pulls every pipeline_tracking row that shares (target_address,
    source_suburb), ordered by created_at — newest sales first feels
    more conversational in the letter than oldest first.
    """
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
    return [dict(r) for r in rows]


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


def pipeline_tracking_grouped():
    """GET /api/pipeline/tracking/grouped — collapse rows by target_address.

    Each returned object has a `sources` list with every sale targeting
    that neighbour. Lets the UI render one row per real-world envelope
    (one letter per target) instead of one row per (source, target)
    pair.
    """
    suburb = (request.args.get('suburb') or '').strip()
    try:
        limit = int(request.args.get('limit') or 200)
    except ValueError:
        limit = 200
    limit = max(1, min(limit, 1000))

    conn = get_db()
    sql = "SELECT * FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND LOWER(source_suburb) = LOWER(?)"
        params.append(suburb)
    sql += " ORDER BY target_address ASC, created_at DESC"

    rows = conn.execute(sql, params).fetchall()
    conn.close()

    # Group by (target_address, source_suburb) — same target on the same
    # street in two different suburbs would technically collide on the
    # text alone, so suburb scopes the collision.
    groups = {}
    order = []
    for raw in rows:
        r = dict(raw)
        # Normalise date/datetime → ISO so the dict is JSON-safe.
        for k, v in list(r.items()):
            if isinstance(v, (date, datetime)):
                r[k] = v.isoformat()
        key = (r['target_address'].lower().strip(), (r.get('source_suburb') or '').lower().strip())
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
                'representative_id': r.get('id'),  # any one row id, useful for download/update calls
                'row_ids': [],
                'sources': [],
            }
            order.append(key)
        g = groups[key]
        g['row_ids'].append(r['id'])
        g['sources'].append({
            'source_address': r.get('source_address'),
            'source_price': r.get('source_price'),
            'source_sold_date': r.get('source_sold_date'),
            'row_id': r.get('id'),
        })
        # Inherit non-empty fields from any row in the group — owner_name
        # is the same for the same target so first-non-null wins.
        if not g.get('target_owner_name') and r.get('target_owner_name'):
            g['target_owner_name'] = r.get('target_owner_name')
        if g.get('hot_vendor_score') is None and r.get('hot_vendor_score') is not None:
            g['hot_vendor_score'] = r.get('hot_vendor_score')

    grouped = [groups[k] for k in order][:limit]
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

    # When the user updates target_owner_name on one row, propagate to
    # ALL rows with the same target_address — the agent thinks of "Mr.
    # Smith at 24 Grant Street" as one entity, not as N pipeline rows.
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

    # Other fields update only the row the caller addressed.
    other_sets = [s for s in sets if not s.startswith('target_owner_name')]
    if other_sets:
        params2 = [p for k, p in zip(allowed, params) if k != 'target_owner_name']
        # Rebuild params in the order matching other_sets above.
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
    """Generate ONE consolidated .docx for a target neighbour, even if
    multiple recent sales reference that same target.

    Looks up the row by id, finds every other pipeline row with the
    SAME (target_address, source_suburb), and merges all source sales
    into a single letter — "your neighbours at A, B, and C recently
    sold" instead of three separate envelopes to the same household.
    """
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Letter not found'}), 404

    entry = dict(row)
    target_address = entry.get('target_address') or ''
    source_suburb = entry.get('source_suburb') or ''

    # Aggregate all source sales pointing at this neighbour — newest first.
    sources = _gather_sources_for_target(conn, target_address, source_suburb)
    conn.close()

    if not sources:
        # Shouldn't happen since the row itself is a source for this
        # target, but defensively mirror the row's data so we never
        # produce a letter with zero sales.
        sources = [{
            'source_address': entry.get('source_address'),
            'source_price': entry.get('source_price'),
            'source_sold_date': entry.get('source_sold_date'),
        }]

    owner_name = entry.get('target_owner_name')
    # If the requested row has no name, but another row for the same
    # target does, use that one — owner_name is shared per address.
    if not owner_name:
        for s in sources:
            n = (s.get('target_owner_name') or '').strip()
            if n:
                owner_name = n
                break

    doc = _render_letter_docx(target_address, owner_name, source_suburb, sources)

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
        '/api/pipeline/tracking/grouped',
        endpoint='pipeline_tracking_grouped',
        view_func=pipeline_tracking_grouped,
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
        "Pipeline routes registered: /api/pipeline/{generate,tracking[,/grouped,/<id>],letter/<id>/download}"
    )

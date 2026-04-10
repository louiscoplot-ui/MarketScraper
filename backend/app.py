import os
import io
import json
import logging
import time
import random
import threading
from datetime import datetime
from collections import Counter
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

from database import init_db, get_db, add_suburb, remove_suburb, get_suburbs, get_listings
from database import upsert_listing, mark_withdrawn, create_scrape_log, update_scrape_log, get_scrape_logs
from database import get_existing_urls, trim_sold_listings, cleanup_agent_entries, restore_false_withdrawn
from database import backup_db
from scraper import scrape_suburb, debug_page
from scraper_rea import scrape_suburb_rea, debug_rea_page

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Track active scraping jobs
scrape_jobs = {}  # suburb_id -> {status, progress, started_at}
scrape_cancel = set()  # suburb_ids to cancel


@app.route('/api/ping', methods=['GET'])
def ping():
    return jsonify({'status': 'ok', 'app': 'market-scraper'})


# --- SUBURB AUTOCOMPLETE ---

@app.route('/api/suburbs/search', methods=['GET'])
def search_suburbs():
    """Autocomplete for WA suburb names."""
    from wa_suburbs import WA_SUBURBS
    q = request.args.get('q', '').strip().lower()
    if not q:
        return jsonify([])
    matches = [s for s in WA_SUBURBS if s.lower().startswith(q)]
    if not matches:
        matches = [s for s in WA_SUBURBS if q in s.lower()]
    return jsonify(matches[:15])


# --- SUBURB MANAGEMENT ---

@app.route('/api/suburbs', methods=['GET'])
def list_suburbs():
    return jsonify(get_suburbs())


@app.route('/api/suburbs', methods=['POST'])
def create_suburb():
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400

    suburb = add_suburb(name)
    if suburb is None:
        return jsonify({'error': 'Suburb already exists'}), 409

    return jsonify(suburb), 201


@app.route('/api/suburbs/<int:suburb_id>', methods=['DELETE'])
def delete_suburb(suburb_id):
    remove_suburb(suburb_id)
    return jsonify({'ok': True})


# --- LISTINGS ---

@app.route('/api/listings', methods=['GET'])
def list_listings():
    suburb_id = request.args.get('suburb_id', type=int)
    suburb_ids_str = request.args.get('suburb_ids', '')
    status = request.args.get('status')
    statuses_str = request.args.get('statuses', '')
    suburb_ids = None
    if suburb_ids_str:
        try:
            suburb_ids = [int(x) for x in suburb_ids_str.split(',') if x.strip()]
        except ValueError:
            pass
    statuses = None
    if statuses_str:
        statuses = [s.strip() for s in statuses_str.split(',') if s.strip()]
    return jsonify(get_listings(suburb_id=suburb_id, suburb_ids=suburb_ids, status=status, statuses=statuses))


@app.route('/api/report', methods=['GET'])
def market_report():
    """Generate market report stats for selected suburbs."""
    import re as _re

    suburb_ids_str = request.args.get('suburb_ids', '')
    suburb_ids = None
    if suburb_ids_str:
        try:
            suburb_ids = [int(x) for x in suburb_ids_str.split(',') if x.strip()]
        except ValueError:
            pass

    listings = get_listings(suburb_ids=suburb_ids)
    if not listings:
        return jsonify({'error': 'No listings found'}), 404

    def parse_price(price_text):
        if not price_text:
            return None
        m = _re.search(r'\$([\d,]+)', price_text.replace(' ', ''))
        if m:
            try:
                return int(m.group(1).replace(',', ''))
            except ValueError:
                return None
        return None

    def calc_dom(l):
        date_str = l.get('listing_date') or l.get('first_seen') or ''
        if not date_str:
            return None
        ddmm = _re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', date_str)
        try:
            if ddmm:
                start = datetime(int(ddmm.group(3)), int(ddmm.group(2)), int(ddmm.group(1)))
            else:
                start = datetime.fromisoformat(date_str.replace('Z', ''))
        except (ValueError, TypeError):
            return None
        return max(0, (datetime.utcnow() - start).days)

    # Overall stats
    active = [l for l in listings if l['status'] == 'active']
    under_offer = [l for l in listings if l['status'] == 'under_offer']
    sold = [l for l in listings if l['status'] == 'sold']
    withdrawn = [l for l in listings if l['status'] == 'withdrawn']

    # Price stats (active only)
    prices = [p for p in (parse_price(l.get('price_text')) for l in active) if p and p >= 100000]
    prices.sort()

    # DOM stats (active only)
    doms = [d for d in (calc_dom(l) for l in active) if d is not None]
    doms.sort()

    # Stale listings (60+ DOM)
    stale = [l for l in active if (calc_dom(l) or 0) >= 60]

    # Agent breakdown
    agent_stats = {}
    for l in listings:
        a = l.get('agent') or 'Unknown'
        if a not in agent_stats:
            agent_stats[a] = {'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0, 'total': 0}
        s = l.get('status', 'active')
        if s in agent_stats[a]:
            agent_stats[a][s] += 1
        agent_stats[a]['total'] += 1

    # Agency breakdown
    agency_stats = {}
    for l in listings:
        a = l.get('agency') or 'Unknown'
        if a not in agency_stats:
            agency_stats[a] = {'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0, 'total': 0}
        s = l.get('status', 'active')
        if s in agency_stats[a]:
            agency_stats[a][s] += 1
        agency_stats[a]['total'] += 1

    # Suburb breakdown
    suburb_stats = {}
    for l in listings:
        sn = l.get('suburb_name', 'Unknown')
        if sn not in suburb_stats:
            suburb_stats[sn] = {'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0, 'total': 0}
        s = l.get('status', 'active')
        if s in suburb_stats[sn]:
            suburb_stats[sn][s] += 1
        suburb_stats[sn]['total'] += 1

    # Property type breakdown
    type_stats = {}
    for l in active:
        t = l.get('listing_type') or 'Unknown'
        type_stats[t] = type_stats.get(t, 0) + 1

    report = {
        'generated_at': datetime.utcnow().isoformat(),
        'total_listings': len(listings),
        'summary': {
            'active': len(active),
            'under_offer': len(under_offer),
            'sold': len(sold),
            'withdrawn': len(withdrawn),
        },
        'price': {
            'count_with_price': len(prices),
            'min': min(prices) if prices else None,
            'max': max(prices) if prices else None,
            'median': prices[len(prices)//2] if prices else None,
            'avg': round(sum(prices) / len(prices)) if prices else None,
        },
        'dom': {
            'count': len(doms),
            'min': min(doms) if doms else None,
            'max': max(doms) if doms else None,
            'median': doms[len(doms)//2] if doms else None,
            'avg': round(sum(doms) / len(doms)) if doms else None,
            'stale_count': len(stale),
        },
        'stale_listings': [{
            'address': l.get('address'),
            'suburb': l.get('suburb_name'),
            'price': l.get('price_text'),
            'agent': l.get('agent'),
            'agency': l.get('agency'),
            'dom': calc_dom(l),
            'listing_date': l.get('listing_date'),
            'reiwa_url': l.get('reiwa_url'),
        } for l in sorted(stale, key=lambda x: calc_dom(x) or 0, reverse=True)],
        'agents': sorted(agent_stats.items(), key=lambda x: x[1]['total'], reverse=True),
        'agencies': sorted(agency_stats.items(), key=lambda x: x[1]['total'], reverse=True),
        'suburbs': sorted(suburb_stats.items(), key=lambda x: x[1]['total'], reverse=True),
        'property_types': sorted(type_stats.items(), key=lambda x: x[1], reverse=True),
        'withdrawn_listings': [{
            'address': l.get('address'),
            'suburb': l.get('suburb_name'),
            'price': l.get('price_text'),
            'agent': l.get('agent'),
            'agency': l.get('agency'),
            'listing_date': l.get('listing_date'),
            'reiwa_url': l.get('reiwa_url'),
        } for l in withdrawn],
    }

    return jsonify(report)


@app.route('/api/listings/export', methods=['GET'])
def export_listings():
    """Export filtered listings to Excel with summary sheets."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    import re as _re

    def _calc_dom(listing):
        date_str = listing.get('listing_date') or listing.get('first_seen') or ''
        if not date_str:
            return None
        ddmm = _re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', date_str)
        try:
            if ddmm:
                start = datetime(int(ddmm.group(3)), int(ddmm.group(2)), int(ddmm.group(1)))
            else:
                start = datetime.fromisoformat(date_str.replace('Z', ''))
        except (ValueError, TypeError):
            return None
        end = datetime.utcnow()
        return max(0, (end - start).days)

    # Parse same filters as list_listings
    suburb_ids_str = request.args.get('suburb_ids', '')
    statuses_str = request.args.get('statuses', '')
    agent = request.args.get('agent', '').strip()
    agency = request.args.get('agency', '').strip()

    suburb_ids = None
    if suburb_ids_str:
        try:
            suburb_ids = [int(x) for x in suburb_ids_str.split(',') if x.strip()]
        except ValueError:
            pass
    statuses = None
    if statuses_str:
        statuses = [s.strip() for s in statuses_str.split(',') if s.strip()]

    listings = get_listings(suburb_ids=suburb_ids, statuses=statuses)

    # Apply agent/agency filters
    if agent:
        listings = [l for l in listings if l.get('agent') == agent]
    if agency:
        listings = [l for l in listings if l.get('agency') == agency]

    # Styles
    header_font = Font(bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill(start_color="1e293b", end_color="1e293b", fill_type="solid")
    header_align = Alignment(horizontal="center", vertical="center")
    thin_border = Border(
        left=Side(style='thin', color='cccccc'),
        right=Side(style='thin', color='cccccc'),
        top=Side(style='thin', color='cccccc'),
        bottom=Side(style='thin', color='cccccc'),
    )
    summary_header_fill = PatternFill(start_color="334155", end_color="334155", fill_type="solid")

    wb = Workbook()

    # === Sheet 1: Listings ===
    ws = wb.active
    ws.title = "Listings"

    columns = ['Address', 'Suburb', 'Price', 'Bed', 'Bath', 'Car', 'Land', 'Internal',
               'Agency', 'Agent', 'Listed', 'DOM', 'Status', 'Type', 'Link']

    for col_idx, col_name in enumerate(columns, 1):
        cell = ws.cell(row=1, column=col_idx, value=col_name)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, l in enumerate(listings, 2):
        values = [
            l.get('address', ''),
            l.get('suburb_name', ''),
            l.get('price_text', ''),
            l.get('bedrooms'),
            l.get('bathrooms'),
            l.get('parking'),
            l.get('land_size', ''),
            l.get('internal_size', ''),
            l.get('agency', ''),
            l.get('agent', ''),
            l.get('listing_date', ''),
            _calc_dom(l),
            (l.get('status', '') or '').replace('_', ' ').title(),
            l.get('listing_type', ''),
            l.get('reiwa_url', ''),
        ]
        stale_fill = PatternFill(start_color="ffcccc", end_color="ffcccc", fill_type="solid")
        for col_idx, val in enumerate(values, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.border = thin_border
            # Highlight DOM cell red if 60+ days
            dom_col = columns.index('DOM') + 1
            if col_idx == dom_col and val is not None and val >= 60:
                cell.fill = stale_fill
                cell.font = Font(bold=True, color="cc0000")

    # Auto-width
    for col_idx in range(1, len(columns) + 1):
        max_len = len(str(ws.cell(row=1, column=col_idx).value))
        for row_idx in range(2, min(len(listings) + 2, 50)):
            val = ws.cell(row=row_idx, column=col_idx).value
            if val:
                max_len = max(max_len, min(len(str(val)), 40))
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = max_len + 3

    # Freeze header row
    ws.freeze_panes = "A2"

    # === Sheet 2: Agent Summary ===
    ws_agents = wb.create_sheet("Agents")
    agent_counts = Counter(l.get('agent', 'Unknown') for l in listings if l.get('agent'))
    agent_status = {}
    for l in listings:
        a = l.get('agent') or 'Unknown'
        if a not in agent_status:
            agent_status[a] = {'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0}
        s = l.get('status', 'active')
        if s in agent_status[a]:
            agent_status[a][s] += 1

    agent_headers = ['Agent', 'Total', 'Active', 'Under Offer', 'Sold', 'Withdrawn']
    for col_idx, h in enumerate(agent_headers, 1):
        cell = ws_agents.cell(row=1, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = summary_header_fill
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, (agent_name, total) in enumerate(agent_counts.most_common(), 2):
        stats = agent_status.get(agent_name, {})
        values = [agent_name, total, stats.get('active', 0), stats.get('under_offer', 0),
                  stats.get('sold', 0), stats.get('withdrawn', 0)]
        for col_idx, val in enumerate(values, 1):
            cell = ws_agents.cell(row=row_idx, column=col_idx, value=val)
            cell.border = thin_border

    for col_idx in range(1, len(agent_headers) + 1):
        ws_agents.column_dimensions[ws_agents.cell(row=1, column=col_idx).column_letter].width = 20
    ws_agents.freeze_panes = "A2"

    # === Sheet 3: Agency Summary ===
    ws_agencies = wb.create_sheet("Agencies")
    agency_counts = Counter(l.get('agency', 'Unknown') for l in listings if l.get('agency'))
    agency_status = {}
    for l in listings:
        a = l.get('agency') or 'Unknown'
        if a not in agency_status:
            agency_status[a] = {'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0}
        s = l.get('status', 'active')
        if s in agency_status[a]:
            agency_status[a][s] += 1

    agency_headers = ['Agency', 'Total', 'Active', 'Under Offer', 'Sold', 'Withdrawn']
    for col_idx, h in enumerate(agency_headers, 1):
        cell = ws_agencies.cell(row=1, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = summary_header_fill
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, (agency_name, total) in enumerate(agency_counts.most_common(), 2):
        stats = agency_status.get(agency_name, {})
        values = [agency_name, total, stats.get('active', 0), stats.get('under_offer', 0),
                  stats.get('sold', 0), stats.get('withdrawn', 0)]
        for col_idx, val in enumerate(values, 1):
            cell = ws_agencies.cell(row=row_idx, column=col_idx, value=val)
            cell.border = thin_border

    for col_idx in range(1, len(agency_headers) + 1):
        ws_agencies.column_dimensions[ws_agencies.cell(row=1, column=col_idx).column_letter].width = 30
    ws_agencies.freeze_panes = "A2"

    # === Sheet 4: Suburb Summary (only if multiple suburbs) ===
    suburb_names = set(l.get('suburb_name', '') for l in listings)
    if len(suburb_names) > 1:
        ws_suburbs = wb.create_sheet("Suburb Summary")
        suburb_data = {}
        for l in listings:
            sn = l.get('suburb_name', 'Unknown')
            if sn not in suburb_data:
                suburb_data[sn] = {'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0, 'agents': set(), 'agencies': set()}
            s = l.get('status', 'active')
            if s in suburb_data[sn]:
                suburb_data[sn][s] += 1
            if l.get('agent'):
                suburb_data[sn]['agents'].add(l['agent'])
            if l.get('agency'):
                suburb_data[sn]['agencies'].add(l['agency'])

        sub_headers = ['Suburb', 'Total', 'Active', 'Under Offer', 'Sold', 'Withdrawn', 'Agents', 'Agencies']
        for col_idx, h in enumerate(sub_headers, 1):
            cell = ws_suburbs.cell(row=1, column=col_idx, value=h)
            cell.font = header_font
            cell.fill = summary_header_fill
            cell.alignment = header_align
            cell.border = thin_border

        for row_idx, (sname, data) in enumerate(sorted(suburb_data.items()), 2):
            total = data['active'] + data['under_offer'] + data['sold'] + data['withdrawn']
            values = [sname, total, data['active'], data['under_offer'], data['sold'], data['withdrawn'],
                      len(data['agents']), len(data['agencies'])]
            for col_idx, val in enumerate(values, 1):
                cell = ws_suburbs.cell(row=row_idx, column=col_idx, value=val)
                cell.border = thin_border

        for col_idx in range(1, len(sub_headers) + 1):
            ws_suburbs.column_dimensions[ws_suburbs.cell(row=1, column=col_idx).column_letter].width = 20
        ws_suburbs.freeze_panes = "A2"

    # Save to buffer and send
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    # Filename with date
    date_str = datetime.now().strftime('%Y-%m-%d')
    suburb_label = ''
    if suburb_ids:
        conn = get_db()
        names = []
        for sid in suburb_ids:
            row = conn.execute("SELECT name FROM suburbs WHERE id = ?", (sid,)).fetchone()
            if row:
                names.append(row['name'])
        conn.close()
        if len(names) <= 3:
            suburb_label = '_' + '_'.join(names)
        else:
            suburb_label = f'_{len(names)}_suburbs'

    filename = f'MarketScraper{suburb_label}_{date_str}.xlsx'

    return send_file(buf, mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     as_attachment=True, download_name=filename)


@app.route('/api/listings/summary', methods=['GET'])
def listings_summary():
    """Get a summary of listings counts by suburb and status."""
    conn = get_db()
    rows = conn.execute("""
        SELECT
            s.id as suburb_id,
            s.name as suburb_name,
            l.status,
            COUNT(*) as count
        FROM listings l
        JOIN suburbs s ON l.suburb_id = s.id
        GROUP BY s.id, l.status
        ORDER BY s.name
    """).fetchall()
    conn.close()

    summary = {}
    for row in rows:
        sid = row['suburb_id']
        if sid not in summary:
            summary[sid] = {
                'suburb_id': row['suburb_id'],
                'suburb_name': row['suburb_name'],
                'active': 0, 'under_offer': 0, 'sold': 0, 'withdrawn': 0
            }
        summary[sid][row['status']] = row['count']

    return jsonify(list(summary.values()))


# --- SCRAPING ---

@app.route('/api/scrape/<int:suburb_id>', methods=['POST'])
def start_scrape(suburb_id):
    """Start scraping a suburb. Runs in background thread."""
    if suburb_id in scrape_jobs and scrape_jobs[suburb_id].get('status') == 'running':
        return jsonify({'error': 'Scrape already in progress for this suburb'}), 409

    conn = get_db()
    suburb = conn.execute("SELECT * FROM suburbs WHERE id = ?", (suburb_id,)).fetchone()
    conn.close()

    if not suburb:
        return jsonify({'error': 'Suburb not found'}), 404

    scrape_jobs[suburb_id] = {
        'status': 'running',
        'progress': 'Starting...',
        'started_at': datetime.utcnow().isoformat(),
    }

    thread = threading.Thread(
        target=_run_scrape,
        args=(suburb_id, suburb['slug'], suburb['name']),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburb': suburb['name']})


@app.route('/api/scrape/all', methods=['POST'])
def start_scrape_all():
    """Start scraping all active suburbs sequentially."""
    suburbs = get_suburbs()
    active_suburbs = [s for s in suburbs if s['active']]

    if not active_suburbs:
        return jsonify({'error': 'No active suburbs'}), 400

    # Check if any scrape is already running
    for s in active_suburbs:
        if s['id'] in scrape_jobs and scrape_jobs[s['id']].get('status') == 'running':
            return jsonify({'error': f'Scrape already running for {s["name"]}'}), 409

    thread = threading.Thread(
        target=_run_scrape_all,
        args=(active_suburbs,),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburbs': [s['name'] for s in active_suburbs]})


@app.route('/api/scrape/cancel', methods=['POST'])
def cancel_scrape():
    """Cancel all running scrapes."""
    running_ids = [sid for sid, job in scrape_jobs.items() if job.get('status') == 'running']
    for sid in running_ids:
        scrape_cancel.add(sid)
        scrape_jobs[sid]['progress'] = 'Cancelling...'
    logger.info(f"Cancel requested for {len(running_ids)} suburb(s): {running_ids}")
    return jsonify({'cancelled': running_ids})


@app.route('/api/scrape/status', methods=['GET'])
def scrape_status():
    """Get status of all scrape jobs."""
    return jsonify(scrape_jobs)


@app.route('/api/scrape/status/<int:suburb_id>', methods=['GET'])
def scrape_status_single(suburb_id):
    job = scrape_jobs.get(suburb_id, {'status': 'idle'})
    return jsonify(job)


@app.route('/api/scrape/debug/<int:suburb_id>', methods=['GET'])
def debug_scrape(suburb_id):
    """Debug: see what the scraper sees on the REIWA page for a suburb."""
    conn = get_db()
    suburb = conn.execute("SELECT * FROM suburbs WHERE id = ?", (suburb_id,)).fetchone()
    conn.close()
    if not suburb:
        return jsonify({'error': 'Suburb not found'}), 404
    result = debug_page(suburb['slug'])
    return jsonify(result)


@app.route('/api/scrape/selected', methods=['POST'])
def scrape_selected():
    """Scrape only selected suburb IDs."""
    data = request.json
    suburb_ids = data.get('suburb_ids', [])
    if not suburb_ids:
        return jsonify({'error': 'No suburbs selected'}), 400

    conn = get_db()
    suburbs_to_scrape = []
    for sid in suburb_ids:
        s = conn.execute("SELECT * FROM suburbs WHERE id = ?", (sid,)).fetchone()
        if s:
            suburbs_to_scrape.append(dict(s))
    conn.close()

    if not suburbs_to_scrape:
        return jsonify({'error': 'No valid suburbs found'}), 400

    for s in suburbs_to_scrape:
        if s['id'] in scrape_jobs and scrape_jobs[s['id']].get('status') == 'running':
            return jsonify({'error': f'Scrape already running for {s["name"]}'}), 409

    thread = threading.Thread(
        target=_run_scrape_all,
        args=([{'id': s['id'], 'slug': s['slug'], 'name': s['name']} for s in suburbs_to_scrape],),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburbs': [s['name'] for s in suburbs_to_scrape]})


@app.route('/api/scrape/logs', methods=['GET'])
def list_scrape_logs():
    suburb_id = request.args.get('suburb_id', type=int)
    return jsonify(get_scrape_logs(suburb_id=suburb_id))


# --- REA SCRAPING ---

@app.route('/api/scrape/rea/selected', methods=['POST'])
def scrape_rea_selected():
    """Scrape selected suburbs from realestate.com.au."""
    data = request.json
    suburb_ids = data.get('suburb_ids', [])
    if not suburb_ids:
        return jsonify({'error': 'No suburbs selected'}), 400

    conn = get_db()
    suburbs_to_scrape = []
    for sid in suburb_ids:
        s = conn.execute("SELECT * FROM suburbs WHERE id = ?", (sid,)).fetchone()
        if s:
            suburbs_to_scrape.append(dict(s))
    conn.close()

    if not suburbs_to_scrape:
        return jsonify({'error': 'No valid suburbs found'}), 400

    for s in suburbs_to_scrape:
        key = f"rea_{s['id']}"
        if key in scrape_jobs and scrape_jobs[key].get('status') == 'running':
            return jsonify({'error': f'REA scrape already running for {s["name"]}'}), 409

    thread = threading.Thread(
        target=_run_scrape_rea_all,
        args=([{'id': s['id'], 'slug': s['slug'], 'name': s['name']} for s in suburbs_to_scrape],),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburbs': [s['name'] for s in suburbs_to_scrape]})


@app.route('/api/scrape/rea/debug/<int:suburb_id>', methods=['GET'])
def debug_rea_scrape(suburb_id):
    """Debug: see what the REA scraper sees for a suburb."""
    conn = get_db()
    suburb = conn.execute("SELECT * FROM suburbs WHERE id = ?", (suburb_id,)).fetchone()
    conn.close()
    if not suburb:
        return jsonify({'error': 'Suburb not found'}), 404
    result = debug_rea_page(suburb['name'])
    return jsonify(result)


MAX_REA_SUBURBS_PER_SESSION = 5  # Safety limit to avoid hammering REA

def _run_scrape_rea_all(suburbs):
    """Run REA scrape SEQUENTIALLY with ONE shared session to avoid re-warmup."""
    from scraper_rea import _create_scraper

    for s in suburbs:
        scrape_cancel.discard(s['id'])

    # Limit suburbs per session to avoid rate limiting
    if len(suburbs) > MAX_REA_SUBURBS_PER_SESSION:
        logger.warning(f"[REA] Limiting from {len(suburbs)} to {MAX_REA_SUBURBS_PER_SESSION} suburbs per session")
        # Mark excess suburbs as skipped
        for s in suburbs[MAX_REA_SUBURBS_PER_SESSION:]:
            key = f"rea_{s['id']}"
            scrape_jobs[key] = {
                'status': 'error',
                'progress': f'[REA] Skipped - max {MAX_REA_SUBURBS_PER_SESSION} suburbs per session to avoid rate limiting. Run again for remaining suburbs.',
                'completed_at': datetime.utcnow().isoformat(),
                'source': 'rea',
            }
        suburbs = suburbs[:MAX_REA_SUBURBS_PER_SESSION]

    # Create ONE shared session for all suburbs
    shared_scraper = _create_scraper()
    rate_limited = False

    for i, s in enumerate(suburbs):
        if s['id'] in scrape_cancel:
            continue
        if rate_limited:
            key = f"rea_{s['id']}"
            scrape_jobs[key] = {
                'status': 'error',
                'progress': '[REA] Skipped - rate limited on previous suburb. Try again in 10-15 minutes.',
                'completed_at': datetime.utcnow().isoformat(),
                'source': 'rea',
            }
            continue
        try:
            result_ok = _run_scrape_rea(s['id'], s['name'], shared_scraper=shared_scraper)
            if not result_ok:
                rate_limited = True
        except Exception as e:
            logger.error(f"[REA] Scrape error for {s['name']}: {e}")
        # Wait between suburbs — longer delays for safety
        if i < len(suburbs) - 1 and not rate_limited:
            wait = random.uniform(30.0, 50.0)
            logger.info(f"[REA] Waiting {wait:.0f}s before next suburb...")
            time.sleep(wait)


def _run_scrape_rea(suburb_id, name, shared_scraper=None):
    """Execute REA scraping for a single suburb. Returns True if OK, False if rate-limited."""
    job_key = f"rea_{suburb_id}"
    log_id = create_scrape_log(suburb_id)
    scrape_jobs[job_key] = {
        'status': 'running',
        'progress': f'[REA] Starting scrape for {name}...',
        'started_at': datetime.utcnow().isoformat(),
        'source': 'rea',
    }

    def progress_cb(msg):
        scrape_jobs[job_key]['progress'] = msg
        logger.info(f"[REA][{name}] {msg}")

    try:
        known_urls = get_existing_urls(suburb_id)

        def cancel_check():
            return suburb_id in scrape_cancel

        result = scrape_suburb_rea(name, suburb_id, progress_callback=progress_cb,
                                    known_urls=known_urls, cancel_check=cancel_check,
                                    shared_scraper=shared_scraper)

        if suburb_id in scrape_cancel:
            scrape_cancel.discard(suburb_id)
            scrape_jobs[job_key] = {
                'status': 'cancelled',
                'progress': '[REA] Cancelled',
                'completed_at': datetime.utcnow().isoformat(),
                'source': 'rea',
            }
            return True

        # Detect if we got rate-limited (429 errors in results)
        got_429 = any('429' in e for e in result.get('errors', []))

        # Save for-sale listings
        new_count = 0
        updated_count = 0
        forsale_urls = []

        progress_cb('[REA] Saving for-sale listings...')
        for listing in result['forsale_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            forsale_urls.append(url)
            action = upsert_listing(suburb_id, url, listing)
            if action == 'new':
                new_count += 1
            else:
                updated_count += 1

        # Save sold listings
        saved_sold = 0
        sold_urls = []
        progress_cb('[REA] Saving sold listings...')
        for listing in result['sold_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            sold_urls.append(url)
            upsert_listing(suburb_id, url, listing)
            saved_sold += 1

        actual_forsale = len(forsale_urls)
        update_scrape_log(
            log_id,
            completed_at=datetime.utcnow().isoformat(),
            forsale_count=actual_forsale,
            sold_count=saved_sold,
            new_count=new_count,
            updated_count=updated_count,
            withdrawn_count=0,
            errors=json.dumps(result['errors']) if result['errors'] else None
        )

        status = 'completed'
        if got_429 and actual_forsale == 0:
            status = 'error'
            msg = f'[REA] Rate limited (429) - 0 listings. Wait 10-15 min and retry.'
        else:
            msg = f'[REA] Done! {actual_forsale} active, {saved_sold} sold, {new_count} new'

        scrape_jobs[job_key] = {
            'status': status,
            'progress': msg,
            'completed_at': datetime.utcnow().isoformat(),
            'stats': result['stats'],
            'source': 'rea',
        }
        logger.info(f"[REA] Scrape completed for {name}: {result['stats']}")

        # Return False if rate-limited with 0 results (signals to stop batch)
        return not (got_429 and actual_forsale == 0)

    except Exception as e:
        logger.error(f"[REA] Scrape failed for {name}: {e}")
        update_scrape_log(log_id, completed_at=datetime.utcnow().isoformat(), errors=str(e))
        scrape_jobs[job_key] = {
            'status': 'error',
            'progress': f'[REA] Error: {str(e)}',
            'error': str(e),
            'source': 'rea',
        }
        return '429' not in str(e)


def _run_scrape_all(suburbs):
    """Run scrape for suburbs in parallel (up to 8 at a time)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    max_workers = min(8, len(suburbs))

    # Mark all suburbs as queued first
    for s in suburbs:
        scrape_cancel.discard(s['id'])

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_run_scrape, s['id'], s['slug'], s['name']): s
            for s in suburbs
        }
        for future in as_completed(futures):
            s = futures[future]
            try:
                future.result()
            except Exception as e:
                logger.error(f"Scrape thread error for {s['name']}: {e}")


def _run_scrape(suburb_id, slug, name):
    """Execute the scraping process for a single suburb."""
    log_id = create_scrape_log(suburb_id)
    scrape_jobs[suburb_id] = {
        'status': 'running',
        'progress': f'Starting scrape for {name}...',
        'started_at': datetime.utcnow().isoformat(),
    }

    def progress_cb(msg):
        scrape_jobs[suburb_id]['progress'] = msg
        logger.info(f"[{name}] {msg}")

    try:
        # Get known URLs to skip detail pages for existing listings
        known_urls = get_existing_urls(suburb_id)
        logger.info(f"[{name}] {len(known_urls)} known URLs in DB, will skip their detail pages")

        def cancel_check():
            return suburb_id in scrape_cancel

        result = scrape_suburb(slug, suburb_id, progress_callback=progress_cb, known_urls=known_urls, cancel_check=cancel_check)

        # Check if cancelled
        if suburb_id in scrape_cancel:
            scrape_cancel.discard(suburb_id)
            scrape_jobs[suburb_id] = {
                'status': 'cancelled',
                'progress': 'Scrape cancelled by user',
                'completed_at': datetime.utcnow().isoformat(),
            }
            update_scrape_log(log_id, completed_at=datetime.utcnow().isoformat(), errors='Cancelled by user')
            logger.info(f"Scrape cancelled for {name}")
            return

        # Process for-sale listings — keyed by reiwa_url (no address dedup)
        # Same property by 2 agencies = 2 different REIWA URLs = 2 rows
        new_count = 0
        updated_count = 0
        forsale_urls = []
        sold_urls = []

        progress_cb('Saving for-sale listings to database...')
        for listing in result['forsale_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            forsale_urls.append(url)
            action = upsert_listing(suburb_id, url, listing)
            if action == 'new':
                new_count += 1
            else:
                updated_count += 1

        # Process sold listings
        progress_cb('Saving sold listings to database...')
        saved_sold = 0
        for listing in result['sold_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            sold_urls.append(url)
            upsert_listing(suburb_id, url, listing)
            saved_sold += 1

        # Mark withdrawn — by URL, not address
        progress_cb('Checking for withdrawn listings...')
        withdrawn_count = mark_withdrawn(suburb_id, forsale_urls, sold_urls)

        # Keep only 40 most recent sold listings
        trimmed = trim_sold_listings(suburb_id, keep=40)
        if trimmed:
            logger.info(f"[{name}] Trimmed {trimmed} old sold listings (keeping 40 most recent)")

        # Use actual saved counts (not raw card counts)
        actual_forsale = len(forsale_urls)
        update_scrape_log(
            log_id,
            completed_at=datetime.utcnow().isoformat(),
            forsale_count=actual_forsale,
            sold_count=saved_sold,
            new_count=new_count,
            updated_count=updated_count,
            withdrawn_count=withdrawn_count,
            errors=json.dumps(result['errors']) if result['errors'] else None
        )

        scrape_jobs[suburb_id] = {
            'status': 'completed',
            'progress': f'Done! {actual_forsale} active, {saved_sold} sold, {new_count} new, {withdrawn_count} withdrawn',
            'completed_at': datetime.utcnow().isoformat(),
            'stats': result['stats'],
        }
        logger.info(f"Scrape completed for {name}: {result['stats']}")

    except Exception as e:
        logger.error(f"Scrape failed for {name}: {e}")
        update_scrape_log(log_id, completed_at=datetime.utcnow().isoformat(), errors=str(e))
        scrape_jobs[suburb_id] = {
            'status': 'error',
            'progress': f'Error: {str(e)}',
            'error': str(e),
        }


if __name__ == '__main__':
    init_db()
    # Auto-backup on every startup
    backup_db()
    logger.info("Database backed up on startup")
    cleaned = cleanup_agent_entries()
    if cleaned:
        logger.info(f"Cleaned up {cleaned} agent profile entries from DB")
    restored = restore_false_withdrawn()
    if restored:
        logger.info(f"Restored {restored} falsely withdrawn listings from last 24h")
    app.run(host='0.0.0.0', port=5000, debug=True)

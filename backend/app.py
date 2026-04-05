import os
import json
import logging
import threading
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS

from database import init_db, get_db, add_suburb, remove_suburb, get_suburbs, get_listings
from database import upsert_listing, mark_withdrawn, create_scrape_log, update_scrape_log, get_scrape_logs
from scraper import scrape_suburb

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Track active scraping jobs
scrape_jobs = {}  # suburb_id -> {status, progress, started_at}


@app.route('/api/ping', methods=['GET'])
def ping():
    return jsonify({'status': 'ok', 'app': 'reiwa-scraper'})


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
    status = request.args.get('status')
    return jsonify(get_listings(suburb_id=suburb_id, status=status))


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


@app.route('/api/scrape/status', methods=['GET'])
def scrape_status():
    """Get status of all scrape jobs."""
    return jsonify(scrape_jobs)


@app.route('/api/scrape/status/<int:suburb_id>', methods=['GET'])
def scrape_status_single(suburb_id):
    job = scrape_jobs.get(suburb_id, {'status': 'idle'})
    return jsonify(job)


@app.route('/api/scrape/logs', methods=['GET'])
def list_scrape_logs():
    suburb_id = request.args.get('suburb_id', type=int)
    return jsonify(get_scrape_logs(suburb_id=suburb_id))


def _run_scrape_all(suburbs):
    """Run scrape for all suburbs sequentially."""
    for suburb in suburbs:
        _run_scrape(suburb['id'], suburb['slug'], suburb['name'])


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
        result = scrape_suburb(slug, suburb_id, progress_callback=progress_cb)

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
        for listing in result['sold_listings']:
            url = listing.get('reiwa_url', '').strip()
            if not url:
                continue
            sold_urls.append(url)
            upsert_listing(suburb_id, url, listing)

        # Mark withdrawn — by URL, not address
        progress_cb('Checking for withdrawn listings...')
        withdrawn_count = mark_withdrawn(suburb_id, forsale_urls, sold_urls)

        # Update scrape log
        update_scrape_log(
            log_id,
            completed_at=datetime.utcnow().isoformat(),
            forsale_count=result['stats']['forsale_count'],
            sold_count=result['stats']['sold_count'],
            new_count=new_count,
            updated_count=updated_count,
            withdrawn_count=withdrawn_count,
            errors=json.dumps(result['errors']) if result['errors'] else None
        )

        scrape_jobs[suburb_id] = {
            'status': 'completed',
            'progress': f'Done! {result["stats"]["forsale_count"]} active, {result["stats"]["sold_count"]} sold, {new_count} new, {withdrawn_count} withdrawn',
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
    app.run(host='0.0.0.0', port=5000, debug=True)

import logging
import threading
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
# flask-compress is optional — if Render hasn't picked up the
# requirements.txt change yet, fail open so the app still boots.
try:
    from flask_compress import Compress
except ImportError:
    Compress = None

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

from database import (
    init_db, get_db, add_suburb, remove_suburb, get_suburbs, get_listings,
    cleanup_agent_entries, backup_db, get_scrape_logs,
)
from scraper import debug_page, debug_detail, compare_suburb
from pipeline_api import register_pipeline_routes
from import_api import register_import_routes
from hot_vendors_api import register_hot_vendors_routes
from listings_api import register_listings_routes
from report_api import register_report_routes
from export_api import register_export_routes
from admin_api import register_admin_routes, seed_admin_if_needed
from auth_api import register_auth_routes
from rental_api import register_rental_routes
from legal_api import register_legal_routes
from scrape_runner import run_scrape, run_scrape_all, scrape_jobs, scrape_cancel

app = Flask(__name__)
CORS(app, origins=[
    'https://www.suburbdesk.com',
    'https://suburbdesk.com',
    'https://market-scraper.vercel.app',
    'http://localhost:5173',
])
# Gzip every response > 500 bytes when flask-compress is available.
# Skipped silently if the dep wasn't picked up yet (Render mid-deploy)
# so a missing pip install doesn't 502 the whole backend.
if Compress is not None:
    app.config['COMPRESS_MIMETYPES'] = [
        'application/json', 'text/html', 'text/css', 'text/plain',
        'application/javascript',
    ]
    app.config['COMPRESS_LEVEL'] = 6
    app.config['COMPRESS_MIN_SIZE'] = 500
    Compress(app)

# Ensure DB schema is up to date on every gunicorn worker start.
# Idempotent (CREATE TABLE IF NOT EXISTS), safe to call here.
try:
    init_db()
    # Seed the initial admin from ADMIN_EMAIL on first boot. Logs the
    # access_key once so the operator can grab it from Render logs.
    seed_admin_if_needed()
except Exception as e:
    logger.error(f"init_db at module load failed: {e}")

register_pipeline_routes(app)
register_import_routes(app)
register_hot_vendors_routes(app)
register_listings_routes(app)
register_report_routes(app)
register_export_routes(app)
register_admin_routes(app)
register_auth_routes(app)
register_rental_routes(app)
register_legal_routes(app)
from signals_api import register_signals_routes
register_signals_routes(app)


# --- GLOBAL AUTH GATE ---
# Block every /api/* call from unauthenticated callers. Exempt the auth
# endpoints (login flow needs to be reachable) and /api/ping (Render
# health check + UI splash check). CORS preflight is also exempt — the
# browser sends OPTIONS without our custom header.
_AUTH_EXEMPT_PREFIXES = ('/api/auth/', '/api/ping', '/api/legal/')


@app.before_request
def _require_auth_for_api():
    if request.method == 'OPTIONS':
        return None
    path = request.path or ''
    if not path.startswith('/api/'):
        return None
    if any(path.startswith(p) for p in _AUTH_EXEMPT_PREFIXES):
        return None
    from admin_api import get_current_user
    if get_current_user() is None:
        return jsonify({'error': 'Not authenticated'}), 401
    return None


@app.route('/api/ping', methods=['GET'])
def ping():
    """Health + diagnostic. The `db` field is the only quick way to
    catch a Render env regression where DATABASE_URL drops off and the
    app silently falls back to ephemeral SQLite."""
    from database import USE_POSTGRES
    info = {
        'status': 'ok',
        'app': 'suburbdesk',
        'db': 'postgres' if USE_POSTGRES else 'sqlite-ephemeral',
    }
    try:
        conn = get_db()
        row = conn.execute("SELECT COUNT(*) AS n FROM suburbs").fetchone()
        info['suburbs'] = (dict(row).get('n') if row else 0)
        conn.close()
    except Exception as e:
        info['db_error'] = str(e)[:200]
    return jsonify(info)


# --- SUBURB AUTOCOMPLETE ---

@app.route('/api/suburbs/search', methods=['GET'])
def search_suburbs():
    """Autocomplete for WA suburb names. Returns [{name, postcode}]
    so the UI can disambiguate by postcode (helpful for names that
    repeat across states). postcode is '' when not in the embedded
    SUBURB_POSTCODES dict — render the name alone in that case."""
    from wa_suburbs import WA_SUBURBS, postcode_for
    q = request.args.get('q', '').strip().lower()
    if not q:
        return jsonify([])
    matches = [s for s in WA_SUBURBS if s.lower().startswith(q)]
    if not matches:
        matches = [s for s in WA_SUBURBS if q in s.lower()]
    return jsonify([
        {'name': s, 'postcode': postcode_for(s)}
        for s in matches[:15]
    ])


# --- SUBURB MANAGEMENT ---

@app.route('/api/suburbs', methods=['GET'])
def list_suburbs():
    # resolve_request_scope() returns (user, allowed_ids). For admins
    # and unauthenticated requests `allowed_ids` is None → no filtering.
    # For regular users it's their assigned suburb ids (possibly empty).
    from admin_api import resolve_request_scope
    _, allowed = resolve_request_scope()
    return jsonify(get_suburbs(allowed_ids=allowed))


@app.route('/api/suburbs', methods=['POST'])
def create_suburb():
    """Add a suburb. Auto-assigns it to the calling user so they see it
    immediately (admins keep their global view). The daily scrape picks
    it up automatically on the next run.

    If the suburb already exists in the global table (another agent on
    the team created it earlier), we DON'T 409 — we look it up and
    assign it to the caller so they can subscribe to a shared suburb."""
    try:
        from admin_api import get_current_user
        # Permission gate: only admins and users explicitly granted
        # can_add_suburbs may introduce a new suburb to the system
        # (it gets scraped nightly). Regular users see only what an
        # admin assigned them — they can't self-expand coverage.
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Authentication required'}), 401
        if user.get('role') != 'admin' and not user.get('can_add_suburbs'):
            return jsonify({
                'error': "You don't have permission to add suburbs. "
                         "Ask your admin to enable it for your account."
            }), 403
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'Name is required'}), 400
        suburb = add_suburb(name)
        status = 201
        if suburb is None:
            # Already exists globally — fetch it so we can still assign
            # it to the caller. Slug computed the same way add_suburb
            # does (strip + lower + dashed).
            slug = name.strip().lower().replace(' ', '-')
            conn = get_db()
            try:
                row = conn.execute(
                    "SELECT * FROM suburbs WHERE slug = ?", (slug,)
                ).fetchone()
                if row is None:
                    conn.close()
                    return jsonify({'error': 'Suburb already exists'}), 409
                suburb = dict(row)
                # Sidebar + autocomplete add path = "I want to see and
                # scrape this suburb". If the row exists but was
                # created via /suburbs/custom (active=0, scoped-only),
                # promote it to active=1 here so GET /api/suburbs
                # (which filters WHERE active=1) actually returns it.
                # Without this, clicking + on a previously custom-
                # assigned suburb looked like a no-op because the
                # follow-up fetchSuburbs filtered it out.
                if not suburb.get('active'):
                    conn.execute(
                        "UPDATE suburbs SET active = 1 WHERE id = ?",
                        (suburb['id'],)
                    )
                    conn.commit()
                    suburb['active'] = 1
            finally:
                conn.close()
            status = 200
        # `user` already resolved by the permission gate above.
        if user and user.get('role') != 'admin':
            try:
                conn = get_db()
                try:
                    conn.execute(
                        "INSERT INTO user_suburbs (user_id, suburb_id) VALUES (?, ?)",
                        (user['id'], suburb['id'])
                    )
                    conn.commit()
                finally:
                    conn.close()
            except Exception as e:
                # Already-assigned PK / unique-violation is the expected
                # idempotent-noop case. Anything else (transient DB
                # error, constraint mismatch) is non-fatal for the
                # create-suburb response but logged for the operator.
                logger.error("user_suburbs insert failed for user=%s suburb=%s: %s",
                             user.get('id'), suburb.get('id'), e)
        return jsonify(suburb), status
    except Exception as e:
        # Top-level safety net — anything that escapes the inner blocks
        # (driver-specific exception not matching IntegrityError,
        # JSON-encode failure on a non-serialisable row, etc.) gets a
        # clean error response with the real cause logged for diagnosis.
        logger.exception("create_suburb failed: %s", e)
        return jsonify({'error': 'Could not create suburb', 'detail': str(e)}), 500


@app.route('/api/suburbs/<int:suburb_id>', methods=['DELETE'])
def delete_suburb(suburb_id):
    """Hard delete — removes the suburb AND all its listings/scrape logs
    via cascade. Restricted to admins so a user can't accidentally wipe
    a suburb that other agents on the team are also working."""
    from admin_api import get_current_user
    user = get_current_user()
    if user and user.get('role') != 'admin':
        return jsonify({
            'error': 'Only admins can delete a suburb. Ask your admin to '
                     'remove it from your assignments instead.'
        }), 403
    remove_suburb(suburb_id)
    return jsonify({'ok': True})


# --- LISTINGS ---

@app.route('/api/listings/<int:listing_id>', methods=['DELETE'])
def delete_listing(listing_id):
    """Manual delete of a single listing row — useful for cleaning stale
    withdrawn rows that the auto re-list detector couldn't match (e.g. the
    withdrawn row has 'Address not disclosed' so no address to normalise).
    Scope-checked: a non-admin user can only delete listings in suburbs
    they're assigned to. Admins (allowed=None) bypass the check."""
    from admin_api import resolve_request_scope
    conn = get_db()
    # SELECT suburb_id too so we can scope-check before deletion.
    row = conn.execute(
        "SELECT id, address, status, suburb_id FROM listings WHERE id = ?",
        (listing_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Listing not found'}), 404
    _, allowed = resolve_request_scope()
    if allowed is not None and row['suburb_id'] not in allowed:
        conn.close()
        return jsonify({'error': 'Not authorised for that suburb'}), 403
    conn.execute("DELETE FROM listings WHERE id = ?", (listing_id,))
    conn.commit()
    conn.close()
    return jsonify({'deleted': listing_id, 'address': row['address'], 'status': row['status']})


@app.route('/api/listings', methods=['GET'])
def list_listings():
    from admin_api import resolve_request_scope
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

    # Apply per-user suburb scoping. If the caller is a regular user,
    # intersect their requested suburb_ids (or suburb_id) with the ones
    # they're allowed to see — they can't widen their scope by passing
    # arbitrary IDs in the query string.
    _, allowed = resolve_request_scope()
    if allowed is not None:
        if not allowed:
            return jsonify([])
        if suburb_ids:
            suburb_ids = [s for s in suburb_ids if s in allowed]
            if not suburb_ids:
                return jsonify([])
        elif suburb_id:
            if suburb_id not in allowed:
                return jsonify([])
        else:
            suburb_ids = allowed
            suburb_id = None

    return jsonify(get_listings(suburb_id=suburb_id, suburb_ids=suburb_ids,
                                status=status, statuses=statuses))


@app.route('/api/listings/summary', methods=['GET'])
def listings_summary():
    """Get a summary of listings counts by suburb and status. Non-admins
    only see counts for the suburbs assigned to them — without this
    filter the sidebar would leak the existence of every suburb in the
    system regardless of role."""
    from admin_api import resolve_request_scope
    _, allowed = resolve_request_scope()
    conn = get_db()
    if allowed is None:
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
    elif not allowed:
        conn.close()
        return jsonify([])
    else:
        placeholders = ','.join(['?'] * len(allowed))
        rows = conn.execute(f"""
            SELECT
                s.id as suburb_id,
                s.name as suburb_name,
                l.status,
                COUNT(*) as count
            FROM listings l
            JOIN suburbs s ON l.suburb_id = s.id
            WHERE s.id IN ({placeholders})
            GROUP BY s.id, l.status
            ORDER BY s.name
        """, allowed).fetchall()
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
    """Start scraping a suburb. Runs in background thread.
    Regular users can only scrape their assigned suburbs."""
    from admin_api import resolve_request_scope
    _, allowed = resolve_request_scope()
    if allowed is not None and suburb_id not in allowed:
        return jsonify({
            'error': "You can't scrape that suburb — it's not in your "
                     "assigned list. Ask your admin to assign it to you."
        }), 403

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
        target=run_scrape,
        args=(suburb_id, suburb['slug'], suburb['name']),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburb': suburb['name']})


@app.route('/api/scrape/all', methods=['POST'])
def start_scrape_all():
    """Start scraping all active suburbs in parallel."""
    from admin_api import _require_admin
    _u, err = _require_admin()
    if err:
        return err
    suburbs = get_suburbs()
    active_suburbs = [s for s in suburbs if s['active']]

    if not active_suburbs:
        return jsonify({'error': 'No active suburbs'}), 400

    for s in active_suburbs:
        if s['id'] in scrape_jobs and scrape_jobs[s['id']].get('status') == 'running':
            return jsonify({'error': f'Scrape already running for {s["name"]}'}), 409

    thread = threading.Thread(
        target=run_scrape_all,
        args=(active_suburbs,),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburbs': [s['name'] for s in active_suburbs]})


@app.route('/api/scrape/cancel', methods=['POST'])
def cancel_scrape():
    """Cancel all running scrapes."""
    from admin_api import _require_admin
    _u, err = _require_admin()
    if err:
        return err
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
    from admin_api import _require_admin
    _u, err = _require_admin()
    if err:
        return err
    conn = get_db()
    suburb = conn.execute("SELECT * FROM suburbs WHERE id = ?", (suburb_id,)).fetchone()
    conn.close()
    if not suburb:
        return jsonify({'error': 'Suburb not found'}), 404
    result = debug_page(suburb['slug'])
    return jsonify(result)


@app.route('/api/admin/suspect-scrape-runs', methods=['GET'])
def suspect_scrape_runs():
    """Diagnostic: list scrape_logs entries that look like mass-withdraw
    cascade victims. A run is "suspect" when forsale_count = 0 AND
    withdrawn_count >= 5 — exactly the pattern the new guards block now.
    Returns one row per (suburb_id, started_at) sorted oldest-first.

    Query params:
      ?days=N  (default 30) — lookback window
    """
    from admin_api import _require_admin
    _, err = _require_admin()
    if err:
        return err
    try:
        days = int(request.args.get('days', 30))
    except (TypeError, ValueError):
        days = 30
    days = max(1, min(days, 365))
    from datetime import timedelta
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT sl.id, sl.suburb_id, s.name AS suburb_name, "
            "       sl.started_at, sl.completed_at, "
            "       sl.forsale_count, sl.sold_count, sl.withdrawn_count, "
            "       sl.new_count, sl.errors "
            "FROM scrape_logs sl "
            "JOIN suburbs s ON sl.suburb_id = s.id "
            "WHERE sl.started_at >= ? "
            "  AND sl.forsale_count = 0 "
            "  AND sl.withdrawn_count >= 5 "
            "ORDER BY sl.started_at ASC",
            (cutoff,)
        ).fetchall()
    finally:
        conn.close()
    runs = [dict(r) for r in rows]
    total_withdrawn = sum(r.get('withdrawn_count', 0) for r in runs)
    return jsonify({
        'days_window': days,
        'cutoff_iso': cutoff,
        'suspect_run_count': len(runs),
        'total_withdrawn_in_suspect_runs': total_withdrawn,
        'runs': runs,
    })


@app.route('/api/admin/restore-cascade-withdrawals', methods=['POST'])
def restore_cascade_withdrawals():
    """Surgical recovery: restore listings that were withdrawn DURING a
    cascade run (forsale_count=0 + withdrawn_count>=5) but NOT touch
    listings withdrawn during healthy scrape passes.

    Strategy: identify each suspect run's [started_at, completed_at]
    window, then UPDATE only the listings whose withdrawn_date falls
    inside any of those windows. Preserves all legitimate withdrawals.

    Body (optional): { "days": int (default 30) }
    Returns count of rows flipped + per-suburb breakdown.
    """
    from admin_api import _require_admin
    _, err = _require_admin()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        days = int(body.get('days', 30))
    except (TypeError, ValueError):
        return jsonify({'error': 'days must be an integer'}), 400
    days = max(1, min(days, 365))
    from datetime import timedelta
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    conn = get_db()
    try:
        suspect = conn.execute(
            "SELECT id, suburb_id, started_at, completed_at, withdrawn_count "
            "FROM scrape_logs "
            "WHERE started_at >= ? "
            "  AND forsale_count = 0 "
            "  AND withdrawn_count >= 5",
            (cutoff,)
        ).fetchall()
        suspect = [dict(r) for r in suspect]
        if not suspect:
            return jsonify({
                'restored': 0,
                'suspect_run_count': 0,
                'note': 'No cascade runs detected in the window — nothing to do.',
            })
        total_restored = 0
        per_suburb = {}
        for run in suspect:
            sid = run['suburb_id']
            # Use a generous window: started_at → completed_at + 5 min
            # to catch listings flipped by the post-pass _backfill /
            # mark_withdrawn that ran slightly after the scrape proper.
            started = run['started_at']
            ended = run.get('completed_at') or run['started_at']
            cur = conn.execute(
                "UPDATE listings SET status = 'active', withdrawn_date = NULL "
                "WHERE suburb_id = ? AND status = 'withdrawn' "
                "  AND withdrawn_date >= ? AND withdrawn_date <= ?",
                (sid, started, ended)
            )
            n = cur.rowcount or 0
            total_restored += n
            per_suburb[sid] = per_suburb.get(sid, 0) + n
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        'restored': total_restored,
        'suspect_run_count': len(suspect),
        'per_suburb_restored': per_suburb,
        'next_step': 'Trigger a fresh scrape per affected suburb so '
                     'mark_withdrawn can re-flag any genuinely-gone '
                     'listings with the new guard in place.',
    })


@app.route('/api/admin/force-reconcile-all', methods=['POST'])
def force_reconcile_all():
    """Force-withdraw orphans across EVERY active suburb in one call.
    Convenience wrapper around force-reconcile-suburb — same logic
    (any active/UO row whose last_seen falls outside the window is
    marked withdrawn) applied per suburb in a single transaction.

    Use case: operator just clicked "Scrape (N)" in the UI and wants
    a one-shot cleanup of orphans across the whole portfolio without
    looking up each suburb_id manually.

    Body: { hours: int (default 24) }
    Returns { restored: 0, withdrawn: N, per_suburb: {...}, kept_alive: N }
    """
    from admin_api import _require_admin
    _, err = _require_admin()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        hours = int(body.get('hours', 24))
    except (TypeError, ValueError):
        hours = 24
    hours = max(1, min(hours, 168))

    from datetime import timedelta
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    now_iso = datetime.utcnow().isoformat()
    conn = get_db()
    try:
        suburbs = conn.execute(
            "SELECT id, name FROM suburbs WHERE active = 1 ORDER BY name"
        ).fetchall()
        per_suburb = {}
        total_flipped = 0
        total_kept = 0
        total_skipped = 0
        # Cascade guard (same rationale as force-reconcile-suburb): a
        # suburb with kept==0 had no successful scrape in the window, so
        # a sweep would withdraw ALL of it — almost always a blocked
        # scraper, not a real mass-withdrawal. Skip those suburbs unless
        # the operator passes {"force": true}.
        force = bool(body.get('force'))
        for s in suburbs:
            sid = dict(s)['id']
            name = dict(s)['name']
            kept_row = conn.execute(
                "SELECT COUNT(*) AS n FROM listings "
                "WHERE suburb_id = ? AND status IN ('active', 'under_offer') "
                "  AND last_seen >= ?",
                (sid, cutoff)
            ).fetchone()
            kept = dict(kept_row)['n'] if kept_row else 0
            if kept == 0 and not force:
                per_suburb[name] = {'skipped': 'no recent scrape — '
                                    'would withdraw all', 'withdrawn': 0,
                                    'kept_alive': 0}
                total_skipped += 1
                continue
            cur = conn.execute(
                "UPDATE listings SET status = 'withdrawn', withdrawn_date = ? "
                "WHERE suburb_id = ? AND status IN ('active', 'under_offer') "
                "  AND (last_seen IS NULL OR last_seen < ?)",
                (now_iso, sid, cutoff)
            )
            flipped = cur.rowcount or 0
            if flipped or kept:
                per_suburb[name] = {'withdrawn': flipped, 'kept_alive': kept}
            total_flipped += flipped
            total_kept += kept
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        'withdrawn': total_flipped,
        'kept_alive': total_kept,
        'suburbs_skipped_no_recent_scrape': total_skipped,
        'suburbs_processed': len(suburbs),
        'per_suburb': per_suburb,
        'window_hours': hours,
        'cutoff_iso': cutoff,
    })


@app.route('/api/admin/force-reconcile-suburb', methods=['POST'])
def force_reconcile_suburb():
    """Force-withdraw orphan listings against the latest scrape data
    without re-running Playwright. Use case: REIWA shows 62 listings,
    DB shows 69 → the 7 extras were over-restored by an aggressive
    recovery, and the normal mark_withdrawn skipped them because the
    scrape's confident threshold was below 95%.

    Strategy: take every row in `listings` for the target suburb where
    last_seen falls inside the scrape-day window (last N hours, default
    24h) → consider those "still alive on REIWA". Every OTHER row
    currently active or under_offer in that suburb is an orphan → flip
    to withdrawn with today's date. confident=True is implicit
    (admin-triggered, operator-vetted).

    Body: { suburb_id: int (required), hours: int (default 24) }
    Returns: { withdrawn: N, suburb_id, kept_alive: N }
    """
    from admin_api import _require_admin
    _, err = _require_admin()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    suburb_id = body.get('suburb_id')
    if suburb_id is None:
        return jsonify({'error': 'suburb_id required'}), 400
    try:
        suburb_id = int(suburb_id)
    except (TypeError, ValueError):
        return jsonify({'error': 'suburb_id must be an integer'}), 400
    try:
        hours = int(body.get('hours', 24))
    except (TypeError, ValueError):
        hours = 24
    hours = max(1, min(hours, 168))  # cap at 1 week

    from datetime import timedelta
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    now_iso = datetime.utcnow().isoformat()
    conn = get_db()
    try:
        # Count what we're about to keep alive (sanity check for the
        # response payload).
        kept = conn.execute(
            "SELECT COUNT(*) AS n FROM listings "
            "WHERE suburb_id = ? AND status IN ('active', 'under_offer') "
            "  AND last_seen >= ?",
            (suburb_id, cutoff)
        ).fetchone()
        kept_alive = dict(kept)['n'] if kept else 0
        # Cascade guard: if NOTHING was seen in the window, there was no
        # successful scrape — flipping everything to withdrawn would wipe
        # the whole suburb (exactly the failure mode when the scraper is
        # blocked, e.g. Cloudflare). Refuse unless the operator overrides
        # with {"force": true}. Mirrors the coverage guard in the scrape
        # path (scrape_runner.py:283).
        force = bool(body.get('force'))
        if kept_alive == 0 and not force:
            conn.close()
            return jsonify({
                'error': f'No listings seen in the last {hours}h for this '
                         f'suburb — a withdraw sweep now would flip the '
                         f'ENTIRE suburb. This usually means the scraper is '
                         f'blocked, not that everything was withdrawn. '
                         f'Re-send with {{"force": true}} to override.',
                'kept_alive': 0,
                'would_withdraw': 'all active/under_offer in suburb',
            }), 409
        # The withdrawal pass: any active/UO row in this suburb that
        # WASN'T touched by a recent scrape → mark withdrawn.
        cur = conn.execute(
            "UPDATE listings SET status = 'withdrawn', withdrawn_date = ? "
            "WHERE suburb_id = ? AND status IN ('active', 'under_offer') "
            "  AND (last_seen IS NULL OR last_seen < ?)",
            (now_iso, suburb_id, cutoff)
        )
        flipped = cur.rowcount or 0
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        'withdrawn': flipped,
        'kept_alive': kept_alive,
        'suburb_id': suburb_id,
        'window_hours': hours,
        'cutoff_iso': cutoff,
        'next_step': 'Verify sidebar count matches REIWA. Repeat per '
                     'suburb if needed.',
    })


@app.route('/api/admin/reset-listing-dates', methods=['POST'])
def reset_listing_dates():
    """Clear listing_date on all rows so the next scrape repopulates them.
    Admin-only: this NULLs a column on every listing row in the DB; any
    authenticated non-admin previously had access via the global gate."""
    from admin_api import _require_admin
    _, err = _require_admin()
    if err:
        return err
    if request.args.get('confirm') != 'yes':
        return jsonify({
            'error': 'Destructive operation. Re-send with ?confirm=yes to proceed. '
                     'This will NULL listing_date on every row across all agencies.'
        }), 400
    conn = get_db()
    cur = conn.execute("UPDATE listings SET listing_date = NULL WHERE listing_date IS NOT NULL")
    affected = cur.rowcount
    conn.commit()
    conn.close()
    return jsonify({'cleared': affected})


@app.route('/api/admin/restore-recent-withdrawals', methods=['POST'])
def restore_recent_withdrawals():
    """Bulk-restore listings that were marked withdrawn within the past
    `days` window. Recovery tool for the mass-withdraw cascade bug:
    a scrape that found 0 actives + had >=5 candidates used to flip
    every candidate to withdrawn (now guarded — see run_daily_scrape.py
    and scrape_runner.py). To clean up data corrupted before the guard
    landed, hit this endpoint with a window covering the bad period,
    then trigger a fresh scrape per suburb — upsert_listing will flip
    re-seen listings back through 'active' via its clear_withdrawn
    branch, and genuinely-gone listings get re-withdrawn correctly by
    the next scrape's mark_withdrawn.

    Body (all optional): {
      "days":      int (default 14)        — window from today UTC
      "suburb_id": int (optional)          — limit to one suburb
    }
    Admin-only. Returns the count of rows whose status was flipped.
    """
    from admin_api import _require_admin
    _, err = _require_admin()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        days = int(body.get('days', 14))
    except (TypeError, ValueError):
        return jsonify({'error': 'days must be an integer'}), 400
    days = max(1, min(days, 90))
    suburb_id = body.get('suburb_id')
    if suburb_id is not None:
        try:
            suburb_id = int(suburb_id)
        except (TypeError, ValueError):
            return jsonify({'error': 'suburb_id must be an integer'}), 400

    from datetime import timedelta
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    conn = get_db()
    try:
        if suburb_id is not None:
            cur = conn.execute(
                "UPDATE listings SET status = 'active', withdrawn_date = NULL "
                "WHERE status = 'withdrawn' AND withdrawn_date >= ? "
                "AND suburb_id = ?",
                (cutoff, suburb_id)
            )
        else:
            cur = conn.execute(
                "UPDATE listings SET status = 'active', withdrawn_date = NULL "
                "WHERE status = 'withdrawn' AND withdrawn_date >= ?",
                (cutoff,)
            )
        affected = cur.rowcount or 0
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        'restored': affected,
        'days_window': days,
        'cutoff_iso': cutoff,
        'suburb_id': suburb_id,
        'next_step': 'Trigger a fresh scrape per suburb to reconcile real '
                     'vs false withdrawals (UI: tick suburb + click Scrape).',
    })


@app.route('/api/scrape/debug-detail', methods=['GET'])
def debug_scrape_detail():
    """Debug a single listing URL: returns extracted fields, text snippets,
    and regex-match results so we can see why land/internal sizes are empty."""
    from admin_api import _require_admin
    _u, err = _require_admin()
    if err:
        return err
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'error': 'Missing ?url=...'}), 400
    return jsonify(debug_detail(url))


@app.route('/api/scrape/compare/<int:suburb_id>', methods=['GET'])
def compare_scrape(suburb_id):
    """Compare REIWA's live listings vs our DB for a suburb."""
    # SECURITY: gate per-suburb access exactly like /api/scrape/logs
    # (app.py:638-645). Without this any authenticated user could
    # probe the scrape state of every suburb in the system.
    from admin_api import resolve_request_scope
    _user, allowed_ids = resolve_request_scope()
    if allowed_ids is not None and suburb_id not in allowed_ids:
        return jsonify({'error': 'Not authorised for that suburb'}), 403
    conn = get_db()
    suburb = conn.execute("SELECT * FROM suburbs WHERE id = ?", (suburb_id,)).fetchone()
    if not suburb:
        conn.close()
        return jsonify({'error': 'Suburb not found'}), 404
    rows = conn.execute(
        "SELECT reiwa_url FROM listings WHERE suburb_id = ? AND status IN ('active', 'under_offer')",
        (suburb_id,)
    ).fetchall()
    conn.close()
    db_urls = {r['reiwa_url'] for r in rows if r['reiwa_url']}
    result = compare_suburb(suburb['slug'], db_urls)
    result['suburb'] = suburb['name']
    return jsonify(result)


@app.route('/api/scrape/audit', methods=['GET'])
def audit_suburbs():
    """Multi-suburb audit — data completeness + optional REIWA comparison."""
    from admin_api import resolve_request_scope
    ids_str = request.args.get('suburb_ids', '').strip()
    if not ids_str:
        return jsonify({'error': 'suburb_ids required (comma-separated)'}), 400
    try:
        suburb_ids = [int(x) for x in ids_str.split(',') if x.strip()]
    except ValueError:
        return jsonify({'error': 'invalid suburb_ids'}), 400
    _user, allowed_ids = resolve_request_scope()
    if allowed_ids is not None:
        suburb_ids = [sid for sid in suburb_ids if sid in allowed_ids]
        if not suburb_ids:
            return jsonify({'error': 'Not authorised for any of those suburbs'}), 403
    do_compare = request.args.get('compare', '').lower() in ('1', 'true', 'yes')

    conn = get_db()
    results = []

    STRATA_TYPES = {'unit', 'apartment', 'townhouse', 'villa', 'studio', 'duplex'}

    for sid in suburb_ids:
        suburb = conn.execute("SELECT * FROM suburbs WHERE id = ?", (sid,)).fetchone()
        if not suburb:
            results.append({'suburb_id': sid, 'error': 'Suburb not found'})
            continue

        rows = conn.execute(
            """
            SELECT address, reiwa_url, listing_type, land_size, internal_size,
                   price_text, agent, agency, bedrooms, bathrooms, listing_date
            FROM listings
            WHERE suburb_id = ? AND status IN ('active', 'under_offer')
            """,
            (sid,)
        ).fetchall()

        missing_land = []
        missing_internal = []
        missing_type = []
        missing_price = []
        missing_agent = []
        missing_agency = []
        missing_date = []
        missing_beds = []
        for r in rows:
            t = (r['listing_type'] or '').strip().lower()
            addr = r['address'] or '(no address)'
            url = r['reiwa_url']
            land = (r['land_size'] or '').strip()
            internal = (r['internal_size'] or '').strip()

            if (t == 'house' and not land) or (not t and not land and not internal):
                missing_land.append({'address': addr, 'url': url, 'type': t or '(unknown)'})
            if t in STRATA_TYPES and not internal:
                missing_internal.append({'address': addr, 'url': url, 'type': t})
            if not t:
                missing_type.append({'address': addr, 'url': url})
            if not (r['price_text'] or '').strip():
                missing_price.append({'address': addr, 'url': url})
            if not (r['agent'] or '').strip():
                missing_agent.append({'address': addr, 'url': url})
            if not (r['agency'] or '').strip():
                missing_agency.append({'address': addr, 'url': url})
            if not (r['listing_date'] or '').strip():
                missing_date.append({'address': addr, 'url': url})
            if r['bedrooms'] is None:
                missing_beds.append({'address': addr, 'url': url})

        entry = {
            'suburb_id': sid,
            'suburb': suburb['name'],
            'db_count': len(rows),
            'completeness': {
                'missing_land_size': len(missing_land),
                'missing_internal_size': len(missing_internal),
                'missing_listing_type': len(missing_type),
                'missing_price': len(missing_price),
                'missing_agent': len(missing_agent),
                'missing_agency': len(missing_agency),
                'missing_listing_date': len(missing_date),
                'missing_bedrooms': len(missing_beds),
            },
            'examples': {
                'missing_land': missing_land[:10],
                'missing_internal': missing_internal[:10],
                'missing_type': missing_type[:10],
                'missing_price': missing_price[:10],
            },
        }

        if do_compare:
            db_urls = {r['reiwa_url'] for r in rows if r['reiwa_url']}
            try:
                cmp_result = compare_suburb(suburb['slug'], db_urls)
                entry['reiwa_total'] = cmp_result.get('reiwa_total')
                entry['matched'] = cmp_result.get('matched')
                entry['missing_from_db'] = cmp_result.get('missing_from_db', [])
                entry['sold_excluded'] = cmp_result.get('sold_excluded', [])
                entry['extra_in_db'] = cmp_result.get('extra_in_db', [])
                entry['pages_scraped'] = cmp_result.get('pages_scraped')
            except Exception as e:
                entry['compare_error'] = str(e)

        results.append(entry)

    conn.close()
    return jsonify({'suburbs': results, 'compare_mode': do_compare})


@app.route('/api/scrape/selected', methods=['POST'])
def scrape_selected():
    """Scrape only selected suburb IDs. Regular users can only scrape
    their assigned suburbs — any IDs they pass that aren't in their
    allowlist are silently dropped."""
    from admin_api import resolve_request_scope
    _, allowed = resolve_request_scope()
    data = request.json
    suburb_ids = data.get('suburb_ids', [])
    if allowed is not None:
        suburb_ids = [s for s in suburb_ids if s in allowed]
    if not suburb_ids:
        return jsonify({'error': 'No suburbs selected (or none assigned to you)'}), 400

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
        target=run_scrape_all,
        args=([{'id': s['id'], 'slug': s['slug'], 'name': s['name']}
               for s in suburbs_to_scrape],),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started', 'suburbs': [s['name'] for s in suburbs_to_scrape]})


@app.route('/api/scrape/logs', methods=['GET'])
def list_scrape_logs():
    from admin_api import resolve_request_scope
    suburb_id = request.args.get('suburb_id', type=int)
    _user, allowed_ids = resolve_request_scope()
    # admin (allowed_ids None) → no filter; specific suburb_id passed
    # is honoured if (a) admin or (b) it's in the user's allowed list.
    if suburb_id is not None:
        if allowed_ids is not None and suburb_id not in allowed_ids:
            return jsonify({'error': 'Not authorised for that suburb'}), 403
        return jsonify(get_scrape_logs(suburb_id=suburb_id))
    if allowed_ids is None:
        return jsonify(get_scrape_logs())
    if not allowed_ids:
        return jsonify([])
    # Non-admin without a specific suburb_id: return logs only for the
    # caller's assigned suburbs. get_scrape_logs filters one suburb at a
    # time, so we collect across allowed and re-cap to 20 most recent.
    rows = []
    for sid in allowed_ids:
        rows.extend(get_scrape_logs(suburb_id=sid, limit=20))
    rows.sort(key=lambda r: r.get('started_at') or '', reverse=True)
    return jsonify(rows[:20])


@app.route('/api/admin/transitions', methods=['GET'])
def list_transitions():
    """LOOP-1 monitoring — recent listing transitions detected by the diff
    engine. Admin-only (read-only). Filters: ?suburb=&type=&processed=&limit=."""
    import json as _json
    from admin_api import _require_admin
    _u, err = _require_admin()
    if err:
        return err
    suburb = request.args.get('suburb')
    ttype = request.args.get('type')
    processed = request.args.get('processed')
    limit = request.args.get('limit', type=int) or 50
    limit = max(1, min(limit, 500))

    clauses, params = [], []
    if suburb:
        clauses.append("suburb = ?"); params.append(suburb)
    if ttype:
        clauses.append("transition_type = ?"); params.append(ttype)
    if processed is not None and processed != '':
        val = 1 if str(processed).lower() in ('1', 'true', 'yes') else 0
        clauses.append("processed = ?"); params.append(val)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

    conn = get_db()
    rows = conn.execute(
        "SELECT id, listing_id, suburb, address, transition_type, from_status, "
        "to_status, detected_at, metadata, processed, processed_at "
        "FROM listing_transitions" + where +
        " ORDER BY detected_at DESC, id DESC LIMIT ?",
        tuple(params + [limit])
    ).fetchall()
    conn.close()

    out = []
    for r in rows:
        d = dict(r)
        if d.get('metadata'):
            try:
                d['metadata'] = _json.loads(d['metadata'])
            except Exception:
                pass
        out.append(d)
    return jsonify(out)


if __name__ == '__main__':
    init_db()
    backup_db()
    logger.info("Database backed up on startup")
    cleaned = cleanup_agent_entries()
    if cleaned:
        logger.info(f"Cleaned up {cleaned} agent profile entries from DB")
    app.run(host='0.0.0.0', port=5000, debug=True)

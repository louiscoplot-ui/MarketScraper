"""SQLite + Postgres dual-driver database layer.

If `DATABASE_URL` is set to a postgres:// or postgresql:// URL the module
talks to that server (used in production / GitHub Actions / Vercel).
Otherwise it falls back to a local SQLite file (handy for offline dev
without depending on a network DB).

The rest of the codebase keeps the simple `conn.execute(sql, params)`
sqlite-style API — _Conn translates placeholders and a couple of
SQLite-specific schema bits transparently for Postgres.

Schema initialisation lives in db_schema.py (re-exported below as
init_db) to keep this module small enough to push via MCP.
"""

import re
import sqlite3
import shutil
import os
import contextlib
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'reiwa.db')
BACKUP_DIR = os.path.join(os.path.dirname(__file__), 'backups')

DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
USE_POSTGRES = DATABASE_URL.startswith('postgres://') or DATABASE_URL.startswith('postgresql://')


def _translate_sql(sql, driver):
    """SQLite → Postgres syntax fixups. Trivially fast (string ops)."""
    if driver != 'pg':
        return sql
    out = sql
    out = out.replace('?', '%s')
    out = re.sub(r'INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT', 'SERIAL PRIMARY KEY', out, flags=re.I)
    out = re.sub(r'\bAUTOINCREMENT\b', '', out, flags=re.I)
    out = out.replace("datetime('now')", "CURRENT_TIMESTAMP")
    out = out.replace("date('now')", "CURRENT_DATE")
    return out


class _Cur:
    """Thin cursor wrapper exposing sqlite-style fetchone/fetchall + lastrowid."""

    def __init__(self, real, driver, last_inserted_id=None):
        self._cur = real
        self._driver = driver
        self._last_inserted_id = last_inserted_id

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def lastrowid(self):
        if self._last_inserted_id is not None:
            return self._last_inserted_id
        if self._driver == 'pg':
            return None
        return getattr(self._cur, 'lastrowid', None)


class _Conn:
    """Sqlite-shaped connection facade over either sqlite3 or psycopg2."""

    def __init__(self, real, driver):
        self._conn = real
        self._driver = driver

    def execute(self, sql, params=()):
        sql = _translate_sql(sql, self._driver)
        cur = self._conn.cursor()
        cur.execute(sql, params)
        return _Cur(cur, self._driver)

    def executescript(self, sql):
        sql = _translate_sql(sql, self._driver)
        cur = self._conn.cursor()
        if self._driver == 'pg':
            cur.execute(sql)
        else:
            cur.executescript(sql)

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


_STREET_ABBREVS = {
    'street': 'st', 'st.': 'st',
    'road': 'rd', 'rd.': 'rd',
    'avenue': 'av', 'ave': 'av', 'av.': 'av',
    'drive': 'dr', 'dr.': 'dr',
    'court': 'ct', 'ct.': 'ct',
    'place': 'pl', 'pl.': 'pl',
    'crescent': 'cres',
    'parade': 'pde',
    'highway': 'hwy', 'hway': 'hwy',
    'terrace': 'tce',
    'lane': 'ln',
    'close': 'cl',
    'boulevard': 'bvd', 'blvd': 'bvd',
    'boulevarde': 'bvd',
}


def normalize_address(addr):
    """Cheap address normaliser — matches same property listed by different agencies."""
    if not addr:
        return ''
    s = addr.lower().strip()
    s = re.sub(r'[,\.]', ' ', s)
    s = re.sub(r'\s+', ' ', s)
    for full, short in _STREET_ABBREVS.items():
        s = re.sub(r'\b' + re.escape(full) + r'\b', short, s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def restore_false_withdrawn(suburb_id=None):
    """Restore listings falsely marked as withdrawn within last 24h."""
    conn = get_db()
    yesterday = (datetime.utcnow() - __import__('datetime').timedelta(hours=24)).isoformat()
    if suburb_id:
        result = conn.execute(
            "UPDATE listings SET status = 'active', withdrawn_date = NULL "
            "WHERE status = 'withdrawn' AND last_seen > ? AND suburb_id = ?",
            (yesterday, suburb_id)
        )
    else:
        result = conn.execute(
            "UPDATE listings SET status = 'active', withdrawn_date = NULL "
            "WHERE status = 'withdrawn' AND last_seen > ?",
            (yesterday,)
        )
    restored = result.rowcount
    conn.commit()
    conn.close()
    return restored


def cleanup_agent_entries():
    """Remove agent profile entries incorrectly scraped as listings."""
    conn = get_db()
    result = conn.execute(
        "DELETE FROM listings WHERE reiwa_url LIKE '%/real-estate-agent/%' OR reiwa_url LIKE '%/agency/%'"
    )
    deleted = result.rowcount
    conn.commit()
    conn.close()
    return deleted


def backup_db():
    if not os.path.exists(DB_PATH):
        return
    if os.path.getsize(DB_PATH) < 1024:
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_path = os.path.join(BACKUP_DIR, f'reiwa_{stamp}.db')
    shutil.copy2(DB_PATH, backup_path)
    backups = sorted([f for f in os.listdir(BACKUP_DIR) if f.endswith('.db')])
    for old in backups[:-5]:
        os.remove(os.path.join(BACKUP_DIR, old))


def get_db():
    """Return a connection wrapper backed by Postgres or SQLite."""
    if USE_POSTGRES:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        raw = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor, connect_timeout=10)
        return _Conn(raw, 'pg')
    raw = sqlite3.connect(DB_PATH)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA journal_mode=WAL")
    raw.execute("PRAGMA foreign_keys=ON")
    return _Conn(raw, 'sqlite')


@contextlib.contextmanager
def get_db_conn():
    """Context-managed get_db() — guarantees conn.close() even when the
    body raises. Use in routes:

        with get_db_conn() as conn:
            rows = conn.execute(...).fetchall()

    Audit follow-up to the codebase-wide `conn = get_db(); ...;
    conn.close()` pattern where any .execute() exception leaked a
    Neon connection. With every route using this helper, a query
    failure rolls the connection back into the pool instead of
    pinning it open until gunicorn-restart."""
    conn = get_db()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass


# init_db lives in db_schema.py — re-export so existing callers
# (e.g. `from database import init_db` in app.py) keep working.
from db_schema import init_db  # noqa: E402,F401


def add_suburb(name):
    slug = name.strip().lower().replace(' ', '-')
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO suburbs (name, slug) VALUES (?, ?)",
            (name.strip().title(), slug)
        )
        conn.commit()
        suburb = conn.execute(
            "SELECT * FROM suburbs WHERE slug = ?", (slug,)
        ).fetchone()
        return dict(suburb)
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()


def remove_suburb(suburb_id):
    conn = get_db()
    conn.execute("DELETE FROM suburbs WHERE id = ?", (suburb_id,))
    conn.commit()
    conn.close()


def get_suburbs(allowed_ids=None):
    """List active suburbs with their listing counts.

    `allowed_ids` is the per-user filter: when None (admin or unauthed
    request) every suburb is returned; when a list is passed we only
    include those (this is how regular users only see their assigned
    suburbs). An empty list returns no rows — the user has nothing
    assigned yet."""
    conn = get_db()
    base = (
        "SELECT s.*, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'active') as active_count, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'under_offer') as under_offer_count, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'sold') as sold_count, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'withdrawn') as withdrawn_count "
        "FROM suburbs s WHERE s.active = 1"
    )
    params = []
    if allowed_ids is not None:
        if not allowed_ids:
            conn.close()
            return []
        placeholders = ','.join('?' * len(allowed_ids))
        base += f" AND s.id IN ({placeholders})"
        params.extend(allowed_ids)
    base += " ORDER BY s.name"
    rows = conn.execute(base, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_listings(suburb_id=None, suburb_ids=None, status=None, statuses=None):
    conn = get_db()
    # LEFT JOIN listing_notes so each listing carries its free-text
    # note inline — frontend renders the 📝 icon as filled when n.note
    # is non-null. Notes are keyed on normalized_address so they survive
    # re-listings (the listings.id changes when REIWA reposts).
    query = (
        "SELECT l.*, s.name as suburb_name, n.note as note "
        "FROM listings l "
        "JOIN suburbs s ON l.suburb_id = s.id "
        "LEFT JOIN listing_notes n ON n.normalized_address = l.normalized_address "
        "WHERE 1=1"
    )
    params = []
    if suburb_ids:
        placeholders = ','.join('?' * len(suburb_ids))
        query += f" AND l.suburb_id IN ({placeholders})"
        params.extend(suburb_ids)
    elif suburb_id:
        query += " AND l.suburb_id = ?"
        params.append(suburb_id)
    if statuses:
        placeholders = ','.join('?' * len(statuses))
        query += f" AND l.status IN ({placeholders})"
        params.extend(statuses)
    elif status:
        query += " AND l.status = ?"
        params.append(status)
    query += " ORDER BY l.listing_date DESC, l.last_seen DESC, l.address ASC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def upsert_listing(suburb_id, reiwa_url, data):
    """Insert or update a listing keyed by reiwa_url."""
    reiwa_url = reiwa_url.rstrip('/')
    conn = get_db()
    now = datetime.utcnow().isoformat()
    norm_addr = normalize_address(data.get('address') or '')
    new_status = data.get('status', 'active')

    existing = conn.execute(
        "SELECT * FROM listings WHERE reiwa_url = ? OR reiwa_url = ?",
        (reiwa_url, reiwa_url + '/')
    ).fetchone()

    if existing and existing['reiwa_url'] != reiwa_url:
        conn.execute("UPDATE listings SET reiwa_url = ? WHERE id = ?", (reiwa_url, existing['id']))
        conn.commit()

    if norm_addr and new_status in ('active', 'under_offer', 'sold'):
        excluded_id = existing['id'] if existing else -1
        conn.execute(
            "DELETE FROM listings WHERE suburb_id = ? AND status = 'withdrawn' "
            "AND normalized_address = ? AND id != ?",
            (suburb_id, norm_addr, excluded_id)
        )

    if existing:
        new_price = data.get('price_text')
        old_price = existing['price_text']
        if new_price and old_price and new_price != old_price:
            # Stamp the exact UTC moment the scraper saw the diff. We
            # don't rely on the column DEFAULT because (a) it lets the
            # Market Report 'When' column reflect detection time
            # precisely and (b) bulk imports / older code paths
            # wouldn't fill it consistently.
            conn.execute(
                "INSERT INTO price_history "
                "(listing_id, old_price, new_price, changed_at) "
                "VALUES (?, ?, ?, ?)",
                (existing['id'], old_price, new_price,
                 datetime.utcnow().isoformat())
            )

        clear_withdrawn = existing['status'] == 'withdrawn' and new_status != 'withdrawn'
        stamp_withdrawn = existing['status'] != 'withdrawn' and new_status == 'withdrawn'
        new_withdrawn_date = (
            None if clear_withdrawn
            else (now if stamp_withdrawn else existing['withdrawn_date'])
        )

        conn.execute("""
            UPDATE listings SET
                address = COALESCE(NULLIF(?, ''), address),
                normalized_address = COALESCE(NULLIF(?, ''), normalized_address),
                price_text = COALESCE(NULLIF(?, ''), price_text),
                bedrooms = COALESCE(?, bedrooms),
                bathrooms = COALESCE(?, bathrooms),
                parking = COALESCE(?, parking),
                land_size = COALESCE(NULLIF(?, ''), land_size),
                internal_size = COALESCE(NULLIF(?, ''), internal_size),
                agency = COALESCE(NULLIF(?, ''), agency),
                agent = COALESCE(NULLIF(?, ''), agent),
                status = ?,
                withdrawn_date = ?,
                last_seen = ?,
                sold_price = COALESCE(NULLIF(?, ''), sold_price),
                sold_date = COALESCE(NULLIF(?, ''), sold_date),
                listing_type = COALESCE(NULLIF(?, ''), listing_type),
                listing_date = COALESCE(NULLIF(?, ''), listing_date),
                source = COALESCE(NULLIF(?, ''), source)
            WHERE id = ?
        """, (
            data.get('address'), norm_addr, data.get('price_text'),
            data.get('bedrooms'), data.get('bathrooms'), data.get('parking'),
            data.get('land_size'), data.get('internal_size'),
            data.get('agency'), data.get('agent'),
            new_status, new_withdrawn_date, now,
            data.get('sold_price'), data.get('sold_date'),
            data.get('listing_type'), data.get('listing_date'),
            data.get('source'),
            existing['id']
        ))
        conn.commit()
        conn.close()
        return 'updated'
    else:
        conn.execute("""
            INSERT INTO listings (
                suburb_id, address, normalized_address, reiwa_url, price_text,
                bedrooms, bathrooms, parking, land_size, internal_size,
                agency, agent, status, withdrawn_date, first_seen, last_seen,
                sold_price, sold_date, listing_type, listing_date, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            suburb_id, data.get('address', ''), norm_addr, reiwa_url, data.get('price_text'),
            data.get('bedrooms'), data.get('bathrooms'), data.get('parking'),
            data.get('land_size'), data.get('internal_size'),
            data.get('agency'), data.get('agent'),
            new_status,
            now if new_status == 'withdrawn' else None,
            now, now,
            data.get('sold_price'), data.get('sold_date'),
            data.get('listing_type'), data.get('listing_date'),
            data.get('source', 'reiwa')
        ))
        conn.commit()
        conn.close()
        return 'new'


def mark_withdrawn(suburb_id, seen_urls, sold_urls, confident=False):
    if not confident:
        import logging
        logging.getLogger(__name__).info(
            f"Suburb {suburb_id}: scrape count < REIWA total, skipping withdrawn detection"
        )
        return 0

    conn = get_db()
    now = datetime.utcnow().isoformat()
    current_active = conn.execute(
        "SELECT id, reiwa_url FROM listings WHERE suburb_id = ? AND status IN ('active', 'under_offer')",
        (suburb_id,)
    ).fetchall()

    if not current_active:
        conn.close()
        return 0

    all_seen = {u.rstrip('/') for u in set(seen_urls) | set(sold_urls)}
    withdrawn_count = 0
    for listing in current_active:
        if listing['reiwa_url'].rstrip('/') not in all_seen:
            conn.execute(
                "UPDATE listings SET status = 'withdrawn', withdrawn_date = ?, "
                "last_seen = ? WHERE id = ?",
                (now, now, listing['id'])
            )
            withdrawn_count += 1

    conn.commit()
    conn.close()
    return withdrawn_count


def get_existing_urls(suburb_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT reiwa_url, listing_type, land_size, internal_size, listing_date "
        "FROM listings WHERE suburb_id = ? AND reiwa_url IS NOT NULL",
        (suburb_id,)
    ).fetchall()
    conn.close()

    STRATA_TYPES = {'unit', 'apartment', 'townhouse', 'villa', 'studio', 'duplex'}
    complete = set()
    for r in rows:
        t = (r['listing_type'] or '').strip().lower()
        land = (r['land_size'] or '').strip()
        internal = (r['internal_size'] or '').strip()
        listing_date = (r['listing_date'] or '').strip()
        if not listing_date:
            continue
        if not land and not internal:
            continue
        if t == 'house' and not land:
            continue
        if t in STRATA_TYPES and not internal:
            continue
        complete.add(r['reiwa_url'].rstrip('/'))
    return complete


def trim_sold_listings(suburb_id, keep=40):
    conn = get_db()
    rows = conn.execute(
        "SELECT id FROM listings WHERE suburb_id = ? AND status = 'sold' ORDER BY last_seen DESC",
        (suburb_id,)
    ).fetchall()
    if len(rows) > keep:
        ids_to_delete = [r['id'] for r in rows[keep:]]
        placeholders = ','.join('?' * len(ids_to_delete))
        conn.execute(f"DELETE FROM listings WHERE id IN ({placeholders})", ids_to_delete)
        conn.commit()
        deleted = len(ids_to_delete)
    else:
        deleted = 0
    conn.close()
    return deleted


def create_scrape_log(suburb_id):
    conn = get_db()
    if USE_POSTGRES:
        cur = conn.execute(
            "INSERT INTO scrape_logs (suburb_id) VALUES (?) RETURNING id", (suburb_id,)
        )
        row = cur.fetchone()
        log_id = row['id'] if row else None
    else:
        cursor = conn.execute(
            "INSERT INTO scrape_logs (suburb_id) VALUES (?)", (suburb_id,)
        )
        log_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return log_id


_UPDATE_SCRAPE_LOG_ALLOWED = frozenset({
    'completed_at', 'forsale_count', 'sold_count',
    'withdrawn_count', 'new_count', 'updated_count', 'errors',
})


def update_scrape_log(log_id, **kwargs):
    """Whitelisted UPDATE on scrape_logs. Column names are interpolated
    into the SQL string — keys outside the allow-list raise ValueError
    so a future caller can't accidentally turn this into SQL injection
    by piping request.json straight in."""
    conn = get_db()
    sets = []
    params = []
    for k, v in kwargs.items():
        if k not in _UPDATE_SCRAPE_LOG_ALLOWED:
            conn.close()
            raise ValueError(f"update_scrape_log: column not allowed: {k}")
        sets.append(f"{k} = ?")
        params.append(v)
    if not sets:
        conn.close()
        return
    params.append(log_id)
    conn.execute(f"UPDATE scrape_logs SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    conn.close()


def get_scrape_logs(suburb_id=None, limit=20):
    conn = get_db()
    query = "SELECT sl.*, s.name as suburb_name FROM scrape_logs sl JOIN suburbs s ON sl.suburb_id = s.id"
    params = []
    if suburb_id:
        query += " WHERE sl.suburb_id = ?"
        params.append(suburb_id)
    query += " ORDER BY sl.started_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_price_changes(suburb_ids=None, limit=50):
    """Return recent price changes joined with their listings.

    `effective_changed_at` is COALESCE(ph.changed_at, l.last_seen,
    l.first_seen) so legacy / pre-default rows that have NULL
    changed_at still show *some* date in the Market Report — the
    listing's last_seen is a tight upper bound (the change happened
    on or before that scrape) and is far better than blanks.
    """
    conn = get_db()
    query = """
        SELECT ph.*,
               l.address, l.reiwa_url, l.agent, l.agency, l.status,
               l.listing_date, l.first_seen, l.last_seen,
               s.name as suburb_name,
               COALESCE(ph.changed_at, l.last_seen, l.first_seen) AS effective_changed_at
        FROM price_history ph
        JOIN listings l ON ph.listing_id = l.id
        JOIN suburbs s ON l.suburb_id = s.id
    """
    params = []
    if suburb_ids:
        placeholders = ','.join('?' * len(suburb_ids))
        query += f" WHERE l.suburb_id IN ({placeholders})"
        params.extend(suburb_ids)
    # Sort by the effective date so rows with a NULL changed_at still
    # land in the right spot chronologically rather than drifting to
    # the end of the list.
    query += " ORDER BY COALESCE(ph.changed_at, l.last_seen, l.first_seen) DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def take_market_snapshot(suburb_id, stats):
    conn = get_db()
    today = datetime.utcnow().strftime('%Y-%m-%d')
    conn.execute(
        "DELETE FROM market_snapshots WHERE suburb_id = ? AND snapshot_date = ?",
        (suburb_id, today)
    )
    conn.execute("""
        INSERT INTO market_snapshots
            (suburb_id, snapshot_date, active_count, under_offer_count,
             sold_count, withdrawn_count, new_count, median_price, avg_dom)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        suburb_id, today,
        stats.get('active', 0), stats.get('under_offer', 0),
        stats.get('sold', 0), stats.get('withdrawn', 0),
        stats.get('new', 0), stats.get('median_price'),
        stats.get('avg_dom'),
    ))
    conn.commit()
    conn.close()


def get_market_snapshots(suburb_ids=None, limit=90):
    conn = get_db()
    query = """
        SELECT ms.*, s.name as suburb_name
        FROM market_snapshots ms
        JOIN suburbs s ON ms.suburb_id = s.id
    """
    params = []
    if suburb_ids:
        placeholders = ','.join('?' * len(suburb_ids))
        query += f" WHERE ms.suburb_id IN ({placeholders})"
        params.extend(suburb_ids)
    query += " ORDER BY ms.snapshot_date DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

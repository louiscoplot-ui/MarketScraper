import sqlite3
import shutil
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'reiwa.db')
BACKUP_DIR = os.path.join(os.path.dirname(__file__), 'backups')


def restore_false_withdrawn(suburb_id=None):
    """Restore listings that were falsely marked as withdrawn recently (within last 24h).
    Called when we suspect a bad scrape caused mass withdrawals."""
    conn = get_db()
    now = datetime.utcnow().isoformat()
    yesterday = (datetime.utcnow() - __import__('datetime').timedelta(hours=24)).isoformat()

    if suburb_id:
        result = conn.execute(
            "UPDATE listings SET status = 'active' WHERE status = 'withdrawn' AND last_seen > ? AND suburb_id = ?",
            (yesterday, suburb_id)
        )
    else:
        result = conn.execute(
            "UPDATE listings SET status = 'active' WHERE status = 'withdrawn' AND last_seen > ?",
            (yesterday,)
        )
    restored = result.rowcount
    conn.commit()
    conn.close()
    return restored


def cleanup_agent_entries():
    """Remove agent profile entries that were incorrectly scraped as listings."""
    conn = get_db()
    result = conn.execute(
        "DELETE FROM listings WHERE reiwa_url LIKE '%/real-estate-agent/%' OR reiwa_url LIKE '%/agency/%'"
    )
    deleted = result.rowcount
    conn.commit()
    conn.close()
    return deleted


def backup_db():
    """Create a timestamped backup of the database."""
    if not os.path.exists(DB_PATH):
        return
    if os.path.getsize(DB_PATH) < 1024:  # Skip if DB is nearly empty
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_path = os.path.join(BACKUP_DIR, f'reiwa_{stamp}.db')
    shutil.copy2(DB_PATH, backup_path)
    # Keep only last 5 backups
    backups = sorted([f for f in os.listdir(BACKUP_DIR) if f.endswith('.db')])
    for old in backups[:-5]:
        os.remove(os.path.join(BACKUP_DIR, old))


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS suburbs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suburb_id INTEGER NOT NULL,
            address TEXT NOT NULL,
            reiwa_url TEXT NOT NULL,
            price_text TEXT,
            bedrooms INTEGER,
            bathrooms INTEGER,
            parking INTEGER,
            land_size TEXT,
            internal_size TEXT,
            agency TEXT,
            agent TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            first_seen TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen TEXT NOT NULL DEFAULT (datetime('now')),
            sold_price TEXT,
            sold_date TEXT,
            listing_type TEXT,
            listing_date TEXT,
            FOREIGN KEY (suburb_id) REFERENCES suburbs(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_url
            ON listings(reiwa_url);

        CREATE INDEX IF NOT EXISTS idx_listings_status
            ON listings(status);

        CREATE INDEX IF NOT EXISTS idx_listings_suburb
            ON listings(suburb_id);

        CREATE TABLE IF NOT EXISTS scrape_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suburb_id INTEGER NOT NULL,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT,
            forsale_count INTEGER DEFAULT 0,
            sold_count INTEGER DEFAULT 0,
            new_count INTEGER DEFAULT 0,
            updated_count INTEGER DEFAULT 0,
            withdrawn_count INTEGER DEFAULT 0,
            errors TEXT,
            FOREIGN KEY (suburb_id) REFERENCES suburbs(id) ON DELETE CASCADE
        );
    """)
    # Migrate: add listing_date column if missing
    try:
        conn.execute("ALTER TABLE listings ADD COLUMN listing_date TEXT")
    except Exception:
        pass  # column already exists
    # Migrate: add source column
    try:
        conn.execute("ALTER TABLE listings ADD COLUMN source TEXT DEFAULT 'reiwa'")
    except Exception:
        pass  # column already exists

    # Price history tracking
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listing_id INTEGER NOT NULL,
            old_price TEXT,
            new_price TEXT,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_price_history_listing
            ON price_history(listing_id);
        CREATE INDEX IF NOT EXISTS idx_price_history_date
            ON price_history(changed_at);

        CREATE TABLE IF NOT EXISTS market_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suburb_id INTEGER NOT NULL,
            snapshot_date TEXT NOT NULL,
            active_count INTEGER DEFAULT 0,
            under_offer_count INTEGER DEFAULT 0,
            sold_count INTEGER DEFAULT 0,
            withdrawn_count INTEGER DEFAULT 0,
            new_count INTEGER DEFAULT 0,
            median_price INTEGER,
            avg_dom INTEGER,
            FOREIGN KEY (suburb_id) REFERENCES suburbs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_suburb_date
            ON market_snapshots(suburb_id, snapshot_date);
    """)

    conn.commit()
    conn.close()


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


def get_suburbs():
    conn = get_db()
    rows = conn.execute(
        "SELECT s.*, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'active') as active_count, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'under_offer') as under_offer_count, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'sold') as sold_count, "
        "(SELECT COUNT(*) FROM listings WHERE suburb_id = s.id AND status = 'withdrawn') as withdrawn_count "
        "FROM suburbs s WHERE s.active = 1 ORDER BY s.name"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_listings(suburb_id=None, suburb_ids=None, status=None, statuses=None):
    conn = get_db()
    query = "SELECT l.*, s.name as suburb_name FROM listings l JOIN suburbs s ON l.suburb_id = s.id WHERE 1=1"
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
    """Insert or update a listing. Keyed by reiwa_url (each REIWA listing is unique).
    Same property listed by 2 agencies = 2 different URLs = 2 rows."""
    conn = get_db()
    now = datetime.utcnow().isoformat()

    existing = conn.execute(
        "SELECT * FROM listings WHERE reiwa_url = ?",
        (reiwa_url,)
    ).fetchone()

    if existing:
        # Detect price change
        new_price = data.get('price_text')
        old_price = existing['price_text']
        if new_price and old_price and new_price != old_price:
            conn.execute(
                "INSERT INTO price_history (listing_id, old_price, new_price) VALUES (?, ?, ?)",
                (existing['id'], old_price, new_price)
            )

        conn.execute("""
            UPDATE listings SET
                address = COALESCE(?, address),
                price_text = COALESCE(?, price_text),
                bedrooms = COALESCE(?, bedrooms),
                bathrooms = COALESCE(?, bathrooms),
                parking = COALESCE(?, parking),
                land_size = COALESCE(?, land_size),
                internal_size = COALESCE(?, internal_size),
                agency = COALESCE(?, agency),
                agent = COALESCE(?, agent),
                status = ?,
                last_seen = ?,
                sold_price = COALESCE(?, sold_price),
                sold_date = COALESCE(?, sold_date),
                listing_type = COALESCE(?, listing_type),
                listing_date = COALESCE(?, listing_date),
                source = COALESCE(?, source)
            WHERE id = ?
        """, (
            data.get('address'), data.get('price_text'),
            data.get('bedrooms'), data.get('bathrooms'), data.get('parking'),
            data.get('land_size'), data.get('internal_size'),
            data.get('agency'), data.get('agent'),
            data.get('status', existing['status']),
            now,
            data.get('sold_price'), data.get('sold_date'),
            data.get('listing_type'),
            data.get('listing_date'),
            data.get('source'),
            existing['id']
        ))
        conn.commit()
        conn.close()
        return 'updated'
    else:
        conn.execute("""
            INSERT INTO listings (
                suburb_id, address, reiwa_url, price_text,
                bedrooms, bathrooms, parking, land_size, internal_size,
                agency, agent, status, first_seen, last_seen,
                sold_price, sold_date, listing_type, listing_date, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            suburb_id, data.get('address', ''), reiwa_url, data.get('price_text'),
            data.get('bedrooms'), data.get('bathrooms'), data.get('parking'),
            data.get('land_size'), data.get('internal_size'),
            data.get('agency'), data.get('agent'),
            data.get('status', 'active'), now, now,
            data.get('sold_price'), data.get('sold_date'),
            data.get('listing_type'),
            data.get('listing_date'),
            data.get('source', 'reiwa')
        ))
        conn.commit()
        conn.close()
        return 'new'


def mark_withdrawn(suburb_id, seen_urls, sold_urls, confident=False):
    """Mark listings as withdrawn if their URL disappeared from for-sale and isn't in sold.

    Only marks withdrawn when confident=True (our scrape count >= REIWA's stated total),
    meaning we're sure we captured every active listing on the site.
    If not confident, we skip entirely — better to keep a stale listing than to falsely
    mark an active one as withdrawn.
    """
    if not confident:
        import logging
        logging.getLogger(__name__).info(
            f"Suburb {suburb_id}: scrape count < REIWA total, skipping withdrawn detection "
            f"(need a complete scrape to safely mark withdrawals)"
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

    all_seen = set(seen_urls) | set(sold_urls)

    withdrawn_count = 0
    for listing in current_active:
        if listing['reiwa_url'] not in all_seen:
            conn.execute(
                "UPDATE listings SET status = 'withdrawn', last_seen = ? WHERE id = ?",
                (now, listing['id'])
            )
            withdrawn_count += 1

    conn.commit()
    conn.close()
    return withdrawn_count


def get_existing_urls(suburb_id):
    """Get all known listing URLs for a suburb (to skip detail pages on re-scrape)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT reiwa_url FROM listings WHERE suburb_id = ? AND reiwa_url IS NOT NULL",
        (suburb_id,)
    ).fetchall()
    conn.close()
    return {r['reiwa_url'] for r in rows}


def trim_sold_listings(suburb_id, keep=40):
    """Keep only the most recent N sold listings per suburb, delete older ones."""
    conn = get_db()
    # Get sold listings ordered by last_seen desc
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
    cursor = conn.execute(
        "INSERT INTO scrape_logs (suburb_id) VALUES (?)", (suburb_id,)
    )
    log_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return log_id


def update_scrape_log(log_id, **kwargs):
    conn = get_db()
    sets = []
    params = []
    for k, v in kwargs.items():
        sets.append(f"{k} = ?")
        params.append(v)
    params.append(log_id)
    conn.execute(
        f"UPDATE scrape_logs SET {', '.join(sets)} WHERE id = ?", params
    )
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
    """Get recent price changes with listing details."""
    conn = get_db()
    query = """
        SELECT ph.*, l.address, l.reiwa_url, l.agent, l.agency, l.status, l.listing_date,
               s.name as suburb_name
        FROM price_history ph
        JOIN listings l ON ph.listing_id = l.id
        JOIN suburbs s ON l.suburb_id = s.id
    """
    params = []
    if suburb_ids:
        placeholders = ','.join('?' * len(suburb_ids))
        query += f" WHERE l.suburb_id IN ({placeholders})"
        params.extend(suburb_ids)
    query += " ORDER BY ph.changed_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def take_market_snapshot(suburb_id, stats):
    """Record a market snapshot after scraping a suburb."""
    conn = get_db()
    today = datetime.utcnow().strftime('%Y-%m-%d')
    # Replace any existing snapshot for same suburb+date
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
    """Get historical market snapshots, last N days."""
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

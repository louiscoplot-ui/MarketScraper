import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'reiwa.db')


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
                listing_date = COALESCE(?, listing_date)
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
                sold_price, sold_date, listing_type, listing_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            suburb_id, data.get('address', ''), reiwa_url, data.get('price_text'),
            data.get('bedrooms'), data.get('bathrooms'), data.get('parking'),
            data.get('land_size'), data.get('internal_size'),
            data.get('agency'), data.get('agent'),
            data.get('status', 'active'), now, now,
            data.get('sold_price'), data.get('sold_date'),
            data.get('listing_type'),
            data.get('listing_date')
        ))
        conn.commit()
        conn.close()
        return 'new'


def mark_withdrawn(suburb_id, seen_urls, sold_urls):
    """Mark listings as withdrawn if their URL disappeared from for-sale and isn't in sold."""
    conn = get_db()
    now = datetime.utcnow().isoformat()

    current_active = conn.execute(
        "SELECT id, reiwa_url FROM listings WHERE suburb_id = ? AND status IN ('active', 'under_offer')",
        (suburb_id,)
    ).fetchall()

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

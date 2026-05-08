"""Schema initialisation — split out from database.py to keep modules
under the MCP push size limit. Re-exported by database.init_db so
existing callers don't need to change their imports.
"""


def init_db():
    from database import get_db, normalize_address, USE_POSTGRES

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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_url ON listings(reiwa_url);
        CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
        CREATE INDEX IF NOT EXISTS idx_listings_suburb ON listings(suburb_id);

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

    for col_sql in [
        "ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_date TEXT",
        "ALTER TABLE listings ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'reiwa'",
        "ALTER TABLE listings ADD COLUMN IF NOT EXISTS withdrawn_date TEXT",
        "ALTER TABLE listings ADD COLUMN IF NOT EXISTS normalized_address TEXT",
    ]:
        try:
            conn.execute(col_sql)
        except Exception:
            try:
                conn.execute(col_sql.replace(" IF NOT EXISTS", ""))
            except Exception:
                conn.commit()

    # One-shot backfill: prior to scraper.py commit 190fed0, the sold-page
    # card scraper wrote REIWA's "Sold DD/MM/YYYY" stamp into
    # listings.listing_date instead of listings.sold_date — leaving the
    # SOLD column blank and showing the sold date as the listed date.
    # Recover those rows by copying listing_date → sold_date (with a
    # dd/mm/yyyy → ISO yyyy-mm-dd conversion via SUBSTR + concat, which
    # works on both SQLite and Postgres) and NULL-ing out the corrupted
    # listing_date so UI doesn't display the same date in LISTED and
    # SOLD columns. Idempotent — only fires for sold rows whose
    # sold_date is still NULL, so subsequent runs are no-ops. The real
    # original listing_date can't be recovered (REIWA doesn't show it
    # on the sold detail page); user can manually edit via the inline
    # cell editor when they remember the date.
    try:
        conn.execute(
            "UPDATE listings "
            "SET sold_date = SUBSTR(listing_date, 7, 4) || '-' "
            "              || SUBSTR(listing_date, 4, 2) || '-' "
            "              || SUBSTR(listing_date, 1, 2), "
            "    listing_date = NULL "
            "WHERE status = 'sold' "
            "AND sold_date IS NULL "
            "AND listing_date IS NOT NULL "
            "AND LENGTH(listing_date) = 10 "
            "AND SUBSTR(listing_date, 3, 1) = '/' "
            "AND SUBSTR(listing_date, 6, 1) = '/'"
        )
        conn.commit()
    except Exception:
        conn.commit()

    conn.execute(
        "UPDATE listings SET withdrawn_date = last_seen "
        "WHERE status = 'withdrawn' AND withdrawn_date IS NULL"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_listings_normaddr "
                 "ON listings(suburb_id, normalized_address)")

    rows_to_backfill = conn.execute(
        "SELECT id, address FROM listings "
        "WHERE address IS NOT NULL AND address != '' "
        "AND (normalized_address IS NULL OR normalized_address = '')"
    ).fetchall()
    for r in rows_to_backfill:
        conn.execute(
            "UPDATE listings SET normalized_address = ? WHERE id = ?",
            (normalize_address(r['address']), r['id'])
        )
    if rows_to_backfill:
        conn.commit()

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listing_id INTEGER NOT NULL,
            old_price TEXT,
            new_price TEXT,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id);
        CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(changed_at);

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

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS pipeline_tracking (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_address TEXT NOT NULL,
            source_suburb TEXT NOT NULL,
            source_sold_date TEXT,
            source_price INTEGER,
            target_address TEXT NOT NULL,
            target_owner_name TEXT,
            hot_vendor_score INTEGER,
            status TEXT NOT NULL DEFAULT 'sent',
            sent_date TEXT NOT NULL DEFAULT CURRENT_DATE,
            response_date TEXT,
            notes TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(target_address, sent_date)
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_status ON pipeline_tracking(status);
        CREATE INDEX IF NOT EXISTS idx_pipeline_suburb ON pipeline_tracking(source_suburb);
        CREATE INDEX IF NOT EXISTS idx_pipeline_sent_date ON pipeline_tracking(sent_date);
    """)

    # Pre-lowered suburb column so the 12+ "WHERE source_suburb = ?"
    # filters across pipeline_api.py can hit an index instead of running
    # LOWER(source_suburb) = LOWER(?) which Postgres can't index without
    # a functional index. Backfill once on schema init; INSERT/UPDATE
    # callers in pipeline_api.py write source_suburb_lower alongside
    # source_suburb so the column stays in sync without a trigger.
    for col_sql in [
        "ALTER TABLE pipeline_tracking ADD COLUMN IF NOT EXISTS source_suburb_lower TEXT",
    ]:
        try:
            conn.execute(col_sql)
        except Exception:
            try:
                conn.execute(col_sql.replace(" IF NOT EXISTS", ""))
            except Exception:
                conn.commit()
    try:
        conn.execute(
            "UPDATE pipeline_tracking SET source_suburb_lower = LOWER(source_suburb) "
            "WHERE source_suburb_lower IS NULL"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_suburb_lower "
            "ON pipeline_tracking(source_suburb_lower)"
        )
        conn.commit()
    except Exception:
        conn.commit()

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS hot_vendor_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agency TEXT,
            uploaded_by TEXT,
            suburb TEXT,
            filename TEXT,
            row_count INTEGER DEFAULT 0,
            median_holding_years REAL,
            uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS hot_vendor_properties (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            upload_id INTEGER NOT NULL,
            address TEXT NOT NULL,
            normalized_address TEXT,
            suburb TEXT,
            type TEXT,
            bedrooms INTEGER,
            bathrooms INTEGER,
            last_sale_price INTEGER,
            owner_purchase_price INTEGER,
            owner_purchase_date TEXT,
            holding_years REAL,
            sales_count INTEGER,
            owner_gain_dollars INTEGER,
            owner_gain_pct REAL,
            cagr REAL,
            hold_score INTEGER,
            type_score INTEGER,
            gain_score INTEGER,
            final_score INTEGER,
            category TEXT,
            current_owner TEXT,
            agency TEXT,
            agent TEXT,
            FOREIGN KEY (upload_id) REFERENCES hot_vendor_uploads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_hv_props_upload ON hot_vendor_properties(upload_id);
        CREATE INDEX IF NOT EXISTS idx_hv_props_normaddr ON hot_vendor_properties(normalized_address);
        CREATE INDEX IF NOT EXISTS idx_hv_props_score ON hot_vendor_properties(final_score DESC);
    """)

    # v4 scoring additions — extra per-property scores + latent profit, plus
    # an upload-level metadata blob (JSON) so we can rebuild the Excel
    # report from stored data without re-running the pipeline.
    for col_sql in [
        "ALTER TABLE hot_vendor_uploads ADD COLUMN IF NOT EXISTS metadata TEXT",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS cagr_score INTEGER",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS freq_score INTEGER",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS prof_score INTEGER",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS estimated_value INTEGER",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS potential_profit INTEGER",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS potential_profit_pct REAL",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS rank INTEGER",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS first_seen_at TEXT",
        "ALTER TABLE hot_vendor_properties ADD COLUMN IF NOT EXISTS last_updated_at TEXT",
    ]:
        try:
            conn.execute(col_sql)
        except Exception:
            try:
                conn.execute(col_sql.replace(" IF NOT EXISTS", ""))
            except Exception:
                conn.commit()

    # User-facing status flag per property, keyed by normalized_address so it
    # survives re-uploads of the same suburb. 4 buckets (matches the UI):
    #   'listed'     — appraised / listed (green)
    #   'pending'    — waiting for response / considering (yellow)
    #   'declined'   — not interested (red)
    #   NULL / empty — never contacted (default, no tint)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS hot_vendor_property_status (
            normalized_address TEXT PRIMARY KEY,
            status TEXT,
            note TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_hv_status_value
            ON hot_vendor_property_status(status);
    """)

    # Re-upload behaviour: on the next score-csv we want UPSERT instead of
    # plain INSERT (no duplicate rows when the same suburb is re-uploaded
    # 6 / 12 months later — only the mutable fields refresh: sale_date,
    # owner, agency, agent, all the recalculated scores).
    #
    # Step 1: dedupe any existing duplicates from previous INSERT-only
    # uploads — keep the row with the highest id (most recent score).
    # Step 2: add UNIQUE INDEX on normalized_address, which the UPSERT
    # in hot_vendors_api._insert_property_rows targets via ON CONFLICT.
    try:
        if USE_POSTGRES:
            conn.execute("""
                DELETE FROM hot_vendor_properties a
                USING hot_vendor_properties b
                WHERE a.normalized_address = b.normalized_address
                  AND a.normalized_address IS NOT NULL
                  AND a.normalized_address <> ''
                  AND a.id < b.id
            """)
        else:
            conn.execute("""
                DELETE FROM hot_vendor_properties
                WHERE id NOT IN (
                    SELECT MAX(id) FROM hot_vendor_properties
                    WHERE normalized_address IS NOT NULL
                      AND normalized_address <> ''
                    GROUP BY normalized_address
                )
                AND normalized_address IS NOT NULL
                AND normalized_address <> ''
            """)
        conn.commit()
    except Exception:
        conn.commit()

    # Postgres ON CONFLICT (normalized_address) requires a NON-PARTIAL
    # unique index — partial indexes only match when the INSERT repeats
    # the WHERE predicate, which our _insert_property_rows doesn't.
    # 1. Coerce empty-string normalized_address rows to NULL (NULLs are
    #    distinct in unique indexes by default, so multiple bad-address
    #    rows still co-exist).
    # 2. Drop any pre-existing partial index from older migrations.
    # 3. Create a clean non-partial unique index.
    try:
        conn.execute(
            "UPDATE hot_vendor_properties SET normalized_address = NULL "
            "WHERE normalized_address = ''"
        )
        conn.commit()
    except Exception:
        try: conn.commit()
        except Exception: pass

    try:
        conn.execute("DROP INDEX IF EXISTS uq_hv_props_normaddr")
        conn.commit()
    except Exception:
        try: conn.commit()
        except Exception: pass

    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_hv_props_normaddr "
            "ON hot_vendor_properties(normalized_address)"
        )
        conn.commit()
    except Exception:
        try: conn.commit()
        except Exception: pass

    # Cache for OSM Overpass street lookups — pipeline neighbour generation
    # falls back to OSM when we have no Hot Vendor / listings data on a
    # street, so we never propose fake house numbers. One Overpass query
    # per street; cache for 30 days.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS street_address_cache (
            street_key TEXT PRIMARY KEY,
            numbers TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)

    # Per-listing free-text notes — keyed on normalized_address so the
    # note survives re-scrapes, re-listings, and agency switches. The
    # listings.id renews when REIWA reposts a withdrawn property; the
    # normalised address is the stable identifier.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS listing_notes (
            normalized_address TEXT PRIMARY KEY,
            note TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)

    # SuburbDesk users — admin-managed allowlist. Each user gets an
    # access_key (32-char hex) that they paste into the login screen.
    # `role` is 'admin' or 'user'. The first admin is seeded via the
    # ADMIN_EMAIL env var on app startup so the allowlist is never
    # empty after a fresh deploy.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            first_name TEXT,
            last_name TEXT,
            phone TEXT,
            role TEXT NOT NULL DEFAULT 'user',
            access_key TEXT NOT NULL UNIQUE,
            last_seen TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_access_key ON users(access_key);
    """)

    # Multi-tenant agent profile fields — populate the prospecting letter
    # signature/footer per-user instead of hardcoding Acton|Belle. The
    # PATCH /api/users/me/profile endpoint writes these; the letter
    # renderer falls back through env vars if a user hasn't filled them.
    for col_sql in [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS agency_name TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_name TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_phone TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_email TEXT",
    ]:
        try:
            conn.execute(col_sql)
        except Exception:
            try:
                conn.execute(col_sql.replace(" IF NOT EXISTS", ""))
            except Exception:
                conn.commit()
    conn.commit()

    # Per-user suburb assignment. A user only sees + scrapes the suburbs
    # they're assigned to (admins see all). Multiple users can share a
    # suburb — that's intentional, an agency team often works the same
    # patch. The "personne vole rien à personne" rule is enforced at
    # query time: unassigned users don't see the suburb at all.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS user_suburbs (
            user_id INTEGER NOT NULL,
            suburb_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, suburb_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (suburb_id) REFERENCES suburbs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_suburbs_user ON user_suburbs(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_suburbs_suburb ON user_suburbs(suburb_id);
    """)

    # One-shot backfill: legacy price_history rows that have NULL or
    # empty changed_at (pre-default inserts, bulk imports) get
    # populated from the joined listing's last_seen — the tightest
    # upper bound we have on when the diff was actually detected.
    # Falls through to first_seen if last_seen is also empty.
    try:
        conn.execute("""
            UPDATE price_history
               SET changed_at = COALESCE(
                   (SELECT l.last_seen FROM listings l WHERE l.id = price_history.listing_id),
                   (SELECT l.first_seen FROM listings l WHERE l.id = price_history.listing_id)
               )
             WHERE changed_at IS NULL OR changed_at = ''
        """)
        conn.commit()
    except Exception as e:
        # Non-fatal — boot must succeed even if the backfill hits an
        # edge case (e.g. very small DB, missing listing rows).
        try: conn.rollback()
        except Exception: pass

    conn.commit()
    conn.close()

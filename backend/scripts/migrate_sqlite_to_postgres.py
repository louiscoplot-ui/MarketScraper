"""One-shot SQLite -> Postgres migration.

Run this ONCE on your local machine after setting DATABASE_URL to your
Neon (or other Postgres) connection string. It reads every row from the
local backend/reiwa.db SQLite file and copies them into the Postgres DB
that database.py will open.

Usage (PowerShell):
    cd backend
    $env:DATABASE_URL = "postgresql://..."
    python scripts/migrate_sqlite_to_postgres.py

The script is safe to rerun: every INSERT uses ON CONFLICT DO NOTHING,
so existing rows are skipped. After the data import, Postgres sequences
are advanced past the migrated IDs so future inserts don't collide.
"""

import os
import sys
import sqlite3
from pathlib import Path


HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
sys.path.insert(0, str(BACKEND_DIR))

import database  # noqa: E402

DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
if not DATABASE_URL.startswith(('postgres://', 'postgresql://')):
    print("ERROR: DATABASE_URL must point to a Postgres server. "
          "Set it before running this script.")
    sys.exit(1)

SQLITE_PATH = BACKEND_DIR / 'reiwa.db'
if not SQLITE_PATH.exists():
    print(f"ERROR: source SQLite file not found at {SQLITE_PATH}")
    sys.exit(1)


# Order matters: parents before children so foreign keys resolve.
TABLES = [
    'suburbs',
    'listings',
    'scrape_logs',
    'price_history',
    'market_snapshots',
]


def main():
    print(f"Source:      {SQLITE_PATH}")
    print(f"Destination: {DATABASE_URL.split('@')[-1].split('/')[0]} (Postgres)")
    print()

    # 1. Build Postgres schema (idempotent)
    print("==> Creating Postgres schema (init_db)…")
    database.init_db()

    # 2. Open SQLite directly — we bypass the wrapper for the source so we
    # never accidentally read from Postgres.
    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = sqlite3.Row

    # 3. Open Postgres via the wrapper (DATABASE_URL is set)
    pg = database.get_db()

    total_in = 0
    total_out = 0
    for table in TABLES:
        try:
            rows = sqlite_conn.execute(f"SELECT * FROM {table}").fetchall()
        except sqlite3.OperationalError:
            print(f"  {table}: not in source SQLite, skipping")
            continue
        if not rows:
            print(f"  {table}: empty")
            continue
        total_in += len(rows)
        cols = list(rows[0].keys())
        placeholders = ','.join(['?'] * len(cols))
        col_sql = ','.join(cols)
        # ON CONFLICT (id) — every table has SERIAL/INTEGER PK named `id`.
        sql = (f"INSERT INTO {table} ({col_sql}) VALUES ({placeholders}) "
               f"ON CONFLICT (id) DO NOTHING")
        inserted = 0
        for r in rows:
            try:
                pg.execute(sql, tuple(r[c] for c in cols))
                inserted += 1
            except Exception as e:
                # Reset the aborted Postgres transaction and continue.
                pg.commit()
                print(f"  {table} id={r['id']}: {e!s}")
        pg.commit()
        total_out += inserted
        print(f"  {table}: {inserted}/{len(rows)} rows imported")

    # 4. Advance Postgres sequences past the migrated IDs.
    print()
    print("==> Syncing sequences…")
    for table in TABLES:
        seq = f"{table}_id_seq"
        try:
            pg.execute(
                f"SELECT setval(?, COALESCE((SELECT MAX(id) FROM {table}), 1), true)",
                (seq,)
            )
            pg.commit()
        except Exception as e:
            pg.commit()
            print(f"  {seq}: {e!s} (table likely empty — sequence stays at 1)")
    print()
    print(f"Migration complete. {total_out}/{total_in} rows in Postgres.")


if __name__ == '__main__':
    main()

"""One-shot SQLite -> Postgres migration.

Run this ONCE on your local machine after setting DATABASE_URL to your
Neon (or other Postgres) connection string. It reads every row from the
local backend/reiwa.db SQLite file and copies them into the Postgres DB
that database.py will open.

Usage (PowerShell):
    cd backend
    $env:DATABASE_URL = "postgresql://..."
    python scripts/migrate_sqlite_to_postgres.py

Implementation notes:
- Uses psycopg2.extras.execute_values for batched INSERTs (much faster
  over a high-latency link like Perth -> Sydney).
- ON CONFLICT DO NOTHING — safe to rerun. Existing rows skip, missing
  rows insert. Catches both id collisions and unique-index conflicts
  (e.g. listings.reiwa_url).
- Rollback after batch errors (commit on aborted txn would still roll
  back implicitly, but rollback is the correct API).
- After the data import, Postgres sequences are advanced past the
  imported max(id).
"""

import os
import sys
import sqlite3
import time
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
    import psycopg2
    from psycopg2.extras import execute_values

    print(f"Source:      {SQLITE_PATH}")
    print(f"Destination: {DATABASE_URL.split('@')[-1].split('/')[0]} (Postgres)")
    print()

    print("==> Creating Postgres schema (init_db)…")
    database.init_db()

    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = sqlite3.Row

    # Direct psycopg2 connection — bypass the wrapper so we can use the
    # batched execute_values helper for speed.
    raw = psycopg2.connect(DATABASE_URL, connect_timeout=15)
    raw.autocommit = False

    total_in = 0
    total_out = 0
    error_summary = {}

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
        src_cols = list(rows[0].keys())

        # Schema-drift defence: only insert columns that exist on BOTH sides.
        # Source-only columns (legacy ALTERs that never made it into init_db,
        # like reiwa_position) get silently dropped with a one-line notice.
        cur = raw.cursor()
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s",
            (table,),
        )
        dst_cols = {r[0] for r in cur.fetchall()}
        cols = [c for c in src_cols if c in dst_cols]
        dropped = [c for c in src_cols if c not in dst_cols]
        if dropped:
            print(f"  (skipping {len(dropped)} source-only column(s) "
                  f"absent in Postgres: {dropped})")
        if not cols:
            print(f"  {table}: no usable columns, skipping")
            continue

        col_sql = ','.join(cols)
        sql = (f"INSERT INTO {table} ({col_sql}) VALUES %s "
               f"ON CONFLICT DO NOTHING")

        # Process in batches so progress is visible and one bad row doesn't
        # tank the whole table.
        BATCH = 200
        inserted = 0
        skipped = 0
        failed_rows = 0
        t0 = time.time()
        cur = raw.cursor()
        for start in range(0, len(rows), BATCH):
            chunk = rows[start:start + BATCH]
            tuples = [tuple(r[c] for c in cols) for r in chunk]
            try:
                execute_values(cur, sql, tuples, page_size=BATCH)
                # cur.rowcount = rows actually inserted (post-ON-CONFLICT)
                ins = cur.rowcount
                skipped += (len(chunk) - ins)
                inserted += ins
                raw.commit()
            except Exception as e:
                raw.rollback()
                # Fall back to per-row insert for this chunk to find which row
                # is bad.
                for r in chunk:
                    try:
                        cur.execute(
                            f"INSERT INTO {table} ({col_sql}) VALUES "
                            f"({','.join(['%s'] * len(cols))}) "
                            f"ON CONFLICT DO NOTHING",
                            tuple(r[c] for c in cols),
                        )
                        if cur.rowcount:
                            inserted += 1
                        else:
                            skipped += 1
                        raw.commit()
                    except Exception as e2:
                        raw.rollback()
                        failed_rows += 1
                        msg = str(e2).strip().splitlines()[0][:200]
                        cls = msg.split(':', 1)[0]
                        error_summary.setdefault(table, {})[cls] = \
                            error_summary[table].get(cls, 0) + 1
            done = start + len(chunk)
            print(f"    …{table}: {done}/{len(rows)} processed", flush=True)

        elapsed = time.time() - t0
        bar = '✓' if failed_rows == 0 else '✗'
        print(f"  {bar} {table}: {inserted} new, {skipped} already-present, "
              f"{failed_rows} failed  ({elapsed:.1f}s)")
        total_out += inserted

    print()
    print("==> Syncing sequences…")
    cur = raw.cursor()
    for table in TABLES:
        seq = f"{table}_id_seq"
        try:
            cur.execute(
                f"SELECT setval(%s, COALESCE((SELECT MAX(id) FROM {table}), 1), true)",
                (seq,),
            )
            raw.commit()
        except Exception as e:
            raw.rollback()
            print(f"  {seq}: {e!s}")

    print()
    if error_summary:
        print("==> Failures by table / error class:")
        for table, errs in error_summary.items():
            for cls, n in sorted(errs.items(), key=lambda x: -x[1]):
                print(f"  {table:>20} | {n:>4}× {cls}")
        print()

    raw.close()
    sqlite_conn.close()
    print(f"Migration complete. {total_out} new rows imported "
          f"(out of {total_in} in source).")


if __name__ == '__main__':
    main()

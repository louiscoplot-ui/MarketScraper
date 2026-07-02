"""One-shot safety net before the sold_date backfill migration (D-3).

Exports to a timestamped local CSV every listings row that the
destructive cleanup in db_schema.py would touch — i.e. sold_date is
non-NULL and equals the day portion of first_seen. Restoring later is
a simple UPDATE per (id, sold_date) pair from the CSV.

Usage (must target the prod DB — refuses to run without it):

    DATABASE_URL=postgres://... python scripts/backup_sold_dates.py

Writes backup_sold_dates_<YYYYMMDD_HHMMSS>.csv in the current
directory and prints the row count + first 10 rows for eyeballing.
"""

import csv
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

COLUMNS = ['id', 'address', 'suburb_id', 'sold_date', 'sold_price', 'first_seen']


def main():
    if not os.environ.get('DATABASE_URL', '').strip():
        print("REFUSED: DATABASE_URL is not set.")
        print("This backup only makes sense against the prod (Neon) database;")
        print("without DATABASE_URL it would silently hit the local SQLite file")
        print("and produce a misleading, empty safety net.")
        print("Run:  DATABASE_URL=postgres://... python scripts/backup_sold_dates.py")
        return 2

    from database import get_db

    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, address, suburb_id, sold_date, sold_price, first_seen "
            "FROM listings "
            "WHERE sold_date IS NOT NULL "
            "AND first_seen IS NOT NULL "
            "AND sold_date = SUBSTR(first_seen, 1, 10) "
            "ORDER BY id"
        ).fetchall()
    finally:
        conn.close()

    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_path = f"backup_sold_dates_{ts}.csv"
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        for r in rows:
            d = dict(r)
            writer.writerow([d.get(c) for c in COLUMNS])

    print(f"Backed up {len(rows)} row(s) -> {out_path}")
    print()
    print(" | ".join(COLUMNS))
    for r in rows[:10]:
        d = dict(r)
        print(" | ".join(str(d.get(c)) for c in COLUMNS))
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""
Standalone diagnostic: compare live REIWA vs our DB for a suburb.
Usage: python diagnose.py [suburb_slug]  (default: claremont)
"""
import sys
import sqlite3
import logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

slug = sys.argv[1] if len(sys.argv) > 1 else "claremont"

conn = sqlite3.connect("reiwa.db")
conn.row_factory = sqlite3.Row

suburb = conn.execute("SELECT * FROM suburbs WHERE slug = ?", (slug,)).fetchone()
if not suburb:
    print(f"Suburb '{slug}' not found in DB. Available slugs:")
    for r in conn.execute("SELECT slug, name FROM suburbs").fetchall():
        print(f"  {r['slug']} ({r['name']})")
    sys.exit(1)

suburb_id = suburb["id"]
print(f"\nDiagnosing: {suburb['name']} (id={suburb_id}, slug={slug})")

rows = conn.execute(
    "SELECT reiwa_url, status FROM listings WHERE suburb_id = ? AND status IN ('active', 'under_offer')",
    (suburb_id,),
).fetchall()
conn.close()

db_urls = {r["reiwa_url"].rstrip("/") for r in rows if r["reiwa_url"]}
print(f"DB has {len(db_urls)} active+under_offer listings")

from scraper import compare_suburb

print("\nRunning live REIWA comparison (this takes ~1-2 minutes)...\n")
result = compare_suburb(slug, db_urls)

print(f"REIWA stated total : {result['reiwa_total']}")
print(f"REIWA URLs found   : {len(result['reiwa_urls'])}")
print(f"DB URLs            : {result['db_urls_count']}")
print(f"Matched            : {result['matched']}")
print(f"Pages scraped      : {result['pages_scraped']}")

if result["missing_from_db"]:
    print(f"\n--- {len(result['missing_from_db'])} MISSING from DB (on REIWA but not in our DB) ---")
    for u in result["missing_from_db"]:
        print(f"  MISSING: {u}")
else:
    print("\nNo missing listings — DB matches REIWA exactly!")

if result["extra_in_db"]:
    print(f"\n--- {len(result['extra_in_db'])} EXTRA in DB (in our DB but not on REIWA) ---")
    for u in result["extra_in_db"]:
        print(f"  EXTRA: {u}")

if result.get("error"):
    print(f"\nError: {result['error']}")

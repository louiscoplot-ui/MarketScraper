"""
DB recovery after the trailing-slash duplication bug.
Run ONCE after the current scrape finishes, BEFORE restarting the backend.

What it does:
1. For each duplicate pair (same URL with/without slash):
   - Keep the WITHOUT-slash row, delete the WITH-slash row
   - But if the without-slash row is withdrawn and the slash row is active/under_offer,
     restore the status from the slash row (it's the real data)
2. Normalize all remaining slash URLs in DB
3. Report what was fixed
"""
import sqlite3
import shutil
import os
from datetime import datetime

DB = os.path.join(os.path.dirname(__file__), 'reiwa.db')

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# --- Backup first ---
stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
backup = os.path.join(os.path.dirname(__file__), 'backups', f'reiwa_pre_recovery_{stamp}.db')
os.makedirs(os.path.dirname(backup), exist_ok=True)
shutil.copy2(DB, backup)
print(f"Backup saved: {backup}\n")

# --- Find duplicate pairs ---
rows = conn.execute("SELECT reiwa_url FROM listings WHERE reiwa_url LIKE '%/'").fetchall()
slash_urls = [r['reiwa_url'] for r in rows]

fixed = 0
restored = 0
orphans_normalized = 0

for slash_url in slash_urls:
    clean_url = slash_url.rstrip('/')

    slash_row = conn.execute("SELECT * FROM listings WHERE reiwa_url = ?", (slash_url,)).fetchone()
    clean_row = conn.execute("SELECT * FROM listings WHERE reiwa_url = ?", (clean_url,)).fetchone()

    if slash_row and clean_row:
        # Duplicate: keep clean_row, delete slash_row
        # But if clean_row is withdrawn and slash_row was active/under_offer → restore status
        if clean_row['status'] == 'withdrawn' and slash_row['status'] in ('active', 'under_offer'):
            conn.execute(
                "UPDATE listings SET status = ?, last_seen = ? WHERE id = ?",
                (slash_row['status'], slash_row['last_seen'], clean_row['id'])
            )
            restored += 1
            print(f"  RESTORED: {clean_url} → status={slash_row['status']}")

        conn.execute("DELETE FROM listings WHERE id = ?", (slash_row['id'],))
        fixed += 1

    elif slash_row and not clean_row:
        # Only the slash version exists — normalize it
        conn.execute("UPDATE listings SET reiwa_url = ? WHERE id = ?", (clean_url, slash_row['id']))
        orphans_normalized += 1

conn.commit()

# --- Summary ---
remaining_slash = conn.execute("SELECT COUNT(*) FROM listings WHERE reiwa_url LIKE '%/'").fetchone()[0]
total = conn.execute("SELECT COUNT(*) FROM listings").fetchone()[0]

print(f"\n=== Recovery complete ===")
print(f"  Duplicate pairs removed : {fixed}")
print(f"  Statuses restored       : {restored}")
print(f"  Orphan URLs normalized  : {orphans_normalized}")
print(f"  Remaining slash URLs    : {remaining_slash}")
print(f"  Total listings in DB    : {total}")

conn.close()
print("\nDone. Restart the backend, then re-scrape all suburbs.")

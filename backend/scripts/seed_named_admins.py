"""Idempotent seeder for the canonical admin accounts.

Runs on every Render boot via seed_admin_if_needed(), but kept as a
standalone entry point so an operator can re-run it from their laptop
against any database (USE_POSTGRES + DATABASE_URL pointing at Neon, or
the local SQLite file) without redeploying.

    cd backend
    DATABASE_URL='postgres://…neon.tech/marketscraper?sslmode=require' \
        python scripts/seed_named_admins.py

Output: one block per upserted user, with the access_key when it was
freshly created.
"""

import os
import sys

# scripts/ lives next to backend/, so step up one to import the
# backend modules without packaging the repo.
HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

from database import get_db  # noqa: E402
from admin_api import _NAMED_ADMINS, _upsert_admin  # noqa: E402


def main():
    print(f"Seeding {len(_NAMED_ADMINS)} named admin(s)...")
    conn = get_db()
    try:
        before = conn.execute(
            "SELECT id, email, role, first_name, last_name "
            "FROM users WHERE email IN ({})".format(
                ','.join(['?'] * len(_NAMED_ADMINS))
            ),
            tuple(e for e, _ in _NAMED_ADMINS)
        ).fetchall()
        print('\n--- BEFORE ---')
        if not before:
            print('  (no matching rows)')
        for r in before:
            d = dict(r)
            print(f"  id={d['id']:>4} email={d['email']:<32} role={d['role']:<6} name={d.get('first_name') or ''} {d.get('last_name') or ''}".rstrip())

        print('\n--- UPSERT ---')
        for email, first_name in _NAMED_ADMINS:
            action, uid, key = _upsert_admin(conn, email, first_name)
            tag = {'created': '+ CREATED', 'promoted': '~ PROMOTED',
                   'unchanged': '. unchanged', 'skipped': '! SKIPPED'}.get(action, action)
            print(f"  {tag:<14} id={uid} email={email}")
            if action == 'created' and key:
                print(f"      ACCESS KEY: {key}")

        after = conn.execute(
            "SELECT id, email, role, first_name, last_name "
            "FROM users WHERE email IN ({})".format(
                ','.join(['?'] * len(_NAMED_ADMINS))
            ),
            tuple(e for e, _ in _NAMED_ADMINS)
        ).fetchall()
        print('\n--- AFTER ---')
        for r in after:
            d = dict(r)
            ok = '✓' if (d.get('role') or '').lower() == 'admin' else '✗'
            print(f"  {ok} id={d['id']:>4} email={d['email']:<32} role={d['role']:<6} name={d.get('first_name') or ''} {d.get('last_name') or ''}".rstrip())
    finally:
        conn.close()


if __name__ == '__main__':
    main()

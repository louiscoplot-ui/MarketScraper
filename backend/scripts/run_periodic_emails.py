"""Periodic market-activity email cron — weekly / monthly / quarterly / annual.

Runs once a day (GitHub Actions, .github/workflows/periodic_emails.yml) and
self-selects which cadences are due for the current Perth date:
    Monday        → weekly recap
    1st of month  → monthly report
    1st of Q       → quarterly report (Jan/Apr/Jul/Oct)
    1 January      → year in review

Every cadence reads only the previous, already-completed period, so this
does NOT depend on tonight's scrape and can run at any hour. Most days
no cadence is due and the script exits in well under a second.

Usage (locally):
    cd backend
    export DATABASE_URL=postgresql://...
    python scripts/run_periodic_emails.py            # honour today's Perth date
    python scripts/run_periodic_emails.py weekly     # force a cadence (test)
"""

import logging
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
sys.path.insert(0, str(BACKEND_DIR))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('periodic_emails')


def main():
    import database  # noqa: F401 — ensures the DB driver is initialised
    from database import init_db
    from time_utils import perth_now
    from email_periodic import due_cadences, send_periodic

    # Schema must be current (new users.email_* + digest_logs.cadence
    # columns). init_db is idempotent — safe to call every run.
    try:
        init_db()
    except Exception:
        log.exception("init_db failed — continuing, columns may be missing")

    forced = [a.strip().lower() for a in sys.argv[1:] if a.strip()]
    ref = perth_now().date()
    cadences = forced or due_cadences(ref)

    if not cadences:
        log.info("No periodic cadence due for %s (Perth) — nothing to send.", ref)
        return

    log.info("Periodic email pass for %s (Perth): cadences=%s",
             ref, ', '.join(cadences))
    for cadence in cadences:
        try:
            result = send_periodic(cadence)
            log.info("Cadence %s: sent=%s skipped=%s failed=%s",
                     cadence, result.get('sent'), result.get('skipped'),
                     result.get('failed'))
        except Exception:
            log.exception("Cadence %s aborted", cadence)


if __name__ == '__main__':
    main()

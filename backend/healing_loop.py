"""Self-healing wrapper around the per-suburb scrape.

The nightly GitHub Actions cron (scripts/run_daily_scrape.py) used to call
`scrape_one(suburb)` directly. When REIWA threw a CAPTCHA, changed its
layout, rate-limited us, or the session died, the cron failed silently and
agents woke up to stale data with no signal that anything broke.

`run_with_recovery(suburb, scrape_fn)` wraps that existing call without
touching the scrape logic itself (scraper.py is left alone). It:

  DETECT   — intercept every failure, whether raised OR reported back via
             the {'error': ...} dict that scrape_one returns (scrape_one
             swallows scrape_suburb crashes, so we must inspect both).
  CLASSIFY — TRANSIENT (timeout / 429 / connection reset) → auto-retry;
             STRUCTURAL (dead selector / layout change) → ALERT now;
             UNKNOWN → retry then ALERT.
  RECOVER  — per-error backoff schedule, capped retries, clean exit.
  ALERT    — one Resend email to louis@suburbdesk.com, throttled to 1 / 2h
             via a /tmp flag so a multi-suburb run can't spam.
  LOG      — every attempt logged in the scraper's existing log format.

No new dependency: Resend goes through the existing email_service module,
backoff is stdlib time.sleep.
"""

import os
import time
import logging
import traceback

from time_utils import perth_now

# Playwright's TimeoutError is a subclass of Exception, not the builtin
# TimeoutError — import it for isinstance() checks. Guarded so this module
# still imports in an environment where playwright isn't present (the
# classifier falls back to string matching, which catches timeouts anyway).
try:
    from playwright.sync_api import (
        TimeoutError as PlaywrightTimeoutError,
        Error as PlaywrightError,
    )
except Exception:  # pragma: no cover - playwright always installed in prod
    PlaywrightTimeoutError = ()
    PlaywrightError = ()

logger = logging.getLogger('healing_loop')

# Where the scraper team will get paged. Hard-coded per spec — this is the
# operator address, not an end-user, so it doesn't go through user scoping.
ALERT_TO = 'louis@suburbdesk.com'

# Throttle file — one alert every ALERT_COOLDOWN seconds across the whole
# run (the GHA runner shares /tmp across the parallel suburb workers, so
# this dedupes a storm where every suburb fails the same way at once).
ALERT_FLAG_PATH = '/tmp/suburbdesk_scraper_alert.ts'
ALERT_COOLDOWN = 2 * 60 * 60  # 2 hours

# Recovery policy per error type. `backoff` is the delay (seconds) BEFORE
# each retry; its length is therefore the max retry count for that type.
#
#   timeout    [5s, 15s, 45s]  — exponential, REIWA usually recovers fast
#   rate_limit [5min ×3]       — 429 / Cloudflare needs a real cooldown
#   connection [1, 3, 10 min]  — the spec's TRANSIENT backoff schedule
#   structural []              — dead selector won't fix itself → ALERT now
#   unknown    [30s, 90s]      — generic exception: retry x2 then ALERT
#
# All TRANSIENT types cap at 3 retries as required. The two retry counts
# the brief gives for the generic/unknown bucket (DETECT "retry x2" vs
# CLASSIFY "retry x1") are reconciled to x2 here, the more resilient of
# the two — flag for Louis if x1 is preferred.
POLICY = {
    'timeout':    {'category': 'TRANSIENT',  'backoff': [5, 15, 45]},
    'rate_limit': {'category': 'TRANSIENT',  'backoff': [300, 300, 300]},
    'connection': {'category': 'TRANSIENT',  'backoff': [60, 180, 600]},
    'structural': {'category': 'STRUCTURAL', 'backoff': []},
    'unknown':    {'category': 'UNKNOWN',    'backoff': [30, 90]},
}


def _suburb_name(suburb):
    """suburb is a sqlite3.Row / dict-like with a 'name' key."""
    try:
        return suburb['name']
    except Exception:
        return str(suburb)


def _is_launch_failure(text):
    """True when the failure is Playwright failing to launch a browser at
    all (missing binary in a CI env, sandbox denied). Not retryable — the
    browser isn't coming back this run — and per spec must exit code 1."""
    t = text.lower()
    return any(s in t for s in (
        "executable doesn't exist",
        "executable doesnt exist",
        "failed to launch",
        "browsertype.launch",
        "playwright install",
        "host system is missing dependencies",
    ))


def classify_error(exc, text):
    """Return a policy key (timeout / rate_limit / connection / structural
    / unknown) from a live exception and/or its rendered text+traceback."""
    t = text.lower()

    # TimeoutError — builtin or Playwright's. Check type first, fall back
    # to the message so a timeout wrapped in another exception still hits.
    if isinstance(exc, TimeoutError) or (
        PlaywrightTimeoutError and isinstance(exc, PlaywrightTimeoutError)
    ):
        return 'timeout'
    if 'timeout' in t or 'timed out' in t:
        return 'timeout'

    # Rate limit / bot challenge surfaced in the page HTML or status.
    if any(s in t for s in (
        '429', 'too many requests', 'rate limit', 'rate-limit',
        'just a moment', 'cloudflare', 'access denied', 'captcha',
    )):
        return 'rate_limit'

    # Connection reset / dropped socket — transient network blip.
    if any(s in t for s in (
        'connection reset', 'econnreset', 'connreset', 'connection aborted',
        'connection refused', 'reset by peer', 'remote end closed',
    )):
        return 'connection'

    # Dead selector / layout change — the markers a scraper throws when
    # REIWA renames a class or restructures the grid.
    if any(s in t for s in (
        'nosuchelement', 'no node found', 'no element', 'selector resolved to',
        "has no attribute", 'attributeerror', 'nonetype', 'list index out of range',
    )):
        return 'structural'

    return 'unknown'


def _last_traceback_line(exc, fallback_text):
    """Last meaningful line of the traceback for the alert body."""
    if exc is not None:
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        lines = [ln.strip() for chunk in tb for ln in chunk.splitlines() if ln.strip()]
        if lines:
            return lines[-1]
    lines = [ln.strip() for ln in (fallback_text or '').splitlines() if ln.strip()]
    return lines[-1] if lines else 'no traceback'


def _alert_allowed():
    """Cooldown gate — True if no alert has fired in the last 2h. Uses a
    /tmp timestamp file (survives across the run's parallel workers)."""
    try:
        with open(ALERT_FLAG_PATH) as f:
            last = float(f.read().strip())
        # perth_now() and last are both naive-UTC-derived epochs via
        # time.time(); compare in plain epoch seconds.
        if time.time() - last < ALERT_COOLDOWN:
            return False
    except (FileNotFoundError, ValueError):
        pass
    except Exception as e:  # don't let the gate break alerting
        logger.warning("alert cooldown check failed (%s) — alerting anyway", e)
    return True


def _mark_alert_sent():
    try:
        with open(ALERT_FLAG_PATH, 'w') as f:
            f.write(str(time.time()))
    except Exception as e:
        logger.warning("could not write alert flag %s: %s", ALERT_FLAG_PATH, e)


def _send_alert(suburb_name, error_type, category, last_line):
    """Email the operator via Resend. Honors the 2h cooldown and the
    'no RESEND_API_KEY → log + continue' edge case (email_service._send
    already returns a logged no-op when the key is missing)."""
    if not os.environ.get('RESEND_API_KEY', '').strip():
        logger.warning(
            "RESEND_API_KEY not set — scraper alert for %s (%s) not sent",
            suburb_name, error_type,
        )
        return

    if not _alert_allowed():
        logger.info(
            "Alert suppressed (2h cooldown) — %s @ %s would have paged",
            error_type, suburb_name,
        )
        return

    ts = perth_now().strftime('%Y-%m-%d %H:%M:%S') + ' Perth'
    subject = f"[SuburbDesk] Scraper blocked — {error_type} @ {suburb_name}"
    html = f"""<!DOCTYPE html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222;">
  <h2 style="color:#b00020;margin:0 0 12px;">Scraper blocked</h2>
  <table cellpadding="6" style="font-size:14px;border-collapse:collapse;">
    <tr><td style="color:#888;">Suburb</td><td><strong>{suburb_name}</strong></td></tr>
    <tr><td style="color:#888;">Error type</td><td>{error_type}</td></tr>
    <tr><td style="color:#888;">Category</td><td>{category}</td></tr>
    <tr><td style="color:#888;">When</td><td>{ts}</td></tr>
  </table>
  <p style="color:#888;font-size:12px;margin:16px 0 4px;">Last traceback line</p>
  <pre style="background:#f5f5f5;padding:12px;border-radius:4px;
              font-size:12px;white-space:pre-wrap;word-break:break-word;">{last_line}</pre>
  <p style="color:#999;font-size:11px;margin-top:20px;">
    SuburbDesk self-healing scraper · further alerts suppressed for 2h
  </p>
</body></html>"""

    try:
        import email_service
        ok, err = email_service._send(ALERT_TO, subject, html)
        if ok:
            _mark_alert_sent()
            logger.info("Scraper alert sent to %s — %s @ %s",
                        ALERT_TO, error_type, suburb_name)
        else:
            logger.error("Scraper alert send failed: %s", err)
    except Exception as e:
        logger.exception("Scraper alert raised while sending: %s", e)


def run_with_recovery(suburb, scrape_fn):
    """Run one suburb's scrape with detect/classify/recover/alert.

    `scrape_fn(suburb)` is the existing per-suburb worker (scrape_one in
    run_daily_scrape.py). It either raises, or returns a result dict —
    which carries {'error': ...} when scrape_suburb crashed (scrape_one
    catches it internally). We treat both paths identically.

    Returns the scrape result dict on success. On give-up returns a dict
    with 'error' set (and 'fatal': True when the browser couldn't launch,
    which the caller turns into a non-zero process exit).
    """
    name = _suburb_name(suburb)
    attempt = 0

    while True:
        attempt += 1
        exc = None
        text = ''
        result = None

        logger.info("[%s] scrape attempt %d", name, attempt)
        try:
            result = scrape_fn(suburb)
            if not (result and result.get('error')):
                if attempt > 1:
                    logger.info("[%s] recovered on attempt %d", name, attempt)
                return result
            # scrape_fn swallowed a crash and reported it back as a dict.
            text = str(result.get('error') or '')
        except Exception as e:
            exc = e
            text = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"

        # --- DETECT: a fatal "browser won't launch" is not retryable ---
        if _is_launch_failure(text):
            logger.error("[%s] Playwright failed to launch — fatal: %s",
                         name, _last_traceback_line(exc, text))
            _send_alert(name, 'launch_failure', 'FATAL',
                        _last_traceback_line(exc, text))
            return {'name': name, 'error': 'playwright_launch_failed', 'fatal': True}

        # --- CLASSIFY ---
        err_type = classify_error(exc, text)
        policy = POLICY[err_type]
        category = policy['category']
        backoff = policy['backoff']
        max_attempts = len(backoff) + 1  # initial try + one per backoff slot

        last_line = _last_traceback_line(exc, text)
        logger.warning(
            "[%s] attempt %d failed — type=%s category=%s :: %s",
            name, attempt, err_type, category, last_line,
        )

        # --- STRUCTURAL: alert immediately, no retry ---
        if category == 'STRUCTURAL':
            logger.error("[%s] LAYOUT_CHANGED (%s) — alerting, no retry",
                         name, err_type)
            _send_alert(name, err_type, category, last_line)
            return {'name': name, 'error': f'structural:{err_type}'}  # err_type == 'structural'

        # --- RECOVER: TRANSIENT / UNKNOWN backoff + retry ---
        if attempt < max_attempts:
            delay = backoff[attempt - 1]
            logger.info("[%s] %s — retry %d/%d in %ds",
                        name, category, attempt, max_attempts - 1, delay)
            time.sleep(delay)
            continue

        # Retries exhausted → ALERT and exit cleanly.
        logger.error("[%s] %s persisted after %d attempts — alerting",
                     name, err_type, attempt)
        _send_alert(name, err_type, category, last_line)
        return {'name': name, 'error': f'{err_type}:retries_exhausted'}

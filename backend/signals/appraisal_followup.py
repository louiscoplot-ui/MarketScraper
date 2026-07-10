"""LOOP-5 — Appraisal follow-up sender (cron).

Sends the J+30/60/90 relances for logged appraisals, each carrying a fresh
suburb data point so the email is never generic. 90% of agents never follow
up; the mandate is won in the follow-up.

SAFETY: every send is gated behind SIGNALS_LIVE. Unset (default) → dry-run:
logs the intended email, sends nothing, leaves the follow-up 'pending' so it
fires once enabled. Also a no-op when RESEND_API_KEY is absent.
"""
import os
import logging
import statistics
from datetime import datetime, timedelta

from database import get_db
from signals.diff_engine import _price_to_int
import email_service

logger = logging.getLogger(__name__)


def _live():
    return os.environ.get('SIGNALS_LIVE', '').strip().lower() in ('1', 'true', 'yes')


def _suburb_data_point(conn, suburb, followup_day):
    """Build a fresh, honest data point for the suburb. Uses only what we can
    actually measure (recent sales count, live active count + median) — never
    invents a month-over-month delta we don't have history for."""
    if not suburb:
        return "the local market continues to move — worth a fresh look at your position."
    # "Since we met, N have sold" must count SALES DATED in the window,
    # not the sold backlog by last_seen (a sold listing's last_seen keeps
    # refreshing while it stays visible on REIWA, so the old count was
    # inflated to the whole visible backlog). Same effective-date pattern
    # as the pipeline's recent-sales window. Suburb match is
    # case-insensitive — appraisal suburbs are hand-typed.
    since_day = (datetime.utcnow() - timedelta(days=int(followup_day or 30))
                 ).strftime('%Y-%m-%d')
    sold = conn.execute(
        "SELECT COUNT(*) AS n FROM listings l JOIN suburbs s ON s.id = l.suburb_id "
        "WHERE LOWER(s.name) = LOWER(?) AND l.status = 'sold' "
        "AND COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) >= ?",
        (suburb, since_day)
    ).fetchone()
    sold_n = dict(sold)['n'] if sold else 0
    active_rows = conn.execute(
        "SELECT l.price_text FROM listings l JOIN suburbs s ON s.id = l.suburb_id "
        "WHERE LOWER(s.name) = LOWER(?) AND l.status = 'active'", (suburb,)
    ).fetchall()
    prices = [p for p in (_price_to_int(dict(r)['price_text']) for r in active_rows) if p]
    median_txt = f"${int(statistics.median(prices)):,}" if prices else None
    active_n = len(active_rows)

    if followup_day == 30:
        base = f"Since we met, {sold_n} propert{'y has' if sold_n == 1 else 'ies have'} sold in {suburb}"
        return base + (f" (median {median_txt})." if median_txt else ".")
    if followup_day == 60:
        return (f"{suburb} currently has {active_n} active listing"
                f"{'' if active_n == 1 else 's'}"
                + (f", median {median_txt}." if median_txt else "."))
    # J+90
    return (f"The {suburb} median is currently {median_txt}." if median_txt
            else f"{suburb} continues to see steady activity — happy to share the latest.")


def _email_html(vendor_name, address, data_point, followup_day):
    greeting = f"Hi {vendor_name}," if vendor_name else "Hi,"
    return f"""<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
<p>{greeting}</p>
<p>It's been about {followup_day} days since I appraised <strong>{address}</strong>.</p>
<p>{data_point}</p>
<p>If you'd like an updated view on where your property sits today, I'm happy to
help — no obligation.</p>
<p>Kind regards,<br>Your SuburbDesk agent</p>
</div>"""


def send_due_followups():
    """Send (or dry-run) all pending follow-ups whose date has arrived.
    Returns counts. Sends only when SIGNALS_LIVE is set."""
    live = _live()
    conn = get_db()
    sent = would_send = no_email = 0
    today = datetime.utcnow().strftime('%Y-%m-%d')
    try:
        rows = conn.execute(
            "SELECT f.id, f.appraisal_id, f.followup_day, a.address, a.suburb, "
            "a.vendor_name, a.vendor_email, a.status AS appraisal_status "
            "FROM appraisal_followups f "
            "JOIN appraisals a ON a.id = f.appraisal_id "
            "WHERE f.status = 'pending' AND f.scheduled_for <= ? "
            "AND a.status = 'active'",
            (today,)
        ).fetchall()

        for r in rows:
            r = dict(r)
            data_point = _suburb_data_point(conn, r['suburb'], r['followup_day'])
            subject = f"Following up on {r['address']}"

            if not r['vendor_email']:
                no_email += 1
                logger.info("followup[%s]: no vendor_email — skip", r['address'])
                continue

            if not live:
                would_send += 1
                logger.info("followup DRY-RUN: would email %s (J+%d) about %s",
                            r['vendor_email'], r['followup_day'], r['address'])
                continue  # leave pending so it fires once enabled

            html = _email_html(r['vendor_name'], r['address'], data_point, r['followup_day'])
            try:
                # _send returns (ok, err) and does NOT raise on a Resend
                # 4xx/5xx — a rejected email must stay 'pending' for retry,
                # not be marked sent.
                ok, err = email_service._send(r['vendor_email'], subject, html)
                if not ok:
                    logger.error("followup: Resend rejected %s: %s", r['vendor_email'], err)
                    continue
                sent += 1
            except Exception:
                logger.exception("followup: send failed to %s", r['vendor_email'])
                continue
            conn.execute(
                "UPDATE appraisal_followups SET status = 'sent', sent_at = ?, "
                "email_subject = ?, data_point_used = ? WHERE id = ?",
                (datetime.utcnow().isoformat(), subject, data_point, r['id'])
            )

        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("send_due_followups failed")
        return {'sent': 0, 'would_send': 0, 'no_email': 0, 'dry_run': not live}
    finally:
        conn.close()

    logger.info("appraisal followups: sent=%d would_send=%d no_email=%d (live=%s)",
                sent, would_send, no_email, live)
    return {'sent': sent, 'would_send': would_send, 'no_email': no_email,
            'dry_run': not live}

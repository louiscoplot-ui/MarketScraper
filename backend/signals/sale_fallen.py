"""LOOP-3 — Vente Tombée (sale-fallen) loop.

An under_offer listing returning to active means finance fell through or the
building inspection failed: the vendor is emotionally committed to selling
and their confidence in the agent is shaken. The action window is ~2 weeks.
The diff engine (LOOP-1) already records these as transition_type='sale_fallen';
this loop alerts the suburb's agent(s) and ages the signal out after 14 days.

SAFETY: every outbound email is gated behind the SIGNALS_LIVE env flag. When
it's unset (the default), the loop runs in dry-run mode — it logs what it
WOULD send and leaves the transition unprocessed, so nothing reaches a real
inbox until you explicitly enable it. No email is ever sent when
RESEND_API_KEY is absent either (email_service._send is a no-op then).
"""
import os
import json
import logging
from datetime import datetime, timedelta

from database import get_db
import email_service

logger = logging.getLogger(__name__)

ALERT_WINDOW_DAYS = 14


def _live():
    return os.environ.get('SIGNALS_LIVE', '').strip().lower() in ('1', 'true', 'yes')


def _recipients_for_suburb(conn, suburb_name):
    """Emails of users assigned to this suburb (by name → id → user_suburbs)."""
    rows = conn.execute(
        "SELECT DISTINCT u.email FROM user_suburbs us "
        "JOIN users u ON u.id = us.user_id "
        "JOIN suburbs s ON s.id = us.suburb_id "
        "WHERE s.name = ? AND u.email IS NOT NULL AND u.email <> ''",
        (suburb_name,)
    ).fetchall()
    return [dict(r)['email'] for r in rows]


def _alert_html(address, suburb, price_text, detected_at):
    app = email_service._app_url() if hasattr(email_service, '_app_url') else 'https://suburdesk.com'
    price_line = f'<p style="margin:0 0 6px;color:#444;">Listed at <strong>{price_text}</strong></p>' if price_text else ''
    # Suggested call script — a static template (no per-alert Claude call to
    # keep the cron cheap/fast). Deliberately avoids inventing a buyer count.
    script = (
        f"Hi, this is [your name] from [your agency]. I noticed your property at "
        f"{address} is available again — I understand that can be frustrating. "
        f"We're active in {suburb} right now and I'd value a quick chat about "
        f"your options. Would you have a few minutes this week?"
    )
    return f"""<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
<h2 style="color:#386350;margin:0 0 8px;">Opportunity detected this morning</h2>
<p style="margin:0 0 6px;font-size:15px;"><strong>{address}</strong> — {suburb} has returned to <strong>active</strong>.</p>
{price_line}
<p style="margin:0 0 6px;color:#444;">Detected: {str(detected_at)[:10]}</p>
<div style="margin:12px 0;padding:12px;background:#f5f5f5;border-left:3px solid #386350;border-radius:0 4px 4px 0;">
<p style="margin:0 0 4px;font-weight:600;">Suggested call script</p>
<p style="margin:0;color:#333;font-style:italic;">{script}</p>
</div>
<p style="margin:0;color:#999;font-size:12px;">This alert expires in {ALERT_WINDOW_DAYS} days. — SuburbDesk</p>
</div>"""


def process_sale_fallen_alerts():
    """Alert the suburb's agent(s) for each new sale_fallen transition, then
    mark it processed. Dry-run unless SIGNALS_LIVE is set. Returns counts."""
    live = _live()
    conn = get_db()
    sent = would_send = no_recipient = 0
    cutoff = (datetime.utcnow() - timedelta(days=ALERT_WINDOW_DAYS)).isoformat()
    try:
        # Only alert on signals still inside the 14-day action window — a
        # stale sale_fallen is past the point where the call lands, and gets
        # aged out by expire_old_sale_fallen() instead.
        rows = conn.execute(
            "SELECT id, listing_id, suburb, address, detected_at, metadata "
            "FROM listing_transitions "
            "WHERE transition_type = 'sale_fallen' AND processed = 0 "
            "AND detected_at >= ? "
            "ORDER BY detected_at DESC",
            (cutoff,)
        ).fetchall()

        for r in rows:
            r = dict(r)
            recipients = _recipients_for_suburb(conn, r['suburb'])
            meta = {}
            if r.get('metadata'):
                try:
                    meta = json.loads(r['metadata'])
                except Exception:
                    meta = {}
            price_text = meta.get('original_price')

            if not recipients:
                no_recipient += 1
                logger.info("sale_fallen[%s]: no agent assigned to %s — skip",
                            r['address'], r['suburb'])
                continue

            if not live:
                would_send += 1
                logger.info("sale_fallen DRY-RUN: would alert %s about %s (%s)",
                            recipients, r['address'], r['suburb'])
                continue  # leave unprocessed so it fires once enabled

            html = _alert_html(r['address'], r['suburb'], price_text, r['detected_at'])
            subject = f"🔔 Sale fallen — {r['address']} is back on the market"
            for to in recipients:
                try:
                    email_service._send(to, subject, html)
                    sent += 1
                except Exception:
                    logger.exception("sale_fallen: send failed to %s", to)
            conn.execute(
                "UPDATE listing_transitions SET processed = 1, processed_at = ? "
                "WHERE id = ?",
                (datetime.utcnow().isoformat(), r['id'])
            )

        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("process_sale_fallen_alerts failed")
        return {'sent': 0, 'would_send': 0, 'no_recipient': 0, 'dry_run': not live}
    finally:
        conn.close()

    logger.info("sale_fallen: sent=%d would_send=%d no_recipient=%d (live=%s)",
                sent, would_send, no_recipient, live)
    return {'sent': sent, 'would_send': would_send,
            'no_recipient': no_recipient, 'dry_run': not live}


def expire_old_sale_fallen():
    """Flag sale_fallen transitions older than 14 days as expired
    (metadata.expired=true). No deletion — keeps the audit trail."""
    conn = get_db()
    cutoff = (datetime.utcnow() - timedelta(days=ALERT_WINDOW_DAYS)).isoformat()
    expired = 0
    try:
        rows = conn.execute(
            "SELECT id, metadata FROM listing_transitions "
            "WHERE transition_type = 'sale_fallen' AND detected_at < ?",
            (cutoff,)
        ).fetchall()
        for r in rows:
            r = dict(r)
            try:
                meta = json.loads(r['metadata']) if r.get('metadata') else {}
            except Exception:
                meta = {}
            if meta.get('expired'):
                continue
            meta['expired'] = True
            conn.execute(
                "UPDATE listing_transitions SET metadata = ? WHERE id = ?",
                (json.dumps(meta), r['id'])
            )
            expired += 1
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("expire_old_sale_fallen failed")
    finally:
        conn.close()
    if expired:
        logger.info("sale_fallen: expired %d stale alert(s)", expired)
    return expired


def list_sale_fallen(allowed_ids=None):
    """Live (≤14d, non-expired) sale_fallen signals WITH details — powers
    the badge's dropdown panel so the agent can see which sale fell
    through and when. Same window/expiry/scope filter as
    active_sale_fallen_count; the two must stay in step or the badge
    count won't match the panel."""
    conn = get_db()
    cutoff = (datetime.utcnow() - timedelta(days=ALERT_WINDOW_DAYS)).isoformat()
    try:
        rows = conn.execute(
            "SELECT t.id, t.address, t.suburb, t.detected_at, t.metadata, "
            "       l.suburb_id, l.reiwa_url, l.price_text "
            "FROM listing_transitions t "
            "LEFT JOIN listings l ON l.id = t.listing_id "
            "WHERE t.transition_type = 'sale_fallen' AND t.detected_at >= ? "
            "ORDER BY t.detected_at DESC",
            (cutoff,)
        ).fetchall()
    except Exception:
        logger.exception("list_sale_fallen failed")
        conn.close()
        return []
    conn.close()
    out = []
    for r in rows:
        r = dict(r)
        if allowed_ids is not None and r.get('suburb_id') not in allowed_ids:
            continue
        try:
            meta = json.loads(r['metadata']) if r.get('metadata') else {}
        except Exception:
            meta = {}
        if meta.get('expired'):
            continue
        out.append({
            'id': r['id'],
            'address': r['address'],
            'suburb': r['suburb'],
            'detected_at': r['detected_at'],
            'original_price': meta.get('original_price') or r.get('price_text') or '',
            'reiwa_url': r.get('reiwa_url') or '',
        })
    return out


def active_sale_fallen_count(allowed_ids=None):
    """Count of live (≤14d, non-expired) sale_fallen signals, optionally
    scoped to a set of allowed suburb_ids (None = all). Powers the dashboard
    badge. Counts by joining the transition's listing back to its suburb."""
    conn = get_db()
    cutoff = (datetime.utcnow() - timedelta(days=ALERT_WINDOW_DAYS)).isoformat()
    try:
        rows = conn.execute(
            "SELECT t.metadata, l.suburb_id FROM listing_transitions t "
            "LEFT JOIN listings l ON l.id = t.listing_id "
            "WHERE t.transition_type = 'sale_fallen' AND t.detected_at >= ?",
            (cutoff,)
        ).fetchall()
    except Exception:
        logger.exception("active_sale_fallen_count failed")
        conn.close()
        return 0
    conn.close()
    n = 0
    for r in rows:
        r = dict(r)
        if allowed_ids is not None and r.get('suburb_id') not in allowed_ids:
            continue
        try:
            meta = json.loads(r['metadata']) if r.get('metadata') else {}
        except Exception:
            meta = {}
        if meta.get('expired'):
            continue
        n += 1
    return n

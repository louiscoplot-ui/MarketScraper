"""Daily morning digest email — sent at the end of the nightly scrape.

For each user in the DB, builds a per-suburb summary (new active
listings, new sales, top 3 hot vendors) scoped to the suburbs they're
assigned to (admins see every active suburb). Sends via Resend; per-
user failures are logged but never raised so a single bad address
can't crash the cron pass."""

import logging
import os
from datetime import datetime

from database import get_db
from email_service import _send, _app_url

logger = logging.getLogger(__name__)


_MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
              'July', 'August', 'September', 'October', 'November', 'December']


def _today_au():
    """8 May 2026 — AU long form, no zero-padded day. Built manually so
    the output is identical on Linux (Render, GHA) and Windows (local
    dev) without depending on locale-specific strftime tokens."""
    now = datetime.utcnow()
    return f"{now.day} {_MONTHS_EN[now.month - 1]} {now.year}"


def _start_of_today_iso():
    """ISO-8601 start of today UTC — comparable against listings.first_seen
    / last_seen which are stored as datetime.utcnow().isoformat()."""
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return today.isoformat()


def _stats_for_suburb(suburb_id, suburb_name, since_iso):
    conn = get_db()
    new_active = conn.execute(
        "SELECT COUNT(*) AS n FROM listings "
        "WHERE suburb_id = ? AND status IN ('active', 'under_offer') "
        "AND first_seen >= ?",
        (suburb_id, since_iso)
    ).fetchone()['n']
    new_sales = conn.execute(
        "SELECT COUNT(*) AS n FROM listings "
        "WHERE suburb_id = ? AND status = 'sold' AND last_seen >= ?",
        (suburb_id, since_iso)
    ).fetchone()['n']
    # Top 3 hot vendors from the most recent upload for this suburb
    # (hot_vendor_uploads.suburb is free-text — joined LOWER on name).
    hv_rows = conn.execute(
        "SELECT p.address, p.final_score "
        "FROM hot_vendor_properties p "
        "JOIN hot_vendor_uploads u ON p.upload_id = u.id "
        "WHERE LOWER(u.suburb) = LOWER(?) "
        "AND p.final_score IS NOT NULL "
        "AND u.id = (SELECT MAX(id) FROM hot_vendor_uploads "
        "            WHERE LOWER(suburb) = LOWER(?)) "
        "ORDER BY p.final_score DESC LIMIT 3",
        (suburb_name, suburb_name)
    ).fetchall()
    conn.close()
    return {
        'new_active': new_active,
        'new_sales': new_sales,
        'hot_vendors': [
            {'address': r['address'], 'score': r['final_score']}
            for r in hv_rows
        ],
    }


def _build_digest_text(user, suburb_stats, today_au):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    lines = [
        f"Good morning {name},",
        '',
        f"Here's your SuburbDesk Morning Report for {today_au}.",
        '',
    ]
    if not suburb_stats:
        lines.append("No suburbs assigned to your account yet — "
                     "ask your admin to add some.")
    else:
        for suburb, stats in suburb_stats:
            lines.append(f"=== {suburb} ===")
            lines.append(f"  New active listings: {stats['new_active']}")
            lines.append(f"  New sales:           {stats['new_sales']}")
            if stats['hot_vendors']:
                lines.append("  Top hot vendors:")
                for hv in stats['hot_vendors']:
                    lines.append(f"    - {hv['address']} (score {hv['score']})")
            lines.append('')
    lines.append(f"Open the app: {app}")
    lines.append('')
    lines.append('-- SuburbDesk')
    return '\n'.join(lines)


def _build_digest_html(user, suburb_stats, today_au):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    if not suburb_stats:
        body = ('<p style="color:#444;font-size:14px;">'
                'No suburbs assigned to your account yet — ask your admin '
                'to add some.</p>')
    else:
        cards = []
        for suburb, stats in suburb_stats:
            hv_html = ''
            if stats['hot_vendors']:
                items = ''.join(
                    f'<li style="margin:4px 0;">{hv["address"]} '
                    f'<span style="color:#777;">(score {hv["score"]})</span></li>'
                    for hv in stats['hot_vendors']
                )
                hv_html = (
                    '<p style="margin:8px 0 0;color:#444;font-size:13px;">'
                    '<strong>Top hot vendors:</strong></p>'
                    f'<ul style="margin:4px 0 0 18px;color:#444;font-size:13px;">'
                    f'{items}</ul>'
                )
            cards.append(
                '<div style="margin:0 0 18px;padding:14px 16px;background:#f7f7f7;'
                'border-left:4px solid #386351;border-radius:4px;">'
                f'<h3 style="margin:0 0 6px;color:#222;font-size:15px;">{suburb}</h3>'
                '<p style="margin:0;color:#444;font-size:13px;">'
                f'New active listings: <strong>{stats["new_active"]}</strong> &middot; '
                f'New sales: <strong>{stats["new_sales"]}</strong></p>'
                f'{hv_html}</div>'
            )
        body = ''.join(cards)
    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
<tr><td style="background:#386351;padding:24px 32px;">
<h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;font-weight:700;">SUBURBDESK</h1>
<p style="margin:4px 0 0;color:#cfe0d6;font-size:13px;">Morning Report &middot; {today_au}</p>
</td></tr>
<tr><td style="padding:28px 32px;">
<p style="margin:0 0 16px;font-size:15px;color:#222;">Good morning {name},</p>
<p style="margin:0 0 22px;color:#444;line-height:1.55;font-size:14px;">
Here's your overnight SuburbDesk update.
</p>
{body}
<p style="margin:24px 0 0;text-align:center;">
<a href="{app}" style="display:inline-block;background:#386351;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open SuburbDesk</a>
</p>
</td></tr>
<tr><td style="background:#fafafa;padding:14px 32px;border-top:1px solid #eee;text-align:center;">
<p style="margin:0;color:#999;font-size:11px;">SuburbDesk &middot; suburbdesk.com</p>
</td></tr>
</table></td></tr></table></body></html>"""


def send_digest(user_id):
    """Build + send the morning digest for a single user.

    Returns (ok, error_or_none). Never raises — caller (the cron) can
    iterate over user IDs without try/except wrapping every call."""
    if not (os.environ.get('EMAIL_FROM') or '').strip():
        logger.warning("EMAIL_FROM not set — digest for user_id=%s skipped", user_id)
        return False, 'EMAIL_FROM not configured'
    try:
        conn = get_db()
        user = conn.execute(
            "SELECT id, email, first_name, role FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            conn.close()
            return False, 'User not found'
        is_admin = (user['role'] or '').lower() == 'admin'
        if is_admin:
            suburb_rows = conn.execute(
                "SELECT id, name FROM suburbs WHERE active = 1 ORDER BY name"
            ).fetchall()
        else:
            suburb_rows = conn.execute(
                "SELECT s.id, s.name FROM suburbs s "
                "JOIN user_suburbs us ON s.id = us.suburb_id "
                "WHERE us.user_id = ? AND s.active = 1 "
                "ORDER BY s.name",
                (user_id,)
            ).fetchall()
        conn.close()
    except Exception as e:
        logger.exception("Digest data lookup failed for user_id=%s", user_id)
        return False, str(e)

    since_iso = _start_of_today_iso()
    suburb_stats = []
    for s in suburb_rows:
        try:
            stats = _stats_for_suburb(s['id'], s['name'], since_iso)
            suburb_stats.append((s['name'], stats))
        except Exception as e:
            logger.warning("Digest stats failed for suburb %s: %s", s['name'], e)
            continue

    today = _today_au()
    user_dict = dict(user)
    if not (user_dict.get('email') or '').strip():
        return False, 'User has no email'
    subject = f"SuburbDesk Morning Report — {today}"
    html = _build_digest_html(user_dict, suburb_stats, today)
    text = _build_digest_text(user_dict, suburb_stats, today)
    try:
        return _send(user_dict['email'], subject, html, text=text)
    except Exception as e:
        logger.exception("Digest send crashed for user_id=%s", user_id)
        return False, str(e)

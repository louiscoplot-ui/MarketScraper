"""Daily morning digest email — sent at the end of the nightly scrape.

For each user in the DB, builds a per-suburb summary scoped to the
suburbs they're assigned to (admins see every active suburb). Three
sections — new listings, status changes, and hot-vendor alerts —
are rendered with per-item detail (address, price, agent, REIWA link)
so the agent can act directly from the inbox. Sends via Resend;
per-user failures are logged but never raised so a single bad address
can't crash the cron pass."""

import logging
import os
from datetime import datetime, timedelta

from database import get_db
from email_service import _send, _app_url
from time_utils import perth_now, _PERTH_OFFSET

logger = logging.getLogger(__name__)


_MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
              'July', 'August', 'September', 'October', 'November', 'December']


def _today_au():
    """8 May 2026 — AU long form, no zero-padded day. Built manually so
    the output is identical on Linux (Render, GHA) and Windows (local
    dev) without depending on locale-specific strftime tokens."""
    now = perth_now()
    return f"{now.day} {_MONTHS_EN[now.month - 1]} {now.year}"


def _weekday_perth():
    return perth_now().strftime('%A')


def _since_iso_perth_midnight():
    """ISO-8601 timestamp for "yesterday 00:00 Perth time" expressed as
    UTC (so it lines up with listings.first_seen / last_seen written
    via datetime.utcnow().isoformat()).

    Perth midnight today UTC = Perth midnight - 8h. The cron runs just
    after Perth midnight, so "yesterday 00:00 Perth" = the previous
    Perth day's start, which is the cutoff for "what landed overnight"."""
    perth_midnight = perth_now().replace(hour=0, minute=0, second=0, microsecond=0)
    # Step back one day to capture the full overnight window.
    perth_yesterday_midnight = perth_midnight - timedelta(days=1)
    return (perth_yesterday_midnight - _PERTH_OFFSET).isoformat()


_STATUS_LABELS = {
    'under_offer': 'Under Offer',
    'sold': 'Sold',
    'withdrawn': 'Withdrawn',
}


def _build_sections(suburb_rows, user_id, since_iso):
    """Pull the three sections (new listings, status changes, hot vendor
    alerts) for every suburb the user can see.

    Returns dict {new_listings: [...], status_changes: [...],
    hot_vendor_alerts: [...]} with each list flat (sorted by suburb,
    then date desc) so the renderer can section-header them once."""
    if not suburb_rows:
        return {'new_listings': [], 'status_changes': [],
                'hot_vendor_alerts': [], 'withdrawn_orphans': []}
    suburb_ids = tuple(s['id'] for s in suburb_rows)
    placeholders = ','.join(['?'] * len(suburb_ids))
    conn = get_db()
    try:
        new_listings = conn.execute(
            f"SELECT l.address, l.price_text, l.bedrooms, l.bathrooms, "
            f"l.agency, l.agent, l.reiwa_url, l.status, s.name AS suburb "
            f"FROM listings l "
            f"JOIN suburbs s ON s.id = l.suburb_id "
            f"WHERE l.suburb_id IN ({placeholders}) "
            f"AND l.first_seen >= ? "
            f"ORDER BY s.name, l.listing_date DESC NULLS LAST, l.first_seen DESC",
            (*suburb_ids, since_iso)
        ).fetchall() if 'NULLS' in conn.__class__.__module__.lower() or True else None
    except Exception:
        # Postgres supports NULLS LAST; SQLite tolerates it as of 3.30
        # but falls back gracefully below if not.
        new_listings = None
    if new_listings is None:
        new_listings = conn.execute(
            f"SELECT l.address, l.price_text, l.bedrooms, l.bathrooms, "
            f"l.agency, l.agent, l.reiwa_url, l.status, s.name AS suburb "
            f"FROM listings l "
            f"JOIN suburbs s ON s.id = l.suburb_id "
            f"WHERE l.suburb_id IN ({placeholders}) "
            f"AND l.first_seen >= ? "
            f"ORDER BY s.name, l.first_seen DESC",
            (*suburb_ids, since_iso)
        ).fetchall()

    status_changes = conn.execute(
        f"SELECT l.address, l.price_text, l.sold_price, l.status, "
        f"l.reiwa_url, s.name AS suburb "
        f"FROM listings l "
        f"JOIN suburbs s ON s.id = l.suburb_id "
        f"WHERE l.suburb_id IN ({placeholders}) "
        f"AND l.last_seen >= ? "
        f"AND l.status IN ('under_offer', 'sold', 'withdrawn') "
        f"AND (l.first_seen IS NULL OR l.first_seen < ?) "
        f"ORDER BY s.name, l.last_seen DESC",
        (*suburb_ids, since_iso, since_iso)
    ).fetchall()

    # Hot vendor alerts — only count uploads attributed to THIS user
    # (hot_vendor_uploads.uploaded_by stores the operator email). Match
    # is on normalized_address so an RP-Data row at "26 Mengler Avenue"
    # surfaces a REIWA listing at the same address regardless of suffix.
    hv_alerts = []
    try:
        user_row = conn.execute(
            "SELECT email FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        user_email = (dict(user_row).get('email') if user_row else '') or ''
        if user_email:
            hv_alerts = conn.execute(
                f"SELECT hvp.address, hvp.final_score, "
                f"l.price_text, l.agency, l.reiwa_url, s.name AS suburb "
                f"FROM hot_vendor_properties hvp "
                f"JOIN hot_vendor_uploads u ON u.id = hvp.upload_id "
                f"JOIN listings l ON l.normalized_address = hvp.normalized_address "
                f"JOIN suburbs s ON s.id = l.suburb_id "
                f"WHERE LOWER(u.uploaded_by) = LOWER(?) "
                f"AND hvp.final_score >= 70 "
                f"AND l.status = 'active' "
                f"AND l.first_seen >= ? "
                f"AND l.suburb_id IN ({placeholders}) "
                f"ORDER BY hvp.final_score DESC, s.name",
                (user_email, since_iso, *suburb_ids)
            ).fetchall()
    except Exception:
        logger.exception("Hot vendor alert query failed (suppressed)")

    # Withdrawn orphans (LOOP-2) — pipeline leads created since the cutoff,
    # scoped to the user's suburbs by name. Failure is suppressed so the
    # digest still sends its other sections.
    orphan_rows = []
    try:
        names = [dict(s)['name'] for s in suburb_rows]
        if names:
            name_ph = ','.join(['?'] * len(names))
            orphan_rows = conn.execute(
                f"SELECT target_address AS address, source_suburb AS suburb, "
                f"notes, sent_date FROM pipeline_tracking "
                f"WHERE status = 'withdrawn_orphan' "
                f"AND source_suburb IN ({name_ph}) "
                f"AND created_at >= ? "
                f"ORDER BY source_suburb, created_at DESC",
                (*names, since_iso)
            ).fetchall()
    except Exception:
        logger.exception("Withdrawn orphan digest query failed (suppressed)")

    return {
        'new_listings': [dict(r) for r in (new_listings or [])],
        'status_changes': [dict(r) for r in (status_changes or [])],
        'hot_vendor_alerts': [dict(r) for r in (hv_alerts or [])],
        'withdrawn_orphans': [dict(r) for r in (orphan_rows or [])],
    }


def _stats_for_suburb(suburb_id, suburb_name, since_iso):
    """Lightweight per-suburb counts — kept for callers (admin test
    digest, legacy tests) that don't have the full sections shape."""
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
    conn.close()
    return {'new_active': new_active, 'new_sales': new_sales}


def _esc(s):
    """Minimal HTML escape — avoid pulling html.escape just to cover
    the four chars that matter inside attribute and text contexts."""
    if s is None:
        return ''
    s = str(s)
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def _status_label(row):
    s = (row.get('status') or '').lower()
    if s == 'sold':
        sp = (row.get('sold_price') or '').strip() if isinstance(row.get('sold_price'), str) else row.get('sold_price')
        return f"Sold for {sp}" if sp else 'Sold'
    return _STATUS_LABELS.get(s, s.title() if s else 'Updated')


def _meta_line(row):
    """e.g. '$1,250,000 · 4bd 2ba' — used in new-listings rows."""
    bits = []
    if row.get('price_text'):
        bits.append(str(row['price_text']))
    bedbaths = []
    if row.get('bedrooms') is not None:
        bedbaths.append(f"{row['bedrooms']}bd")
    if row.get('bathrooms') is not None:
        bedbaths.append(f"{row['bathrooms']}ba")
    if bedbaths:
        bits.append(' '.join(bedbaths))
    return ' · '.join(bits)


def _build_digest_text(user, sections, suburb_names, today_au):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    lines = [
        f"Good morning {name},",
        '',
        f"Your SuburbDesk Morning Brief — {today_au}.",
        '',
    ]
    if not suburb_names:
        lines.append("No suburbs assigned to your account yet — ask your admin to add some.")
    else:
        # Section 1 — new listings
        lines.append('=== NEW LISTINGS ===')
        if not sections['new_listings']:
            lines.append('  No new listings in your suburbs yesterday.')
        else:
            for r in sections['new_listings']:
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}")
                meta = _meta_line(r)
                if meta:
                    lines.append(f"      {meta}")
                if r.get('agency') or r.get('agent'):
                    lines.append(f"      {r.get('agency') or ''}{' · ' if r.get('agency') and r.get('agent') else ''}{r.get('agent') or ''}")
                if r.get('reiwa_url'):
                    lines.append(f"      View: {r['reiwa_url']}")
        lines.append('')

        # Section 2 — status changes
        lines.append('=== STATUS CHANGES ===')
        if not sections['status_changes']:
            lines.append('  No status changes yesterday.')
        else:
            for r in sections['status_changes']:
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}")
                lines.append(f"      Now: {_status_label(r)}")
                if r.get('reiwa_url'):
                    lines.append(f"      View: {r['reiwa_url']}")
        lines.append('')

        # Section — withdrawn orphans (LOOP-2), omitted entirely if empty
        if sections.get('withdrawn_orphans'):
            lines.append('=== WITHDRAWN ORPHANS (LIKELY MOTIVATED VENDORS) ===')
            for r in sections['withdrawn_orphans']:
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}")
                if r.get('notes'):
                    lines.append(f"      {r['notes']}")
            lines.append('')

        # Section 3 — hot vendor alerts (omitted entirely if empty)
        if sections['hot_vendor_alerts']:
            lines.append('=== HOT VENDOR NOW LISTED ===')
            for r in sections['hot_vendor_alerts']:
                lines.append(f"  ⚠ {r.get('address', '')} — {r.get('suburb', '')}")
                lines.append(f"      Score: {r.get('final_score')}/100 — Listed by {r.get('agency') or '?'}")
                if r.get('price_text'):
                    lines.append(f"      {r['price_text']}")
                lines.append("      This property was on your watchlist.")
                if r.get('reiwa_url'):
                    lines.append(f"      View: {r['reiwa_url']}")
            lines.append('')

        lines.append(f"Suburbs covered: {', '.join(suburb_names)}")
        lines.append('')

    lines.append(f"Open the app: {app}")
    lines.append('Reply with "unsubscribe" to stop receiving these emails.')
    lines.append('')
    lines.append('-- SuburbDesk · suburbdesk@gmail.com')
    return '\n'.join(lines)


def _render_new_listing_html(r):
    parts = [
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>'
    ]
    meta = _meta_line(r)
    if meta:
        parts.append(f'<div style="margin:0 0 4px;color:#444;font-size:13px;">{_esc(meta)}</div>')
    agency_agent = ' · '.join(filter(None, [r.get('agency'), r.get('agent')]))
    if agency_agent:
        parts.append(f'<div style="margin:0 0 4px;color:#666;font-size:12px;">{_esc(agency_agent)}</div>')
    if r.get('reiwa_url'):
        parts.append(
            f'<a href="{_esc(r["reiwa_url"])}" '
            f'style="color:#386350;font-size:12px;text-decoration:none;">View on REIWA →</a>'
        )
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:8px 12px;background:#fff;'
            f'border-left:3px solid #386350;border-radius:0 4px 4px 0;">'
            f'{inner}</div>')


def _render_change_html(r):
    label = _status_label(r)
    price_extra = r.get('price_text') if (r.get('status') or '').lower() != 'sold' else ''
    parts = [
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
        f'<div style="margin:0 0 4px;color:#444;font-size:13px;">Now: <strong>{_esc(label)}</strong></div>',
    ]
    if price_extra:
        parts.append(f'<div style="margin:0 0 4px;color:#666;font-size:12px;">{_esc(price_extra)}</div>')
    if r.get('reiwa_url'):
        parts.append(
            f'<a href="{_esc(r["reiwa_url"])}" '
            f'style="color:#386350;font-size:12px;text-decoration:none;">View on REIWA →</a>'
        )
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:8px 12px;background:#fff;'
            f'border-left:3px solid #386350;border-radius:0 4px 4px 0;">'
            f'{inner}</div>')


def _render_hv_alert_html(r):
    parts = [
        f'<div style="margin:0 0 4px;font-weight:700;color:#92400e;font-size:13px;">'
        f'⚠️ HOT VENDOR NOW LISTED</div>',
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
        f'<div style="margin:0 0 4px;color:#444;font-size:13px;">'
        f'Score: <strong>{_esc(r.get("final_score"))}/100</strong> — Listed by {_esc(r.get("agency") or "?")}'
        f'</div>',
    ]
    if r.get('price_text'):
        parts.append(f'<div style="margin:0 0 4px;color:#666;font-size:12px;">{_esc(r["price_text"])}</div>')
    parts.append('<div style="margin:0 0 4px;color:#92400e;font-size:12px;font-style:italic;">'
                 'This property was on your watchlist.</div>')
    if r.get('reiwa_url'):
        parts.append(
            f'<a href="{_esc(r["reiwa_url"])}" '
            f'style="color:#386350;font-size:12px;text-decoration:none;">View on REIWA →</a>'
        )
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:10px 12px;background:#fffbeb;'
            f'border-left:4px solid #f59e0b;border-radius:0 4px 4px 0;">'
            f'{inner}</div>')


def _render_orphan_html(r):
    parts = [
        '<div style="margin:0 0 4px;font-weight:700;color:#7c2d12;font-size:13px;">'
        '🏷️ WITHDRAWN — LIKELY MOTIVATED VENDOR</div>',
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
    ]
    if r.get('notes'):
        parts.append(f'<div style="margin:0 0 4px;color:#666;font-size:12px;">{_esc(r["notes"])}</div>')
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:10px 12px;background:#fff7ed;'
            f'border-left:4px solid #ea580c;border-radius:0 4px 4px 0;">{inner}</div>')


def _section_header(text):
    return (f'<h3 style="margin:18px 0 8px;color:#386350;font-size:14px;'
            f'font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">'
            f'{_esc(text)}</h3>')


def _build_digest_html(user, sections, suburb_names, today_au):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    if not suburb_names:
        body = ('<p style="color:#444;font-size:14px;">'
                'No suburbs assigned to your account yet — ask your admin '
                'to add some.</p>')
    else:
        new_html = (
            ''.join(_render_new_listing_html(r) for r in sections['new_listings'])
            if sections['new_listings']
            else '<p style="color:#666;font-size:13px;margin:0 0 8px;">No new listings in your suburbs yesterday.</p>'
        )
        change_html = (
            ''.join(_render_change_html(r) for r in sections['status_changes'])
            if sections['status_changes']
            else '<p style="color:#666;font-size:13px;margin:0 0 8px;">No status changes yesterday.</p>'
        )
        orphan_section = ''
        if sections.get('withdrawn_orphans'):
            orphan_section = (
                _section_header('Withdrawn Orphans')
                + ''.join(_render_orphan_html(r) for r in sections['withdrawn_orphans'])
            )
        hv_section = ''
        if sections['hot_vendor_alerts']:
            hv_section = (
                _section_header('Hot Vendor Alert')
                + ''.join(_render_hv_alert_html(r) for r in sections['hot_vendor_alerts'])
            )
        body = (
            _section_header('New Listings') + new_html
            + _section_header('Status Changes') + change_html
            + orphan_section
            + hv_section
        )

    suburbs_line = (
        f'<p style="margin:0 0 6px;color:#666;font-size:12px;">'
        f'Your suburbs: {_esc(", ".join(suburb_names))}'
        f'</p>'
    ) if suburb_names else ''

    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;color:#1a1a1a;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);max-width:600px;">
<tr><td style="background:#386350;padding:24px 32px;">
<h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;font-weight:700;">SUBURBDESK</h1>
<p style="margin:4px 0 0;color:#cfe0d6;font-size:13px;">Morning Brief &middot; {_esc(today_au)}</p>
</td></tr>
<tr><td style="padding:24px 28px;">
<p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Good morning {_esc(name)},</p>
{body}
<p style="margin:24px 0 0;text-align:center;">
<a href="{_esc(app)}" style="display:inline-block;background:#386350;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open SuburbDesk</a>
</p>
</td></tr>
<tr><td style="background:#fafafa;padding:14px 28px;border-top:1px solid #eee;">
{suburbs_line}
<p style="margin:0;color:#999;font-size:11px;">
Reply with "unsubscribe" to stop receiving these emails.<br>
SuburbDesk &middot; <a href="mailto:suburbdesk@gmail.com" style="color:#999;">suburbdesk@gmail.com</a>
</p>
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

    since_iso = _since_iso_perth_midnight()
    suburb_names = [s['name'] for s in suburb_rows]
    # Spec says: never send if the user has no suburbs assigned.
    # Admins always get the full active list above so they never hit
    # this branch; only regular users with an empty user_suburbs map.
    if not suburb_names:
        logger.info("Digest skipped for user_id=%s — no suburbs assigned", user_id)
        return False, 'No suburbs assigned'
    try:
        sections = _build_sections(suburb_rows, user_id, since_iso)
    except Exception as e:
        logger.exception("Digest sections build failed for user_id=%s", user_id)
        return False, str(e)

    today = _today_au()
    user_dict = dict(user)
    if not (user_dict.get('email') or '').strip():
        return False, 'User has no email'
    weekday = _weekday_perth()
    nl_n = len(sections['new_listings'])
    ch_n = len(sections['status_changes'])
    hv_n = len(sections['hot_vendor_alerts'])
    if hv_n > 0:
        subject = f"🔔 SuburbDesk — Hot Vendor Listed + Morning Brief {today}"
    elif nl_n + ch_n > 0:
        subject = f"SuburbDesk Morning Brief — {weekday}, {today}"
    else:
        subject = f"SuburbDesk Morning Brief — {weekday}, {today} — Quiet day"
    html = _build_digest_html(user_dict, sections, suburb_names, today)
    text = _build_digest_text(user_dict, sections, suburb_names, today)
    try:
        ok, info = _send(user_dict['email'], subject, html, text=text)
    except Exception as e:
        logger.exception("Digest send crashed for user_id=%s", user_id)
        ok, info = False, str(e)
    _log_digest_attempt(
        user_id, suburb_names, sections,
        status='sent' if ok else 'failed',
        error=None if ok else str(info)[:300],
    )
    return ok, info


def _log_digest_attempt(user_id, suburb_names, sections, status, error=None):
    """Append a row to digest_logs. Never raises — logging failure
    must not crash the cron pass. Writes both the legacy columns
    (new_count, change_count, hot_vendor_alert) and the per-section
    counts so historical queries keep working."""
    try:
        suburbs = ', '.join(suburb_names)[:500]
        nl_n = len(sections['new_listings'])
        ch_n = len(sections['status_changes'])
        hv_n = len(sections['hot_vendor_alerts'])
        conn = get_db()
        # Try the extended shape first (new_listings_count /
        # status_changes_count / hot_vendor_alerts_count columns added
        # by the migration below). Fall back to the legacy columns if
        # the migration hasn't run yet on this environment.
        try:
            conn.execute(
                "INSERT INTO digest_logs "
                "(user_id, suburbs_covered, new_count, change_count, "
                " hot_vendor_alert, new_listings_count, "
                " status_changes_count, hot_vendor_alerts_count, "
                " status, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user_id, suburbs, nl_n, ch_n, 1 if hv_n > 0 else 0,
                 nl_n, ch_n, hv_n, status, error)
            )
        except Exception:
            conn.rollback() if hasattr(conn, 'rollback') else None
            conn.execute(
                "INSERT INTO digest_logs "
                "(user_id, suburbs_covered, new_count, change_count, "
                " hot_vendor_alert, status, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, suburbs, nl_n, ch_n,
                 1 if hv_n > 0 else 0, status, error)
            )
        conn.commit()
        conn.close()
    except Exception:
        logger.exception("digest_logs write failed (suppressed)")


def send_morning_digest():
    """Cron entry point — iterate every opt-in user and send their
    digest. Designed to be called at the end of the nightly scrape
    (scripts/run_daily_scrape.py) so the email lands a few minutes
    after fresh data is in the DB. Returns dict of counts for the
    GHA job log to surface."""
    sent, skipped, failed = 0, 0, 0
    try:
        conn = get_db()
        users = conn.execute(
            "SELECT id, email, digest_enabled FROM users "
            "WHERE digest_enabled = 1 AND email IS NOT NULL AND email <> ''"
        ).fetchall()
        conn.close()
    except Exception:
        logger.exception("send_morning_digest: user lookup failed")
        return {'sent': 0, 'skipped': 0, 'failed': 0, 'fatal': True}
    for u in users:
        try:
            ok, _ = send_digest(u['id'])
            if ok:
                sent += 1
            else:
                skipped += 1
        except Exception:
            logger.exception("send_morning_digest: unhandled per-user crash uid=%s", u['id'])
            failed += 1
    logger.info(
        "[digest] morning pass complete: %d sent, %d skipped, %d failed",
        sent, skipped, failed
    )
    return {'sent': sent, 'skipped': skipped, 'failed': failed, 'fatal': False}

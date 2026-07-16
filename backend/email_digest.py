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

import email_brand as brand
from database import get_db
from email_service import _send, _app_url, _support_reply_to
from time_utils import perth_now, _PERTH_OFFSET

try:
    from signals.diff_engine import _price_to_int
except Exception:  # pragma: no cover
    def _price_to_int(_):
        return None

logger = logging.getLogger(__name__)


_MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
              'July', 'August', 'September', 'October', 'November', 'December']


def _today_au():
    """DD/MM/YYYY (Perth) — the AU numeric convention used everywhere in
    the product, never American MM/DD. Zero-padded so it's unambiguous."""
    now = perth_now()
    return f"{now.day:02d}/{now.month:02d}/{now.year}"


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
        return {'new_listings': [], 'status_changes': [], 'hot_vendor_alerts': [],
                'withdrawn_orphans': [], 'sold_reveals': [], 'strata_sales': []}
    suburb_ids = tuple(s['id'] for s in suburb_rows)
    placeholders = ','.join(['?'] * len(suburb_ids))
    conn = get_db()
    # Wrap the whole section build so the connection is ALWAYS closed —
    # this runs once per opted-in user every night; leaking one Neon
    # connection per user exhausts the free-tier pool.
    try:
        return _build_sections_impl(conn, suburb_ids, placeholders, since_iso, user_id, suburb_rows)
    finally:
        try:
            conn.close()
        except Exception:
            pass


# NOTE: must NOT be named _build_sections — that would shadow the 3-arg
# wrapper above (the later def wins at import time), making every
# send_digest() call raise TypeError and silently skip the email.
def _build_sections_impl(conn, suburb_ids, placeholders, since_iso, user_id, suburb_rows):
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

    # Sold-price reveals (LOOP-4) — scoped to the user's suburbs, last 24h.
    sold_reveals = []
    try:
        from signals.sold_reveal import list_sold_reveals
        sold_reveals = list_sold_reveals(list(suburb_ids), since_iso)
    except Exception:
        logger.exception("Sold-reveal digest query failed (suppressed)")

    # Strata contagion (LOOP-6) — strata unit sales, scoped, last 24h.
    strata_sales = []
    try:
        from signals.strata_contagion import list_strata_sales
        strata_sales = list_strata_sales(list(suburb_ids), since_iso)
    except Exception:
        logger.exception("Strata digest query failed (suppressed)")

    return {
        'new_listings': [dict(r) for r in (new_listings or [])],
        'status_changes': [dict(r) for r in (status_changes or [])],
        'hot_vendor_alerts': [dict(r) for r in (hv_alerts or [])],
        'withdrawn_orphans': [dict(r) for r in (orphan_rows or [])],
        'sold_reveals': [dict(r) for r in (sold_reveals or [])],
        'strata_sales': [dict(r) for r in (strata_sales or [])],
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
        # Format the raw sold_price ("5650000") into "$5.65m" — the old
        # digest showed the bare integer.
        n = _price_to_int(row.get('sold_price'))
        return f"Sold {brand.fmt_price(n)}" if n else 'Sold'
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

        # Section — sold price reveals (LOOP-4), omitted if empty
        if sections.get('sold_reveals'):
            lines.append('=== SOLD PRICES REVEALED ===')
            for r in sections['sold_reveals']:
                price = r.get('sold_price') or 'price disclosed'
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}: {price}")
            lines.append('  (Generate neighbour letters from the app.)')
            lines.append('')

        # Section — strata contagion (LOOP-6), omitted if empty
        if sections.get('strata_sales'):
            lines.append('=== STRATA CONTAGION ===')
            for r in sections['strata_sales']:
                price = r.get('sold_price') or 'price disclosed'
                lines.append(f"  - {r.get('complex_address', '')} — {r.get('suburb', '')}: "
                             f"unit sold {price}")
            lines.append('  (Generate building letters from the app.)')
            lines.append('')

        # Section 3 — hot vendor alerts (omitted entirely if empty)
        if sections['hot_vendor_alerts']:
            lines.append('=== HOT VENDOR NOW LISTED ===')
            for r in sections['hot_vendor_alerts']:
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}")
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


def _card(accent, bg, addr, suburb, detail_html='', url=None, note=None, tag=''):
    """One highlighted listing row — the shared shape for every category
    (tinted background + coloured left border, mirroring the app)."""
    head = (f'<div style="margin:0 0 3px;font-weight:600;color:#1a1a1a;font-size:14px;">'
            f'{_esc(addr)} <span style="color:#777;font-weight:500;">— {_esc(suburb)}</span>{tag}</div>')
    body = [head]
    if detail_html:
        body.append(detail_html)
    if note:
        body.append(f'<div style="margin:2px 0 0;color:#666;font-size:12px;">{_esc(note)}</div>')
    if url:
        body.append(f'<a href="{_esc(url)}" style="color:{accent};font-size:12px;'
                    f'text-decoration:none;">View on REIWA →</a>')
    return brand.hl_card(accent, bg, ''.join(body))


def _render_new_listing_html(r):
    acc, bg = brand.LISTING['new']
    detail = ''
    meta = _meta_line(r)
    if meta:
        detail += f'<div style="margin:0 0 2px;color:#444;font-size:13px;">{_esc(meta)}</div>'
    agency_agent = ' · '.join(filter(None, [r.get('agency'), r.get('agent')]))
    if agency_agent:
        detail += f'<div style="margin:0 0 2px;color:#777;font-size:12px;">{_esc(agency_agent)}</div>'
    return _card(acc, bg, r.get('address'), r.get('suburb'), detail, url=r.get('reiwa_url'))


def _render_change_html(r):
    status = (r.get('status') or '').lower()
    acc, bg = brand.LISTING.get(status, brand.LISTING['sold'])
    label = _status_label(r)
    detail = (f'<div style="margin:0 0 2px;color:#444;font-size:13px;">'
              f'Now: <strong>{_esc(label)}</strong></div>')
    if status != 'sold' and r.get('price_text'):
        detail += f'<div style="margin:0 0 2px;color:#777;font-size:12px;">{_esc(r["price_text"])}</div>'
    return _card(acc, bg, r.get('address'), r.get('suburb'), detail, url=r.get('reiwa_url'))


def _render_hv_alert_html(r):
    # No internal header — the coloured section band already labels this.
    acc, bg = brand.LISTING['hot']
    detail = (f'<div style="margin:0 0 2px;color:#444;font-size:13px;">'
              f'Score <strong>{_esc(r.get("final_score"))}/100</strong> — '
              f'listed by {_esc(r.get("agency") or "?")}</div>')
    if r.get('price_text'):
        detail += f'<div style="margin:0 0 2px;color:#777;font-size:12px;">{_esc(r["price_text"])}</div>'
    detail += (f'<div style="margin:2px 0 0;color:{acc};font-size:12px;font-style:italic;">'
               f'This property was on your watchlist.</div>')
    return _card(acc, bg, r.get('address'), r.get('suburb'), detail, url=r.get('reiwa_url'))


def _render_strata_html(r):
    acc, bg = brand.LISTING['strata']
    n = _price_to_int(r.get('sold_price'))
    price = brand.fmt_price(n) if n else 'price disclosed'
    detail = (f'<div style="margin:0 0 2px;color:#444;font-size:13px;">'
              f'Unit sold for <strong>{_esc(price)}</strong></div>')
    return _card(acc, bg, r.get('complex_address'), r.get('suburb'), detail,
                 note='Generate letters for the rest of the building from the app.')


def _render_sold_reveal_html(r):
    acc, bg = brand.LISTING['sold']
    n = _price_to_int(r.get('sold_price'))
    price = brand.fmt_price(n) if n else 'price disclosed'
    detail = (f'<div style="margin:0 0 2px;color:#444;font-size:13px;">'
              f'Sold for <strong>{_esc(price)}</strong></div>')
    return _card(acc, bg, r.get('address'), r.get('suburb'), detail,
                 note='Generate neighbour appraisal letters from the app.')


def _render_orphan_html(r):
    acc, bg = brand.LISTING['withdrawn']
    tag = (f' <span style="color:{acc};font-size:12px;font-weight:600;">'
           f'· likely motivated vendor</span>')
    return _card(acc, bg, r.get('address'), r.get('suburb'),
                 note=r.get('notes'), tag=tag)



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
        reveal_section = ''
        if sections.get('sold_reveals'):
            reveal_section = (
                _section_header('Sold Prices Revealed')
                + ''.join(_render_sold_reveal_html(r) for r in sections['sold_reveals'])
            )
        strata_section = ''
        if sections.get('strata_sales'):
            strata_section = (
                _section_header('Strata Contagion')
                + ''.join(_render_strata_html(r) for r in sections['strata_sales'])
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
            + reveal_section
            + strata_section
            + hv_section
        )

    greeting = (f'<p style="margin:0 0 4px;font-size:15px;color:{brand.INK};">'
                f'Good morning {brand._esc(name)}.</p>')
    lead = _digest_lead(sections, suburb_names, today_au)
    inner = greeting + brand.lead(lead) + body
    return brand.shell('Morning Brief', inner, app,
                       suburbs_line=', '.join(suburb_names) if suburb_names else None)


def _digest_lead(sections, suburb_names, today_au):
    """AI (or fallback) opening line for the daily digest."""
    nl = len(sections.get('new_listings') or [])
    ch = len(sections.get('status_changes') or [])
    hv = len(sections.get('hot_vendor_alerts') or [])
    parts = []
    if nl:
        parts.append(f"{nl} new listing{'s' if nl != 1 else ''}")
    if ch:
        parts.append(f"{ch} status change{'s' if ch != 1 else ''}")
    if hv:
        parts.append(f"{hv} hot-vendor alert{'s' if hv != 1 else ''}")
    fallback = (f"Overnight across your suburbs: {', '.join(parts)}."
                if parts else "A quiet night across your suburbs — no new activity overnight.")
    if not suburb_names:
        return fallback
    facts = [f"Date: {today_au}", f"New listings: {nl}",
             f"Status changes: {ch}", f"Hot-vendor alerts: {hv}"]
    return brand.compose_lead(facts, fallback)


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
        subject = f"SuburbDesk — Hot Vendor Listed + Morning Brief {today}"
    elif nl_n + ch_n > 0:
        subject = f"SuburbDesk Morning Brief — {weekday}, {today}"
    else:
        subject = f"SuburbDesk Morning Brief — {weekday}, {today} — Quiet day"
    html = _build_digest_html(user_dict, sections, suburb_names, today)
    text = _build_digest_text(user_dict, sections, suburb_names, today)
    try:
        reply_to = _support_reply_to()
        ok, info = _send(user_dict['email'], subject, html, text=text,
                         reply_to=reply_to, list_unsubscribe=reply_to)
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


# ---------------------------------------------------------------------------
# Combined daily email — the single morning email (overnight recap + the
# rotating prospect list), replacing the old digest+brief pair so agents
# receive ONE email a day, not two.
# ---------------------------------------------------------------------------

def _daily_lead(sections, prospect_n, suburb_names, today_au):
    nl = len(sections['new_listings'])
    ch = len(sections['status_changes'])
    hv = len(sections['hot_vendor_alerts'])
    parts = []
    if prospect_n:
        parts.append(f"{prospect_n} vendor{'s' if prospect_n != 1 else ''} to prospect")
    if hv:
        parts.append(f"{hv} hot-vendor alert{'s' if hv != 1 else ''}")
    if nl:
        parts.append(f"{nl} new listing{'s' if nl != 1 else ''}")
    if ch:
        parts.append(f"{ch} status change{'s' if ch != 1 else ''}")
    fallback = (f"This morning across your suburbs: {', '.join(parts)}."
                if parts else "A quiet night across your suburbs — nothing new overnight.")
    facts = [f"Date: {today_au}", f"Vendor prospects: {prospect_n}",
             f"Hot-vendor alerts: {hv}", f"New listings: {nl}",
             f"Status changes: {ch}"]
    return brand.compose_lead(facts, fallback)


_DAILY_CAP = 6   # rows shown per section before a "+N more" collapse


def _section(parts, title, accent, items, render_fn, app, cap=_DAILY_CAP):
    """Append a coloured section band + up to `cap` rendered rows + a
    '+N more' line when the list is longer. Keeps one huge subdivision
    (e.g. 50 lots of the same street) from drowning the whole email."""
    if not items:
        return
    parts.append(brand.section_band(title, accent, count=len(items)))
    for r in items[:cap]:
        parts.append(render_fn(r))
    if len(items) > cap:
        parts.append(brand.more_line(len(items) - cap, app))


def _build_daily_html(user, sections, prospect_items, pixel, suburb_names, today_au):
    from signals.brief_builder import prospect_cards_html
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    lead = _daily_lead(sections, len(prospect_items), suburb_names, today_au)
    n_sub = len(suburb_names)

    # Warm, human opener + the AI recap sentence beneath it.
    parts = [
        f'<p style="margin:0 0 6px;font-size:16px;color:{brand.INK};">'
        f'Good morning {brand._esc(name)} — here’s your overnight recap across '
        f'{n_sub} suburb{"s" if n_sub != 1 else ""}.</p>',
        brand.lead(lead),
    ]

    C = brand.LISTING   # (accent, bg) per category — mirrors the app

    # Prospects first — the money section.
    if prospect_items:
        parts.append(brand.section_band('Who to prospect today', C['prospect'][0],
                                        count=len(prospect_items)))
        parts.append(prospect_cards_html(prospect_items))

    # Hot vendor watchlist matches.
    _section(parts, 'Hot vendor now listed', C['hot'][0],
             sections['hot_vendor_alerts'], _render_hv_alert_html, app)

    # Status changes split into distinct, category-coloured blocks.
    changes = sections['status_changes']
    sold = [r for r in changes if (r.get('status') or '').lower() == 'sold']
    offer = [r for r in changes if (r.get('status') or '').lower() == 'under_offer']
    wd = [r for r in changes if (r.get('status') or '').lower() == 'withdrawn']
    _section(parts, 'Sold', C['sold'][0], sold, _render_change_html, app)
    _section(parts, 'New listings', C['new'][0],
             sections['new_listings'], _render_new_listing_html, app)
    _section(parts, 'Under offer', C['under_offer'][0], offer, _render_change_html, app)

    # ONE withdrawn section — motivated-vendor orphans first (they carry the
    # note), then any plain overnight withdrawals not already covered. Avoids
    # the old duplicate "Withdrawn" + "Withdrawn — likely motivated" pair.
    orphans = sections.get('withdrawn_orphans') or []
    orphan_keys = {(o.get('address') or '').strip().lower() for o in orphans}
    wd_extra = [w for w in wd if (w.get('address') or '').strip().lower() not in orphan_keys]
    wtotal = len(orphans) + len(wd_extra)
    if wtotal:
        parts.append(brand.section_band('Withdrawn', C['withdrawn'][0], count=wtotal))
        shown = 0
        for o in orphans[:_DAILY_CAP]:
            parts.append(_render_orphan_html(o)); shown += 1
        for w in wd_extra[:max(0, _DAILY_CAP - shown)]:
            parts.append(_render_change_html(w)); shown += 1
        if wtotal > _DAILY_CAP:
            parts.append(brand.more_line(wtotal - _DAILY_CAP, app))

    # Remaining signal sub-sections.
    _section(parts, 'Sold prices revealed', C['sold'][0],
             sections.get('sold_reveals') or [], _render_sold_reveal_html, app)
    _section(parts, 'Strata contagion', C['strata'][0],
             sections.get('strata_sales') or [], _render_strata_html, app)

    # Nothing at all overnight — say so warmly instead of a blank body.
    if not any([prospect_items, sections['hot_vendor_alerts'], changes,
                sections['new_listings'], sections.get('withdrawn_orphans'),
                sections.get('sold_reveals'), sections.get('strata_sales')]):
        parts.append('<p style="color:#666;font-size:14px;margin:8px 0;">'
                     'A quiet night — no new activity across your suburbs. '
                     'We’ll keep watching.</p>')

    if pixel:
        parts.append(f'<img src="{_esc(pixel)}" width="1" height="1" alt=""/>')
    from email_service import manage_url
    return brand.shell('Daily', ''.join(parts), app,
                       suburbs_line=', '.join(suburb_names),
                       manage_url=manage_url(user.get('id')))


def _build_daily_text(user, sections, prospect_items, suburb_names, today_au):
    from signals.brief_builder import prospect_lines_text
    name = (user.get('first_name') or 'there').strip()
    lines = [f"Good morning {name},", '',
             f"SuburbDesk daily — {today_au}.", '']
    if prospect_items:
        lines.append('=== WHO TO PROSPECT TODAY ===')
        lines += ['  - ' + s for s in prospect_lines_text(prospect_items)]
        lines.append('')
    # Reuse the digest's section text for the market recap portion.
    lines.append(_build_digest_text(user, sections, suburb_names, today_au))
    return '\n'.join(lines)


def send_daily(user_id):
    """Build + send the ONE combined daily email for a single user:
    the overnight market recap plus their rotating prospect list. Persists
    the briefs row (so the in-app Today view + rotation keep working) and
    logs one digest_logs row (cadence='daily'). Never raises."""
    if not (os.environ.get('EMAIL_FROM') or '').strip():
        logger.warning("EMAIL_FROM not set — daily for user_id=%s skipped", user_id)
        return False, 'EMAIL_FROM not configured'
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id, email, first_name, role, all_suburbs FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            return False, 'User not found'
        user = dict(user)
        is_admin = (user.get('role') or '').lower() == 'admin'
        # all_suburbs = a non-admin who sees EVERY suburb. Widen here too so
        # the daily matches the prospect scope (build_items honours the flag)
        # and the periodic emails — otherwise these users silently got the
        # overnight recap for only their explicit (often empty) assignment.
        if is_admin or user.get('all_suburbs') in (1, True):
            suburb_rows = conn.execute(
                "SELECT id, name FROM suburbs WHERE active = 1 ORDER BY name"
            ).fetchall()
        else:
            suburb_rows = conn.execute(
                "SELECT s.id, s.name FROM suburbs s "
                "JOIN user_suburbs us ON s.id = us.suburb_id "
                "WHERE us.user_id = ? AND s.active = 1 ORDER BY s.name",
                (user_id,)
            ).fetchall()
        suburb_names = [s['name'] for s in suburb_rows]
        if not suburb_names:
            logger.info("Daily skipped for user_id=%s — no suburbs assigned", user_id)
            return False, 'No suburbs assigned'
        if not (user.get('email') or '').strip():
            return False, 'User has no email'

        since_iso = _since_iso_perth_midnight()
        sections = _build_sections(suburb_rows, user_id, since_iso)

        base = (os.environ.get('BACKEND_PUBLIC_URL')
                or 'https://marketscraper-backend.onrender.com').rstrip('/')
        today_iso = perth_now().strftime('%Y-%m-%d')
        try:
            from signals.brief_builder import persist_brief
            prospect_items, pixel = persist_brief(conn, user, today_iso, base)
        except Exception:
            logger.exception("persist_brief failed for user_id=%s (suppressed)", user_id)
            prospect_items, pixel = [], None

        today_au = _today_au()
        weekday = _weekday_perth()
        hv_n = len(sections['hot_vendor_alerts'])
        pn = len(prospect_items)
        if hv_n > 0:
            subject = f"SuburbDesk — Hot vendor listed · {today_au}"
        elif pn > 0:
            subject = f"SuburbDesk Daily — {pn} to prospect · {weekday}, {today_au}"
        elif len(sections['new_listings']) + len(sections['status_changes']) > 0:
            subject = f"SuburbDesk Daily — {weekday}, {today_au}"
        else:
            subject = f"SuburbDesk Daily — {weekday}, {today_au} · Quiet day"

        html = _build_daily_html(user, sections, prospect_items, pixel, suburb_names, today_au)
        text = _build_daily_text(user, sections, prospect_items, suburb_names, today_au)
        try:
            from email_service import unsubscribe_url
            reply_to = _support_reply_to()
            ok, info = _send(user['email'], subject, html, text=text,
                             reply_to=reply_to,
                             list_unsubscribe=unsubscribe_url(user_id))
        except Exception as e:
            logger.exception("Daily send crashed for user_id=%s", user_id)
            ok, info = False, str(e)
        _log_digest_attempt(user_id, suburb_names, sections,
                            status='sent' if ok else 'failed',
                            error=None if ok else str(info)[:300])
        return ok, info
    except Exception as e:
        logger.exception("send_daily failed for user_id=%s", user_id)
        return False, str(e)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def send_daily_all():
    """Cron entry point — send the one combined daily email to every
    opted-in user (users.digest_enabled). Replaces the old
    send_morning_briefs() + send_morning_digest() pair."""
    sent, skipped, failed = 0, 0, 0
    try:
        conn = get_db()
        users = conn.execute(
            "SELECT id FROM users "
            "WHERE digest_enabled = 1 AND email IS NOT NULL AND email <> ''"
        ).fetchall()
        conn.close()
    except Exception:
        logger.exception("send_daily_all: user lookup failed")
        return {'sent': 0, 'skipped': 0, 'failed': 0, 'fatal': True}
    for u in users:
        try:
            ok, _ = send_daily(u['id'])
            if ok:
                sent += 1
            else:
                skipped += 1
        except Exception:
            logger.exception("send_daily_all: per-user crash uid=%s", u['id'])
            failed += 1
    logger.info("[daily] pass complete: %d sent, %d skipped, %d failed",
                sent, skipped, failed)
    return {'sent': sent, 'skipped': skipped, 'failed': failed, 'fatal': False}

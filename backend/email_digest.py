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
        return {'new_listings': [], 'status_changes': [], 'withdrawn': [],
                'hot_vendor_alerts': [], 'withdrawn_orphans': [],
                'sold_reveals': [], 'strata_sales': []}
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

    # Under-offer + sold only — withdrawn gets its own prominent section
    # below (it's the motivated-vendor signal, the core value), instead
    # of being buried in a mixed "status changes" list.
    status_changes = conn.execute(
        f"SELECT l.address, l.price_text, l.sold_price, l.status, "
        f"l.reiwa_url, s.name AS suburb "
        f"FROM listings l "
        f"JOIN suburbs s ON s.id = l.suburb_id "
        f"WHERE l.suburb_id IN ({placeholders}) "
        f"AND l.last_seen >= ? "
        f"AND l.status IN ('under_offer', 'sold') "
        f"AND (l.first_seen IS NULL OR l.first_seen < ?) "
        f"ORDER BY s.name, l.last_seen DESC",
        (*suburb_ids, since_iso, since_iso)
    ).fetchall()

    # Freshly withdrawn — a home pulled from market overnight is a
    # motivated vendor to approach. Carries the last listed price so the
    # agent has a number to anchor on. Excludes brand-new rows the same
    # way status_changes does (a first_seen inside the window would be a
    # data artefact, not a real withdrawal).
    withdrawn = conn.execute(
        f"SELECT l.address, l.price_text, l.withdrawn_date, l.reiwa_url, "
        f"s.name AS suburb "
        f"FROM listings l "
        f"JOIN suburbs s ON s.id = l.suburb_id "
        f"WHERE l.suburb_id IN ({placeholders}) "
        f"AND l.last_seen >= ? "
        f"AND l.status = 'withdrawn' "
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
        'withdrawn': [dict(r) for r in (withdrawn or [])],
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
        sp = (row.get('sold_price') or '').strip() if isinstance(row.get('sold_price'), str) else row.get('sold_price')
        if sp:
            return f"Sold for {sp}"
        # REIWA often discloses the sale price days after the sale. Until
        # then, anchor on the last listed price rather than a bare "Sold"
        # — never fabricate a sale figure. Only fall back when the listed
        # text is an actual price (has a digit): "last listed Contact form"
        # or "Contact agent" reads as broken, so those become the generic
        # "price not yet disclosed".
        listed = (row.get('price_text') or '').strip()
        if listed and any(c.isdigit() for c in listed):
            return f"Sold — last listed {listed}"
        return 'Sold — price not yet disclosed'
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

        # Section — freshly withdrawn (motivated vendors), omitted if empty
        if sections.get('withdrawn'):
            lines.append('=== WITHDRAWN · MOTIVATED VENDORS ===')
            for r in sections['withdrawn']:
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}")
                if r.get('price_text'):
                    lines.append(f"      Last listed {r['price_text']}")
                if r.get('reiwa_url'):
                    lines.append(f"      View: {r['reiwa_url']}")
            lines.append('')

        # Section 2 — under offer / sold
        lines.append('=== UNDER OFFER / SOLD ===')
        if not sections['status_changes']:
            lines.append('  No under-offer or sold changes yesterday.')
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


# Status → card colour grammar, mirrored from the frontend STATUS_COLORS
# (App.jsx:31): sold = blue, under_offer = orange (amber). Each card is
# colour-coded on its left rail + status word + link + a faint tint so a
# glance down the section separates sales (blue) from under-offers (orange).
_CHANGE_COLORS = {
    'sold': {'accent': '#2563eb', 'tint': '#eff6ff', 'link': '#1e40af'},
    'under_offer': {'accent': '#d97706', 'tint': '#fff7ed', 'link': '#b45309'},
}
_CHANGE_DEFAULT = {'accent': '#386350', 'tint': '#ffffff', 'link': '#386350'}


def _render_change_html(r):
    status = (r.get('status') or '').lower()
    c = _CHANGE_COLORS.get(status, _CHANGE_DEFAULT)
    label = _status_label(r)
    # Sold carries its price inside the label; under-offer shows the last
    # asking price as a separate context line.
    price_extra = r.get('price_text') if status != 'sold' else ''
    parts = [
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
        f'<div style="margin:0 0 4px;color:#444;font-size:13px;">Now: '
        f'<strong style="color:{c["link"]};">{_esc(label)}</strong></div>',
    ]
    if price_extra:
        parts.append(f'<div style="margin:0 0 4px;color:#666;font-size:12px;">{_esc(price_extra)}</div>')
    if r.get('reiwa_url'):
        parts.append(
            f'<a href="{_esc(r["reiwa_url"])}" '
            f'style="color:{c["link"]};font-size:12px;text-decoration:none;font-weight:600;">'
            f'View on REIWA →</a>'
        )
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:8px 12px;background:{c["tint"]};'
            f'border-left:4px solid {c["accent"]};border-radius:0 4px 4px 0;">'
            f'{inner}</div>')


def _render_withdrawn_html(r):
    """A freshly-withdrawn listing — motivated-vendor lead. Amber accent,
    last listed price as the anchor number."""
    parts = [
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
    ]
    listed = (r.get('price_text') or '').strip()
    if listed:
        parts.append(f'<div style="margin:0 0 4px;color:#7c2d12;font-size:13px;">'
                     f'Last listed <strong>{_esc(listed)}</strong></div>')
    parts.append('<div style="margin:0 0 4px;color:#9a3412;font-size:12px;'
                 'font-style:italic;">Came off market — likely motivated vendor.</div>')
    if r.get('reiwa_url'):
        parts.append(
            f'<a href="{_esc(r["reiwa_url"])}" '
            f'style="color:#c2410c;font-size:12px;text-decoration:none;font-weight:600;">'
            f'View on REIWA →</a>'
        )
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:10px 12px;background:#fff7ed;'
            f'border-left:4px solid #ea580c;border-radius:0 4px 4px 0;">{inner}</div>')


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


def _render_strata_html(r):
    price = r.get('sold_price') or 'Price disclosed'
    parts = [
        '<div style="margin:0 0 4px;font-weight:700;color:#5b21b6;font-size:13px;">'
        '🏢 STRATA CONTAGION</div>',
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("complex_address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
        f'<div style="margin:0 0 4px;color:#444;font-size:13px;">Unit sold for <strong>{_esc(price)}</strong></div>',
        '<div style="margin:0;color:#666;font-size:12px;font-style:italic;">'
        'Generate letters for the rest of the building from the app.</div>',
    ]
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:10px 12px;background:#f5f3ff;'
            f'border-left:4px solid #8b5cf6;border-radius:0 4px 4px 0;">{inner}</div>')


def _render_sold_reveal_html(r):
    price = r.get('sold_price') or 'Price disclosed'
    parts = [
        '<div style="margin:0 0 4px;font-weight:700;color:#1e40af;font-size:13px;">'
        '💰 SOLD PRICE REVEALED</div>',
        f'<div style="margin:0 0 4px;font-weight:600;color:#1a1a1a;font-size:14px;">'
        f'{_esc(r.get("address"))} — <span style="color:#555;font-weight:500;">{_esc(r.get("suburb"))}</span>'
        f'</div>',
        f'<div style="margin:0 0 4px;color:#444;font-size:13px;">Sold for <strong>{_esc(price)}</strong></div>',
        '<div style="margin:0;color:#666;font-size:12px;font-style:italic;">'
        'Generate neighbour appraisal letters from the app.</div>',
    ]
    inner = ''.join(parts)
    return (f'<div style="margin:0 0 8px;padding:10px 12px;background:#eff6ff;'
            f'border-left:4px solid #3b82f6;border-radius:0 4px 4px 0;">{inner}</div>')


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


def _section_header(text, bg='#386350', count=None):
    """Filled colour bar, not just coloured text. A saturated background
    with white text survives iOS Mail's dark-mode colour inversion (thin
    coloured text on white was washed out to near-invisible), and reads as
    a clear section divider when scanning on a phone."""
    badge = ''
    if count is not None:
        badge = (f'<span style="float:right;background:rgba(255,255,255,0.25);'
                 f'border-radius:10px;padding:1px 9px;font-size:12px;">{count}</span>')
    return (f'<div style="margin:20px 0 10px;background:{bg};color:#ffffff;'
            f'padding:9px 14px;border-radius:6px;font-size:13px;font-weight:700;'
            f'text-transform:uppercase;letter-spacing:0.6px;">'
            f'{badge}{_esc(text)}</div>')


# Cap how many rows each section prints in the email. A digest with
# 130+ status changes = hundreds of external links: an unreadable wall on
# a phone AND a strong Promotions/spam signal for Gmail. The overflow is
# summarised with a "+N more — open SuburbDesk" link; the full list always
# lives in the app.
DIGEST_SECTION_CAP = 25


def _capped_html(render_fn, items, app, cap=DIGEST_SECTION_CAP):
    """Render at most `cap` items; append a link to the app for the rest."""
    html = ''.join(render_fn(r) for r in items[:cap])
    if len(items) > cap:
        html += (f'<div style="margin:2px 0 10px;font-size:12px;color:#666;">'
                 f'+ {len(items) - cap} more — '
                 f'<a href="{_esc(app)}" style="color:#386350;font-weight:600;'
                 f'text-decoration:none;">open SuburbDesk →</a></div>')
    return html


def _build_digest_html(user, sections, suburb_names, today_au):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    if not suburb_names:
        body = ('<p style="color:#444;font-size:14px;">'
                'No suburbs assigned to your account yet — ask your admin '
                'to add some.</p>')
    else:
        new_html = (
            _capped_html(_render_new_listing_html, sections['new_listings'], app)
            if sections['new_listings']
            else '<p style="color:#666;font-size:13px;margin:0 0 8px;">No new listings in your suburbs yesterday.</p>'
        )
        # Split the status changes into two colour-coded sections — Under
        # Offer (orange) and Sold (blue) — so the section headers match the
        # per-card colour grammar instead of one mixed "Under Offer / Sold".
        under_offers = [r for r in sections['status_changes']
                        if (r.get('status') or '').lower() == 'under_offer']
        solds = [r for r in sections['status_changes']
                 if (r.get('status') or '').lower() == 'sold']
        under_offer_section = ''
        if under_offers:
            under_offer_section = (
                _section_header('Under Offer', bg='#d97706', count=len(under_offers))
                + _capped_html(_render_change_html, under_offers, app)
            )
        sold_section = ''
        if solds:
            sold_section = (
                _section_header('Sold', bg='#2563eb', count=len(solds))
                + _capped_html(_render_change_html, solds, app)
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
                _section_header('Hot Vendor Alert', bg='#b45309',
                                count=len(sections['hot_vendor_alerts']))
                + ''.join(_render_hv_alert_html(r) for r in sections['hot_vendor_alerts'])
            )
        # Freshly withdrawn — motivated vendors — get their own amber
        # section, placed high (right after new listings) because it's the
        # most actionable signal in the whole brief.
        withdrawn_section = ''
        if sections.get('withdrawn'):
            withdrawn_section = (
                _section_header('Withdrawn · motivated vendors', bg='#c2410c',
                                count=len(sections['withdrawn']))
                + _capped_html(_render_withdrawn_html, sections['withdrawn'], app)
            )
        body = (
            _section_header('New Listings', count=len(sections['new_listings']))
            + new_html
            + withdrawn_section
            + under_offer_section
            + sold_section
            + orphan_section
            + reveal_section
            + strata_section
            + hv_section
        )

    suburbs_line = (
        f'<p style="margin:0 0 6px;color:#666;font-size:12px;">'
        f'Your suburbs: {_esc(", ".join(suburb_names))}'
        f'</p>'
    ) if suburb_names else ''

    # At-a-glance counts strip — colour-coded pills so the agent can scan
    # the overnight picture on a phone before scrolling. Filled backgrounds
    # (not tinted text) so they survive iOS Mail dark mode.
    def _pill(n, label, bg):
        # width:33% + table-layout:fixed on the parent keeps the three
        # pills on one row at any phone width (no horizontal scroll).
        return (f'<td width="33%" valign="top" style="padding:0 3px;"><div style="background:{bg};'
                f'border-radius:8px;padding:11px 4px;text-align:center;">'
                f'<div style="color:#fff;font-size:20px;font-weight:700;line-height:1;">{n}</div>'
                f'<div style="color:#fff;font-size:10px;letter-spacing:.4px;'
                f'text-transform:uppercase;margin-top:4px;">{label}</div></div></td>')
    counts_strip = ''
    if suburb_names:
        # Three headline signals only — Withdrawn is the star. Under-offer
        # is still listed in its own section; keeping the strip to three
        # keeps every pill readable on the narrowest phones.
        counts_strip = (
            '<table width="100%" cellpadding="0" cellspacing="0" '
            'style="margin:0 0 6px;table-layout:fixed;"><tr>'
            + _pill(len(sections['new_listings']), 'New', '#386350')
            + _pill(len(sections.get('withdrawn', [])), 'Withdrawn', '#c2410c')
            + _pill(sum(1 for r in sections['status_changes']
                        if (r.get('status') or '').lower() == 'sold'), 'Sold', '#1e40af')
            + '</tr></table>'
        )

    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>:root {{ color-scheme: light; supported-color-schemes: light; }}</style>
</head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;color:#1a1a1a;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);max-width:600px;">
<tr><td style="background:#386350;padding:24px 32px;">
<h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;font-weight:700;">SUBURBDESK</h1>
<p style="margin:4px 0 0;color:#cfe0d6;font-size:13px;">Morning Brief &middot; {_esc(today_au)}</p>
</td></tr>
<tr><td style="padding:24px 28px;">
<p style="margin:0 0 14px;font-size:15px;color:#1a1a1a;">Good morning {_esc(name)},</p>
{counts_strip}
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
    wd_n = len(sections.get('withdrawn', []))
    hv_n = len(sections['hot_vendor_alerts'])
    if hv_n > 0:
        subject = f"🔔 SuburbDesk — Hot Vendor Listed + Morning Brief {today}"
    elif wd_n > 0:
        # Lead with the withdrawn count in the subject — it's the signal
        # the agent most wants to see land in their inbox.
        subject = (f"SuburbDesk Morning Brief — {wd_n} withdrawn "
                   f"(motivated) — {weekday}, {today}")
    elif nl_n + ch_n > 0:
        subject = f"SuburbDesk Morning Brief — {weekday}, {today}"
    else:
        subject = f"SuburbDesk Morning Brief — {weekday}, {today} — Quiet day"
    html = _build_digest_html(user_dict, sections, suburb_names, today)
    text = _build_digest_text(user_dict, sections, suburb_names, today)
    # Deliverability headers — the digest is recurring bulk mail, so
    # Gmail/Yahoo now REQUIRE a machine-readable one-click unsubscribe
    # (List-Unsubscribe + List-Unsubscribe-Post); without it they down-rank
    # to spam. The welcome email already set these — the digest didn't,
    # which is exactly the kind of mail that lands in spam. Reply-To makes
    # it read as reachable 1:1 mail rather than an unanswerable no-reply.
    # Address defaults to the one already shown in the digest footer.
    contact = (os.environ.get('SUPPORT_EMAIL') or '').strip() or 'suburbdesk@gmail.com'
    try:
        ok, info = _send(user_dict['email'], subject, html, text=text,
                         reply_to=contact, list_unsubscribe=contact)
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

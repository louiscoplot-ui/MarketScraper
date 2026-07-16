"""Periodic market-activity emails — weekly / monthly / quarterly / annual.

Complements the daily digest (email_digest.py). Each cadence is gated by
its own users.email_<cadence> flag (independent opt-in) and scoped to the
suburbs a user can see. Every figure is derived from data ALREADY in the
DB — the listing_events ledger (SENTINEL S1) plus the listings table — so
no new collection is needed: the previous completed period is fully
scraped by the time the email goes out, which is why the send can run any
time of day without waiting on tonight's scrape.

Public surface:
    due_cadences(ref_date) -> list[str]
        Which cadences fire on a given Perth date (Monday → weekly,
        1st → monthly, 1st of a quarter → quarterly, 1 Jan → annual).
    send_periodic(cadence) -> dict
        Build + send one cadence to every opted-in user. Never raises.

Design notes:
- Date-only cutoffs ('YYYY-MM-DD') are used in every WHERE clause. Both
  timestamp formats in the DB (listings.first_seen is isoformat with a
  'T'; listing_events.detected_at is "YYYY-MM-DD HH:MM:SS" with a space)
  share the same 'YYYY-MM-DD' prefix, so a lexicographic >=/< comparison
  against a date string is correct for both without parsing.
- Windows are UTC-day-granular. An 8h Perth/UTC skew at the day boundary
  is immaterial for 7-to-365-day aggregates and is documented rather than
  over-engineered.
"""

import logging
import os
from datetime import date, datetime, timedelta

from database import get_db
from email_service import _send, _app_url, _support_reply_to
from email_digest import _esc
from time_utils import perth_now

try:
    from signals.diff_engine import _price_to_int
except Exception:  # pragma: no cover - defensive, diff_engine is always present
    def _price_to_int(_):
        return None

logger = logging.getLogger(__name__)

# users.<column> that gates each cadence. Daily is intentionally absent —
# it stays on digest_enabled, owned by email_digest.py.
_FLAG = {
    'weekly': 'email_weekly',
    'monthly': 'email_monthly',
    'quarterly': 'email_quarterly',
    'annual': 'email_annual',
}

_STEP_MONTHS = {'monthly': 1, 'quarterly': 3, 'annual': 12}

_MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December']

# "Ça bouge ici" — a suburb is flagged as heating up when withdrawals
# spike. Two independent triggers (either fires the flag):
#   - absolute: >= WITHDRAWN_ABS withdrawn in the trailing 7 days, or
#   - relative: 7-day withdrawn >= SPIKE_MULT × the average weekly
#     withdrawn over the prior 4 weeks.
WITHDRAWN_ABS = 3
SPIKE_MULT = 1.5


# ---------------------------------------------------------------------------
# Scheduling
# ---------------------------------------------------------------------------

def due_cadences(ref_date):
    """Cadences that should fire on `ref_date` (a Perth date). Monday sends
    the weekly recap; the 1st of a month sends monthly (plus quarterly on a
    quarter boundary, plus annual on 1 January)."""
    out = []
    if ref_date.weekday() == 0:      # Monday
        out.append('weekly')
    if ref_date.day == 1:
        out.append('monthly')
        if ref_date.month in (1, 4, 7, 10):
            out.append('quarterly')
        if ref_date.month == 1:
            out.append('annual')
    return out


def _shift_month_start(year, month, delta):
    """(year, month) of a first-of-month shifted by `delta` months."""
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def _period_window(cadence, ref):
    """Return (start, end, prev_start, prev_end, label) for the just-
    completed period, as date objects. [start, end) is the window the
    email covers; [prev_start, prev_end) is the equal-length window before
    it (for trend arrows). `ref` is the send date (a period boundary for
    monthly/quarterly/annual)."""
    if cadence == 'weekly':
        end = ref
        start = end - timedelta(days=7)
        prev_start = start - timedelta(days=7)
        last_day = end - timedelta(days=1)
        label = f"{start.day:02d}/{start.month:02d}–{last_day.day:02d}/{last_day.month:02d}/{last_day.year}"
        return start, end, prev_start, start, label

    step = _STEP_MONTHS[cadence]
    if cadence == 'monthly':
        ey, em = ref.year, ref.month
    elif cadence == 'quarterly':
        ey, em = ref.year, ((ref.month - 1) // 3) * 3 + 1
    else:  # annual
        ey, em = ref.year, 1
    end = date(ey, em, 1)
    sy, sm = _shift_month_start(ey, em, -step)
    py, pm = _shift_month_start(ey, em, -2 * step)
    start = date(sy, sm, 1)
    prev_start = date(py, pm, 1)

    if cadence == 'monthly':
        label = f"{_MONTHS_EN[sm - 1]} {sy}"
    elif cadence == 'quarterly':
        label = f"Q{(sm - 1) // 3 + 1} {sy}"
    else:
        label = str(sy)
    return start, end, prev_start, start, label


# ---------------------------------------------------------------------------
# Scoping
# ---------------------------------------------------------------------------

def _user_suburbs(conn, user):
    """Suburb rows [{id, name}] the user can see. Admins and all_suburbs
    users get every active suburb; everyone else gets their explicit
    assignment. Mirrors the scoping used by the daily digest/brief."""
    is_admin = (user.get('role') or '').lower() == 'admin'
    all_sub = user.get('all_suburbs') in (1, True)
    if is_admin or all_sub:
        rows = conn.execute(
            "SELECT id, name FROM suburbs WHERE active = 1 ORDER BY name"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT s.id, s.name FROM suburbs s "
            "JOIN user_suburbs us ON s.id = us.suburb_id "
            "WHERE us.user_id = ? AND s.active = 1 ORDER BY s.name",
            (user['id'],)
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Data — aggregates (monthly / quarterly / annual)
# ---------------------------------------------------------------------------

def _event_count(conn, suburb_ids, event_type, start, end):
    ph = ','.join(['?'] * len(suburb_ids))
    return conn.execute(
        f"SELECT COUNT(*) AS n FROM listing_events "
        f"WHERE suburb_id IN ({ph}) AND event_type = ? "
        f"AND detected_at >= ? AND detected_at < ?",
        (*suburb_ids, event_type, start.isoformat(), end.isoformat())
    ).fetchone()['n']


def _new_listing_count(conn, suburb_ids, start, end):
    ph = ','.join(['?'] * len(suburb_ids))
    return conn.execute(
        f"SELECT COUNT(*) AS n FROM listings "
        f"WHERE suburb_id IN ({ph}) AND first_seen >= ? AND first_seen < ?",
        (*suburb_ids, start.isoformat(), end.isoformat())
    ).fetchone()['n']


def _median(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    mid = n // 2
    if n % 2:
        return vals[mid]
    return (vals[mid - 1] + vals[mid]) // 2


def _sold_stats(conn, suburb_ids, start, end):
    """(sold_count, median_sold_price, median_days_on_market) over the
    window. Sold price parses sold_price, falling back to price_text.
    DOM is last_seen - first_seen in days, only when both parse."""
    ph = ','.join(['?'] * len(suburb_ids))
    rows = conn.execute(
        f"SELECT sold_price, price_text, first_seen, last_seen FROM listings "
        f"WHERE suburb_id IN ({ph}) AND status = 'sold' "
        f"AND last_seen >= ? AND last_seen < ?",
        (*suburb_ids, start.isoformat(), end.isoformat())
    ).fetchall()
    prices, doms = [], []
    for r in rows:
        d = dict(r)
        p = _price_to_int(d.get('sold_price')) or _price_to_int(d.get('price_text'))
        if p:
            prices.append(p)
        dom = _days_on_market(d.get('first_seen'), d.get('last_seen'))
        if dom is not None:
            doms.append(dom)
    return len(rows), _median(prices), _median(doms)


def _days_on_market(first_seen, last_seen):
    a, b = _parse_ts(first_seen), _parse_ts(last_seen)
    if a is None or b is None:
        return None
    delta = (b - a).days
    return delta if delta >= 0 else None


def _parse_ts(ts):
    if not ts:
        return None
    s = str(ts).replace('T', ' ')
    for fmt in ('%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            return datetime.strptime(s[:26] if '.' in s else s, fmt)
        except ValueError:
            continue
    return None


def _suburb_aggregate(conn, suburb, start, end, prev_start, prev_end):
    """Per-suburb metrics for the window + the prior window (for trends)."""
    sid = (suburb['id'],)
    cur_sold, cur_median, cur_dom = _sold_stats(conn, sid, start, end)
    prev_sold, prev_median, _ = _sold_stats(conn, sid, prev_start, prev_end)
    return {
        'suburb': suburb['name'],
        'new_listings': _new_listing_count(conn, sid, start, end),
        'new_listings_prev': _new_listing_count(conn, sid, prev_start, prev_end),
        'sold': cur_sold,
        'sold_prev': prev_sold,
        'median_sold': cur_median,
        'median_sold_prev': prev_median,
        'median_dom': cur_dom,
        'withdrawn': _event_count(conn, sid, 'withdrawn', start, end),
        'price_drops': _event_count(conn, sid, 'price_drop', start, end),
    }


def build_period_rows(conn, suburb_rows, start, end, prev_start, prev_end):
    """One aggregate row per suburb, plus a totals row appended last."""
    rows = [_suburb_aggregate(conn, s, start, end, prev_start, prev_end)
            for s in suburb_rows]
    total = {
        'suburb': 'All suburbs',
        'new_listings': sum(r['new_listings'] for r in rows),
        'new_listings_prev': sum(r['new_listings_prev'] for r in rows),
        'sold': sum(r['sold'] for r in rows),
        'sold_prev': sum(r['sold_prev'] for r in rows),
        'median_sold': _median([r['median_sold'] for r in rows if r['median_sold']]),
        'median_sold_prev': _median([r['median_sold_prev'] for r in rows if r['median_sold_prev']]),
        'median_dom': _median([r['median_dom'] for r in rows if r['median_dom'] is not None]),
        'withdrawn': sum(r['withdrawn'] for r in rows),
        'price_drops': sum(r['price_drops'] for r in rows),
        'is_total': True,
    }
    return rows, total


# ---------------------------------------------------------------------------
# Data — weekly detail
# ---------------------------------------------------------------------------

def build_weekly_sections(conn, suburb_rows, start, end, ref):
    """Detail lists for the weekly recap: withdrawn, price moves, sales,
    plus the 'moving suburbs' prospecting signal."""
    suburb_ids = [s['id'] for s in suburb_rows]
    ph = ','.join(['?'] * len(suburb_ids))
    s, e = start.isoformat(), end.isoformat()

    def _events(types):
        tph = ','.join(['?'] * len(types))
        return [dict(r) for r in conn.execute(
            f"SELECT ev.address, ev.event_type, ev.old_value, ev.new_value, "
            f"su.name AS suburb, ev.detected_at "
            f"FROM listing_events ev JOIN suburbs su ON su.id = ev.suburb_id "
            f"WHERE ev.suburb_id IN ({ph}) AND ev.event_type IN ({tph}) "
            f"AND ev.detected_at >= ? AND ev.detected_at < ? "
            f"ORDER BY su.name, ev.detected_at DESC",
            (*suburb_ids, *types, s, e)
        ).fetchall()]

    withdrawn = _events(['withdrawn'])
    price_moves = _events(['price_drop', 'price_rise'])
    sales = _events(['sold'])
    hot = _moving_suburbs(conn, suburb_rows, ref)
    return {
        'withdrawn': withdrawn,
        'price_moves': price_moves,
        'sales': sales,
        'hot_suburbs': hot,
    }


def _moving_suburbs(conn, suburb_rows, ref):
    """Suburbs where withdrawals are spiking — the 'prospect here now'
    signal. Returns [{suburb, w7, avg4, reason}] for flagged suburbs only,
    most-active first."""
    out = []
    w7_start = (ref - timedelta(days=7)).isoformat()
    w7_end = ref.isoformat()
    prior_start = (ref - timedelta(days=35)).isoformat()   # 4 weeks before the 7-day window
    prior_end = w7_start
    for s in suburb_rows:
        sid = s['id']
        w7 = conn.execute(
            "SELECT COUNT(*) AS n FROM listing_events WHERE suburb_id = ? "
            "AND event_type = 'withdrawn' AND detected_at >= ? AND detected_at < ?",
            (sid, w7_start, w7_end)
        ).fetchone()['n']
        prior = conn.execute(
            "SELECT COUNT(*) AS n FROM listing_events WHERE suburb_id = ? "
            "AND event_type = 'withdrawn' AND detected_at >= ? AND detected_at < ?",
            (sid, prior_start, prior_end)
        ).fetchone()['n']
        avg4 = prior / 4.0
        hit_abs = w7 >= WITHDRAWN_ABS
        hit_rel = avg4 > 0 and w7 >= SPIKE_MULT * avg4
        if hit_abs or hit_rel:
            if hit_abs and hit_rel:
                reason = f"{w7} withdrawn this week ({avg4:.1f}/wk avg over the prior month)"
            elif hit_abs:
                reason = f"{w7} withdrawn this week"
            else:
                reason = f"{w7} withdrawn this week vs {avg4:.1f}/wk average — a spike"
            out.append({'suburb': s['name'], 'w7': w7, 'avg4': round(avg4, 1),
                        'reason': reason})
    out.sort(key=lambda r: r['w7'], reverse=True)
    return out


def _has_weekly_content(sections):
    return bool(sections['withdrawn'] or sections['price_moves']
                or sections['sales'] or sections['hot_suburbs'])


def _has_period_content(rows):
    return any(r['new_listings'] or r['sold'] or r['withdrawn'] for r in rows)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _fmt_price(n):
    return f"${n:,.0f}" if n else '—'


def _trend(cur, prev):
    """Small ▲/▼ badge comparing cur vs prev. Neutral when prev is 0."""
    if not prev:
        return ''
    if cur > prev:
        return f' <span style="color:#15803d;">▲{cur - prev}</span>'
    if cur < prev:
        return f' <span style="color:#b91c1c;">▼{prev - cur}</span>'
    return ' <span style="color:#999;">→</span>'


def _shell(title, subtitle, body_html, app):
    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;color:#1a1a1a;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);max-width:600px;">
<tr><td style="background:#386350;padding:24px 32px;">
<h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;font-weight:700;">SUBURBDESK</h1>
<p style="margin:4px 0 0;color:#cfe0d6;font-size:13px;">{_esc(subtitle)}</p>
</td></tr>
<tr><td style="padding:24px 28px;">
{body_html}
<p style="margin:24px 0 0;text-align:center;">
<a href="{_esc(app)}" style="display:inline-block;background:#386350;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open SuburbDesk</a>
</p>
</td></tr>
<tr><td style="background:#fafafa;padding:14px 28px;border-top:1px solid #eee;">
<p style="margin:0;color:#999;font-size:11px;">
Reply with "unsubscribe" to stop receiving these emails.<br>
SuburbDesk &middot; <a href="mailto:suburbdesk@gmail.com" style="color:#999;">suburbdesk@gmail.com</a>
</p>
</td></tr>
</table></td></tr></table></body></html>"""


def _section_header(text):
    return (f'<h3 style="margin:18px 0 8px;color:#386350;font-size:14px;'
            f'font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">'
            f'{_esc(text)}</h3>')


def _card(inner, accent='#386350', bg='#fff'):
    return (f'<div style="margin:0 0 8px;padding:8px 12px;background:{bg};'
            f'border-left:3px solid {accent};border-radius:0 4px 4px 0;">{inner}</div>')


def render_weekly(user, sections, suburb_names, label):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    parts = [f'<p style="margin:0 0 16px;font-size:15px;">Good morning {_esc(name)}, '
             f'here is what moved in your suburbs last week ({_esc(label)}).</p>']

    if sections['hot_suburbs']:
        parts.append(_section_header('Prospect here now'))
        for h in sections['hot_suburbs']:
            parts.append(_card(
                f'<div style="font-weight:700;color:#7c2d12;font-size:14px;">🔥 {_esc(h["suburb"])}</div>'
                f'<div style="color:#444;font-size:13px;">{_esc(h["reason"])}</div>',
                accent='#ea580c', bg='#fff7ed'))

    parts.append(_section_header(f'Withdrawn ({len(sections["withdrawn"])})'))
    if sections['withdrawn']:
        for r in sections['withdrawn']:
            parts.append(_card(
                f'<div style="font-weight:600;font-size:14px;">{_esc(r.get("address"))} '
                f'<span style="color:#555;font-weight:500;">— {_esc(r.get("suburb"))}</span></div>'))
    else:
        parts.append('<p style="color:#666;font-size:13px;margin:0 0 8px;">None this week.</p>')

    parts.append(_section_header(f'Price changes ({len(sections["price_moves"])})'))
    if sections['price_moves']:
        for r in sections['price_moves']:
            arrow = '▼' if r['event_type'] == 'price_drop' else '▲'
            col = '#b91c1c' if r['event_type'] == 'price_drop' else '#15803d'
            move = ''
            if r.get('old_value') and r.get('new_value'):
                move = f' <span style="color:{col};">{arrow} {_esc(r["old_value"])} → {_esc(r["new_value"])}</span>'
            parts.append(_card(
                f'<div style="font-weight:600;font-size:14px;">{_esc(r.get("address"))} '
                f'<span style="color:#555;font-weight:500;">— {_esc(r.get("suburb"))}</span></div>'
                f'<div style="color:#444;font-size:13px;">Price change{move}</div>'))
    else:
        parts.append('<p style="color:#666;font-size:13px;margin:0 0 8px;">None this week.</p>')

    parts.append(_section_header(f'Sales ({len(sections["sales"])})'))
    if sections['sales']:
        for r in sections['sales']:
            parts.append(_card(
                f'<div style="font-weight:600;font-size:14px;">{_esc(r.get("address"))} '
                f'<span style="color:#555;font-weight:500;">— {_esc(r.get("suburb"))}</span></div>'
                f'<div style="color:#444;font-size:13px;">Sold</div>'))
    else:
        parts.append('<p style="color:#666;font-size:13px;margin:0 0 8px;">None this week.</p>')

    parts.append(f'<p style="margin:16px 0 0;color:#666;font-size:12px;">'
                 f'Suburbs covered: {_esc(", ".join(suburb_names))}</p>')
    return _shell('Weekly recap', f'Weekly recap · {label}', ''.join(parts), app)


def render_weekly_text(user, sections, suburb_names, label):
    name = (user.get('first_name') or 'there').strip()
    lines = [f"Good morning {name},", '',
             f"SuburbDesk weekly recap — {label}.", '']
    if sections['hot_suburbs']:
        lines.append('=== PROSPECT HERE NOW ===')
        for h in sections['hot_suburbs']:
            lines.append(f"  🔥 {h['suburb']}: {h['reason']}")
        lines.append('')
    for title, key in (('WITHDRAWN', 'withdrawn'), ('PRICE CHANGES', 'price_moves'),
                       ('SALES', 'sales')):
        lines.append(f"=== {title} ({len(sections[key])}) ===")
        if sections[key]:
            for r in sections[key]:
                lines.append(f"  - {r.get('address', '')} — {r.get('suburb', '')}")
        else:
            lines.append('  None this week.')
        lines.append('')
    lines.append(f"Suburbs covered: {', '.join(suburb_names)}")
    lines.append('')
    lines.append(f"Open the app: {_app_url()}")
    lines.append('Reply with "unsubscribe" to stop receiving these emails.')
    lines.append('-- SuburbDesk · suburbdesk@gmail.com')
    return '\n'.join(lines)


def _period_table(rows, total):
    head = (
        '<tr style="background:#f0f4f2;">'
        '<th style="text-align:left;padding:6px 8px;font-size:12px;color:#386350;">Suburb</th>'
        '<th style="text-align:right;padding:6px 8px;font-size:12px;color:#386350;">New</th>'
        '<th style="text-align:right;padding:6px 8px;font-size:12px;color:#386350;">Sold</th>'
        '<th style="text-align:right;padding:6px 8px;font-size:12px;color:#386350;">Median sold</th>'
        '<th style="text-align:right;padding:6px 8px;font-size:12px;color:#386350;">Withdrawn</th>'
        '</tr>'
    )
    body = []
    for r in list(rows) + [total]:
        weight = '700' if r.get('is_total') else '500'
        border = 'border-top:2px solid #386350;' if r.get('is_total') else 'border-top:1px solid #eee;'
        body.append(
            f'<tr style="{border}">'
            f'<td style="padding:6px 8px;font-size:13px;font-weight:{weight};">{_esc(r["suburb"])}</td>'
            f'<td style="padding:6px 8px;font-size:13px;text-align:right;">{r["new_listings"]}{_trend(r["new_listings"], r["new_listings_prev"])}</td>'
            f'<td style="padding:6px 8px;font-size:13px;text-align:right;">{r["sold"]}{_trend(r["sold"], r["sold_prev"])}</td>'
            f'<td style="padding:6px 8px;font-size:13px;text-align:right;">{_fmt_price(r["median_sold"])}</td>'
            f'<td style="padding:6px 8px;font-size:13px;text-align:right;">{r["withdrawn"]}</td>'
            f'</tr>'
        )
    return (f'<table width="100%" cellpadding="0" cellspacing="0" '
            f'style="border-collapse:collapse;margin:8px 0;">{head}{"".join(body)}</table>')


def render_period(user, cadence, rows, total, suburb_names, label):
    name = (user.get('first_name') or 'there').strip()
    app = _app_url()
    titles = {'monthly': 'Monthly report', 'quarterly': 'Quarterly report',
              'annual': 'Year in review'}
    title = titles[cadence]
    dom = f"{total['median_dom']} days" if total.get('median_dom') is not None else '—'
    body = (
        f'<p style="margin:0 0 12px;font-size:15px;">Hi {_esc(name)}, your {_esc(title.lower())} '
        f'for <strong>{_esc(label)}</strong> across your suburbs.</p>'
        f'<p style="margin:0 0 12px;font-size:13px;color:#444;">'
        f'{total["new_listings"]} new listings · {total["sold"]} sold · '
        f'median sold {_fmt_price(total["median_sold"])} · '
        f'typical days on market {dom} · {total["withdrawn"]} withdrawn.</p>'
        + _period_table(rows, total)
        + f'<p style="margin:12px 0 0;color:#999;font-size:11px;">'
          f'▲/▼ compares against the previous {cadence.replace("ly", "")} period.</p>'
        + f'<p style="margin:8px 0 0;color:#666;font-size:12px;">'
          f'Suburbs: {_esc(", ".join(suburb_names))}</p>'
    )
    return _shell(title, f'{title} · {label}', body, app)


def render_period_text(user, cadence, rows, total, suburb_names, label):
    name = (user.get('first_name') or 'there').strip()
    titles = {'monthly': 'Monthly report', 'quarterly': 'Quarterly report',
              'annual': 'Year in review'}
    lines = [f"Hi {name},", '',
             f"SuburbDesk {titles[cadence]} — {label}.", '',
             f"Totals: {total['new_listings']} new · {total['sold']} sold · "
             f"median {_fmt_price(total['median_sold'])} · {total['withdrawn']} withdrawn.",
             '']
    for r in rows:
        lines.append(f"  {r['suburb']}: {r['new_listings']} new, {r['sold']} sold, "
                     f"median {_fmt_price(r['median_sold'])}, {r['withdrawn']} withdrawn")
    lines.append('')
    lines.append(f"Open the app: {_app_url()}")
    lines.append('Reply with "unsubscribe" to stop receiving these emails.')
    lines.append('-- SuburbDesk · suburbdesk@gmail.com')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Send
# ---------------------------------------------------------------------------

def _log_attempt(conn, user_id, cadence, suburb_names, status, error=None):
    """Best-effort audit row in digest_logs (tagged with cadence). Never
    raises — a logging failure must not abort the cron pass."""
    try:
        suburbs = ', '.join(suburb_names)[:500]
        try:
            conn.execute(
                "INSERT INTO digest_logs (user_id, suburbs_covered, status, "
                "error, cadence) VALUES (?, ?, ?, ?, ?)",
                (user_id, suburbs, status, error, cadence)
            )
        except Exception:
            conn.rollback() if hasattr(conn, 'rollback') else None
            conn.execute(
                "INSERT INTO digest_logs (user_id, suburbs_covered, status, error) "
                "VALUES (?, ?, ?, ?)",
                (user_id, suburbs, status, error)
            )
        conn.commit()
    except Exception:
        logger.exception("periodic digest_logs write failed (suppressed)")


def _build_email(cadence, conn, user, suburb_rows, ref):
    """Return (subject, html, text, has_content) for one user + cadence."""
    start, end, prev_start, prev_end, label = _period_window(cadence, ref)
    suburb_names = [s['name'] for s in suburb_rows]
    if cadence == 'weekly':
        sections = build_weekly_sections(conn, suburb_rows, start, end, ref)
        has = _has_weekly_content(sections)
        subject = f"SuburbDesk Weekly Recap — {label}"
        html = render_weekly(user, sections, suburb_names, label)
        text = render_weekly_text(user, sections, suburb_names, label)
        return subject, html, text, has
    rows, total = build_period_rows(conn, suburb_rows, start, end, prev_start, prev_end)
    has = _has_period_content(rows)
    titles = {'monthly': 'Monthly Report', 'quarterly': 'Quarterly Report',
              'annual': 'Year in Review'}
    subject = f"SuburbDesk {titles[cadence]} — {label}"
    html = render_period(user, cadence, rows, total, suburb_names, label)
    text = render_period_text(user, cadence, rows, total, suburb_names, label)
    return subject, html, text, has


def send_periodic(cadence):
    """Build + send one cadence to every opted-in user. Returns a summary
    dict for the cron log. Never raises."""
    if cadence not in _FLAG:
        return {'cadence': cadence, 'error': 'unknown cadence'}
    if not (os.environ.get('EMAIL_FROM') or '').strip():
        logger.warning("EMAIL_FROM not set — %s email pass skipped", cadence)
        return {'cadence': cadence, 'sent': 0, 'skipped': 0, 'failed': 0,
                'reason': 'EMAIL_FROM not configured'}

    flag = _FLAG[cadence]
    ref = perth_now().date()
    sent = skipped = failed = 0
    try:
        conn = get_db()
        users = [dict(r) for r in conn.execute(
            f"SELECT id, email, first_name, role, all_suburbs FROM users "
            f"WHERE {flag} = 1 AND email IS NOT NULL AND email <> ''"
        ).fetchall()]
    except Exception:
        logger.exception("send_periodic(%s): user lookup failed", cadence)
        return {'cadence': cadence, 'sent': 0, 'skipped': 0, 'failed': 0, 'fatal': True}

    reply_to = _support_reply_to()
    for user in users:
        try:
            suburb_rows = _user_suburbs(conn, user)
            if not suburb_rows:
                skipped += 1
                _log_attempt(conn, user['id'], cadence, [], 'skipped',
                             'No suburbs assigned')
                continue
            subject, html, text, has = _build_email(cadence, conn, user, suburb_rows, ref)
            if not has:
                # Nothing happened in the window — don't send an empty
                # report (weekly especially would be noise). Logged, not sent.
                skipped += 1
                _log_attempt(conn, user['id'], cadence,
                             [s['name'] for s in suburb_rows], 'skipped', 'No activity')
                continue
            ok, info = _send(user['email'], subject, html, text=text,
                             reply_to=reply_to, list_unsubscribe=reply_to)
            _log_attempt(conn, user['id'], cadence,
                         [s['name'] for s in suburb_rows],
                         'sent' if ok else 'failed', None if ok else str(info)[:300])
            if ok:
                sent += 1
            else:
                failed += 1
        except Exception:
            logger.exception("send_periodic(%s): per-user crash uid=%s",
                             cadence, user.get('id'))
            failed += 1
    try:
        conn.close()
    except Exception:
        pass
    logger.info("[%s] pass complete: %d sent, %d skipped, %d failed",
                cadence, sent, skipped, failed)
    return {'cadence': cadence, 'sent': sent, 'skipped': skipped, 'failed': failed}

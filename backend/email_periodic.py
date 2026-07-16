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

import email_brand as brand
from database import get_db
from email_service import _send, _app_url, _support_reply_to
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
    # Sales join listings via listing_id to disclose the sold price when we
    # have it (LEFT JOIN — backfilled events may have a null listing_id).
    sales = [dict(r) for r in conn.execute(
        f"SELECT ev.address, su.name AS suburb, ev.detected_at, "
        f"l.sold_price, l.price_text "
        f"FROM listing_events ev JOIN suburbs su ON su.id = ev.suburb_id "
        f"LEFT JOIN listings l ON l.id = ev.listing_id "
        f"WHERE ev.suburb_id IN ({ph}) AND ev.event_type = 'sold' "
        f"AND ev.detected_at >= ? AND ev.detected_at < ? "
        f"ORDER BY su.name, ev.detected_at DESC",
        (*suburb_ids, s, e)
    ).fetchall()]
    for r in sales:
        p = _price_to_int(r.get('sold_price')) or _price_to_int(r.get('price_text'))
        r['sold_display'] = _fmt_price(p) if p else None
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
# Rendering  (all chrome comes from email_brand — no emojis, one identity)
# ---------------------------------------------------------------------------

def _fmt_price(n):
    """Compact dollar figure: $4,250,000 -> '$4.25m', $850,000 -> '$850k'."""
    if not n:
        return '—'
    if n >= 1_000_000:
        return f"${n / 1_000_000:.2f}m".replace('.00m', 'm')
    if n >= 1_000:
        return f"${n / 1_000:.0f}k"
    return f"${n:,.0f}"


def _trend(cur, prev):
    """Small up/down delta vs the previous period. Neutral when prev is 0.
    Uses geometric triangles (financial convention), not emoji."""
    if not prev:
        return ''
    if cur > prev:
        return f' <span style="color:{brand.GREEN};">▲{cur - prev}</span>'
    if cur < prev:
        return f' <span style="color:#b45309;">▼{prev - cur}</span>'
    return f' <span style="color:{brand.MUTED};">→</span>'


def _weekly_lead_fallback(sections):
    w, p, s = (len(sections['withdrawn']), len(sections['price_moves']),
               len(sections['sales']))
    hot = sections['hot_suburbs'][0]['suburb'] if sections['hot_suburbs'] else None
    bits = []
    if w:
        bits.append(f"{w} withdrawal{'s' if w != 1 else ''}")
    if p:
        bits.append(f"{p} price reduction{'s' if p != 1 else ''}")
    if s:
        bits.append(f"{s} sale{'s' if s != 1 else ''}")
    head = ', '.join(bits) if bits else 'a quiet week'
    tail = f" {hot} is the one to watch." if hot else ''
    return f"Across your suburbs this week: {head}.{tail}"


def _weekly_body(sections, suburb_names, label, lead_text):
    parts = [brand.kicker_date(label), brand.lead(lead_text)]
    parts.append(brand.numbers_line([
        (len(sections['withdrawn']), 'withdrawn'),
        (len(sections['price_moves']), 'price cuts'),
        (len(sections['sales']), 'sales'),
    ]))
    if sections['hot_suburbs']:
        focus = ' '.join(
            f"<strong style='color:{brand.GREEN}'>{brand._esc(h['suburb'])}</strong> — {brand._esc(h['reason'])}."
            for h in sections['hot_suburbs'])
        parts.append(brand.focus_block('Where to focus', focus))

    # Group every event under its suburb for a clean editorial read.
    subs = []
    for lst in (sections['sales'], sections['price_moves'], sections['withdrawn']):
        for r in lst:
            if r.get('suburb') and r['suburb'] not in subs:
                subs.append(r['suburb'])
    subs.sort()
    for sub in subs:
        rows = []
        for r in sections['sales']:
            if r.get('suburb') == sub:
                disp = r.get('sold_display')
                right = f"<span style='color:{brand.GREEN};font-weight:600'>{disp}</span>" if disp else ''
                rows.append(brand.line(r.get('address', ''), 'sold', right=right and disp or '',
                                       right_color=brand.GREEN))
        for r in sections['price_moves']:
            if r.get('suburb') == sub:
                move = ''
                if r.get('old_value') and r.get('new_value'):
                    move = f"{brand._esc(r['old_value'])} → {brand._esc(r['new_value'])}"
                rows.append(
                    f"<div style='font-size:14px;margin:4px 0;color:{brand.INK};font-family:{brand._SANS}'>"
                    f"{brand._esc(r.get('address',''))} <span style='color:{brand.MUTED}'>— reduced</span> "
                    f"<span style='color:{brand.BRASS}'>{move}</span></div>")
        wd = [r.get('address', '') for r in sections['withdrawn'] if r.get('suburb') == sub]
        if wd:
            rows.append(
                f"<div style='font-size:14px;margin:4px 0;color:#5a5a54;font-family:{brand._SANS}'>"
                f"Withdrawn — {brand._esc(', '.join(wd))}</div>")
        if rows:
            parts.append(brand.group_header(sub))
            parts.extend(rows)
    return ''.join(parts)


def render_weekly(user, sections, suburb_names, label, lead_text):
    body = _weekly_body(sections, suburb_names, label, lead_text)
    from email_service import unsubscribe_url
    return brand.shell('Weekly Brief', body, _app_url(),
                       suburbs_line=', '.join(suburb_names),
                       unsubscribe_url=unsubscribe_url(user.get('id')))


def render_weekly_text(user, sections, suburb_names, label, lead_text):
    lines = []
    for title, key in (('SALES', 'sales'), ('PRICE REDUCTIONS', 'price_moves'),
                       ('WITHDRAWN', 'withdrawn')):
        lines.append(f"{title} ({len(sections[key])})")
        if sections[key]:
            for r in sections[key]:
                extra = ''
                if key == 'sales' and r.get('sold_display'):
                    extra = f" — {r['sold_display']}"
                elif key == 'price_moves' and r.get('old_value') and r.get('new_value'):
                    extra = f" — {r['old_value']} -> {r['new_value']}"
                lines.append(f"  - {r.get('address','')} — {r.get('suburb','')}{extra}")
        else:
            lines.append('  None this week.')
        lines.append('')
    if sections['hot_suburbs']:
        lines.append('WHERE TO FOCUS')
        for h in sections['hot_suburbs']:
            lines.append(f"  - {h['suburb']}: {h['reason']}")
        lines.append('')
    return brand.text_shell(f'Weekly Brief · {label}', lead_text, lines,
                            ', '.join(suburb_names), _app_url())


def _period_table(rows, total):
    def th(t, align='left'):
        return (f'<th style="text-align:{align};padding:7px 8px;font-family:{brand._SANS};'
                f'font-size:11px;font-weight:700;color:{brand.GREEN};text-transform:uppercase;'
                f'letter-spacing:.6px;border-bottom:2px solid {brand.BRASS};">{t}</th>')
    head = ('<tr>' + th('Suburb') + th('New', 'right') + th('Sold', 'right')
            + th('Median sold', 'right') + th('Withdrawn', 'right') + '</tr>')
    body = []
    for r in list(rows) + [total]:
        weight = '700' if r.get('is_total') else '500'
        top = f'border-top:2px solid {brand.GREEN};' if r.get('is_total') else f'border-top:1px solid {brand.HAIR};'
        def td(v, align='left', extra=''):
            return (f'<td style="padding:7px 8px;font-family:{brand._SANS};font-size:13px;'
                    f'text-align:{align};font-weight:{weight};color:{brand.INK};{extra}">{v}</td>')
        body.append(
            f'<tr style="{top}">'
            + td(brand._esc(r['suburb']))
            + td(f"{r['new_listings']}{_trend(r['new_listings'], r['new_listings_prev'])}", 'right')
            + td(f"{r['sold']}{_trend(r['sold'], r['sold_prev'])}", 'right')
            + td(f"<span style='color:{brand.GREEN};font-weight:600'>{_fmt_price(r['median_sold'])}</span>", 'right')
            + td(str(r['withdrawn']), 'right')
            + '</tr>')
    return ('<table width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse;margin:12px 0;">' + head + ''.join(body) + '</table>')


def _period_lead_fallback(cadence, total, label):
    period = {'monthly': 'month', 'quarterly': 'quarter', 'annual': 'year'}[cadence]
    return (f"In {label}, your suburbs saw {total['new_listings']} new listing"
            f"{'s' if total['new_listings'] != 1 else ''} and {total['sold']} sale"
            f"{'s' if total['sold'] != 1 else ''}, with a median sold price of "
            f"{_fmt_price(total['median_sold'])} over the {period}.")


def render_period(user, cadence, rows, total, suburb_names, label, lead_text):
    kickers = {'monthly': 'Monthly Report', 'quarterly': 'Quarterly Report',
               'annual': 'Year in Review'}
    dom = f"{total['median_dom']} days on market" if total.get('median_dom') is not None else 'days on market n/a'
    body = (
        brand.kicker_date(label)
        + brand.lead(lead_text)
        + brand.numbers_line([
            (total['new_listings'], 'new'),
            (total['sold'], 'sold'),
            (_fmt_price(total['median_sold']), 'median'),
            (total['withdrawn'], 'withdrawn'),
        ])
        + _period_table(rows, total)
        + f'<p style="font-family:{brand._SANS};margin:10px 0 0;color:{brand.MUTED};font-size:11px;">'
          f'Typical {brand._esc(dom)}. ▲/▼ compares against the previous period.</p>'
    )
    from email_service import unsubscribe_url
    return brand.shell(kickers[cadence], body, _app_url(),
                       suburbs_line=', '.join(suburb_names),
                       unsubscribe_url=unsubscribe_url(user.get('id')))


def render_period_text(user, cadence, rows, total, suburb_names, label, lead_text):
    kickers = {'monthly': 'Monthly Report', 'quarterly': 'Quarterly Report',
               'annual': 'Year in Review'}
    lines = [f"Totals: {total['new_listings']} new · {total['sold']} sold · "
             f"median {_fmt_price(total['median_sold'])} · {total['withdrawn']} withdrawn", '']
    for r in rows:
        lines.append(f"  {r['suburb']}: {r['new_listings']} new, {r['sold']} sold, "
                     f"median {_fmt_price(r['median_sold'])}, {r['withdrawn']} withdrawn")
    return brand.text_shell(f"{kickers[cadence]} · {label}", lead_text, lines,
                            ', '.join(suburb_names), _app_url())



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
        subject = f"SuburbDesk Weekly Brief — {label}"
        lead = _weekly_lead(sections, suburb_names, label)
        html = render_weekly(user, sections, suburb_names, label, lead)
        text = render_weekly_text(user, sections, suburb_names, label, lead)
        return subject, html, text, has
    rows, total = build_period_rows(conn, suburb_rows, start, end, prev_start, prev_end)
    has = _has_period_content(rows)
    titles = {'monthly': 'Monthly Report', 'quarterly': 'Quarterly Report',
              'annual': 'Year in Review'}
    subject = f"SuburbDesk {titles[cadence]} — {label}"
    lead = _period_lead(cadence, total, label)
    html = render_period(user, cadence, rows, total, suburb_names, label, lead)
    text = render_period_text(user, cadence, rows, total, suburb_names, label, lead)
    return subject, html, text, has


def _weekly_lead(sections, suburb_names, label):
    """AI summary line for the weekly email; deterministic fallback if the
    Claude call is unavailable."""
    fallback = _weekly_lead_fallback(sections)
    facts = [f"Reporting week: {label}",
             f"Suburbs: {', '.join(suburb_names)}",
             f"Withdrawals: {len(sections['withdrawn'])}",
             f"Price reductions: {len(sections['price_moves'])}",
             f"Sales: {len(sections['sales'])}"]
    if sections['sales']:
        top = [f"{r.get('address')} ({r.get('sold_display')})"
               for r in sections['sales'] if r.get('sold_display')][:3]
        if top:
            facts.append("Notable sales: " + "; ".join(top))
    if sections['hot_suburbs']:
        facts.append("Withdrawal spikes: " + "; ".join(
            f"{h['suburb']} ({h['reason']})" for h in sections['hot_suburbs']))
    return brand.compose_lead(facts, fallback)


def _period_lead(cadence, total, label):
    fallback = _period_lead_fallback(cadence, total, label)
    facts = [f"Period: {label}",
             f"New listings: {total['new_listings']} (prev {total['new_listings_prev']})",
             f"Sales: {total['sold']} (prev {total['sold_prev']})",
             f"Median sold price: {_fmt_price(total['median_sold'])}",
             f"Withdrawals: {total['withdrawn']}"]
    if total.get('median_dom') is not None:
        facts.append(f"Median days on market: {total['median_dom']}")
    return brand.compose_lead(facts, fallback)


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
            from email_service import unsubscribe_url
            ok, info = _send(user['email'], subject, html, text=text,
                             reply_to=reply_to,
                             list_unsubscribe=unsubscribe_url(user['id']))
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

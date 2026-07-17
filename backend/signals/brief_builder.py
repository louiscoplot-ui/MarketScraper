"""SENTINEL S4 — the morning brief builder (the product).

After the nightly cron has refreshed events → signals → predictions, this
pass builds one brief per opted-in user: their top 5 'new' vendor signals
(scoped to user_suburbs), each with a short narrative, and emails it via
the existing Resend pathway. Every brief row keeps its items JSON so the
"Today" view renders the same content in-app.

Narratives come from the Claude API (model pinned by the handoff spec,
overridable via BRIEF_MODEL env). The prompt is strictly constrained to
the signal's own data — sober tone, 2 sentences max, no invention. The
call is raw HTTP via `requests` (already a dependency — the project rule
is no new deps, so no anthropic SDK). Without ANTHROPIC_API_KEY, or on
any API failure, the narrative falls back to the signal's reason_codes
verbatim — the brief always ships, never fails the cron, never invents.

Opt-in: reuses users.digest_enabled — the same consent as the morning
digest (documented decision D7, docs/sentinel-decisions.md).
"""
import json
import logging
import os
import secrets
from datetime import datetime, timedelta

import requests

import email_brand as brand
from database import get_db
from email_service import _app_url

logger = logging.getLogger(__name__)

BRIEF_MODEL = os.environ.get('BRIEF_MODEL', 'claude-sonnet-4-6')
ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
TOP_N = 5

_SYSTEM = (
    "You write one short narrative line for a real-estate agent's morning "
    "brief in Perth, Western Australia. You are given the ONLY facts you "
    "may use: an address and a list of observed market signals. Write at "
    "most 2 sentences, sober professional tone, no exclamation marks, no "
    "advice on pricing, and NEVER state anything not present in the given "
    "facts. Do not mention that you are an AI. Always write in English, "
    "using Australian real-estate terminology and spelling. Output the "
    "narrative only."
)


def generate_text(system, user_content, max_tokens=200, timeout=20):
    """One guarded Claude text generation. Returns the text, or None on
    missing key / HTTP error / refusal / empty output — callers MUST fall
    back to their static template. Never raises, never invents structure:
    the caller owns validation of what comes back."""
    api_key = (os.environ.get('ANTHROPIC_API_KEY') or '').strip()
    if not api_key:
        return None
    try:
        resp = requests.post(
            ANTHROPIC_URL,
            headers={
                'x-api-key': api_key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            json={
                'model': BRIEF_MODEL,
                'max_tokens': max_tokens,
                'system': system,
                'messages': [{'role': 'user', 'content': user_content}],
            },
            timeout=timeout,
        )
        if resp.status_code != 200:
            logger.warning("claude text API %s: %s",
                           resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        if data.get('stop_reason') == 'refusal':
            return None
        text = ' '.join(
            b.get('text', '') for b in data.get('content', [])
            if b.get('type') == 'text'
        ).strip()
        return text or None
    except Exception:
        logger.exception("claude text call failed")
        return None


def _narrative(address, suburb, reasons):
    """2-sentence narrative for one signal. Falls back to the reasons
    verbatim when the API is unavailable — never raises, never invents."""
    fallback = ' '.join(reasons)[:280]
    text = generate_text(
        _SYSTEM,
        (f"Address: {address}, {suburb}.\n"
         "Observed signals:\n- " + "\n- ".join(reasons)),
        max_tokens=200,
    )
    return text or fallback


def _user_suburb_ids(conn, user):
    if user.get('role') == 'admin' or user.get('all_suburbs'):
        return [dict(r)['id'] for r in conn.execute(
            "SELECT id FROM suburbs WHERE active = 1").fetchall()]
    return [dict(r)['suburb_id'] for r in conn.execute(
        "SELECT suburb_id FROM user_suburbs WHERE user_id = ?",
        (user['id'],)).fetchall()]


def _recent_signal_ids(conn, user_id, days=7):
    """signal_ids already emailed to this user within the last `days` days,
    read from the stored briefs.items JSON. Used to ROTATE the daily
    prospect list so the same addresses don't land every morning. Never
    raises — on any failure we simply don't exclude anything."""
    from time_utils import perth_now
    cutoff = (perth_now().date() - timedelta(days=days)).isoformat()
    ids = set()
    try:
        rows = conn.execute(
            "SELECT items FROM briefs WHERE user_id = ? AND brief_date >= ?",
            (user_id, cutoff)
        ).fetchall()
        for r in rows:
            try:
                for it in json.loads(dict(r).get('items') or '[]'):
                    if it.get('signal_id') is not None:
                        ids.add(it['signal_id'])
            except Exception:
                continue
    except Exception:
        logger.exception("recent signal-id lookup failed (suppressed)")
    return ids


def _top_signals(conn, suburb_ids, limit=TOP_N, exclude_ids=None):
    """Top vendor signals for a suburb set. When exclude_ids is given,
    recently-shown signals are pushed to the back (fresh addresses first),
    then used to backfill only if there aren't enough fresh ones — so the
    agent never receives fewer prospects than the pool actually holds."""
    if not suburb_ids:
        return []
    exclude_ids = set(exclude_ids or ())
    ph = ','.join(['?'] * len(suburb_ids))
    cap = max(limit * 5, limit + len(exclude_ids))
    rows = conn.execute(
        f"SELECT v.id, v.address, v.suburb_id, s.name AS suburb, v.score, "
        f"v.reason_codes FROM vendor_signals v "
        f"LEFT JOIN suburbs s ON s.id = v.suburb_id "
        f"WHERE v.status = 'new' AND v.suburb_id IN ({ph}) "
        f"ORDER BY v.score DESC, v.created_at DESC LIMIT ?",
        list(suburb_ids) + [cap]
    ).fetchall()
    cand = [dict(r) for r in rows]
    fresh = [d for d in cand if d['id'] not in exclude_ids]
    chosen = fresh[:limit]
    if len(chosen) < limit:
        seen = [d for d in cand if d['id'] in exclude_ids]
        chosen += seen[:limit - len(chosen)]
    for d in chosen:
        try:
            d['reason_codes'] = json.loads(d.get('reason_codes') or '[]')
        except Exception:
            d['reason_codes'] = []
    return chosen


def build_items(conn, user, use_ai=True, exclude_recent=False):
    """Assemble (and narrate) the top signals for one user. Pure read —
    used by both the email pass and the on-demand /api/brief/today.

    use_ai=False skips the Claude narrative calls (falls back to the
    reason codes verbatim). The on-demand GET path uses this: up to five
    sequential 20s API calls on a page load could hang the Today view for
    ~100s — the cron keeps the narrated version.

    exclude_recent=True (the nightly email pass) rotates out signals shown
    to this user in the last 7 days so the daily prospect list stays
    fresh; the on-demand Today view leaves it False so it always shows the
    current top signals."""
    exclude = _recent_signal_ids(conn, user['id']) if exclude_recent else None
    signals = _top_signals(conn, _user_suburb_ids(conn, user), exclude_ids=exclude)
    items = []
    for s in signals:
        reasons = s['reason_codes'] or ['New vendor signal']
        narrative = (_narrative(s['address'], s['suburb'], reasons)
                     if use_ai else ' '.join(reasons)[:280])
        items.append({
            'signal_id': s['id'],
            'address': s['address'],
            'suburb': s['suburb'],
            'score': s['score'],
            'reasons': s['reason_codes'],
            'narrative': narrative,
        })
    return items


def prospect_cards_html(items):
    """The prospect cards, without any email chrome — so the combined daily
    email (email_digest.send_daily) can drop them straight into its own
    'Who to prospect today' section."""
    rows = []
    for it in items:
        reasons = ''.join(
            f"<li style='margin:2px 0'>{brand._esc(r)}</li>" for r in it['reasons'])
        rows.append(
            f"<div style='margin:0 0 14px;padding:12px 14px;border:1px solid {brand.HAIR};"
            f"background:#fff;font-family:{brand._SANS};'>"
            f"<div style='font-weight:700;font-size:15px;color:{brand.INK}'>"
            f"{brand._esc(it['address'])}"
            f" <span style='color:{brand.MUTED};font-weight:400'>— {brand._esc(it['suburb'])}"
            f" &middot; score {round((it['score'] or 0) * 100)}</span></div>"
            f"<div style='margin:6px 0;color:#2c3e50;font-family:{brand._SERIF};font-size:15px'>"
            f"{brand._esc(it['narrative'])}</div>"
            f"<ul style='margin:4px 0 0;padding-left:18px;color:#566573;font-size:13px'>"
            f"{reasons}</ul></div>"
        )
    return ''.join(rows)


def prospect_lines_text(items):
    return [f"{it['address']} — {it['suburb']}\n  {it['narrative']}" for it in items]


def persist_brief(conn, user, today, base_url):
    """Build (with rotation), store the daily briefs row, and return
    (items, pixel_url). Idempotent per user+day: if a brief already exists
    for `today` it is reused (parsed back), so re-running the pass — or the
    combined daily email — never double-writes. Returns ([], None) when the
    user has no signals. The stored row is what the in-app Today view reads,
    so this must run even though the email itself is now the combined daily."""
    row = conn.execute(
        "SELECT items, open_token FROM briefs WHERE user_id = ? AND brief_date = ?",
        (user['id'], today)
    ).fetchone()
    if row:
        d = dict(row)
        try:
            items = json.loads(d.get('items') or '[]')
        except Exception:
            items = []
        token = d.get('open_token') or ''
        pixel = f"{base_url}/api/brief/open/{token}.gif" if token else None
        return items, pixel
    items = build_items(conn, user, exclude_recent=True)
    if not items:
        return [], None
    token = secrets.token_urlsafe(24)
    conn.execute(
        "INSERT INTO briefs (user_id, brief_date, items, open_token, sent_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (user['id'], today, json.dumps(items), token, datetime.utcnow().isoformat())
    )
    conn.commit()
    return items, f"{base_url}/api/brief/open/{token}.gif"


def _render_email(user, items, open_pixel_url):
    first = (user.get('first_name') or '').strip() or 'there'
    lead_txt = (f"{len(items)} address{'es' if len(items) != 1 else ''} worth a look "
                f"today — your highest-signal vendor prospects, refreshed each morning.")
    body = (
        brand.kicker_date('Today’s prospects')
        + brand.lead(lead_txt)
        + f"<p style='font-family:{brand._SANS};margin:0 0 12px;color:#5a5a54;font-size:13px'>"
          f"Good morning {brand._esc(first)}.</p>"
        + prospect_cards_html(items)
        + f"<img src='{brand._esc(open_pixel_url)}' width='1' height='1' alt=''/>"
    )
    html = brand.shell('Daily Brief', body, _app_url())
    text = '\n\n'.join(
        f"{it['address']} — {it['suburb']}\n{it['narrative']}" for it in items)
    return html, text


def send_morning_briefs(backend_base_url=None):
    """Build + email one brief per opted-in user. Returns a summary dict;
    never raises. Email is skipped (but the brief row still written, so
    the Today view works) when Resend/EMAIL_FROM aren't configured."""
    summary = {'built': 0, 'sent': 0, 'skipped': 0, 'no_items': 0}
    base = (backend_base_url or os.environ.get('BACKEND_PUBLIC_URL')
            or 'https://marketscraper-backend.onrender.com').rstrip('/')
    conn = get_db()
    try:
        # all_suburbs is REQUIRED here: build_items() checks it to widen
        # scope, and omitting it from the SELECT made every all_suburbs
        # (non-admin full-read) user fall back to their empty explicit
        # assignment — they silently never received a brief.
        users = [dict(r) for r in conn.execute(
            "SELECT id, email, first_name, role, digest_enabled, all_suburbs "
            "FROM users WHERE digest_enabled = 1 "
            "AND email IS NOT NULL AND email <> ''"
        ).fetchall()]
        # Perth date — the cron fires around midnight Perth (16:xx UTC),
        # and a UTC stamp dated the brief 'yesterday': the Today view
        # (which asks for Perth-today) ignored the stored narrated brief
        # and rebuilt a non-narrated one on the fly after 8am Perth.
        from time_utils import perth_now
        today = perth_now().strftime('%Y-%m-%d')
        for user in users:
            existing = conn.execute(
                "SELECT 1 FROM briefs WHERE user_id = ? AND brief_date = ?",
                (user['id'], today)
            ).fetchone()
            if existing:
                summary['skipped'] += 1
                continue
            items = build_items(conn, user, exclude_recent=True)
            if not items:
                summary['no_items'] += 1
                continue
            token = secrets.token_urlsafe(24)
            cur = conn.execute(
                "INSERT INTO briefs (user_id, brief_date, items, open_token, "
                "sent_at) VALUES (?, ?, ?, ?, ?)",
                (user['id'], today, json.dumps(items), token,
                 datetime.utcnow().isoformat())
            )
            conn.commit()
            summary['built'] += 1

            try:
                from email_service import _send, _support_reply_to
                pixel = f"{base}/api/brief/open/{token}.gif"
                html, text = _render_email(user, items, pixel)
                reply_to = _support_reply_to()
                ok, _err = _send(
                    user['email'],
                    f"Morning brief — {len(items)} vendor signal"
                    f"{'s' if len(items) > 1 else ''}",
                    html, text=text,
                    reply_to=reply_to, list_unsubscribe=reply_to,
                )
                if ok:
                    summary['sent'] += 1
            except Exception:
                logger.exception("brief email to user %s failed", user['id'])

        logger.info("morning briefs: %(built)d built, %(sent)d sent, "
                    "%(skipped)d already-sent, %(no_items)d empty", summary)
        return summary
    except Exception:
        conn.rollback()
        logger.exception("brief builder failed")
        summary['error'] = True
        return summary
    finally:
        conn.close()

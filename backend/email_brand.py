"""SuburbDesk email brand system — one visual identity for every cadence.

Every recurring email (daily digest, daily brief, weekly/monthly/quarterly/
annual) is wrapped by shell() so the header (S monogram + SuburbDesk
wordmark + Perth locator + brass rule), the cream paper, the type scale
and the signed footer are identical everywhere. Renderers only produce the
body; they never hand-roll the chrome.

No emojis anywhere — the look is editorial/premium for a high-end Perth
market. Colours and helpers are the single source of truth; change them
here and every email follows.
"""

import logging

logger = logging.getLogger(__name__)

# Palette — deep green primary, warm brass accent, cream paper, ink text.
GREEN = '#2f5545'
BRASS = '#a9854a'
PAPER = '#faf8f4'
INK = '#1c1c1c'
MUTED = '#9a9a90'
HAIR = '#eae6de'          # hairline on paper
OUTER = '#eeeae2'         # page background behind the card

_SANS = "-apple-system,'Segoe UI',Arial,sans-serif"
_SERIF = "Georgia,'Times New Roman',serif"


def _esc(s):
    if s is None:
        return ''
    s = str(s)
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def emblem(size=44, fs=22):
    """The S monogram tile. Rounded on modern clients, square on Outlook —
    both read fine."""
    return (f'<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>'
            f'<td width="{size}" height="{size}" align="center" valign="middle" '
            f'style="background:{GREEN};border-radius:9px;font-family:{_SERIF};'
            f'font-size:{fs}px;font-weight:700;color:{PAPER};line-height:{size}px;">S</td>'
            f'</tr></table>')


def _header(kicker):
    return (
        f'<tr><td style="padding:26px 34px 0;">'
        f'<table width="100%" cellpadding="0" cellspacing="0"><tr>'
        f'<td width="44" valign="middle">{emblem()}</td>'
        f'<td valign="middle" style="padding-left:14px;">'
        f'<div style="font-family:{_SANS};font-size:20px;color:{INK};letter-spacing:.3px;">'
        f'<span style="font-weight:400;">Suburb</span>'
        f'<span style="font-weight:800;color:{GREEN};">Desk</span></div>'
        f'<div style="font-family:{_SANS};font-size:10px;letter-spacing:2px;color:{MUTED};'
        f'text-transform:uppercase;margin-top:2px;">Perth &middot; Western Australia</div>'
        f'</td>'
        f'<td valign="middle" align="right" style="font-family:{_SANS};font-size:11px;'
        f'color:{MUTED};text-transform:uppercase;letter-spacing:1.4px;">{_esc(kicker)}</td>'
        f'</tr></table></td></tr>'
        f'<tr><td style="padding:14px 34px 0;">'
        f'<div style="height:2px;background:{BRASS};width:100%;"></div></td></tr>'
    )


def _footer(suburbs_line):
    sub = (f'Suburbs: {_esc(suburbs_line)}<br>' if suburbs_line else '')
    return (
        f'<tr><td style="padding:22px 34px 26px;">'
        f'<div style="border-top:1px solid {HAIR};padding-top:16px;">'
        f'<table cellpadding="0" cellspacing="0"><tr>'
        f'<td valign="middle">{emblem(26, 13)}</td>'
        f'<td valign="middle" style="padding-left:10px;font-family:{_SANS};font-size:11px;'
        f'color:{MUTED};line-height:1.5;">'
        f'SuburbDesk — real-estate prospecting intelligence<br>{sub}'
        f'Reply to unsubscribe &middot; suburbdesk@gmail.com</td>'
        f'</tr></table></div></td></tr>'
    )


def shell(kicker, body_html, app_url, suburbs_line=None, cta='Open SuburbDesk'):
    """Wrap a body in the full branded document. `kicker` is the small
    upper-right label (e.g. 'Weekly Brief'); `suburbs_line` is a comma
    string shown in the footer."""
    cta_html = (
        f'<tr><td style="padding:4px 34px 0;text-align:center;">'
        f'<a href="{_esc(app_url)}" style="display:inline-block;background:{GREEN};color:#fff;'
        f'padding:12px 30px;text-decoration:none;font-family:{_SANS};font-size:14px;'
        f'font-weight:600;letter-spacing:.3px;">{_esc(cta)}</a></td></tr>'
    ) if cta else ''
    return (
        f'<!DOCTYPE html><html><body style="margin:0;padding:0;background:{OUTER};'
        f'font-family:{_SERIF};color:{INK};">'
        f'<table width="100%" cellpadding="0" cellspacing="0" style="padding:30px 0;">'
        f'<tr><td align="center">'
        f'<table width="600" cellpadding="0" cellspacing="0" '
        f'style="max-width:600px;background:{PAPER};">'
        f'{_header(kicker)}'
        f'<tr><td style="padding:18px 34px 0;">{body_html}</td></tr>'
        f'{cta_html}'
        f'{_footer(suburbs_line)}'
        f'</table></td></tr></table></body></html>'
    )


# --- body building blocks ---------------------------------------------------

def kicker_date(label):
    return (f'<div style="font-family:{_SANS};font-size:11px;text-transform:uppercase;'
            f'letter-spacing:1.5px;color:{MUTED};">{_esc(label)}</div>')


def lead(text):
    """The AI (or fallback) summary paragraph — serif, editorial."""
    return (f'<p style="font-size:18px;line-height:1.55;color:{INK};margin:12px 0 18px;">'
            f'{_esc(text)}</p>')


def numbers_line(parts):
    """parts = [(value, label), …] → '7 withdrawn · 2 price cuts · …'."""
    inner = ' &nbsp;&middot;&nbsp; '.join(
        f'<strong style="color:{INK};">{_esc(v)}</strong> {_esc(l)}' for v, l in parts)
    return (f'<div style="font-family:{_SANS};font-size:13px;color:#5a5a54;'
            f'border-top:1px solid {HAIR};border-bottom:1px solid {HAIR};'
            f'padding:11px 0;margin:0 0 4px;">{inner}</div>')


def focus_block(title, body_html):
    return (
        f'<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr>'
        f'<td width="4" style="background:{BRASS};"></td>'
        f'<td style="background:#f3f0e9;padding:12px 16px;font-family:{_SANS};">'
        f'<div style="font-size:11px;font-weight:700;color:{GREEN};text-transform:uppercase;'
        f'letter-spacing:1.4px;">{_esc(title)}</div>'
        f'<div style="font-size:14px;color:#333;margin-top:5px;">{body_html}</div>'
        f'</td></tr></table>'
    )


def group_header(text):
    return (f'<div style="font-family:{_SANS};font-size:11px;font-weight:700;color:{GREEN};'
            f'text-transform:uppercase;letter-spacing:1.4px;padding-bottom:5px;'
            f'border-bottom:1px solid {HAIR};margin:16px 0 6px;">{_esc(text)}</div>')


def line(main, meta='', right='', right_color=None):
    """One address/event line: bold main, muted meta, optional right value."""
    rc = right_color or INK
    r = (f'<span style="float:right;font-weight:600;color:{rc};">{right}</span>'
         if right else '')
    m = f' <span style="color:{MUTED};">{_esc(meta)}</span>' if meta else ''
    return (f'<div style="font-size:14px;margin:4px 0;color:{INK};font-family:{_SANS};">'
            f'{r}{_esc(main)}{m}</div>')


def section_label(text):
    return (f'<div style="font-family:{_SANS};font-size:12px;font-weight:700;color:{GREEN};'
            f'text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid {HAIR};'
            f'padding-bottom:5px;margin:22px 0 8px;">{_esc(text)}</div>')


# --- plaintext --------------------------------------------------------------

def text_shell(kicker, lead_text, body_lines, suburbs_line, app_url):
    lines = [f"SUBURBDESK — {kicker}", '', lead_text, '']
    lines.extend(body_lines)
    lines.append('')
    if suburbs_line:
        lines.append(f"Suburbs: {suburbs_line}")
    lines.append(f"Open SuburbDesk: {app_url}")
    lines.append('Reply to unsubscribe · SuburbDesk · suburbdesk@gmail.com')
    return '\n'.join(lines)


# --- AI lead ----------------------------------------------------------------

_LEAD_SYSTEM = (
    "You write the opening line of a real-estate agent's market email for "
    "Perth, Western Australia. You are given the ONLY facts you may use. "
    "Write at most 2 sentences, sober professional tone, no exclamation "
    "marks, no emojis, no pricing advice, and NEVER state anything not in "
    "the facts. Australian spelling and real-estate terminology. Output the "
    "summary sentence(s) only."
)


def compose_lead(fact_lines, fallback):
    """One guarded Claude summary sentence from the given facts. Falls back
    to `fallback` (a deterministic sentence built from the same numbers)
    when the API is unavailable or returns nothing — the email always ships
    and never invents."""
    try:
        from signals.brief_builder import generate_text
    except Exception:
        return fallback
    try:
        text = generate_text(
            _LEAD_SYSTEM,
            "Facts:\n- " + "\n- ".join(fact_lines),
            max_tokens=160,
        )
    except Exception:
        logger.exception("compose_lead failed (suppressed)")
        text = None
    return (text or fallback).strip()

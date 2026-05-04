"""SuburbDesk email sending — thin wrapper around the Resend HTTP API.

Reads `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` from the environment.
If `RESEND_API_KEY` isn't set, sends become no-ops with a logged warning
so the app keeps working when Resend hasn't been provisioned yet
(useful for first-time deploys).

Uses urllib only — no extra dependency needed in requirements.txt.

Public surface:
    is_configured() -> bool
    send_welcome_email(user_dict, access_key, inviter_name=None)
        Returns (ok: bool, error: str | None).
"""

import os
import json
import logging

logger = logging.getLogger(__name__)

# Use the `requests` library for the actual HTTP call. urllib's defaults
# (Python-urllib/3.x User-Agent, no Accept-Encoding) trigger Cloudflare's
# bot-protection layer in front of the Resend API and get HTTP 403 with
# "error code: 1010". `requests` sends a saner header set out of the box,
# and we override the User-Agent for good measure.
import requests

RESEND_API_URL = 'https://api.resend.com/emails'
DEFAULT_FROM = 'SuburbDesk <onboarding@resend.dev>'  # Resend sandbox sender
DEFAULT_APP_URL = 'https://suburbdesk.com'


def is_configured():
    """True when we have an API key. Used by the admin route to decide
    whether to surface a 'check your email' or 'copy the key' message."""
    return bool(os.environ.get('RESEND_API_KEY', '').strip())


def _app_url():
    return os.environ.get('APP_URL', DEFAULT_APP_URL).rstrip('/')


def _send(to, subject, html, text=None):
    api_key = os.environ.get('RESEND_API_KEY', '').strip()
    sender = os.environ.get('EMAIL_FROM', DEFAULT_FROM).strip() or DEFAULT_FROM
    if not api_key:
        logger.warning("RESEND_API_KEY not set — email to %s skipped", to)
        return False, 'Resend not configured'

    payload = {
        'from': sender,
        'to': [to] if isinstance(to, str) else list(to),
        'subject': subject,
        'html': html,
    }
    if text:
        payload['text'] = text

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; SuburbDesk/1.0; +https://suburbdesk.com)',
    }
    try:
        resp = requests.post(RESEND_API_URL, headers=headers, json=payload, timeout=15)
        if resp.status_code >= 400:
            logger.error("Resend HTTP %s for %s: %s", resp.status_code, to, resp.text[:300])
            return False, f'Resend rejected the email (HTTP {resp.status_code}): {resp.text[:200]}'
        body = resp.json() if resp.text else {}
        logger.info("Email sent to %s, resend_id=%s", to, body.get('id'))
        return True, None
    except requests.RequestException as e:
        logger.exception("Email send to %s failed", to)
        return False, f'Network error: {e}'


def _welcome_html(user, access_key, inviter_name):
    """Branded HTML email — green band header, prominent access key,
    3-step instructions. Inline CSS only (Gmail strips <style>)."""
    name = (user.get('first_name') or 'there').strip()
    inviter = (inviter_name or 'Your team').strip()
    app = _app_url()
    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:8px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,0.05);">
        <tr><td style="background:#386351;padding:28px 32px;">
          <h1 style="margin:0;color:#fff;font-size:26px;letter-spacing:3px;
                     font-weight:700;">SUBURBDESK</h1>
          <p style="margin:6px 0 0;color:#cfe0d6;font-size:13px;">
            Real-estate prospecting that does the boring work
          </p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 14px;font-size:16px;color:#222;">Hi {name},</p>
          <p style="margin:0 0 18px;color:#444;line-height:1.55;font-size:14px;">
            <strong>{inviter}</strong> has invited you to SuburbDesk —
            the tool that scrapes your suburbs every night, surfaces hot
            vendor leads, and pre-fills your prospecting letters so you can
            spend your time on calls and meetings, not spreadsheets.
          </p>

          <div style="background:#f7f7f7;border-left:4px solid #386351;
                      padding:16px 18px;margin:24px 0;border-radius:4px;">
            <p style="margin:0 0 8px;font-size:11px;color:#888;
                      text-transform:uppercase;letter-spacing:1.2px;
                      font-weight:600;">Your access key</p>
            <code style="display:block;font-family:'Courier New',monospace;
                         font-size:15px;color:#222;word-break:break-all;
                         user-select:all;">{access_key}</code>
          </div>

          <h3 style="margin:28px 0 10px;color:#222;font-size:15px;">
            How to log in
          </h3>
          <ol style="margin:0 0 16px;padding-left:22px;color:#444;
                     line-height:1.8;font-size:14px;">
            <li>Open <a href="{app}" style="color:#386351;font-weight:600;">{app}</a></li>
            <li>Click the <strong>Admin</strong> tab</li>
            <li>Paste the key above into <em>"Your access key"</em>
                → click <strong>Save key</strong></li>
          </ol>

          <p style="margin:24px 0 0;padding:14px 16px;background:#fff8e7;
                    border-radius:4px;color:#7d6608;font-size:13px;
                    line-height:1.5;">
            ⚡ Your session lasts <strong>forever</strong> on this browser
            — no re-login. To switch devices, ask {inviter} for a new key.
          </p>

          <p style="margin:24px 0 0;color:#888;font-size:12px;line-height:1.5;">
            Questions? Just reply to this email and {inviter} will get
            back to you.
          </p>
        </td></tr>
        <tr><td style="background:#fafafa;padding:14px 32px;
                       border-top:1px solid #eee;text-align:center;">
          <p style="margin:0;color:#999;font-size:11px;">
            SuburbDesk · suburbdesk.com
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _welcome_text(user, access_key, inviter_name):
    """Plain-text fallback (deliverability + accessibility)."""
    name = (user.get('first_name') or 'there').strip()
    inviter = (inviter_name or 'Your team').strip()
    app = _app_url()
    return (
        f"Hi {name},\n\n"
        f"{inviter} has invited you to SuburbDesk — the real-estate "
        f"prospecting tool.\n\n"
        f"Your access key:\n  {access_key}\n\n"
        f"How to log in:\n"
        f"  1. Open {app}\n"
        f"  2. Click the Admin tab\n"
        f"  3. Paste the key into 'Your access key' and click Save key\n\n"
        f"Your session lasts forever on this browser. To switch devices, "
        f"ask {inviter} for a new key.\n\n"
        f"Questions? Just reply to this email.\n\n"
        f"— SuburbDesk\n"
    )


def send_welcome_email(user, access_key, inviter_name=None):
    """Send the SuburbDesk welcome email to a freshly-created user."""
    to = (user.get('email') or '').strip()
    if not to or '@' not in to:
        return False, 'Invalid email address'
    subject = f"Welcome to SuburbDesk — your access is ready"
    html = _welcome_html(user, access_key, inviter_name)
    text = _welcome_text(user, access_key, inviter_name)
    return _send(to, subject, html, text=text)


def _login_link(access_key):
    """One-click login URL. Frontend extracts ?key=, stashes it in
    localStorage, and clears the URL via history.replaceState so the
    key isn't visible in the address bar after page load."""
    return f"{_app_url()}/?key={access_key}"


def _login_html(user, access_key):
    name = (user.get('first_name') or 'there').strip()
    link = _login_link(access_key)
    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:8px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,0.05);">
        <tr><td style="background:#386351;padding:28px 32px;">
          <h1 style="margin:0;color:#fff;font-size:26px;letter-spacing:3px;
                     font-weight:700;">SUBURBDESK</h1>
          <p style="margin:6px 0 0;color:#cfe0d6;font-size:13px;">
            Log in
          </p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 14px;font-size:16px;color:#222;">Hi {name},</p>
          <p style="margin:0 0 24px;color:#444;line-height:1.55;font-size:14px;">
            Click the button below to log in to SuburbDesk. The link works
            on any device — once you've clicked it, you stay logged in
            <strong>forever</strong> on that browser.
          </p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="{link}" style="display:inline-block;background:#386351;
               color:#fff;padding:14px 32px;border-radius:6px;
               text-decoration:none;font-weight:600;font-size:15px;">
              Log in to SuburbDesk
            </a>
          </p>
          <p style="margin:24px 0 0;color:#888;font-size:12px;line-height:1.5;
                    word-break:break-all;">
            Or paste this URL into your browser:<br>
            <span style="color:#386351;">{link}</span>
          </p>
          <p style="margin:24px 0 0;padding:14px 16px;background:#fef9e7;
                    border-radius:4px;color:#7d6608;font-size:12px;
                    line-height:1.5;">
            Didn't request this? Ignore the email — your account stays safe.
          </p>
        </td></tr>
        <tr><td style="background:#fafafa;padding:14px 32px;
                       border-top:1px solid #eee;text-align:center;">
          <p style="margin:0;color:#999;font-size:11px;">
            SuburbDesk · suburbdesk.com
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _login_text(user, access_key):
    name = (user.get('first_name') or 'there').strip()
    link = _login_link(access_key)
    return (
        f"Hi {name},\n\n"
        f"Click below to log in to SuburbDesk:\n\n"
        f"  {link}\n\n"
        f"Once clicked you stay logged in forever on this browser.\n"
        f"Didn't request this? Ignore the email.\n\n"
        f"— SuburbDesk\n"
    )


def send_login_link_email(user, access_key):
    """Magic-link login email. Same delivery infra as the welcome mail."""
    to = (user.get('email') or '').strip()
    if not to or '@' not in to:
        return False, 'Invalid email address'
    subject = "Log in to SuburbDesk"
    html = _login_html(user, access_key)
    text = _login_text(user, access_key)
    return _send(to, subject, html, text=text)

"""Lightweight beta-gate auth — HMAC-signed bearer tokens.

Validates against either an email allowlist or a shared access key,
both configurable via env vars. Sessionless: token contains its own
expiry, server stays stateless.

Env vars:
    AUTH_SECRET     — random ≥32-char string for HMAC signing (required
                      in prod; falls back to dev-secret locally)
    ALLOWED_EMAILS  — comma-separated allowlist of email addresses
    ACCESS_KEY      — optional shared key (single string)

Either ALLOWED_EMAILS or ACCESS_KEY must be set in prod, otherwise no
one can log in.
"""

import os
import json
import hmac
import time
import base64
import hashlib
import logging

logger = logging.getLogger(__name__)

_SECRET = os.environ.get('AUTH_SECRET') or 'dev-secret-do-not-use-in-prod'
_ALLOWED_EMAILS = {
    e.strip().lower()
    for e in (os.environ.get('ALLOWED_EMAILS') or '').split(',')
    if e.strip()
}
_ACCESS_KEY = (os.environ.get('ACCESS_KEY') or '').strip()
TOKEN_TTL_DAYS = 30

# Paths reachable without a token: login + healthcheck. CORS preflights
# (OPTIONS) are also bypassed in the Flask before_request hook.
_OPEN_PATHS = {
    '/api/auth/login',
    '/api/auth/me',
    '/api/ping',
}


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode('ascii')


def _b64d(s):
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(body):
    return _b64(hmac.new(_SECRET.encode(), body.encode(), hashlib.sha256).digest())


def issue_token(subject):
    payload = {
        'sub': subject,
        'iat': int(time.time()),
        'exp': int(time.time()) + TOKEN_TTL_DAYS * 86400,
    }
    body = _b64(json.dumps(payload, separators=(',', ':')).encode())
    return f"{body}.{_sign(body)}"


def verify_token(token):
    if not token:
        return None
    try:
        body, sig = token.split('.', 1)
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(body)):
        return None
    try:
        payload = json.loads(_b64d(body))
    except Exception:
        return None
    if int(payload.get('exp', 0)) < int(time.time()):
        return None
    return payload


def login(credential):
    """Validate the supplied credential against the email allowlist or
    the shared access key. Returns a token on match, None otherwise."""
    s = (credential or '').strip()
    if not s:
        return None
    if _ACCESS_KEY and hmac.compare_digest(s, _ACCESS_KEY):
        return issue_token('shared-key')
    e = s.lower()
    if e in _ALLOWED_EMAILS:
        return issue_token(e)
    return None


def is_open_path(path):
    return path in _OPEN_PATHS


def auth_configured():
    return bool(_ALLOWED_EMAILS or _ACCESS_KEY)

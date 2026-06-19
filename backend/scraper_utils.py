"""Shared scraper constants + URL helpers — extracted from scraper.py
to keep modules under the MCP push size limit."""

import os
import random
import re
from urllib.parse import urlparse


REIWA_BASE = "https://reiwa.com.au"
MAX_PAGES = 50
# Rotate across realistic Chrome/Safari UAs. A single static Playwright
# UA coming from the GHA runner IP is an easy fingerprint; picking one
# per run breaks the trivial signature without affecting page rendering.
USER_AGENTS = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)


def pick_user_agent():
    return random.choice(USER_AGENTS)


# Sent on every request so the headless context advertises the headers a
# real browser does — Chromium's bare defaults are missing Accept-Language
# and a sensible Accept, which is a known headless fingerprint.
EXTRA_HTTP_HEADERS = {
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': ('text/html,application/xhtml+xml,application/xml;q=0.9,'
               'image/avif,image/webp,*/*;q=0.8'),
}

# Backwards-compat: any caller still importing `UA` gets a valid string.
# New call sites pass `user_agent=pick_user_agent()` to new_context().
UA = USER_AGENTS[0]
DETAIL_TABS = 3  # concurrent detail page tabs

CHROMIUM_PATH = os.environ.get(
    'CHROMIUM_PATH',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
)
if not os.path.exists(CHROMIUM_PATH):
    CHROMIUM_PATH = None


def normalize_reiwa_url(url):
    """Single source of truth for REIWA listing URL comparison and
    storage. Strips trailing slash and any query / fragment so the
    same listing always hashes to the same string regardless of
    where it came from (card link, JS extract, orphan rescue, DB
    read). Returns '' for falsy input — callers can safely compare
    `if normalize_reiwa_url(a) == normalize_reiwa_url(b)`.

    Previously the strip-trailing-slash convention was duplicated
    across upsert_listing, get_existing_urls, clean_listing_url and
    scraper.py — any new code path that forgot a .rstrip('/') (or
    a different .strip() shape) caused the URL to not match the DB
    and the listing was treated as "new" forever, blowing the
    detail-fetch budget on already-scraped pages."""
    if not url:
        return ''
    s = str(url).strip()
    # Drop query + fragment without re-parsing — REIWA listing URLs
    # are static, never query-string-keyed, so anything after ? or #
    # is tracking junk that varies between page loads.
    for sep in ('?', '#'):
        idx = s.find(sep)
        if idx != -1:
            s = s[:idx]
    return s.rstrip('/')


def clean_listing_url(href):
    """Return canonical listing URL (no query params, no trailing slash),
    or None if not a listing. Built on top of normalize_reiwa_url so
    every code path converges on the same string for the same URL."""
    if not href:
        return None
    full = ("https://reiwa.com.au" + href) if href.startswith("/") else href
    parsed = urlparse(full)
    path = parsed.path
    if not re.search(r"-\d{5,8}/?$", path):
        return None
    return normalize_reiwa_url("https://reiwa.com.au" + path)


def build_url(suburb_slug, page=1):
    u = f"{REIWA_BASE}/for-sale/{suburb_slug}/?includesurroundingsuburbs=false&sortby=listdate"
    return u if page == 1 else u + f"&page={page}"


def build_sold_url(suburb_slug, page=1):
    u = f"{REIWA_BASE}/sold/{suburb_slug}/?includesurroundingsuburbs=false&sortby=default"
    return u if page == 1 else u + f"&page={page}"


def listing_id(url):
    m = re.search(r"-(\d{5,8})/?$", url or "")
    return m.group(1) if m else ""


def normalise_agency(a):
    if not a:
        return a
    if re.search(r"acton.*belle|belle.*acton|acton\s*[|]\s*belle", a, re.I):
        return "Acton | Belle Property Dalkeith | Cottesloe"
    return a


# Backwards-compat aliases for any caller still using the underscore-prefixed names
_clean_listing_url = clean_listing_url
_build_url = build_url
_build_sold_url = build_sold_url
_listing_id = listing_id
_normalise_agency = normalise_agency


def get_scrape_proxy():
    """Playwright proxy dict from the SCRAPE_PROXY env var, or None.

    REIWA sits behind Cloudflare, which challenges datacenter IPs (Render,
    GitHub Actions). Routing through a residential proxy (IPRoyal) is what
    gets past it — proven via probe: an AU residential exit returns the
    real listing grid (HTTP 200, 114 cards) where the bare datacenter IP
    gets the "Just a moment" challenge.

    SCRAPE_PROXY format: http://USERNAME:PASSWORD@geo.iproyal.com:12321
    IPRoyal targeting params go on the PASSWORD; we append `_country-au`
    (the format that passed) unless the password already carries a
    `_country-` param. Returns None when unset so local dev / a
    residential laptop runs direct without a proxy.
    """
    raw = (os.environ.get('SCRAPE_PROXY') or '').strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if not parsed.hostname:
        return None
    proxy = {'server': f"{parsed.scheme or 'http'}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        proxy['username'] = parsed.username
    if parsed.password:
        pw = parsed.password
        if '_country-' not in pw:
            pw = pw + '_country-au'
        proxy['password'] = pw
    return proxy


# --- Bandwidth control for the residential proxy (billed per GB) ---------
# Block heavy asset types AND every third-party host. REIWA's pages drag a
# lot of weight that the parser never reads — analytics, ad networks, map
# tiles, web fonts, chat widgets, social embeds. We allow only requests
# whose host belongs to REIWA itself (so the listing grid's own JS/XHR
# still loads) plus Cloudflare (so a challenge can still solve when one is
# served). Everything else is aborted. This cut the per-page transfer
# dramatically vs the image-only block.
_HEAVY_RESOURCE_TYPES = ('image', 'media', 'font', 'stylesheet')
_PROXY_ALLOWED_HOSTS = ('reiwa', 'cloudflare', 'cf-')


def _should_abort_request(request):
    if request.resource_type in _HEAVY_RESOURCE_TYPES:
        return True
    try:
        host = (urlparse(request.url).hostname or '').lower()
    except Exception:
        return False
    return not any(tok in host for tok in _PROXY_ALLOWED_HOSTS)


def route_filter(route):
    """Playwright route handler — abort heavy/third-party requests, let
    REIWA's own traffic through. Use everywhere we open a scraping page:
        page.route("**/*", route_filter)
    """
    try:
        if _should_abort_request(route.request):
            route.abort()
        else:
            route.continue_()
    except Exception:
        try:
            route.continue_()
        except Exception:
            pass



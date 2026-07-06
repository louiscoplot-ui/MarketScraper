"""Shared scraper constants + URL helpers — extracted from scraper.py
to keep modules under the MCP push size limit."""

import logging
import os
import random
import re
import threading
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


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


# --- In-run cache for REIWA's static JS bundles ---------------------------
# page.route() interception disables Chromium's own HTTP cache, so the same
# ~1.7MB of script bundles was re-downloaded on EVERY page — through the
# billed residential proxy that's ~70% of the nightly GB bill. Cache the
# bundles in memory for the life of the process (one nightly run covers all
# suburbs): first request fetches and stores, every later page is served
# locally with zero network traffic.
# Keyed by full URL — REIWA fingerprints bundle URLs, so a mid-run deploy
# changes the URL and misses the cache instead of serving a stale script.
# Only reiwa-hosted GET scripts are cached: Cloudflare challenge scripts can
# be per-request/per-visitor and MUST stay live, and XHR/fetch responses
# carry listing data that differs per page.
_ASSET_CACHE = {}
_ASSET_CACHE_LOCK = threading.Lock()
_ASSET_CACHE_MAX_ENTRIES = 64
_ASSET_CACHE_STATS = {'hits': 0, 'bytes_saved': 0}


def _is_cacheable(request):
    if request.resource_type != 'script' or request.method != 'GET':
        return False
    try:
        host = (urlparse(request.url).hostname or '').lower()
    except Exception:
        return False
    return 'reiwa' in host


def asset_cache_stats():
    """Snapshot of cache effectiveness for end-of-suburb logging."""
    with _ASSET_CACHE_LOCK:
        return {'entries': len(_ASSET_CACHE),
                'hits': _ASSET_CACHE_STATS['hits'],
                'mb_saved': round(_ASSET_CACHE_STATS['bytes_saved'] / 1e6, 1)}


def route_filter(route):
    """Playwright route handler — abort heavy/third-party requests, serve
    REIWA's static JS from the in-run cache, let everything else through.
    Use everywhere we open a scraping page:
        page.route("**/*", route_filter)
    Any error falls back to continue_() so a cache bug can never block a
    page load — worst case we just pay the bandwidth like before.
    """
    try:
        req = route.request
        if _should_abort_request(req):
            route.abort()
            return
        if _is_cacheable(req):
            with _ASSET_CACHE_LOCK:
                hit = _ASSET_CACHE.get(req.url)
            if hit is not None:
                body, ctype = hit
                with _ASSET_CACHE_LOCK:
                    _ASSET_CACHE_STATS['hits'] += 1
                    _ASSET_CACHE_STATS['bytes_saved'] += len(body)
                route.fulfill(status=200, body=body, content_type=ctype)
                return
            resp = route.fetch()
            body = resp.body()
            if resp.status == 200 and body:
                with _ASSET_CACHE_LOCK:
                    if len(_ASSET_CACHE) < _ASSET_CACHE_MAX_ENTRIES:
                        _ASSET_CACHE[req.url] = (
                            body,
                            resp.headers.get('content-type',
                                             'application/javascript'),
                        )
            route.fulfill(response=resp)
            return
        route.continue_()
    except Exception:
        try:
            route.continue_()
        except Exception:
            pass


# --- Direct-first proxy escalation ----------------------------------------
# The residential proxy is billed per GB, but a probe on 02/07 showed the
# bare datacenter IP getting the real listing grid (Cloudflare not
# challenging). So each nightly run now STARTS without the proxy; the first
# suburb that hits a challenge/block flips this process-wide flag and every
# scrape from then on (including the retry of that suburb) goes through the
# proxy — exactly the behaviour we had before, just not paid for upfront.
_PROXY_MODE = {'forced': False}


def proxy_forced():
    return _PROXY_MODE['forced']


def force_proxy(reason=''):
    if not _PROXY_MODE['forced']:
        _PROXY_MODE['forced'] = True
        # Drop cached bundles fetched on the direct connection — if the
        # block was mid-deploy weirdness rather than Cloudflare, a stale
        # bundle must not poison the proxy retry.
        with _ASSET_CACHE_LOCK:
            _ASSET_CACHE.clear()
        logger.warning(f"Escalating to residential proxy: {reason}")


_CHALLENGE_TITLES = ('just a moment', 'attention required', 'access denied')


def looks_like_challenge(page):
    """True when the current page is a Cloudflare interstitial rather than
    a REIWA page — the reliable tell is the tab title."""
    try:
        title = (page.title() or '').lower()
    except Exception:
        return False
    return any(t in title for t in _CHALLENGE_TITLES)


# --- Address quality helpers --------------------------------------------
# REIWA withholds the street address on some listings ("Address available
# on application"); the grid card then only yields the suburb or a street
# name with no number, while the listing's own detail page shows the full
# address once it's disclosed. These helpers let us (a) prefer a real
# disclosed address over a placeholder/partial one and (b) never overwrite
# a real address with a placeholder.
_ADDR_PLACEHOLDERS = (
    'address not disclosed', 'address available on application',
    'address available on request', 'address on application',
    'address on request', 'address available', 'on application',
    'address withheld', 'contact agent', 'no address',
)


def is_real_address(addr):
    """True when `addr` looks like a real, disclosed street address —
    i.e. non-empty, not a 'withheld' placeholder, and containing a street
    number (a digit). A street-only ("Jarrad Street") or suburb-only
    ("Cottesloe") value returns False so it can be re-fetched/replaced."""
    a = (addr or '').strip()
    if not a:
        return False
    low = a.lower()
    if any(p in low for p in _ADDR_PLACEHOLDERS):
        return False
    return any(ch.isdigit() for ch in a)


def better_address(old, new):
    """Pick the more complete of two addresses. A real disclosed address
    always wins over a placeholder/partial one. When neither is real,
    keep a longer non-empty value over a shorter one, else keep `old`.
    Guarantees we never downgrade a real address to a placeholder."""
    old_s = (old or '').strip()
    new_s = (new or '').strip()
    if is_real_address(new_s) and not is_real_address(old_s):
        return new_s
    if is_real_address(old_s) and not is_real_address(new_s):
        return old_s
    if is_real_address(new_s) and is_real_address(old_s):
        # Both real — keep the longer (usually fuller: number + street +
        # suburb + postcode) so we trend toward the most complete form.
        return new_s if len(new_s) > len(old_s) else old_s
    # Neither real: prefer any non-empty, longer string; fall back to old.
    if new_s and len(new_s) > len(old_s):
        return new_s
    return old_s or new_s



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


def clean_listing_url(href):
    """Return canonical listing URL (no query params, no trailing slash),
    or None if not a listing."""
    if not href:
        return None
    full = ("https://reiwa.com.au" + href) if href.startswith("/") else href
    parsed = urlparse(full)
    path = parsed.path
    if not re.search(r"-\d{5,8}/?$", path):
        return None
    return "https://reiwa.com.au" + path.rstrip("/")


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

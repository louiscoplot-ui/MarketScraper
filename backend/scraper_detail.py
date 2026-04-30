"""Detail-page scraper — visits an individual REIWA listing page to fill
in fields the grid card omits (sizes, exact price, status). Also hosts the
verify_disappeared_listings + debug_detail entry points used by the cron and
admin debug routes. Extracted from scraper.py."""

import re
import logging

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

from scraper_utils import UA, CHROMIUM_PATH, normalise_agency
from scraper_dates import parse_date_text, parse_date_relaxed

logger = logging.getLogger(__name__)


def fetch_detail(page, url):
    """Visit listing detail page for sizes and under_offer status."""
    out = {"land_size": "", "internal_size": "", "price_text": "", "status": None,
           "listing_date": "", "address": "", "agency": "", "agent": "",
           "bedrooms": None, "bathrooms": None, "parking": None, "listing_type": ""}
    if not url:
        return out

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=20000)
        try:
            page.wait_for_function(
                "document.body && /landsize|land\\s+size|floor\\s+area|internal|bedroom/i"
                ".test(document.body.innerText)",
                timeout=6000,
            )
        except Exception:
            pass
        try:
            page.evaluate("window.scrollTo(0, 600)")
        except Exception:
            pass
        page.wait_for_timeout(1500)
        html = page.content()
        soup = BeautifulSoup(html, "html.parser")

        STATUS_CLASSES = ["status", "badge", "banner", "label", "tag", "ribbon", "flag",
                          "pill", "listing-status", "property-status", "listing__status", "p-status"]

        is_sold = False
        is_under_offer = False

        for el in soup.find_all(["span", "div", "p", "strong", "h1", "h2", "h3"], class_=True):
            cls = " ".join(el.get("class", []))
            if not any(k in cls for k in STATUS_CLASSES):
                continue
            txt = el.get_text(strip=True).lower()
            if txt == "sold":
                is_sold = True
                break
            if "under offer" in txt:
                is_under_offer = True

        if not is_sold and not is_under_offer:
            header = (
                soup.find("div", class_=re.compile(r"listing-header|property-header|p-header", re.I))
                or soup.find("section", class_=re.compile(r"listing|property|detail", re.I))
                or soup.find("header")
            )
            if header and re.search(r"\bunder\s+offer\b",
                                    header.get_text(" ", strip=True)[:800], re.I):
                is_under_offer = True

        if not is_sold and not is_under_offer:
            main = soup.find("main")
            if main and re.search(r"\bunder\s+offer\b",
                                  main.get_text(" ", strip=True)[:1500], re.I):
                is_under_offer = True

        if is_sold:
            out["status"] = "sold"
        elif is_under_offer:
            out["status"] = "under_offer"

        t = re.sub(r"m\s+2|sqm|sq\.?\s*m", "m2", soup.get_text(" ", strip=True), flags=re.I)

        for pat in [r"landsize\s*([\d,]+)\s*m", r"land\s*(?:size|area)[^\d]{0,10}([\d,]+)\s*m",
                    r"([\d,]+)\s*m2\s*(?:land|block|lot)"]:
            m = re.search(pat, t, re.I)
            if m:
                try:
                    v = int(m.group(1).replace(",", ""))
                    if 10 <= v <= 100000:
                        out["land_size"] = f"{v} m²"
                        break
                except ValueError:
                    pass

        for pat in [r"floor\s*area\s*([\d,]+)\s*m", r"internal\s*(?:size|area)[^\d]{0,10}([\d,]+)\s*m",
                    r"strata\s*(?:total\s*)?area[:\s]*([\d,]+)\s*m",
                    r"([\d,]+)\s*m2\s*(?:internal|living|floor|strata)"]:
            m = re.search(pat, t, re.I)
            if m:
                try:
                    v = int(m.group(1).replace(",", ""))
                    if 10 <= v <= 50000:
                        out["internal_size"] = f"{v} m²"
                        break
                except ValueError:
                    pass

        head = t[:800]
        TEXT_PRICE_RE = re.compile(
            r"(?:offers?\s+clos(?:e|ing)[^.\n]{0,40})"
            r"|(?:bids?\s+clos(?:e|ing)[^.\n]{0,40})"
            r"|(?:contact\s+(?:agent|the\s+agent|\w+))"
            r"|(?:call\s+\w+)"
            r"|(?:expressions?\s+of\s+interest)"
            r"|(?:\beoi\b)"
            r"|(?:all\s+offers(?:\s+presented)?)"
            r"|(?:best\s+offers?)"
            r"|(?:by\s+negotiation)"
            r"|(?:under\s+instructions)"
            r"|(?:price\s+(?:on\s+application|guide))"
            r"|(?:\bauction\b)",
            re.I,
        )
        m = re.search(
            r"((?:offers?\s+|mid\s+|early\s+|late\s+|high\s+|low\s+|new\s+price\s*-?\s*|from\s+|over\s+|above\s+|around\s+)?"
            r"\$\d+(?:,\d{3})*(?:\.\d+)?\s*[MmKk]?(?:[a-z]{0,8})?)",
            head, re.I,
        )
        if m:
            candidate = m.group(1).strip()
            digits = re.sub(r"[^\d.MmKk]", "", candidate)
            if digits and ("m" in digits.lower() or
                           (re.fullmatch(r"[\d.]+", digits) and float(digits) >= 100)):
                out["price_text"] = candidate
        if not out["price_text"]:
            m = TEXT_PRICE_RE.search(head)
            if m:
                out["price_text"] = m.group(0).strip()[:120]

        # Listing date — try strict prefix-based parser first (covers
        # "Listed 3 weeks ago" etc.). If REIWA doesn't include the prefix,
        # fall back to the relaxed parser on a tighter slice (header only).
        out["listing_date"] = parse_date_text(t[:1500])
        if not out["listing_date"]:
            out["listing_date"] = parse_date_relaxed(t[:800])

        addr_el = soup.find("h2", class_="p-details__add") or soup.find("h1")
        if addr_el:
            out["address"] = addr_el.get_text(strip=True)

        logo = soup.find("a", class_="agent__logo")
        if logo:
            sr = logo.find("span", class_="u-sr-only")
            if sr:
                out["agency"] = normalise_agency(sr.get_text(strip=True))

        nd = soup.find("div", class_="agent__name")
        if nd:
            a = nd.find("a", class_="-ignore-theme")
            if a:
                out["agent"] = a.get_text(strip=True)

        nums = [s.get_text(strip=True) for s in soup.find_all("span", class_="u-grey-dark")
                if s.get_text(strip=True).isdigit()]
        if len(nums) > 0:
            out["bedrooms"] = int(nums[0])
        if len(nums) > 1:
            out["bathrooms"] = int(nums[1])
        if len(nums) > 2:
            out["parking"] = int(nums[2])

        page_text = soup.get_text(" ", strip=True)
        for pt in ["House", "Unit", "Apartment", "Townhouse", "Villa", "Studio",
                    "Duplex", "Terrace", "Land", "Rural"]:
            if re.search(r"\b" + pt + r"\b", page_text[:2000], re.I):
                out["listing_type"] = pt
                break

    except Exception as e:
        logger.warning(f"Detail error {url}: {e}")

    return out


def fetch_details_batch(detail_pages, listings):
    """Fetch detail pages for a batch of listings using multiple tabs round-robin."""
    if not listings:
        return []

    results = []
    for i, rec in enumerate(listings):
        tab = detail_pages[i % len(detail_pages)]
        detail = fetch_detail(tab, rec['url'])

        if detail['land_size'] and not rec['land_size']:
            rec['land_size'] = detail['land_size']
        if detail['internal_size'] and not rec['internal_size']:
            rec['internal_size'] = detail['internal_size']
        if detail['price_text'] and not rec['price_text']:
            rec['price_text'] = detail['price_text']
        if detail['listing_date'] and not rec.get('listing_date'):
            rec['listing_date'] = detail['listing_date']
        if detail['status'] == 'under_offer':
            rec['status'] = 'under_offer'

        results.append(rec)

    return results


def verify_disappeared_listings(urls):
    """For each URL, visit its detail page and report what REIWA actually says.

    Used to rescue listings about to be marked withdrawn just because they fell
    off the for-sale grid + weren't in the first N sold pages. The detail page
    is the source of truth — if REIWA still shows it as Sold or Under Offer
    there, we should NOT mark withdrawn.

    Returns dict {url: status} where status is one of:
        'sold' | 'under_offer' | 'active' | 'gone'
    'gone' = the page returned no usable data → safe to mark withdrawn.
    """
    out = {}
    if not urls:
        return out
    with sync_playwright() as p:
        launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
        if CHROMIUM_PATH:
            launch_opts['executable_path'] = CHROMIUM_PATH
        browser = p.chromium.launch(**launch_opts)
        context = browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800},
                                      locale='en-AU')
        page = context.new_page()
        page.route("**/*", lambda route: route.abort()
                   if route.request.resource_type in ("image", "media", "font", "stylesheet")
                   else route.continue_())
        for url in urls:
            try:
                detail = fetch_detail(page, url)
                status = detail.get('status')
                if status in ('sold', 'under_offer'):
                    out[url] = status
                else:
                    has_content = bool(detail.get('address') or detail.get('agent')
                                       or detail.get('agency') or detail.get('bedrooms'))
                    out[url] = 'active' if has_content else 'gone'
            except Exception as e:
                logger.warning(f"verify {url}: {e}")
                out[url] = 'gone'
        browser.close()
    return out


def debug_detail(url):
    """Diagnose what fetch_detail sees on a single listing URL.

    Returns the extracted fields plus raw text snippets around the size labels
    so we can tell whether the regex failed, the page never rendered, or the
    data simply isn't published.
    """
    out = {'url': url, 'extracted': {}, 'text_length': 0,
           'snippets': {}, 'regex_matches': {}, 'error': None}
    try:
        with sync_playwright() as p:
            launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
            if CHROMIUM_PATH:
                launch_opts['executable_path'] = CHROMIUM_PATH
            browser = p.chromium.launch(**launch_opts)
            context = browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800},
                                          locale='en-AU')
            page = context.new_page()

            out['extracted'] = fetch_detail(page, url)

            html = page.content()
            soup = BeautifulSoup(html, "html.parser")
            raw = soup.get_text(" ", strip=True)
            t = re.sub(r"m\s+2|sqm|sq\.?\s*m", "m2", raw, flags=re.I)
            out['text_length'] = len(t)

            for kw in ['landsize', 'land size', 'floor area', 'internal', 'strata',
                       'added ', 'listed ', 'posted ', 'days ago', 'weeks ago', 'hours ago']:
                idx = t.lower().find(kw)
                if idx >= 0:
                    out['snippets'][kw] = t[max(0, idx - 30): idx + 120]

            land_patterns = [r"landsize\s*([\d,]+)\s*m",
                             r"land\s*(?:size|area)[^\d]{0,10}([\d,]+)\s*m",
                             r"([\d,]+)\s*m2\s*(?:land|block|lot)"]
            internal_patterns = [r"floor\s*area\s*([\d,]+)\s*m",
                                 r"internal\s*(?:size|area)[^\d]{0,10}([\d,]+)\s*m",
                                 r"strata\s*(?:total\s*)?area[:\s]*([\d,]+)\s*m",
                                 r"([\d,]+)\s*m2\s*(?:internal|living|floor|strata)"]
            out['regex_matches']['land'] = []
            for pat in land_patterns:
                m = re.search(pat, t, re.I)
                out['regex_matches']['land'].append({
                    'pattern': pat,
                    'match': m.group(0) if m else None,
                    'value': m.group(1) if m else None,
                })
            out['regex_matches']['internal'] = []
            for pat in internal_patterns:
                m = re.search(pat, t, re.I)
                out['regex_matches']['internal'].append({
                    'pattern': pat,
                    'match': m.group(0) if m else None,
                    'value': m.group(1) if m else None,
                })

            browser.close()
    except Exception as e:
        out['error'] = str(e)
    return out


_fetch_detail = fetch_detail
_fetch_details_batch = fetch_details_batch

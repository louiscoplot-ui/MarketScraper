"""Detail-page scraper — visits an individual REIWA listing page to fill
in fields the grid card omits (sizes, exact price, status). Also hosts the
verify_disappeared_listings + debug_detail entry points used by the cron and
admin debug routes. Extracted from scraper.py."""

import re
import logging
from datetime import datetime

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

from scraper_utils import UA, CHROMIUM_PATH, normalise_agency, get_scrape_proxy, route_filter
from scraper_dates import parse_date_text, parse_date_relaxed

logger = logging.getLogger(__name__)


def fetch_detail(page, url):
    """Visit listing detail page for sizes and under_offer status.

    Uses 2 attempts at 35s timeout. On Render free tier the round-trip
    to REIWA AU + DOM build genuinely runs 18-30s during peak; the
    previous single-shot 20s tripped routinely and silently returned
    empty data, which fed the cascade-withdraw bug. 35s + 1 retry
    covers the worst case without dragging total scrape time up too
    much (verify pass remains ~5-10s per URL on warm runs)."""
    out = {"land_size": "", "internal_size": "", "price_text": "", "status": None,
           "listing_date": "", "address": "", "agency": "", "agent": "",
           "bedrooms": None, "bathrooms": None, "parking": None, "listing_type": ""}
    if not url:
        return out

    last_exc = None
    for attempt in range(1, 3):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=35000)
            last_exc = None
            break
        except Exception as e:
            last_exc = e
            if attempt < 2:
                logger.info(f"Detail retry {attempt} for {url}: {e}")
                continue
    if last_exc is not None:
        logger.warning(f"Detail error {url}: {last_exc}")
        return out

    try:
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
        # 800ms (was 1500) covers REIWA's late-load of sizes/agent
        # info after the scroll without sitting idle. Saves ~14s on
        # a 20-listing batch.
        page.wait_for_timeout(800)
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

        # Sold-page detail block — REIWA shows "Last Sold on 10 Apr 2026
        # for $4,450,000" once status flips to sold. We extract the
        # numeric price + the date so the Pipeline can show the real
        # transaction price instead of the original asking price.
        # Anchored to the "Last Sold on" / "Sold on" / "Sold for" wording
        # so we don't accidentally pick up advertised guide prices that
        # share the dollar shape elsewhere on the page.
        if is_sold:
            sold_text = soup.get_text(" ", strip=True)
            sold_m = re.search(
                r"(?:last\s+sold|sold)\s+(?:on\s+)?"
                r"(\d{1,2}\s+[A-Za-z]+\s+\d{4})"
                r"(?:[^$\n]{0,40}for\s+)?"
                r"\$\s*([\d,]+(?:\.\d+)?)\s*([MmKk])?",
                sold_text,
                re.I,
            )
            if sold_m:
                date_str, num_str, suffix = sold_m.group(1), sold_m.group(2), sold_m.group(3)
                try:
                    val = float(num_str.replace(",", ""))
                    if suffix and suffix.lower() == "m":
                        val *= 1_000_000
                    elif suffix and suffix.lower() == "k":
                        val *= 1_000
                    if val >= 100_000:
                        # Store as plain integer string for the TEXT column.
                        out["sold_price"] = str(int(round(val)))
                except ValueError:
                    pass
                # Normalize "10 Apr 2026" → ISO "2026-04-10" so callers
                # don't have to multi-format-parse later.
                try:
                    parsed = datetime.strptime(date_str, "%d %b %Y")
                    out["sold_date"] = parsed.strftime("%Y-%m-%d")
                except ValueError:
                    try:
                        parsed = datetime.strptime(date_str, "%d %B %Y")
                        out["sold_date"] = parsed.strftime("%Y-%m-%d")
                    except ValueError:
                        pass

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


def fetch_details_batch(detail_pages, listings, cancel_check=None,
                        progress_callback=None, progress_prefix=''):
    """Fetch detail pages sequentially through the tab pool (round-robin).

    Was parallelised across 3 tabs via ThreadPoolExecutor (commit
    35b4a46) but that triggered ERR_ABORTED from REIWA — 3 concurrent
    detail-page requests from the same Render IP get rate-limited /
    actively aborted. Sequential is slower wall-time-wise but actually
    completes, which is what matters.

    progress_callback fires BEFORE each fetch so the modal shows
    movement instead of sitting on "20 new, 0 known". cancel_check is
    honoured between each fetch."""
    if not listings:
        return []

    results = []
    total = len(listings)
    for i, rec in enumerate(listings):
        if cancel_check and cancel_check():
            break
        if progress_callback:
            progress_callback(f'{progress_prefix}Fetching detail {i + 1}/{total}…')
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

    Returns dict {url: {status, sold_price, sold_date}} where status is
    one of: 'sold' | 'under_offer' | 'gone'.
        'gone'        = not sold/under-offer AND already absent from REIWA's
                        for-sale grid → no longer listed, safe to withdraw.
                        (We do NOT return 'active' on a still-rendering detail
                        page: REIWA leaves withdrawn listings' pages online, so
                        that would rescue them back to active forever.)
        sold_price    = transaction price string (digits only, "4450000")
                        when status == 'sold' AND REIWA's "Last Sold on
                        DD MMM YYYY for $X" block was parseable; else None
        sold_date     = ISO date "YYYY-MM-DD" from same block; else None
    """
    out = {}
    if not urls:
        return out
    with sync_playwright() as p:
        launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
        if CHROMIUM_PATH:
            launch_opts['executable_path'] = CHROMIUM_PATH
        _proxy = get_scrape_proxy()
        if _proxy:
            launch_opts['proxy'] = _proxy
        browser = p.chromium.launch(**launch_opts)
        context = browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800},
                                      locale='en-AU')
        page = context.new_page()
        page.route("**/*", route_filter)
        for url in urls:
            try:
                detail = fetch_detail(page, url)
                status = detail.get('status')
                if status in ('sold', 'under_offer'):
                    resolved = status
                else:
                    # Absent from REIWA's for-sale grid AND no sold/under-offer
                    # badge on the detail page → no longer for sale. REIWA keeps
                    # withdrawn listings' detail pages live (address/agent still
                    # render), so "has content" is NOT proof it is still listed
                    # — the for-sale grid is the source of truth. Resolve 'gone'
                    # so the coverage-gated withdraw sweep can flip it.
                    # Previously this returned 'active' on any content, which
                    # rescued every withdrawn listing straight back to active →
                    # counts drifted above REIWA's real total and withdrawn
                    # stayed 0 every night (e.g. Cottesloe 50 vs 43).
                    resolved = 'gone'
                out[url] = {
                    'status': resolved,
                    'sold_price': detail.get('sold_price') or None,
                    'sold_date': detail.get('sold_date') or None,
                }
            except Exception as e:
                logger.warning(f"verify {url}: {e}")
                out[url] = {'status': 'gone', 'sold_price': None, 'sold_date': None}
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
            _proxy = get_scrape_proxy()
            if _proxy:
                launch_opts['proxy'] = _proxy
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

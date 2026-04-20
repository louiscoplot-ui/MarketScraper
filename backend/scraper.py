import re
import time
import random
import logging
import os
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

REIWA_BASE = "https://reiwa.com.au"
MAX_PAGES = 50
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
DETAIL_TABS = 3  # Number of concurrent detail page tabs

CHROMIUM_PATH = os.environ.get('CHROMIUM_PATH', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
if not os.path.exists(CHROMIUM_PATH):
    CHROMIUM_PATH = None


def _clean_listing_url(href):
    """Return canonical listing URL (no query params, no trailing slash), or None if not a listing."""
    if not href:
        return None
    full = ("https://reiwa.com.au" + href) if href.startswith("/") else href
    parsed = urlparse(full)
    path = parsed.path  # strips query string and fragment
    if not re.search(r"-\d{5,8}/?$", path):
        return None
    return "https://reiwa.com.au" + path.rstrip("/")


def _build_url(suburb_slug, page=1):
    u = f"{REIWA_BASE}/for-sale/{suburb_slug}/?includesurroundingsuburbs=false&sortby=listdate"
    return u if page == 1 else u + f"&page={page}"


def _build_sold_url(suburb_slug, page=1):
    u = f"{REIWA_BASE}/sold/{suburb_slug}/?includesurroundingsuburbs=false&sortby=default"
    return u if page == 1 else u + f"&page={page}"


def _listing_id(url):
    m = re.search(r"-(\d{5,8})/?$", url or "")
    return m.group(1) if m else ""


def _parse_date_text(text):
    if not text:
        return ""
    today = datetime.now()
    if re.search(r"added\s+today", text, re.I):
        return today.strftime("%d/%m/%Y")
    if re.search(r"added\s+yesterday", text, re.I):
        return (today - timedelta(days=1)).strftime("%d/%m/%Y")
    m = re.search(r"added\s+(\d+)\s+day", text, re.I)
    if m:
        return (today - timedelta(days=int(m.group(1)))).strftime("%d/%m/%Y")
    m = re.search(r"added\s+(\d+)\s+week", text, re.I)
    if m:
        return (today - timedelta(weeks=int(m.group(1)))).strftime("%d/%m/%Y")
    m = re.search(r"added\s+(\d{1,2})\s+([A-Za-z]{3,})", text, re.I)
    if m:
        try:
            dt = datetime.strptime(f"{m.group(1)} {m.group(2)[:3].capitalize()} {today.year}", "%d %b %Y")
            if dt > today:
                dt = dt.replace(year=dt.year - 1)
            return dt.strftime("%d/%m/%Y")
        except ValueError:
            pass
    return ""


def _extract_date(card):
    for el in card.find_all(["span", "div", "p", "time"]):
        if el.name == "time":
            v = el.get("datetime", "") or el.get_text(strip=True)
            try:
                dt = datetime.strptime(v.strip()[:10], "%Y-%m-%d")
                return dt.strftime("%d/%m/%Y")
            except ValueError:
                pass
        txt = el.get_text(strip=True)
        if not txt or len(txt) > 50:
            continue
        result = _parse_date_text(txt)
        if result:
            return result
    return ""


def _normalise_agency(a):
    if not a:
        return a
    if re.search(r"acton.*belle|belle.*acton|acton\s*[|]\s*belle", a, re.I):
        return "Acton | Belle Property Dalkeith | Cottesloe"
    return a


def _parse_card(card, suburb_name):
    """Parse one listing card using REIWA's actual CSS classes."""
    h2 = card.find("h2", class_="p-details__add")
    address = h2.get_text(strip=True) if h2 else ""
    address = re.sub(r",?\s*" + re.escape(suburb_name) + r"$", "", address, flags=re.I).strip()

    # URLs to exclude (agent profiles, agency pages, etc.)
    EXCLUDE_URL_PATTERNS = ["/real-estate-agent/", "/agency/", "/suburb/", "/news/", "/advice/"]

    url = ""
    # Method 1: link inside h2.p-details__add
    if h2:
        a = h2.find("a", href=True)
        if a and not any(x in a["href"] for x in EXCLUDE_URL_PATTERNS):
            url = _clean_listing_url(a["href"]) or ""
    # Method 2: any link with REIWA listing ID pattern (handles query params via _clean_listing_url)
    if not url:
        for a in card.find_all("a", href=True):
            href = a["href"]
            if any(x in href for x in EXCLUDE_URL_PATTERNS):
                continue
            clean = _clean_listing_url(href)
            if clean:
                url = clean
                break
    # Method 3: link containing /buy/ or /sold/ or /for-sale/ (safe property URLs only)
    if not url:
        for a in card.find_all("a", href=True):
            href = a["href"]
            if any(x in href for x in ["/buy/", "/sold/", "/for-sale/"]) and not any(x in href for x in EXCLUDE_URL_PATTERNS):
                url = ("https://reiwa.com.au" + href) if href.startswith("/") else href
                break

    if not address and url:
        m = re.search(r"\.com\.au/(.+)-\d{5,8}/?$", url)
        if m:
            slug = re.sub(r"-" + suburb_name.lower().replace(" ", "-") + "$", "", m.group(1), flags=re.I)
            address = " ".join(p.capitalize() for p in slug.split("-"))
    if not address:
        address = "Address not disclosed"

    price = ""
    for el in card.find_all(["span", "div", "p", "strong", "h2", "h3"]):
        txt = el.get_text(strip=True)
        if not txt or len(txt) > 100 or len(txt) < 2:
            continue
        if "p-details__add" in " ".join(el.get("class", [])):
            continue
        txt = re.sub(r"save listing.*$", "", txt, flags=re.I).strip()
        if not txt:
            continue
        if re.match(r"^(auction|price on application|contact agent|by negotiation|expressions? of interest)$", txt, re.I):
            price = txt
            break
        m = re.search(r"\$([\d,]+)\s*[-\u2013]\s*\$([\d,]+)", txt)
        if m:
            price = f"${m.group(1)} - ${m.group(2)}"
            break
        m = re.search(r"((?:offers?\s+(?:from|over|above|around)|from|above|over)\s*\$[\d,\.]+(?:[Mm](?:illion)?)?)", txt, re.I)
        if m:
            price = m.group(1).strip()
            break
        m = re.search(r"\$(\d{1,3}(?:,\d{3})+|\d+\.\d+[Mm]|\d+[Mm])", txt)
        if m:
            try:
                raw = m.group(1).replace(",", "").replace("M", "000000").replace("m", "000000")
                if float(raw) >= 100000:
                    price = f"${m.group(1)}"
                    break
            except ValueError:
                pass

    nums = [s.get_text(strip=True) for s in card.find_all("span", class_="u-grey-dark")
            if s.get_text(strip=True).isdigit()]
    beds = int(nums[0]) if len(nums) > 0 else None
    baths = int(nums[1]) if len(nums) > 1 else None
    cars = int(nums[2]) if len(nums) > 2 else None

    ct = card.get_text(" ", strip=True)
    cn = re.sub(r"m\s+2\b", "m2", ct, flags=re.I)

    land = ""
    for pat in [r"landsize\s*([\d,]+)\s*m", r"land\s*size[^\d]{0,10}([\d,]+)\s*m",
                r"([\d,]+)\s*m2\s*(?:land|block|lot)"]:
        m = re.search(pat, cn, re.I)
        if m:
            try:
                v = int(m.group(1).replace(",", ""))
                if 10 <= v <= 100000:
                    land = f"{v} m²"
                    break
            except ValueError:
                pass

    internal = ""
    for pat in [r"internal\s*size[^\d]{0,10}([\d,]+)\s*m", r"floor\s*area[^\d]{0,10}([\d,]+)\s*m",
                r"([\d,]+)\s*m2\s*(?:internal|living|floor)"]:
        m = re.search(pat, cn, re.I)
        if m:
            try:
                v = int(m.group(1).replace(",", ""))
                if 10 <= v <= 10000:
                    internal = f"{v} m²"
                    break
            except ValueError:
                pass

    ptype = ""
    for t in ["House", "Unit", "Apartment", "Townhouse", "Villa", "Studio",
              "Duplex", "Terrace", "Land", "Rural"]:
        if re.search(r"\b" + t + r"\b", ct, re.I):
            ptype = t
            break

    agency = ""
    logo = card.find("a", class_="agent__logo")
    if logo:
        sr = logo.find("span", class_="u-sr-only")
        if sr:
            agency = _normalise_agency(sr.get_text(strip=True))

    agent = ""
    nd = card.find("div", class_="agent__name")
    if nd:
        a = nd.find("a", class_="-ignore-theme")
        if a:
            agent = a.get_text(strip=True)

    # Under offer detection from card text
    card_status = "active"
    card_text_lower = ct.lower()
    if "under offer" in card_text_lower or "under contract" in card_text_lower:
        card_status = "under_offer"

    return {
        "url": url,
        "address": address,
        "price_text": price,
        "listing_type": ptype,
        "bedrooms": beds,
        "bathrooms": baths,
        "parking": cars,
        "land_size": land,
        "internal_size": internal,
        "agency": agency,
        "agent": agent,
        "status": card_status,
        "listing_date": _extract_date(card),
    }


def _fetch_detail(page, url):
    """Visit listing detail page for sizes and under_offer status."""
    out = {"land_size": "", "internal_size": "", "price_text": "", "status": None, "listing_date": "",
           "address": "", "agency": "", "agent": "", "bedrooms": None, "bathrooms": None, "parking": None,
           "listing_type": ""}
    if not url:
        return out

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(800)
        html = page.content()
        soup = BeautifulSoup(html, "html.parser")

        # Status detection — Sold detection only via tight badge-class check
        # (avoids false positives from "recently sold" widgets, agent bios, etc.)
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
            if header and re.search(r"\bunder\s+offer\b", header.get_text(" ", strip=True)[:800], re.I):
                is_under_offer = True

        if not is_sold and not is_under_offer:
            main = soup.find("main")
            if main and re.search(r"\bunder\s+offer\b", main.get_text(" ", strip=True)[:1500], re.I):
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

        m = re.search(r"\$([\d]{1,3}(?:,[\d]{3})+)", t[:600])
        if m:
            out["price_text"] = f"${m.group(1)}"

        # Listing date from detail page
        for el in soup.find_all(["span", "div", "p", "time"]):
            txt = el.get_text(strip=True)
            if txt and len(txt) < 60:
                d = _parse_date_text(txt)
                if d:
                    out["listing_date"] = d
                    break

        # Address from detail page (h1 or h2.p-details__add)
        addr_el = soup.find("h2", class_="p-details__add") or soup.find("h1")
        if addr_el:
            out["address"] = addr_el.get_text(strip=True)

        # Agency from detail page
        logo = soup.find("a", class_="agent__logo")
        if logo:
            sr = logo.find("span", class_="u-sr-only")
            if sr:
                out["agency"] = _normalise_agency(sr.get_text(strip=True))

        # Agent from detail page
        nd = soup.find("div", class_="agent__name")
        if nd:
            a = nd.find("a", class_="-ignore-theme")
            if a:
                out["agent"] = a.get_text(strip=True)

        # Bed/bath/car from detail page
        nums = [s.get_text(strip=True) for s in soup.find_all("span", class_="u-grey-dark")
                if s.get_text(strip=True).isdigit()]
        if len(nums) > 0:
            out["bedrooms"] = int(nums[0])
        if len(nums) > 1:
            out["bathrooms"] = int(nums[1])
        if len(nums) > 2:
            out["parking"] = int(nums[2])

        # Property type
        page_text = soup.get_text(" ", strip=True)
        for pt in ["House", "Unit", "Apartment", "Townhouse", "Villa", "Studio",
                    "Duplex", "Terrace", "Land", "Rural"]:
            if re.search(r"\b" + pt + r"\b", page_text[:2000], re.I):
                out["listing_type"] = pt
                break

    except Exception as e:
        logger.warning(f"Detail error {url}: {e}")

    return out


def _fetch_details_batch(detail_pages, listings):
    """Fetch detail pages for a batch of listings using multiple tabs round-robin."""
    if not listings:
        return []

    results = []
    for i, rec in enumerate(listings):
        tab = detail_pages[i % len(detail_pages)]
        detail = _fetch_detail(tab, rec['url'])

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


def _get_reiwa_total(soup):
    """Extract the total listing count REIWA shows (e.g. '49 Properties Found')."""
    for el in soup.find_all(["h1", "h2", "h3", "span", "div", "p"]):
        txt = el.get_text(strip=True)
        m = re.search(r"(\d+)\s+(?:propert|listing|result)", txt, re.I)
        if m:
            return int(m.group(1))
    return None


def _count_cards(page):
    """Count p-card elements currently in the DOM."""
    return page.evaluate("""() => document.querySelectorAll('[class*="p-card"]').length""")


def _extract_all_listing_urls_js(page):
    """Extract ALL listing URLs directly from the live DOM via JavaScript.
    Uses pathname to handle query-param decorated hrefs (featured/promoted listings)."""
    return page.evaluate("""() => {
        const urls = new Set();
        const exclude = ['/real-estate-agent/', '/agency/', '/suburb/', '/news/', '/advice/'];
        document.querySelectorAll('a[href]').forEach(a => {
            try {
                const parsed = new URL(a.href, 'https://reiwa.com.au');
                if (!parsed.hostname.includes('reiwa.com.au')) return;
                const path = parsed.pathname;
                if (exclude.some(x => path.includes(x))) return;
                if (/-\\d{5,8}\\/?$/.test(path)) {
                    urls.add('https://reiwa.com.au' + path.replace(/\\/$/, ''));
                }
            } catch(e) {}
        });
        return [...urls];
    }""")


def _load_listing_page(page, url, retries=3):
    """Load a REIWA listing page, wait for cards, scroll repeatedly to load all."""
    for attempt in range(1, retries + 1):
        try:
            page.goto(url, wait_until="networkidle", timeout=40000)
            try:
                page.wait_for_selector('[class*="p-card"]', timeout=8000)
            except Exception:
                pass

            # Scroll incrementally until no new cards appear
            prev_count = 0
            no_change_rounds = 0
            for scroll_round in range(12):
                page.evaluate("window.scrollBy(0, window.innerHeight * 1.5)")
                page.wait_for_timeout(600)
                cur_count = _count_cards(page)
                if cur_count > prev_count:
                    prev_count = cur_count
                    no_change_rounds = 0
                else:
                    no_change_rounds += 1
                    if no_change_rounds >= 3:
                        break  # 3 scrolls with no new cards = done

            # Final scroll to absolute bottom + extra wait
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1500)

            # If new cards appeared after final scroll, wait more
            final_count = _count_cards(page)
            if final_count > prev_count:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(1200)

            # Click any "Load More" / "Show All" buttons
            try:
                for selector in [
                    'button:has-text("Load More")',
                    'button:has-text("Show More")',
                    'button:has-text("Show All")',
                    'a:has-text("Load More")',
                    'a:has-text("Show More")',
                ]:
                    btn = page.query_selector(selector)
                    if btn and btn.is_visible():
                        btn.click()
                        page.wait_for_timeout(2000)
                        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        page.wait_for_timeout(1000)
                        break
            except Exception:
                pass

            return True
        except Exception as e:
            if attempt < retries:
                time.sleep(1.5 * attempt)
            else:
                logger.error(f"Failed to load {url}: {e}")
                return False
    return False


def scrape_suburb(suburb_slug, suburb_id, progress_callback=None, known_urls=None, cancel_check=None):
    """Scrape all for-sale and sold listings for a suburb."""
    suburb_name = suburb_slug.replace("-", " ").title()
    results = {
        'forsale_listings': [],
        'sold_listings': [],
        'errors': [],
        'stats': {
            'forsale_pages_scraped': 0,
            'sold_pages_scraped': 0,
            'forsale_count': 0,
            'sold_count': 0,
            'detail_pages_scraped': 0,
        }
    }

    with sync_playwright() as p:
        launch_opts = {
            'headless': True,
            'args': ['--no-sandbox', '--disable-setuid-sandbox'],
        }
        if CHROMIUM_PATH:
            launch_opts['executable_path'] = CHROMIUM_PATH

        browser = p.chromium.launch(**launch_opts)
        context = browser.new_context(
            user_agent=UA,
            viewport={'width': 1280, 'height': 800},
            locale='en-AU',
        )

        listing_page = context.new_page()

        # Create multiple detail tabs for faster fetching
        detail_pages = []
        for _ in range(DETAIL_TABS):
            dp = context.new_page()
            dp.route("**/*", lambda route: route.abort()
                     if route.request.resource_type in ("image", "media", "font", "stylesheet")
                     else route.continue_())
            detail_pages.append(dp)

        try:
            # === FOR-SALE ===
            if progress_callback:
                progress_callback('Scraping for-sale pages...')

            seen_urls = set()
            page_num = 1
            consecutive_empty = 0

            while page_num <= MAX_PAGES:
                # Check cancel
                if cancel_check and cancel_check():
                    logger.info(f"{suburb_name}: scrape cancelled by user")
                    break

                url = _build_url(suburb_slug, page_num)
                if progress_callback:
                    progress_callback(f'For-sale page {page_num}...')

                if not _load_listing_page(listing_page, url):
                    logger.error(f"Failed to load for-sale page {page_num}")
                    results['errors'].append(f"Failed to load for-sale page {page_num}")
                    break

                html = listing_page.content()
                soup = BeautifulSoup(html, "html.parser")

                # Find ALL elements with p-card in their class (any tag)
                cards = soup.find_all(True, class_=lambda c: c and "p-card" in c)
                # De-duplicate: remove nested p-card elements (keep outermost only)
                filtered_cards = []
                for card in cards:
                    # Skip if this card is inside another p-card
                    parent_card = card.find_parent(True, class_=lambda c: c and "p-card" in c)
                    if parent_card is None:
                        filtered_cards.append(card)
                cards = filtered_cards

                # Extract ALL listing URLs from the live DOM via JS (catches dynamically loaded content)
                js_urls = set()
                try:
                    js_urls = set(u.rstrip('/') for u in _extract_all_listing_urls_js(listing_page))
                except Exception:
                    pass

                # Also scan BS4 for listing links NOT inside any p-card (featured/promoted)
                # _clean_listing_url strips query params so tracking URLs don't get missed
                EXCLUDE = ["/real-estate-agent/", "/agency/", "/suburb/", "/news/", "/advice/"]
                page_link_urls = set()
                for a_tag in soup.find_all("a", href=True):
                    href = a_tag["href"]
                    if any(x in href for x in EXCLUDE):
                        continue
                    full_url = _clean_listing_url(href)
                    if not full_url:
                        continue
                    parent_card = a_tag.find_parent(True, class_=lambda c: c and "p-card" in c)
                    if parent_card is None:
                        page_link_urls.add(full_url)

                # On first page, grab REIWA's total count for comparison
                if page_num == 1:
                    reiwa_total = _get_reiwa_total(soup)
                    if reiwa_total:
                        results['stats']['reiwa_total'] = reiwa_total
                        logger.info(f"{suburb_name}: REIWA says {reiwa_total} total listings")

                if not cards:
                    logger.info(f"{suburb_name} p{page_num}: 0 BS4 cards, checking JS URLs...")

                # Parse all cards first
                page_listings = []
                new_on_page = 0
                skipped = 0

                for card in cards:
                    rec = _parse_card(card, suburb_name)
                    card_url = rec['url']

                    if not card_url:
                        skipped += 1
                        continue
                    # Skip agent profile cards
                    if "/real-estate-agent/" in card_url or "/agency/" in card_url:
                        skipped += 1
                        logger.debug(f"{suburb_name} p{page_num}: skipped agent card: {card_url}")
                        continue
                    if card_url.rstrip('/') in seen_urls:
                        continue

                    seen_urls.add(card_url.rstrip('/'))
                    new_on_page += 1
                    page_listings.append(rec)

                if skipped:
                    results['errors'].append(f"p{page_num}: {skipped} card(s) with no URL")

                # Add orphan listing links (not inside any p-card - e.g. featured/promoted)
                for orphan_url in page_link_urls:
                    if orphan_url.rstrip('/') in seen_urls:
                        continue
                    seen_urls.add(orphan_url.rstrip('/'))
                    new_on_page += 1
                    rec = {
                        "url": orphan_url,
                        "address": "Address not disclosed",
                        "price_text": "", "listing_type": "",
                        "bedrooms": None, "bathrooms": None, "parking": None,
                        "land_size": "", "internal_size": "",
                        "agency": "", "agent": "", "status": "active",
                        "listing_date": "",
                    }
                    for a_tag in soup.find_all("a", href=True):
                        full = ("https://reiwa.com.au" + a_tag["href"]) if a_tag["href"].startswith("/") else a_tag["href"]
                        if full == orphan_url:
                            txt = a_tag.get_text(strip=True)
                            if txt and len(txt) > 3 and len(txt) < 120:
                                rec["address"] = txt
                                break
                    page_listings.append(rec)
                    logger.info(f"{suburb_name} p{page_num}: found orphan listing link: {orphan_url}")

                # Final safety net: any JS-discovered URL not yet captured gets added
                for js_url in js_urls:
                    normalized = js_url.rstrip('/')
                    if normalized in seen_urls:
                        continue
                    # Also check with trailing slash variant
                    if normalized + '/' in seen_urls:
                        continue
                    seen_urls.add(normalized)
                    new_on_page += 1
                    rec = {
                        "url": normalized,
                        "address": "Address not disclosed",
                        "price_text": "", "listing_type": "",
                        "bedrooms": None, "bathrooms": None, "parking": None,
                        "land_size": "", "internal_size": "",
                        "agency": "", "agent": "", "status": "active",
                        "listing_date": "",
                    }
                    page_listings.append(rec)
                    logger.info(f"{suburb_name} p{page_num}: JS rescued missed listing: {normalized}")

                # Split into new vs known listings
                new_listings = []
                known_listings = []
                _known = known_urls or set()

                for rec in page_listings:
                    if rec['url'] in _known:
                        known_listings.append(rec)
                    else:
                        new_listings.append(rec)

                # Only fetch detail pages for NEW listings
                if new_listings:
                    if progress_callback:
                        progress_callback(f'For-sale page {page_num}: {len(new_listings)} new, {len(known_listings)} known (skipped)')

                    _fetch_details_batch(detail_pages, new_listings)
                    results['stats']['detail_pages_scraped'] += len(new_listings)
                elif known_listings and progress_callback:
                    progress_callback(f'For-sale page {page_num}: {len(known_listings)} known (all skipped)')

                for rec in page_listings:
                    rec['reiwa_url'] = rec['url']
                    results['forsale_listings'].append(rec)

                results['stats']['forsale_pages_scraped'] = page_num
                logger.info(f"{suburb_name} p{page_num}: {len(cards)} cards, {new_on_page} new, total={len(results['forsale_listings'])}")

                if progress_callback:
                    progress_callback(f'For-sale page {page_num}: {len(cards)} cards, {new_on_page} new. Total: {len(results["forsale_listings"])}')

                # Decide whether to continue pagination
                reiwa_target = results['stats'].get('reiwa_total', 0)
                current_total = len(results['forsale_listings'])

                if new_on_page == 0:
                    consecutive_empty += 1
                    if reiwa_target and current_total < reiwa_target:
                        # Below REIWA total: keep going, allow up to 3 empty pages
                        logger.info(f"{suburb_name} p{page_num}: 0 new but only {current_total}/{reiwa_target}, continuing...")
                        if consecutive_empty >= 3:
                            logger.info(f"{suburb_name}: 3 consecutive empty pages despite being below target, stopping")
                            break
                    elif consecutive_empty >= 2:
                        break
                else:
                    consecutive_empty = 0

                page_num += 1
                time.sleep(random.uniform(0.5, 1.0))

            results['stats']['forsale_count'] = len(results['forsale_listings'])

            # Fallback: if we're short of REIWA total, re-scan ALL pages for missed URLs
            reiwa_total = results['stats'].get('reiwa_total', 0)
            our_count = len(results['forsale_listings'])
            if reiwa_total and our_count < reiwa_total:
                missing = reiwa_total - our_count
                logger.info(f"{suburb_name}: we found {our_count}/{reiwa_total}, trying to recover {missing} missed listing(s)")
                if progress_callback:
                    progress_callback(f'Recovering {missing} missed listing(s)...')

                EXCLUDE_FALLBACK = ["/real-estate-agent/", "/agency/", "/suburb/", "/news/", "/advice/"]
                recovered = 0
                existing_urls = {r['url'].rstrip('/') for r in results['forsale_listings']}
                pages_scraped = results['stats'].get('forsale_pages_scraped', 1)

                for fb_page in range(1, MAX_PAGES + 1):  # scan all possible pages
                    if recovered >= missing:
                        break
                    fb_url = _build_url(suburb_slug, fb_page)
                    if not _load_listing_page(listing_page, fb_url):
                        break

                    html = listing_page.content()
                    fb_soup = BeautifulSoup(html, "html.parser")

                    # Also use JS extraction in fallback
                    try:
                        fb_js_urls = _extract_all_listing_urls_js(listing_page)
                    except Exception:
                        fb_js_urls = []

                    # Collect all candidate URLs from BS4 + JS (query params stripped)
                    fb_candidate_urls = set()
                    for a_tag in fb_soup.find_all("a", href=True):
                        href = a_tag["href"]
                        if any(x in href for x in EXCLUDE_FALLBACK):
                            continue
                        clean = _clean_listing_url(href)
                        if clean:
                            fb_candidate_urls.add(clean)
                    for u in fb_js_urls:
                        fb_candidate_urls.add(u.rstrip('/'))

                    new_on_fb_page = 0
                    for full_url in fb_candidate_urls:
                        if full_url in seen_urls:
                            continue

                        seen_urls.add(full_url)
                        new_on_fb_page += 1

                        # Try to find matching card in BS4 for this URL
                        matched_card = None
                        for a_tag in fb_soup.find_all("a", href=True):
                            href = a_tag["href"]
                            norm = ("https://reiwa.com.au" + href).rstrip('/') if href.startswith("/") else href.rstrip('/')
                            if norm == full_url:
                                pc = a_tag.find_parent(True, class_=lambda c: c and "p-card" in c)
                                if pc:
                                    matched_card = pc
                                    break

                        if matched_card:
                            rec = _parse_card(matched_card, suburb_name)
                        else:
                            rec = {
                                "url": full_url,
                                "address": "Address not disclosed",
                                "price_text": "", "listing_type": "",
                                "bedrooms": None, "bathrooms": None, "parking": None,
                                "land_size": "", "internal_size": "",
                                "agency": "", "agent": "", "status": "active",
                                "listing_date": "",
                            }

                        if rec.get('url') and rec['url'].rstrip('/') not in existing_urls:
                            # Always fetch detail to learn the true status — REIWA's for-sale page
                            # sometimes lists already-SOLD properties, which the sold scrape captures.
                            # We must skip them here to avoid stomping their 'sold' status.
                            detail = _fetch_detail(detail_pages[0], rec['url'])
                            results['stats']['detail_pages_scraped'] += 1

                            if detail.get('status') == 'sold':
                                logger.info(f"{suburb_name}: missing URL is SOLD, leaving for sold scrape: {rec['url']}")
                                # Count as recovered so the loop can terminate (REIWA included it in total)
                                recovered += 1
                                continue

                            for field in ['land_size', 'internal_size', 'price_text', 'listing_date',
                                          'address', 'agency', 'agent', 'bedrooms', 'bathrooms',
                                          'parking', 'listing_type']:
                                if detail.get(field) and not rec.get(field):
                                    rec[field] = detail[field]
                            if detail.get('status') == 'under_offer':
                                rec['status'] = 'under_offer'

                            rec['reiwa_url'] = rec['url']
                            results['forsale_listings'].append(rec)
                            existing_urls.add(rec['url'].rstrip('/'))
                            recovered += 1
                            logger.info(f"{suburb_name}: recovered missed listing from page {fb_page}: {rec['url']}")

                    # Stop if this page had nothing new AND we're past what we originally scraped
                    if new_on_fb_page == 0 and fb_page > pages_scraped:
                        # But keep going if we still haven't recovered everything
                        if recovered < missing:
                            # Allow a few more pages before giving up
                            if fb_page > pages_scraped + 3:
                                break
                        else:
                            break
                    time.sleep(0.3)

                if recovered:
                    results['stats']['forsale_count'] = len(results['forsale_listings'])
                    logger.info(f"{suburb_name}: recovered {recovered}/{missing} missed listing(s), new total: {results['stats']['forsale_count']}")

            # === SOLD (2 pages) ===
            if progress_callback:
                progress_callback('Scraping sold pages...')

            sold_seen = set()
            for pg in range(1, 3):
                if cancel_check and cancel_check():
                    break
                url = _build_sold_url(suburb_slug, pg)
                if progress_callback:
                    progress_callback(f'Sold page {pg}...')

                if not _load_listing_page(listing_page, url):
                    break

                html = listing_page.content()
                soup = BeautifulSoup(html, "html.parser")
                cards = soup.find_all("article", class_=lambda c: c and "p-card" in c)

                if not cards:
                    break

                for card in cards:
                    rec = _parse_card(card, suburb_name)
                    card_url = rec['url']

                    if card_url and card_url in sold_seen:
                        continue
                    if card_url:
                        sold_seen.add(card_url)

                    rec['status'] = 'sold'
                    rec['reiwa_url'] = card_url
                    results['sold_listings'].append(rec)

                results['stats']['sold_pages_scraped'] = pg
                logger.info(f"{suburb_name} sold p{pg}: {len(cards)} cards")

                time.sleep(random.uniform(0.3, 0.8))

            results['stats']['sold_count'] = len(results['sold_listings'])

        except Exception as e:
            logger.error(f"Fatal error scraping {suburb_name}: {e}")
            results['errors'].append(f"Fatal error: {str(e)}")
        finally:
            browser.close()

    return results


def debug_page(suburb_slug):
    """Debug: see what the scraper sees on a REIWA for-sale page."""
    url = _build_url(suburb_slug, 1)
    result = {'url': url, 'title': '', 'cards_found': 0, 'sample_card': '', 'text_preview': '', 'error': None}

    try:
        with sync_playwright() as p:
            launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
            if CHROMIUM_PATH:
                launch_opts['executable_path'] = CHROMIUM_PATH
            browser = p.chromium.launch(**launch_opts)
            context = browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800}, locale='en-AU')
            page = context.new_page()

            _load_listing_page(page, url)
            html = page.content()
            soup = BeautifulSoup(html, "html.parser")

            result['title'] = page.title()
            cards = soup.find_all("article", class_=lambda c: c and "p-card" in c)
            result['cards_found'] = len(cards)

            if cards:
                result['sample_card'] = str(cards[0])[:2000]

            result['text_preview'] = soup.get_text(" ", strip=True)[:3000]

            browser.close()
    except Exception as e:
        result['error'] = str(e)

    return result


def compare_suburb(suburb_slug, db_urls):
    """Compare what REIWA shows vs what we have in DB.
    Returns detailed diff: missing from DB, extra in DB, and total counts."""
    suburb_name = suburb_slug.replace("-", " ").title()
    result = {
        'reiwa_total': None,
        'reiwa_urls': [],
        'db_urls_count': len(db_urls),
        'missing_from_db': [],    # on REIWA's for-sale list but not in our DB (active/under_offer)
        'sold_excluded': [],      # on REIWA's for-sale list but actually SOLD (sold scrape handles them)
        'extra_in_db': [],        # in our DB but not on REIWA
        'matched': 0,
        'pages_scraped': 0,
        'error': None,
    }

    try:
        with sync_playwright() as p:
            launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
            if CHROMIUM_PATH:
                launch_opts['executable_path'] = CHROMIUM_PATH
            browser = p.chromium.launch(**launch_opts)
            context = browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800}, locale='en-AU')
            page = context.new_page()

            all_reiwa_urls = set()
            page_num = 1
            consecutive_empty = 0

            while page_num <= MAX_PAGES:
                url = _build_url(suburb_slug, page_num)
                if not _load_listing_page(page, url):
                    break

                html = page.content()
                soup = BeautifulSoup(html, "html.parser")

                # Get REIWA's stated total on page 1
                if page_num == 1:
                    result['reiwa_total'] = _get_reiwa_total(soup)

                # Method 1: extract URLs from live DOM via JS
                js_urls = _extract_all_listing_urls_js(page)
                before = len(all_reiwa_urls)
                for u in js_urls:
                    all_reiwa_urls.add(u.rstrip('/'))

                # Method 2: extract from BeautifulSoup as backup (query params stripped)
                EXCLUDE = ["/real-estate-agent/", "/agency/", "/suburb/", "/news/", "/advice/"]
                for a_tag in soup.find_all("a", href=True):
                    href = a_tag["href"]
                    if any(x in href for x in EXCLUDE):
                        continue
                    clean = _clean_listing_url(href)
                    if clean:
                        all_reiwa_urls.add(clean)

                new_found = len(all_reiwa_urls) - before
                result['pages_scraped'] = page_num

                reiwa_target = result.get('reiwa_total') or 0
                if new_found == 0 and page_num > 1:
                    consecutive_empty += 1
                    if reiwa_target and len(all_reiwa_urls) < reiwa_target:
                        logger.info(f"{suburb_name} compare p{page_num}: 0 new but only {len(all_reiwa_urls)}/{reiwa_target}, continuing...")
                        if consecutive_empty >= 3:
                            logger.info(f"{suburb_name} compare: 3 consecutive empty pages, stopping")
                            break
                    else:
                        break
                else:
                    consecutive_empty = 0

                page_num += 1
                time.sleep(0.5)

            # Normalize all URLs for comparison
            reiwa_set = {u.rstrip('/') for u in all_reiwa_urls}
            db_set = {u.rstrip('/') for u in db_urls}

            initial_missing = sorted(reiwa_set - db_set)

            # REIWA's for-sale listing pages occasionally include already-SOLD properties
            # in their total count. Fetch detail for each "missing" URL — if SOLD, exclude
            # from missing_from_db so the user doesn't get a false-alarm.
            sold_excluded = []
            real_missing = []
            detail_page = context.new_page()
            detail_page.route("**/*", lambda route: route.abort()
                              if route.request.resource_type in ("image", "media", "font", "stylesheet")
                              else route.continue_())
            for url in initial_missing:
                detail = _fetch_detail(detail_page, url)
                if detail.get('status') == 'sold':
                    sold_excluded.append(url)
                else:
                    real_missing.append(url)

            browser.close()

            result['reiwa_urls'] = sorted(reiwa_set)
            result['missing_from_db'] = real_missing
            result['sold_excluded'] = sold_excluded
            result['extra_in_db'] = sorted(db_set - reiwa_set)
            result['matched'] = len(reiwa_set & db_set)

    except Exception as e:
        result['error'] = str(e)

    return result

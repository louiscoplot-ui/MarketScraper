import re
import time
import random
import logging
import os
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

REIWA_BASE = "https://reiwa.com.au"
MAX_PAGES = 15
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
DETAIL_TABS = 3  # Number of concurrent detail page tabs

CHROMIUM_PATH = os.environ.get('CHROMIUM_PATH', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
if not os.path.exists(CHROMIUM_PATH):
    CHROMIUM_PATH = None


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

    url = ""
    # Method 1: link inside h2.p-details__add
    if h2:
        a = h2.find("a", href=True)
        if a:
            url = ("https://reiwa.com.au" + a["href"]) if a["href"].startswith("/") else a["href"]
    # Method 2: any link with REIWA listing ID pattern
    if not url:
        for a in card.find_all("a", href=True):
            if re.search(r"-\d{5,8}/?$", a["href"]):
                url = ("https://reiwa.com.au" + a["href"]) if a["href"].startswith("/") else a["href"]
                break
    # Method 3: any link containing /buy/ or /sold/ or /for-sale/
    if not url:
        for a in card.find_all("a", href=True):
            href = a["href"]
            if any(x in href for x in ["/buy/", "/sold/", "/for-sale/", "/property/"]):
                url = ("https://reiwa.com.au" + href) if href.startswith("/") else href
                break
    # Method 4: any link that's not # or javascript
    if not url:
        for a in card.find_all("a", href=True):
            href = a["href"]
            if href and not href.startswith("#") and not href.startswith("javascript") and href != "/":
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
        "status": "active",
        "listing_date": _extract_date(card),
    }


def _fetch_detail(page, url):
    """Visit listing detail page for sizes and under_offer status."""
    out = {"land_size": "", "internal_size": "", "price_text": "", "status": None, "listing_date": ""}
    if not url:
        return out

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(800)
        html = page.content()
        soup = BeautifulSoup(html, "html.parser")

        # Under Offer detection
        STATUS_CLASSES = ["status", "badge", "banner", "label", "tag", "ribbon", "flag",
                          "pill", "listing-status", "property-status", "listing__status", "p-status"]

        is_under_offer = False

        for el in soup.find_all(["span", "div", "p", "strong", "h1", "h2", "h3"], class_=True):
            cls = " ".join(el.get("class", []))
            txt = el.get_text(strip=True).lower()
            if "under offer" in txt and any(k in cls for k in STATUS_CLASSES):
                is_under_offer = True
                break

        if not is_under_offer:
            header = (
                soup.find("div", class_=re.compile(r"listing-header|property-header|p-header", re.I))
                or soup.find("section", class_=re.compile(r"listing|property|detail", re.I))
                or soup.find("header")
            )
            if header:
                if re.search(r"\bunder\s+offer\b", header.get_text(" ", strip=True)[:800], re.I):
                    is_under_offer = True

        if not is_under_offer:
            main = soup.find("main")
            if main:
                if re.search(r"\bunder\s+offer\b", main.get_text(" ", strip=True)[:1500], re.I):
                    is_under_offer = True

        if is_under_offer:
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


def _load_listing_page(page, url, retries=3):
    """Load a REIWA listing page, wait for article.p-card cards, scroll to load all."""
    for attempt in range(1, retries + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_selector("article.p-card", timeout=6000)
            except Exception:
                pass
            # Scroll down to trigger any lazy-loaded cards
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1500)
            return True
        except Exception as e:
            if attempt < retries:
                time.sleep(1.5 * attempt)
            else:
                logger.error(f"Failed to load {url}: {e}")
                return False
    return False


def scrape_suburb(suburb_slug, suburb_id, progress_callback=None):
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
                url = _build_url(suburb_slug, page_num)
                if progress_callback:
                    progress_callback(f'For-sale page {page_num}...')

                if not _load_listing_page(listing_page, url):
                    logger.error(f"Failed to load for-sale page {page_num}")
                    results['errors'].append(f"Failed to load for-sale page {page_num}")
                    break

                html = listing_page.content()
                soup = BeautifulSoup(html, "html.parser")
                cards = soup.find_all("article", class_=lambda c: c and "p-card" in c)
                # Also check for listing cards in other wrappers (featured/premium)
                extra_cards = soup.find_all("div", class_=lambda c: c and "p-card" in c)
                if extra_cards:
                    # Avoid duplicates by checking if card already in list
                    card_htmls = {str(c) for c in cards}
                    for ec in extra_cards:
                        if str(ec) not in card_htmls:
                            cards.append(ec)

                # On first page, grab REIWA's total count for comparison
                if page_num == 1:
                    reiwa_total = _get_reiwa_total(soup)
                    if reiwa_total:
                        results['stats']['reiwa_total'] = reiwa_total
                        logger.info(f"{suburb_name}: REIWA says {reiwa_total} total listings")

                if not cards:
                    logger.info(f"{suburb_name} p{page_num}: 0 cards -> done")
                    break

                # Parse all cards first
                page_listings = []
                new_on_page = 0
                skipped = 0

                for card in cards:
                    rec = _parse_card(card, suburb_name)
                    card_url = rec['url']

                    if not card_url:
                        skipped += 1
                        logger.warning(f"{suburb_name} p{page_num}: skipped card with no URL (address: {rec.get('address', '?')})")
                        continue
                    if card_url in seen_urls:
                        continue

                    seen_urls.add(card_url)
                    new_on_page += 1
                    page_listings.append(rec)

                if skipped:
                    results['errors'].append(f"p{page_num}: {skipped} card(s) with no URL")

                # Fetch all detail pages for this page's listings
                if page_listings:
                    if progress_callback:
                        progress_callback(f'For-sale page {page_num}: fetching {len(page_listings)} detail pages...')

                    _fetch_details_batch(detail_pages, page_listings)
                    results['stats']['detail_pages_scraped'] += len(page_listings)

                    for rec in page_listings:
                        rec['reiwa_url'] = rec['url']
                        results['forsale_listings'].append(rec)

                results['stats']['forsale_pages_scraped'] = page_num
                logger.info(f"{suburb_name} p{page_num}: {len(cards)} cards, {new_on_page} new, total={len(results['forsale_listings'])}")

                if progress_callback:
                    progress_callback(f'For-sale page {page_num}: {len(cards)} cards, {new_on_page} new. Total: {len(results["forsale_listings"])}')

                if new_on_page == 0:
                    consecutive_empty += 1
                    if consecutive_empty >= 2:
                        break
                else:
                    consecutive_empty = 0

                page_num += 1
                time.sleep(random.uniform(0.5, 1.0))

            results['stats']['forsale_count'] = len(results['forsale_listings'])

            # === SOLD (2 pages) ===
            if progress_callback:
                progress_callback('Scraping sold pages...')

            sold_seen = set()
            for pg in range(1, 3):
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

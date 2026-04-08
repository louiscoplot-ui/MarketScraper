import re
import time
import random
import logging
import os
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

REA_BASE = "https://www.realestate.com.au"
MAX_PAGES = 10
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

CHROMIUM_PATH = os.environ.get('CHROMIUM_PATH', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
if not os.path.exists(CHROMIUM_PATH):
    CHROMIUM_PATH = None

# JavaScript to inject to hide headless browser fingerprint
STEALTH_JS = """
() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Override chrome runtime
    window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);

    // Override plugins to look like a real browser
    Object.defineProperty(navigator, 'plugins', {
        get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-AU', 'en-US', 'en'] });

    // Remove headless indicators from user agent
    Object.defineProperty(navigator, 'userAgent', {
        get: () => navigator.userAgent.replace('HeadlessChrome/', 'Chrome/')
    });

    // Override platform
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

    // Override hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

    // Override deviceMemory
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // Fix iframe contentWindow
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() {
        return originalAttachShadow.apply(this, [{mode: 'open'}]);
    };
}
"""


def _build_rea_buy_url(suburb_name, postcode, page=1):
    slug = suburb_name.lower().replace(' ', '-')
    return f"{REA_BASE}/buy/in-{slug},+wa+{postcode}/list-{page}?includeSurrounding=false&activeSort=list-date"


def _build_rea_sold_url(suburb_name, postcode, page=1):
    slug = suburb_name.lower().replace(' ', '-')
    return f"{REA_BASE}/sold/in-{slug},+wa+{postcode}/list-{page}?includeSurrounding=false&activeSort=list-date"


def _get_postcode(suburb_name):
    from wa_postcodes import WA_POSTCODES
    return WA_POSTCODES.get(suburb_name.strip().title(), "")


def _parse_date_text_rea(text):
    """Parse REA date text like 'Added 3 days ago', 'Listed 2 weeks ago'."""
    if not text:
        return ""
    today = datetime.now()
    text = text.strip()

    if re.search(r"added\s+today|listed\s+today", text, re.I):
        return today.strftime("%d/%m/%Y")
    if re.search(r"added\s+yesterday|listed\s+yesterday", text, re.I):
        return (today - timedelta(days=1)).strftime("%d/%m/%Y")
    m = re.search(r"(\d+)\s+day", text, re.I)
    if m:
        return (today - timedelta(days=int(m.group(1)))).strftime("%d/%m/%Y")
    m = re.search(r"(\d+)\s+week", text, re.I)
    if m:
        return (today - timedelta(weeks=int(m.group(1)))).strftime("%d/%m/%Y")
    m = re.search(r"(\d+)\s+month", text, re.I)
    if m:
        return (today - timedelta(days=int(m.group(1)) * 30)).strftime("%d/%m/%Y")
    # "Listed on 15 Mar 2025" pattern
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})", text)
    if m:
        try:
            dt = datetime.strptime(f"{m.group(1)} {m.group(2)[:3].capitalize()} {m.group(3)}", "%d %b %Y")
            return dt.strftime("%d/%m/%Y")
        except ValueError:
            pass
    return ""


def _normalise_agency(a):
    if not a:
        return a
    if re.search(r"acton.*belle|belle.*acton|acton\s*[|]\s*belle", a, re.I):
        return "Acton | Belle Property Dalkeith | Cottesloe"
    return a


def _parse_rea_card(card, suburb_name):
    """Parse one REA listing card. REA uses data-testid attributes and structured HTML."""
    result = {
        "url": "",
        "address": "",
        "price_text": "",
        "listing_type": "",
        "bedrooms": None,
        "bathrooms": None,
        "parking": None,
        "land_size": "",
        "internal_size": "",
        "agency": "",
        "agent": "",
        "status": "active",
        "listing_date": "",
        "source": "rea",
    }

    # --- URL ---
    # REA cards have links to /property-{type}-in-{suburb}/ or /{suburb}-wa-{postcode}/{address}/
    for a_tag in card.find_all("a", href=True):
        href = a_tag["href"]
        if "/property-" in href or re.search(r"/\d+-[a-z]", href):
            full = (REA_BASE + href) if href.startswith("/") else href
            # Exclude non-property links
            if "/news/" in href or "/insights/" in href or "/agent/" in href:
                continue
            result["url"] = full
            break

    # Fallback: any link containing suburb slug and looking like a listing
    if not result["url"]:
        suburb_slug = suburb_name.lower().replace(" ", "-")
        for a_tag in card.find_all("a", href=True):
            href = a_tag["href"]
            if suburb_slug in href.lower() and ("/buy/" in href or "/property" in href or "-wa-" in href):
                full = (REA_BASE + href) if href.startswith("/") else href
                result["url"] = full
                break

    # --- Address ---
    # Try data-testid first
    addr_el = card.find(attrs={"data-testid": re.compile(r"address|listing-card-address", re.I)})
    if not addr_el:
        # Try h2/h3 inside the card
        addr_el = card.find(["h2", "h3"])
    if not addr_el:
        # Try link text that looks like an address
        for a_tag in card.find_all("a", href=True):
            txt = a_tag.get_text(strip=True)
            if txt and len(txt) > 5 and len(txt) < 120 and not txt.startswith("$"):
                # Likely an address
                if re.search(r"\d+\s+\w+|lot\s+\d+|unit\s+\d+", txt, re.I):
                    addr_el = a_tag
                    break

    if addr_el:
        address = addr_el.get_text(strip=True)
        # Clean up: remove suburb name from end
        address = re.sub(r",?\s*" + re.escape(suburb_name) + r"(\s+WA\s*\d*)?$", "", address, flags=re.I).strip()
        address = re.sub(r",?\s*WA\s*\d*$", "", address).strip()
        result["address"] = address

    if not result["address"] and result["url"]:
        # Extract from URL
        m = re.search(r"\.com\.au/(.+?)(?:\?|$)", result["url"])
        if m:
            slug = m.group(1).rstrip("/").split("/")[-1]
            result["address"] = " ".join(p.capitalize() for p in slug.replace("-", " ").split())

    if not result["address"]:
        result["address"] = "Address not disclosed"

    # --- Price ---
    price_el = card.find(attrs={"data-testid": re.compile(r"price|listing-card-price", re.I)})
    if not price_el:
        # Search for price-like text
        for el in card.find_all(["span", "p", "div", "strong"]):
            txt = el.get_text(strip=True)
            if not txt or len(txt) > 100 or len(txt) < 2:
                continue
            if re.match(r"^(auction|price on application|contact agent|by negotiation|expressions? of interest)$", txt, re.I):
                price_el = el
                break
            if re.search(r"\$[\d,]", txt):
                price_el = el
                break
            if re.search(r"(offers?\s+(?:from|over|above|around))", txt, re.I):
                price_el = el
                break

    if price_el:
        ptxt = price_el.get_text(strip=True)
        if re.match(r"^(auction|price on application|contact agent|by negotiation|expressions? of interest)$", ptxt, re.I):
            result["price_text"] = ptxt
        else:
            m = re.search(r"\$([\d,]+)\s*[-\u2013]\s*\$([\d,]+)", ptxt)
            if m:
                result["price_text"] = f"${m.group(1)} - ${m.group(2)}"
            else:
                m = re.search(r"((?:offers?\s+(?:from|over|above|around)|from|above|over)\s*\$[\d,\.]+(?:[Mm](?:illion)?)?)", ptxt, re.I)
                if m:
                    result["price_text"] = m.group(1).strip()
                else:
                    m = re.search(r"\$(\d{1,3}(?:,\d{3})+|\d+\.\d+[Mm]|\d+[Mm])", ptxt)
                    if m:
                        result["price_text"] = f"${m.group(1)}"

    # --- Features (bed/bath/car) ---
    # REA uses spans/divs with aria-label or data-testid for features
    features_el = card.find(attrs={"data-testid": re.compile(r"features|property-features", re.I)})
    if not features_el:
        features_el = card.find(True, class_=re.compile(r"general-features|property-features|features", re.I))
    if not features_el:
        features_el = card  # Search whole card

    # Look for bed/bath/car by aria-label or text patterns
    ct = features_el.get_text(" ", strip=True) if features_el else ""

    # Method 1: aria-label attributes
    for el in (features_el or card).find_all(True, attrs={"aria-label": True}):
        label = el.get("aria-label", "").lower()
        val_text = el.get_text(strip=True)
        if val_text.isdigit():
            val = int(val_text)
            if "bed" in label and result["bedrooms"] is None:
                result["bedrooms"] = val
            elif "bath" in label and result["bathrooms"] is None:
                result["bathrooms"] = val
            elif ("car" in label or "parking" in label or "garage" in label) and result["parking"] is None:
                result["parking"] = val

    # Method 2: icon-based (REA uses SVG icons next to numbers)
    if result["bedrooms"] is None:
        nums = re.findall(r"(\d+)\s*(?:bed|Bed)", ct)
        if nums:
            result["bedrooms"] = int(nums[0])
    if result["bathrooms"] is None:
        nums = re.findall(r"(\d+)\s*(?:bath|Bath)", ct)
        if nums:
            result["bathrooms"] = int(nums[0])
    if result["parking"] is None:
        nums = re.findall(r"(\d+)\s*(?:car|Car|park|Park|garage|Garage)", ct)
        if nums:
            result["parking"] = int(nums[0])

    # Method 3: look for feature spans with just numbers (bed, bath, car order)
    if result["bedrooms"] is None:
        feat_spans = []
        for span in (features_el or card).find_all("span"):
            txt = span.get_text(strip=True)
            if txt.isdigit() and int(txt) < 20:
                feat_spans.append(int(txt))
        if len(feat_spans) >= 1:
            result["bedrooms"] = feat_spans[0]
        if len(feat_spans) >= 2:
            result["bathrooms"] = feat_spans[1]
        if len(feat_spans) >= 3:
            result["parking"] = feat_spans[2]

    # --- Land size ---
    card_text = card.get_text(" ", strip=True)
    cn = re.sub(r"m\s+2\b", "m2", card_text, flags=re.I)
    for pat in [r"(\d[\d,]*)\s*m[²2]\s*(?:land|block|lot)?",
                r"land\s*(?:size|area)?[:\s]*([\d,]+)\s*m"]:
        m = re.search(pat, cn, re.I)
        if m:
            try:
                v = int(m.group(1).replace(",", ""))
                if 10 <= v <= 100000:
                    result["land_size"] = f"{v} m²"
                    break
            except ValueError:
                pass

    # --- Property type ---
    for t in ["House", "Unit", "Apartment", "Townhouse", "Villa", "Studio",
              "Duplex", "Terrace", "Land", "Rural"]:
        if re.search(r"\b" + t + r"\b", card_text, re.I):
            result["listing_type"] = t
            break

    # --- Agency ---
    agency_el = card.find(attrs={"data-testid": re.compile(r"agency|branding", re.I)})
    if not agency_el:
        agency_el = card.find(True, class_=re.compile(r"agency|branding|brand-name", re.I))
    if not agency_el:
        # Look for img alt with agency name
        for img in card.find_all("img", alt=True):
            alt = img["alt"]
            if "agency" in alt.lower() or "property" in alt.lower() or "real estate" in alt.lower():
                result["agency"] = _normalise_agency(alt)
                break
            # REA agency logos often have the agency name as alt
            if len(alt) > 3 and not alt.startswith("$") and not alt[0].isdigit():
                result["agency"] = _normalise_agency(alt)
    if agency_el and not result["agency"]:
        result["agency"] = _normalise_agency(agency_el.get_text(strip=True))

    # --- Agent ---
    agent_el = card.find(attrs={"data-testid": re.compile(r"agent-name", re.I)})
    if not agent_el:
        agent_el = card.find(True, class_=re.compile(r"agent-name|agent__name", re.I))
    if agent_el:
        result["agent"] = agent_el.get_text(strip=True)

    # --- Status (under offer) ---
    if re.search(r"under\s+offer|under\s+contract", card_text, re.I):
        result["status"] = "under_offer"

    # --- Listing date ---
    for el in card.find_all(["span", "div", "p", "time"]):
        txt = el.get_text(strip=True)
        if txt and len(txt) < 60:
            d = _parse_date_text_rea(txt)
            if d:
                result["listing_date"] = d
                break

    return result


def _get_rea_total(soup):
    """Extract total listing count REA shows (e.g. '48 properties')."""
    for el in soup.find_all(["h1", "h2", "span", "p", "strong"]):
        txt = el.get_text(strip=True)
        m = re.search(r"(\d+)\s+(?:propert|result|home|listing)", txt, re.I)
        if m:
            return int(m.group(1))
    return None


def _create_stealth_context(browser):
    """Create a browser context with anti-detection measures."""
    context = browser.new_context(
        user_agent=UA,
        viewport={'width': 1366, 'height': 768},
        locale='en-AU',
        timezone_id='Australia/Perth',
        geolocation={'latitude': -31.95, 'longitude': 115.86},
        permissions=['geolocation'],
        color_scheme='light',
        java_script_enabled=True,
        extra_http_headers={
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-AU,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
        }
    )

    # Inject stealth JS on every new page
    context.add_init_script(STEALTH_JS)

    return context


def _load_rea_page(page, url, retries=3):
    """Load a REA page, handling potential bot detection."""
    for attempt in range(1, retries + 1):
        try:
            # Navigate
            page.goto(url, wait_until="domcontentloaded", timeout=35000)

            # Wait for JS rendering
            page.wait_for_timeout(3000)

            # Check for bot detection / captcha / empty page
            content = page.content()
            title = page.title()

            if not title or "access denied" in content.lower():
                logger.warning(f"REA possible block on attempt {attempt}: title='{title}'")
                if attempt < retries:
                    time.sleep(5 * attempt)
                    continue

            if "captcha" in content.lower() or "robot" in content.lower():
                logger.warning(f"REA captcha on attempt {attempt}")
                if attempt < retries:
                    time.sleep(8 * attempt)
                    continue

            # Wait for listing content to appear
            try:
                page.wait_for_selector(
                    '[data-testid*="listing-card"], [data-testid*="result-card"], '
                    '[class*="residential-card"], [class*="listing-card"], '
                    '[class*="ListingCard"], article.css-0',
                    timeout=12000
                )
            except Exception:
                # Content might still be there, just different selectors
                pass

            # Scroll to load all content
            for _ in range(5):
                page.evaluate("window.scrollBy(0, window.innerHeight)")
                page.wait_for_timeout(600)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1200)

            return True
        except Exception as e:
            if attempt < retries:
                time.sleep(3 * attempt)
            else:
                logger.error(f"Failed to load REA page {url}: {e}")
                return False
    return False


def _find_rea_cards(soup):
    """Find listing cards in REA HTML using multiple strategies."""
    cards = []
    seen = set()

    # Strategy 1: data-testid containing "listing-card"
    for el in soup.find_all(True, attrs={"data-testid": re.compile(r"listing-card", re.I)}):
        # Only keep outermost
        parent = el.find_parent(True, attrs={"data-testid": re.compile(r"listing-card", re.I)})
        if parent is None and id(el) not in seen:
            cards.append(el)
            seen.add(id(el))

    # Strategy 2: residential-card class
    if not cards:
        for el in soup.find_all(True, class_=re.compile(r"residential-card|listing-card", re.I)):
            parent = el.find_parent(True, class_=re.compile(r"residential-card|listing-card", re.I))
            if parent is None and id(el) not in seen:
                cards.append(el)
                seen.add(id(el))

    # Strategy 3: article tags in a listing results area
    if not cards:
        results_section = soup.find(True, attrs={"data-testid": re.compile(r"results|search-results", re.I)})
        if not results_section:
            results_section = soup.find(True, class_=re.compile(r"results|search-results", re.I))
        container = results_section or soup
        for article in container.find_all("article"):
            if id(article) not in seen:
                # Must contain at least a link to be a listing
                if article.find("a", href=True):
                    cards.append(article)
                    seen.add(id(article))

    # Strategy 4: divs that contain property links
    if not cards:
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            if "/property-" in href or ("-wa-" in href and re.search(r"/\d+", href)):
                # Walk up to find a meaningful container
                parent = a_tag.parent
                for _ in range(5):
                    if parent and parent.name in ["div", "article", "section", "li"]:
                        if id(parent) not in seen:
                            # Check it's a card-like container (has some text content)
                            text = parent.get_text(strip=True)
                            if len(text) > 20:
                                cards.append(parent)
                                seen.add(id(parent))
                                break
                    if parent:
                        parent = parent.parent

    return cards


def scrape_suburb_rea(suburb_name, suburb_id, progress_callback=None, known_urls=None, cancel_check=None):
    """Scrape all for-sale listings from realestate.com.au for a suburb."""
    postcode = _get_postcode(suburb_name)
    if not postcode:
        logger.error(f"No postcode found for {suburb_name}")
        return {
            'forsale_listings': [], 'sold_listings': [], 'errors': [f'No postcode for {suburb_name}'],
            'stats': {'forsale_count': 0, 'sold_count': 0},
        }

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
            'args': [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1366,768',
            ],
        }
        if CHROMIUM_PATH:
            launch_opts['executable_path'] = CHROMIUM_PATH

        browser = p.chromium.launch(**launch_opts)
        context = _create_stealth_context(browser)

        listing_page = context.new_page()

        # Visit REA homepage first to establish cookies/session
        try:
            listing_page.goto(REA_BASE, wait_until="domcontentloaded", timeout=15000)
            listing_page.wait_for_timeout(2000)
        except Exception as e:
            logger.warning(f"[REA] Could not load homepage: {e}")

        try:
            # === FOR-SALE ===
            if progress_callback:
                progress_callback(f'[REA] Scraping for-sale pages for {suburb_name}...')

            seen_urls = set()
            page_num = 1
            consecutive_empty = 0

            while page_num <= MAX_PAGES:
                if cancel_check and cancel_check():
                    logger.info(f"[REA] {suburb_name}: cancelled")
                    break

                url = _build_rea_buy_url(suburb_name, postcode, page_num)
                if progress_callback:
                    progress_callback(f'[REA] For-sale page {page_num}...')

                if not _load_rea_page(listing_page, url):
                    results['errors'].append(f"[REA] Failed to load page {page_num}")
                    break

                html = listing_page.content()
                soup = BeautifulSoup(html, "html.parser")
                cards = _find_rea_cards(soup)

                # On first page, get total count
                if page_num == 1:
                    rea_total = _get_rea_total(soup)
                    if rea_total:
                        results['stats']['rea_total'] = rea_total
                        logger.info(f"[REA] {suburb_name}: REA says {rea_total} total listings")
                    else:
                        logger.info(f"[REA] {suburb_name}: could not extract total count")

                if not cards:
                    logger.info(f"[REA] {suburb_name} p{page_num}: 0 cards -> done")
                    break

                page_listings = []
                new_on_page = 0

                for card in cards:
                    rec = _parse_rea_card(card, suburb_name)
                    card_url = rec['url']

                    if not card_url:
                        continue
                    if "/agent/" in card_url or "/agency/" in card_url:
                        continue
                    if card_url in seen_urls:
                        continue

                    seen_urls.add(card_url)
                    new_on_page += 1
                    page_listings.append(rec)

                for rec in page_listings:
                    rec['reiwa_url'] = rec['url']  # reuse same DB column
                    results['forsale_listings'].append(rec)

                results['stats']['forsale_pages_scraped'] = page_num
                logger.info(f"[REA] {suburb_name} p{page_num}: {len(cards)} cards, {new_on_page} new, total={len(results['forsale_listings'])}")

                if progress_callback:
                    progress_callback(f'[REA] Page {page_num}: {len(cards)} cards, {new_on_page} new. Total: {len(results["forsale_listings"])}')

                if new_on_page == 0:
                    consecutive_empty += 1
                    if consecutive_empty >= 2:
                        break
                else:
                    consecutive_empty = 0

                page_num += 1
                time.sleep(random.uniform(1.0, 2.0))  # More delay for REA

            results['stats']['forsale_count'] = len(results['forsale_listings'])

            # === SOLD (2 pages) ===
            if progress_callback:
                progress_callback(f'[REA] Scraping sold pages...')

            sold_seen = set()
            for pg in range(1, 3):
                if cancel_check and cancel_check():
                    break

                url = _build_rea_sold_url(suburb_name, postcode, pg)
                if progress_callback:
                    progress_callback(f'[REA] Sold page {pg}...')

                if not _load_rea_page(listing_page, url):
                    break

                html = listing_page.content()
                soup = BeautifulSoup(html, "html.parser")
                cards = _find_rea_cards(soup)

                if not cards:
                    break

                for card in cards:
                    rec = _parse_rea_card(card, suburb_name)
                    card_url = rec['url']

                    if card_url and card_url in sold_seen:
                        continue
                    if card_url:
                        sold_seen.add(card_url)

                    rec['status'] = 'sold'
                    rec['reiwa_url'] = card_url
                    results['sold_listings'].append(rec)

                results['stats']['sold_pages_scraped'] = pg
                logger.info(f"[REA] {suburb_name} sold p{pg}: {len(cards)} cards")

                time.sleep(random.uniform(1.0, 2.0))

            results['stats']['sold_count'] = len(results['sold_listings'])

        except Exception as e:
            logger.error(f"[REA] Fatal error scraping {suburb_name}: {e}")
            results['errors'].append(f"[REA] Fatal error: {str(e)}")
        finally:
            browser.close()

    return results


def debug_rea_page(suburb_name):
    """Debug: see what we get from a REA page. Returns HTML samples and card info."""
    postcode = _get_postcode(suburb_name)
    if not postcode:
        return {'error': f'No postcode for {suburb_name}'}

    url = _build_rea_buy_url(suburb_name, postcode, 1)
    result = {
        'url': url,
        'suburb': suburb_name,
        'postcode': postcode,
        'title': '',
        'cards_found': 0,
        'card_strategies': {},
        'sample_card_html': '',
        'sample_card_parsed': {},
        'total_displayed': None,
        'text_preview': '',
        'bot_detected': False,
        'error': None,
    }

    try:
        with sync_playwright() as p:
            launch_opts = {
                'headless': True,
                'args': [
                    '--no-sandbox', '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--window-size=1366,768',
                ],
            }
            if CHROMIUM_PATH:
                launch_opts['executable_path'] = CHROMIUM_PATH
            browser = p.chromium.launch(**launch_opts)
            context = _create_stealth_context(browser)
            page = context.new_page()

            # Visit homepage first to establish session
            try:
                page.goto(REA_BASE, wait_until="domcontentloaded", timeout=15000)
                page.wait_for_timeout(2000)
            except Exception:
                pass

            _load_rea_page(page, url)
            html = page.content()
            soup = BeautifulSoup(html, "html.parser")

            result['title'] = page.title()
            result['final_url'] = page.url  # Check if redirected

            # Check bot detection
            if "captcha" in html.lower() or "are you a robot" in html.lower() or "access denied" in html.lower():
                result['bot_detected'] = True

            # Capture raw HTML size for debugging
            result['html_size'] = len(html)

            # Try all card strategies and report counts
            s1 = soup.find_all(True, attrs={"data-testid": re.compile(r"listing-card", re.I)})
            s2 = soup.find_all(True, class_=re.compile(r"residential-card|listing-card", re.I))
            s3 = soup.find_all("article")
            result['card_strategies'] = {
                'data-testid=listing-card': len(s1),
                'class=residential-card/listing-card': len(s2),
                'article tags': len(s3),
            }

            cards = _find_rea_cards(soup)
            result['cards_found'] = len(cards)

            if cards:
                result['sample_card_html'] = str(cards[0])[:3000]
                result['sample_card_parsed'] = _parse_rea_card(cards[0], suburb_name)

            result['total_displayed'] = _get_rea_total(soup)
            result['text_preview'] = soup.get_text(" ", strip=True)[:3000]

            browser.close()
    except Exception as e:
        result['error'] = str(e)

    return result

import re
import json
import time
import random
import logging
from datetime import datetime, timedelta

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# Try undetected-chromedriver first (real Chrome, best bypass), then curl_cffi, then cloudscraper
_ENGINE = 'none'
try:
    import undetected_chromedriver as uc
    _ENGINE = 'undetected_chrome'
    print("[REA] >>> Engine: undetected-chromedriver (real Chrome)")
except Exception as _e:
    print(f"[REA] >>> undetected-chromedriver FAILED: {type(_e).__name__}: {_e}")
    try:
        from curl_cffi.requests import Session as CurlSession
        _ENGINE = 'curl_cffi'
        print("[REA] >>> Engine: curl_cffi")
    except Exception as _e2:
        print(f"[REA] >>> curl_cffi FAILED: {_e2}")
        try:
            import cloudscraper
            _ENGINE = 'cloudscraper'
            print("[REA] >>> Engine: cloudscraper")
        except Exception:
            print("[REA] >>> NO ENGINE AVAILABLE")

REA_BASE = "https://www.realestate.com.au"
MAX_PAGES = 10


def _build_rea_buy_url(suburb_name, postcode, page=1):
    slug = suburb_name.lower().replace(' ', '-')
    return f"{REA_BASE}/buy/in-{slug},+wa+{postcode}/list-{page}?includeSurrounding=false&activeSort=list-date&source=refinement"


def _build_rea_sold_url(suburb_name, postcode, page=1):
    slug = suburb_name.lower().replace(' ', '-')
    return f"{REA_BASE}/sold/in-{slug},+wa+{postcode}/list-{page}?includeSurrounding=false&activeSort=list-date&source=refinement"


def _get_postcode(suburb_name):
    from wa_postcodes import WA_POSTCODES
    return WA_POSTCODES.get(suburb_name.strip().title(), "")


_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
}


def _create_chrome_driver():
    """Create an undetected Chrome browser instance."""
    import undetected_chromedriver as uc

    options = uc.ChromeOptions()
    options.add_argument('--headless=new')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('--lang=en-AU')

    driver = uc.Chrome(options=options, version_main=None)
    driver.set_page_load_timeout(30)
    logger.info("[REA] Chrome browser started (undetected-chromedriver)")
    return driver


def _create_http_scraper():
    """Create an HTTP scraper session (curl_cffi or cloudscraper fallback)."""
    if _ENGINE == 'curl_cffi':
        from curl_cffi.requests import Session as CurlSession
        scraper = CurlSession(impersonate="chrome124")
        scraper.headers.update(_HEADERS)
    else:
        try:
            import cloudscraper
            scraper = cloudscraper.create_scraper(
                browser={'browser': 'chrome', 'platform': 'windows', 'desktop': True},
                delay=5,
            )
        except Exception:
            import requests
            scraper = requests.Session()
            scraper.headers.update({
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            })
        scraper.headers.update(_HEADERS)

    # Warm up
    try:
        resp = scraper.get(REA_BASE, timeout=15)
        logger.info(f"[REA] HTTP warmup: {resp.status_code}")
        time.sleep(random.uniform(2.0, 4.0))
    except Exception as e:
        logger.warning(f"[REA] HTTP warmup failed: {e}")

    return scraper


def _fetch_page_chrome(driver, url):
    """Fetch page using undetected Chrome. Returns (html, error)."""
    try:
        driver.get(url)
        # Wait for page to load — check for content or Cloudflare challenge
        time.sleep(random.uniform(3.0, 5.0))

        # Check if Cloudflare challenge is showing
        page_source = driver.page_source
        if 'challenge-platform' in page_source or 'Just a moment' in page_source:
            logger.info("[REA] Cloudflare challenge detected, waiting for it to resolve...")
            time.sleep(8)
            page_source = driver.page_source

        if len(page_source) < 500:
            return None, "Empty page"

        return page_source, None
    except Exception as e:
        return None, str(e)[:200]


def _fetch_page_http(scraper, url, retries=3, progress_callback=None):
    """Fetch page using HTTP. Returns (html, error). Handles 429."""
    backoff_429 = [20, 45, 90]

    for attempt in range(1, retries + 1):
        try:
            resp = scraper.get(url, timeout=15, headers={
                'Referer': REA_BASE + '/buy/in-wa/',
            })

            if resp.status_code == 200:
                html = resp.text
                if len(html) < 500 and ('challenge' in html.lower() or 'cloudflare' in html.lower()):
                    return None, "Cloudflare challenge (blocked)"
                return html, None
            elif resp.status_code == 429:
                wait = backoff_429[min(attempt - 1, len(backoff_429) - 1)]
                logger.warning(f"[REA] HTTP 429 on attempt {attempt}, waiting {wait}s...")
                if progress_callback:
                    progress_callback(f"[REA] Rate limited (429). Waiting {wait}s before retry {attempt}/{retries}...")
                if attempt < retries:
                    time.sleep(wait)
                    continue
                return None, "HTTP 429 - rate limited"
            elif resp.status_code == 403:
                return None, "403 Forbidden"
            else:
                if attempt < retries:
                    time.sleep(3)
                    continue
                return None, f"HTTP {resp.status_code}"
        except Exception as e:
            if attempt < retries:
                time.sleep(3)
            else:
                return None, str(e)[:200]
    return None, "Max retries exceeded"


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


def _extract_next_data(html):
    """Extract listing data from Next.js __NEXT_DATA__ JSON if present."""
    listings = []
    m = re.search(r'<script\s+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return listings

    try:
        data = json.loads(m.group(1))
        # Navigate the Next.js data structure to find listings
        props = data.get('props', {}).get('pageProps', {})

        # Try different paths REA might use
        for key in ['listings', 'results', 'searchResults', 'data']:
            items = props.get(key)
            if isinstance(items, list):
                for item in items:
                    listing = _parse_next_data_listing(item)
                    if listing:
                        listings.append(listing)
                break
            elif isinstance(items, dict):
                # Might be nested: results.exact, results.listings, etc.
                for subkey in ['exact', 'listings', 'results', 'tieredResults']:
                    sub = items.get(subkey)
                    if isinstance(sub, list):
                        for item in sub:
                            listing = _parse_next_data_listing(item)
                            if listing:
                                listings.append(listing)
                        if listings:
                            break

        # Also try componentProps path
        if not listings:
            component_props = props.get('componentProps', {})
            for key, val in component_props.items():
                if isinstance(val, dict) and 'listings' in val:
                    for item in val['listings']:
                        listing = _parse_next_data_listing(item)
                        if listing:
                            listings.append(listing)
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        logger.warning(f"[REA] Error parsing __NEXT_DATA__: {e}")

    return listings


def _parse_next_data_listing(item):
    """Parse a single listing from Next.js JSON data."""
    if not isinstance(item, dict):
        return None

    # REA JSON listings typically have these fields
    listing = item.get('listing') or item
    if not isinstance(listing, dict):
        return None

    url = listing.get('listingUrl') or listing.get('url') or listing.get('_links', {}).get('canonical', {}).get('href', '')
    if url and not url.startswith('http'):
        url = REA_BASE + url

    address_parts = listing.get('address', {})
    if isinstance(address_parts, dict):
        display_addr = address_parts.get('display', {})
        if isinstance(display_addr, dict):
            address = display_addr.get('shortAddress', '') or display_addr.get('fullAddress', '')
        elif isinstance(display_addr, str):
            address = display_addr
        else:
            address = address_parts.get('streetAddress', '') or address_parts.get('displayAddress', '')
    elif isinstance(address_parts, str):
        address = address_parts
    else:
        address = ''

    price = listing.get('price', {})
    if isinstance(price, dict):
        price_text = price.get('display', '') or price.get('displayPrice', '') or ''
    elif isinstance(price, str):
        price_text = price
    else:
        price_text = ''

    features = listing.get('features', {}) or listing.get('generalFeatures', {}) or {}
    if isinstance(features, dict):
        beds = features.get('bedrooms') or features.get('beds')
        baths = features.get('bathrooms') or features.get('baths')
        cars = features.get('parkingSpaces') or features.get('parking') or features.get('garageSpaces')
    else:
        beds = baths = cars = None

    prop_type = listing.get('propertyType', '') or listing.get('propertyCategory', '') or ''

    agency_info = listing.get('agency', {}) or listing.get('lister', {}) or {}
    agency = ''
    if isinstance(agency_info, dict):
        agency = agency_info.get('name', '') or agency_info.get('brandName', '')

    agents = listing.get('agents', []) or listing.get('listers', [])
    agent = ''
    if isinstance(agents, list) and agents:
        first = agents[0]
        if isinstance(first, dict):
            agent = first.get('name', '') or first.get('displayName', '')

    status = 'active'
    status_text = listing.get('status', '') or listing.get('listingStatus', '') or ''
    if 'under' in status_text.lower():
        status = 'under_offer'
    elif 'sold' in status_text.lower():
        status = 'sold'

    land_size = ''
    prop_sizes = listing.get('propertySizes', {}) or {}
    if isinstance(prop_sizes, dict):
        land = prop_sizes.get('land', {}) or {}
        if isinstance(land, dict):
            ls = land.get('displayValue', '') or land.get('value', '')
            if ls:
                land_size = str(ls)
                if 'm' not in land_size.lower():
                    land_size += ' m²'

    date_text = ''
    date_available = listing.get('dateAvailable', '') or listing.get('dateListed', '') or listing.get('listedDate', '')
    if date_available:
        try:
            dt = datetime.fromisoformat(date_available.replace('Z', '+00:00'))
            date_text = dt.strftime("%d/%m/%Y")
        except (ValueError, TypeError):
            date_text = _parse_date_text_rea(str(date_available))

    if not url:
        return None

    return {
        "url": url,
        "address": address or "Address not disclosed",
        "price_text": price_text,
        "listing_type": prop_type.title() if prop_type else "",
        "bedrooms": int(beds) if beds is not None else None,
        "bathrooms": int(baths) if baths is not None else None,
        "parking": int(cars) if cars is not None else None,
        "land_size": land_size,
        "internal_size": "",
        "agency": _normalise_agency(agency),
        "agent": agent,
        "status": status,
        "listing_date": date_text,
        "source": "rea",
    }


def _parse_rea_card(card, suburb_name):
    """Parse one REA listing card from HTML."""
    result = {
        "url": "", "address": "", "price_text": "", "listing_type": "",
        "bedrooms": None, "bathrooms": None, "parking": None,
        "land_size": "", "internal_size": "",
        "agency": "", "agent": "", "status": "active",
        "listing_date": "", "source": "rea",
    }

    # --- URL ---
    for a_tag in card.find_all("a", href=True):
        href = a_tag["href"]
        if "/property-" in href or re.search(r"/\d+-[a-z]", href):
            full = (REA_BASE + href) if href.startswith("/") else href
            if "/news/" in href or "/insights/" in href or "/agent/" in href:
                continue
            result["url"] = full
            break
    if not result["url"]:
        suburb_slug = suburb_name.lower().replace(" ", "-")
        for a_tag in card.find_all("a", href=True):
            href = a_tag["href"]
            if suburb_slug in href.lower() and ("/buy/" in href or "/property" in href or "-wa-" in href):
                full = (REA_BASE + href) if href.startswith("/") else href
                result["url"] = full
                break

    # --- Address ---
    addr_el = card.find(attrs={"data-testid": re.compile(r"address|listing-card-address", re.I)})
    if not addr_el:
        addr_el = card.find(["h2", "h3"])
    if not addr_el:
        for a_tag in card.find_all("a", href=True):
            txt = a_tag.get_text(strip=True)
            if txt and 5 < len(txt) < 120 and not txt.startswith("$"):
                if re.search(r"\d+\s+\w+|lot\s+\d+|unit\s+\d+", txt, re.I):
                    addr_el = a_tag
                    break
    if addr_el:
        address = addr_el.get_text(strip=True)
        address = re.sub(r",?\s*" + re.escape(suburb_name) + r"(\s+WA\s*\d*)?$", "", address, flags=re.I).strip()
        address = re.sub(r",?\s*WA\s*\d*$", "", address).strip()
        result["address"] = address
    if not result["address"]:
        result["address"] = "Address not disclosed"

    # --- Price ---
    card_text = card.get_text(" ", strip=True)
    for el in card.find_all(["span", "p", "div", "strong"]):
        txt = el.get_text(strip=True)
        if not txt or len(txt) > 100 or len(txt) < 2:
            continue
        if re.match(r"^(auction|price on application|contact agent|by negotiation|expressions? of interest)$", txt, re.I):
            result["price_text"] = txt
            break
        m = re.search(r"\$([\d,]+)\s*[-\u2013]\s*\$([\d,]+)", txt)
        if m:
            result["price_text"] = f"${m.group(1)} - ${m.group(2)}"
            break
        m = re.search(r"((?:offers?\s+(?:from|over|above|around)|from|above|over)\s*\$[\d,\.]+)", txt, re.I)
        if m:
            result["price_text"] = m.group(1).strip()
            break
        m = re.search(r"\$(\d{1,3}(?:,\d{3})+)", txt)
        if m:
            result["price_text"] = f"${m.group(1)}"
            break

    # --- Features ---
    ct = card_text
    nums = re.findall(r"(\d+)\s*(?:bed|Bed)", ct)
    if nums:
        result["bedrooms"] = int(nums[0])
    nums = re.findall(r"(\d+)\s*(?:bath|Bath)", ct)
    if nums:
        result["bathrooms"] = int(nums[0])
    nums = re.findall(r"(\d+)\s*(?:car|Car|park|Park|garage|Garage)", ct)
    if nums:
        result["parking"] = int(nums[0])

    # --- Land size ---
    cn = re.sub(r"m\s+2\b", "m2", ct, flags=re.I)
    for pat in [r"(\d[\d,]*)\s*m[²2]", r"land\s*(?:size|area)?[:\s]*([\d,]+)\s*m"]:
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
        if re.search(r"\b" + t + r"\b", ct, re.I):
            result["listing_type"] = t
            break

    # --- Agency ---
    for img in card.find_all("img", alt=True):
        alt = img["alt"]
        if len(alt) > 3 and not alt.startswith("$") and not alt[0].isdigit():
            result["agency"] = _normalise_agency(alt)
            break

    # --- Status ---
    if re.search(r"under\s+offer|under\s+contract", ct, re.I):
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
    """Extract total listing count REA shows."""
    for el in soup.find_all(["h1", "h2", "span", "p", "strong"]):
        txt = el.get_text(strip=True)
        m = re.search(r"(\d+)\s+(?:propert|result|home|listing)", txt, re.I)
        if m:
            return int(m.group(1))
    return None


def _find_rea_cards(soup):
    """Find listing cards in REA HTML."""
    cards = []
    seen = set()

    # Strategy 1: data-testid
    for el in soup.find_all(True, attrs={"data-testid": re.compile(r"listing-card", re.I)}):
        parent = el.find_parent(True, attrs={"data-testid": re.compile(r"listing-card", re.I)})
        if parent is None and id(el) not in seen:
            cards.append(el)
            seen.add(id(el))

    # Strategy 2: class patterns
    if not cards:
        for el in soup.find_all(True, class_=re.compile(r"residential-card|listing-card|ListingCard", re.I)):
            parent = el.find_parent(True, class_=re.compile(r"residential-card|listing-card|ListingCard", re.I))
            if parent is None and id(el) not in seen:
                cards.append(el)
                seen.add(id(el))

    # Strategy 3: article tags
    if not cards:
        for article in soup.find_all("article"):
            if article.find("a", href=True) and id(article) not in seen:
                cards.append(article)
                seen.add(id(article))

    # Strategy 4: divs with property links
    if not cards:
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            if "/property-" in href or ("-wa-" in href and re.search(r"/\d+", href)):
                parent = a_tag.parent
                for _ in range(5):
                    if parent and parent.name in ["div", "article", "section", "li"]:
                        if id(parent) not in seen:
                            text = parent.get_text(strip=True)
                            if len(text) > 20:
                                cards.append(parent)
                                seen.add(id(parent))
                                break
                    if parent:
                        parent = parent.parent

    return cards


def _fetch_page(driver_or_scraper, url, progress_callback=None):
    """Fetch a page using either Chrome driver or HTTP scraper. Returns (html, error)."""
    if _ENGINE == 'undetected_chrome' and hasattr(driver_or_scraper, 'get') and hasattr(driver_or_scraper, 'page_source'):
        return _fetch_page_chrome(driver_or_scraper, url)
    else:
        return _fetch_page_http(driver_or_scraper, url, progress_callback=progress_callback)


def scrape_suburb_rea(suburb_name, suburb_id, progress_callback=None, known_urls=None, cancel_check=None, shared_scraper=None):
    """Scrape REA listings. Uses undetected-chromedriver if available, else HTTP.

    Pass shared_scraper to reuse a session/driver across multiple suburbs.
    """
    postcode = _get_postcode(suburb_name)
    if not postcode:
        return {
            'forsale_listings': [], 'sold_listings': [],
            'errors': [f'No postcode for {suburb_name}'],
            'stats': {'forsale_count': 0, 'sold_count': 0},
        }

    results = {
        'forsale_listings': [], 'sold_listings': [], 'errors': [],
        'stats': {
            'forsale_pages_scraped': 0, 'sold_pages_scraped': 0,
            'forsale_count': 0, 'sold_count': 0, 'detail_pages_scraped': 0,
        }
    }

    # Use shared session/driver or create new one
    own_driver = False
    if shared_scraper:
        fetcher = shared_scraper
    elif _ENGINE == 'undetected_chrome':
        fetcher = _create_chrome_driver()
        own_driver = True
    else:
        fetcher = _create_http_scraper()

    seen_urls = set()

    try:
        # === FOR-SALE ===
        if progress_callback:
            progress_callback(f'[REA] Scraping for-sale pages for {suburb_name}...')

        page_num = 1
        consecutive_empty = 0

        while page_num <= MAX_PAGES:
            if cancel_check and cancel_check():
                break

            url = _build_rea_buy_url(suburb_name, postcode, page_num)
            if progress_callback:
                progress_callback(f'[REA] For-sale page {page_num}...')

            html, error = _fetch_page(fetcher, url, progress_callback=progress_callback)
            if error:
                results['errors'].append(f"[REA] Page {page_num}: {error}")
                break
            if not html:
                break

            # Try __NEXT_DATA__ JSON first (most reliable)
            json_listings = _extract_next_data(html)

            if json_listings:
                new_on_page = 0
                for rec in json_listings:
                    card_url = rec['url']
                    if card_url in seen_urls:
                        continue
                    seen_urls.add(card_url)
                    new_on_page += 1
                    rec['reiwa_url'] = card_url
                    results['forsale_listings'].append(rec)

                logger.info(f"[REA] {suburb_name} p{page_num}: {len(json_listings)} from JSON, {new_on_page} new")
            else:
                # Fallback: parse HTML cards
                soup = BeautifulSoup(html, "html.parser")
                cards = _find_rea_cards(soup)

                if page_num == 1:
                    rea_total = _get_rea_total(soup)
                    if rea_total:
                        results['stats']['rea_total'] = rea_total

                new_on_page = 0
                for card in cards:
                    rec = _parse_rea_card(card, suburb_name)
                    card_url = rec['url']
                    if not card_url or card_url in seen_urls:
                        continue
                    if "/agent/" in card_url or "/agency/" in card_url:
                        continue
                    seen_urls.add(card_url)
                    new_on_page += 1
                    rec['reiwa_url'] = card_url
                    results['forsale_listings'].append(rec)

                logger.info(f"[REA] {suburb_name} p{page_num}: {len(cards)} cards, {new_on_page} new")

            results['stats']['forsale_pages_scraped'] = page_num

            if progress_callback:
                progress_callback(f'[REA] Page {page_num}: {new_on_page} new. Total: {len(results["forsale_listings"])}')

            if new_on_page == 0:
                consecutive_empty += 1
                if consecutive_empty >= 2:
                    break
            else:
                consecutive_empty = 0

            page_num += 1
            time.sleep(random.uniform(5.0, 8.0))

        results['stats']['forsale_count'] = len(results['forsale_listings'])

        # Pause between for-sale and sold sections
        time.sleep(random.uniform(5.0, 8.0))

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

            html, error = _fetch_page(fetcher, url, progress_callback=progress_callback)
            if error or not html:
                break

            json_listings = _extract_next_data(html)
            if json_listings:
                for rec in json_listings:
                    card_url = rec['url']
                    if card_url in sold_seen:
                        continue
                    sold_seen.add(card_url)
                    rec['status'] = 'sold'
                    rec['reiwa_url'] = card_url
                    results['sold_listings'].append(rec)
            else:
                soup = BeautifulSoup(html, "html.parser")
                cards = _find_rea_cards(soup)
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
            time.sleep(random.uniform(5.0, 8.0))

        results['stats']['sold_count'] = len(results['sold_listings'])

    finally:
        # Close the Chrome driver if we created it (not shared)
        if own_driver and hasattr(fetcher, 'quit'):
            try:
                fetcher.quit()
                logger.info("[REA] Chrome driver closed")
            except Exception:
                pass

    return results


def debug_rea_page(suburb_name):
    """Debug: see what we get from a REA page."""
    postcode = _get_postcode(suburb_name)
    if not postcode:
        return {'error': f'No postcode for {suburb_name}'}

    url = _build_rea_buy_url(suburb_name, postcode, 1)
    result = {
        'url': url, 'suburb': suburb_name, 'postcode': postcode,
        'engine': _ENGINE,
        'http_status': None, 'title': '', 'cards_found': 0,
        'json_listings_found': 0, 'sample_card_parsed': {},
        'total_displayed': None, 'text_preview': '',
        'html_size': 0, 'html_preview': '',
        'bot_detected': False, 'error': None,
    }

    driver = None
    try:
        if _ENGINE == 'undetected_chrome':
            # Use real Chrome for debug
            driver = _create_chrome_driver()
            html, error = _fetch_page_chrome(driver, url)
            if error:
                result['error'] = error
                return result
            result['http_status'] = 200
        else:
            scraper = _create_http_scraper()
            resp = scraper.get(url, timeout=15, headers={'Referer': REA_BASE + '/buy/in-wa/'})
            result['http_status'] = resp.status_code

            if resp.status_code != 200:
                body = resp.text or ''
                result['error'] = f"HTTP {resp.status_code}"
                result['html_size'] = len(body)
                result['html_preview'] = body[:2000]
                return result
            html = resp.text

        result['html_size'] = len(html)
        result['html_preview'] = html[:2000]

        soup = BeautifulSoup(html, "html.parser")
        result['title'] = soup.title.string if soup.title else ''

        if "captcha" in html.lower() or "are you a robot" in html.lower() or "access denied" in html.lower():
            result['bot_detected'] = True

        json_listings = _extract_next_data(html)
        result['json_listings_found'] = len(json_listings)
        if json_listings:
            result['sample_card_parsed'] = json_listings[0]

        cards = _find_rea_cards(soup)
        result['cards_found'] = len(cards)
        if cards and not json_listings:
            result['sample_card_parsed'] = _parse_rea_card(cards[0], suburb_name)

        result['total_displayed'] = _get_rea_total(soup)
        result['text_preview'] = soup.get_text(" ", strip=True)[:2000]

    except Exception as e:
        result['error'] = str(e)
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass

    return result

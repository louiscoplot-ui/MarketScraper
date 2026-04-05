import re
import time
import logging
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

logger = logging.getLogger(__name__)

REIWA_BASE = "https://reiwa.com.au"
PAGE_LOAD_TIMEOUT = 30000
LISTING_TIMEOUT = 20000

# Use system-installed Chromium if available, otherwise let Playwright find one
import os
CHROMIUM_PATH = os.environ.get(
    'CHROMIUM_PATH',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
)
if not os.path.exists(CHROMIUM_PATH):
    CHROMIUM_PATH = None  # Let Playwright use its default


def _normalize_address(address):
    """Normalize address for deduplication."""
    if not address:
        return ""
    addr = address.strip().lower()
    addr = re.sub(r'\s+', ' ', addr)
    # Remove unit/lot prefixes variations for matching
    addr = re.sub(r'^(unit|lot|apt|suite)\s+', '', addr)
    return addr


def _extract_number(text):
    """Extract first integer from text."""
    if not text:
        return None
    match = re.search(r'(\d+)', text.strip())
    return int(match.group(1)) if match else None


def scrape_suburb(suburb_slug, suburb_id, progress_callback=None):
    """
    Scrape all for-sale and sold listings for a suburb.
    Returns dict with all listing data and stats.
    """
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
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ]
        }
        if CHROMIUM_PATH:
            launch_opts['executable_path'] = CHROMIUM_PATH
        browser = p.chromium.launch(**launch_opts)
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport={'width': 1920, 'height': 1080},
            locale='en-AU',
        )
        # Stealth: remove webdriver flag
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)

        page = context.new_page()

        try:
            # --- SCRAPE FOR-SALE LISTINGS ---
            if progress_callback:
                progress_callback('Scraping for-sale listings...')

            forsale_urls = _scrape_listing_urls(
                page, suburb_slug, 'for-sale', max_pages=10, results=results
            )

            if progress_callback:
                progress_callback(f'Found {len(forsale_urls)} for-sale listing URLs. Fetching details...')

            # Visit each listing page for full details
            seen_addresses = set()
            for i, (url, card_data) in enumerate(forsale_urls):
                if progress_callback and i % 5 == 0:
                    progress_callback(f'Scraping listing {i+1}/{len(forsale_urls)}...')
                try:
                    detail = _scrape_listing_detail(page, url)
                    merged = {**card_data, **{k: v for k, v in detail.items() if v is not None}}
                    merged['reiwa_url'] = url

                    # Deduplicate by normalized address
                    norm_addr = _normalize_address(merged.get('address', ''))
                    if norm_addr and norm_addr not in seen_addresses:
                        seen_addresses.add(norm_addr)
                        results['forsale_listings'].append(merged)
                        results['stats']['detail_pages_scraped'] += 1
                    elif norm_addr:
                        logger.info(f"Duplicate skipped: {merged.get('address')}")
                except Exception as e:
                    logger.error(f"Error scraping {url}: {e}")
                    results['errors'].append(f"Detail page error: {url} - {str(e)}")

            results['stats']['forsale_count'] = len(results['forsale_listings'])

            # --- SCRAPE SOLD LISTINGS (first 2 pages) ---
            if progress_callback:
                progress_callback('Scraping sold listings...')

            sold_urls = _scrape_listing_urls(
                page, suburb_slug, 'sold', max_pages=2, results=results
            )

            if progress_callback:
                progress_callback(f'Found {len(sold_urls)} sold listing URLs. Fetching details...')

            seen_sold_addresses = set()
            for i, (url, card_data) in enumerate(sold_urls):
                if progress_callback and i % 5 == 0:
                    progress_callback(f'Scraping sold listing {i+1}/{len(sold_urls)}...')
                try:
                    detail = _scrape_listing_detail(page, url)
                    merged = {**card_data, **{k: v for k, v in detail.items() if v is not None}}
                    merged['reiwa_url'] = url
                    merged['status'] = 'sold'

                    norm_addr = _normalize_address(merged.get('address', ''))
                    if norm_addr and norm_addr not in seen_sold_addresses:
                        seen_sold_addresses.add(norm_addr)
                        results['sold_listings'].append(merged)
                    elif norm_addr:
                        logger.info(f"Duplicate sold skipped: {merged.get('address')}")
                except Exception as e:
                    logger.error(f"Error scraping sold {url}: {e}")
                    results['errors'].append(f"Sold detail error: {url} - {str(e)}")

            results['stats']['sold_count'] = len(results['sold_listings'])

        except Exception as e:
            logger.error(f"Fatal scrape error for {suburb_slug}: {e}")
            results['errors'].append(f"Fatal error: {str(e)}")
        finally:
            browser.close()

    return results


def _scrape_listing_urls(page, suburb_slug, listing_type, max_pages, results):
    """
    Scrape listing card URLs and basic card data from search result pages.
    listing_type: 'for-sale' or 'sold'
    Returns list of (url, card_data) tuples.
    """
    all_listings = []
    stats_key = 'forsale_pages_scraped' if listing_type == 'for-sale' else 'sold_pages_scraped'

    for page_num in range(1, max_pages + 1):
        url = f"{REIWA_BASE}/{listing_type}/{suburb_slug}/?includesurroundingsuburbs=false&sortby=listdate"
        if page_num > 1:
            url += f"&page={page_num}"

        logger.info(f"Scraping {listing_type} page {page_num}: {url}")

        try:
            page.goto(url, wait_until='domcontentloaded', timeout=PAGE_LOAD_TIMEOUT)
            time.sleep(2)  # Let dynamic content load

            # Wait for listing cards to appear
            page.wait_for_selector('[class*="listing-card"], [class*="PropertyCard"], [class*="property-card"], a[href*="/{listing_type}/"] [class*="card"], .search-results-list a, [data-testid*="listing"], [class*="ListingCard"]', timeout=10000)
            time.sleep(1)

            # Extract listing links and card data from the page
            cards = page.evaluate("""() => {
                const results = [];

                // Strategy 1: Find all links that look like property listings
                const allLinks = document.querySelectorAll('a[href]');
                const seenUrls = new Set();

                for (const link of allLinks) {
                    const href = link.getAttribute('href') || '';
                    const fullHref = href.startsWith('/') ? href : '/' + href;

                    // REIWA listing URLs typically look like: /123-street-name-suburb/
                    // They contain a number followed by street name and suburb
                    // Exclude navigation, pagination, agent, and search URLs
                    if (
                        fullHref.match(/^\/\d+[a-z]?-[a-z]+-[a-z]+/) &&
                        !fullHref.includes('/for-sale/') &&
                        !fullHref.includes('/sold/') &&
                        !fullHref.includes('/rent/') &&
                        !fullHref.includes('/agent/') &&
                        !fullHref.includes('/agency/') &&
                        !fullHref.includes('?') &&
                        !seenUrls.has(fullHref)
                    ) {
                        seenUrls.add(fullHref);

                        // Try to get card-level data
                        const card = link.closest('[class*="card"], [class*="Card"], [class*="listing"], [class*="Listing"], [class*="property"], [class*="Property"], li, article') || link;
                        const text = card.innerText || '';

                        // Check for under offer
                        const isUnderOffer = text.toLowerCase().includes('under offer');

                        // Try to get price from card
                        const priceMatch = text.match(/\$[\d,]+(?:\.\d+)?(?:\s*[-–]\s*\$[\d,]+(?:\.\d+)?)?/);
                        const price = priceMatch ? priceMatch[0] : null;

                        // Try to get address - usually the first prominent text
                        const addressEl = card.querySelector('h2, h3, h4, [class*="address"], [class*="Address"]');
                        const address = addressEl ? addressEl.innerText.trim() : null;

                        results.push({
                            url: fullHref,
                            price_text: price,
                            address: address,
                            is_under_offer: isUnderOffer,
                        });
                    }
                }

                return results;
            }""")

            if not cards or len(cards) == 0:
                # Try alternate extraction: look for any structured listing content
                cards = page.evaluate("""() => {
                    const results = [];
                    // Look for structured data or JSON-LD
                    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                    for (const s of scripts) {
                        try {
                            const data = JSON.parse(s.textContent);
                            if (data['@type'] === 'ItemList' && data.itemListElement) {
                                for (const item of data.itemListElement) {
                                    if (item.url) {
                                        results.push({
                                            url: item.url.replace('https://reiwa.com.au', ''),
                                            price_text: null,
                                            address: item.name || null,
                                            is_under_offer: false,
                                        });
                                    }
                                }
                            }
                        } catch(e) {}
                    }
                    return results;
                }""")

            if not cards or len(cards) == 0:
                logger.warning(f"No listings found on {listing_type} page {page_num}")
                # If first page has no results, the suburb might have no listings
                if page_num == 1:
                    break
                # Otherwise we've gone past the last page
                break

            for card in cards:
                card_url = REIWA_BASE + card['url'] if not card['url'].startswith('http') else card['url']
                card_data = {
                    'price_text': card.get('price_text'),
                    'address': card.get('address'),
                    'status': 'under_offer' if card.get('is_under_offer') else ('sold' if listing_type == 'sold' else 'active'),
                }
                all_listings.append((card_url, card_data))

            results['stats'][stats_key] = page_num
            logger.info(f"Found {len(cards)} listings on {listing_type} page {page_num}")

            # Check if there's a next page
            has_next = page.evaluate("""() => {
                const nextLinks = document.querySelectorAll('a[href*="page="], [class*="next"], [class*="Next"], [aria-label="Next"]');
                return nextLinks.length > 0;
            }""")

            if not has_next:
                break

            time.sleep(1)  # Be polite between pages

        except PlaywrightTimeout:
            logger.warning(f"Timeout on {listing_type} page {page_num}")
            if page_num == 1:
                results['errors'].append(f"Timeout loading {listing_type} page 1")
            break
        except Exception as e:
            logger.error(f"Error on {listing_type} page {page_num}: {e}")
            results['errors'].append(f"Error on {listing_type} page {page_num}: {str(e)}")
            break

    return all_listings


def _scrape_listing_detail(page, url):
    """Scrape individual listing page for full details."""
    detail = {
        'address': None,
        'price_text': None,
        'bedrooms': None,
        'bathrooms': None,
        'parking': None,
        'land_size': None,
        'internal_size': None,
        'agency': None,
        'agent': None,
        'listing_type': None,
        'sold_price': None,
        'sold_date': None,
    }

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=LISTING_TIMEOUT)
        time.sleep(1.5)

        data = page.evaluate("""() => {
            const result = {};
            const text = document.body.innerText || '';
            const html = document.body.innerHTML || '';

            // Address - usually in h1 or prominent header
            const h1 = document.querySelector('h1');
            if (h1) result.address = h1.innerText.trim();

            // Price
            const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"], [data-testid*="price"]');
            for (const el of priceEls) {
                const t = el.innerText.trim();
                if (t && (t.includes('$') || t.toLowerCase().includes('offer') || t.toLowerCase().includes('contact'))) {
                    result.price_text = t;
                    break;
                }
            }
            if (!result.price_text) {
                const priceMatch = text.match(/(?:Price|Asking|From|Offers?)[\s:]*(\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?)/i);
                if (priceMatch) result.price_text = priceMatch[1];
            }

            // Property features (bed/bath/car/land/internal)
            // Look for structured feature elements
            const featureEls = document.querySelectorAll('[class*="feature"], [class*="Feature"], [class*="attribute"], [class*="Attribute"], [class*="property-info"], [class*="PropertyInfo"], [class*="bed"], [class*="bath"], [class*="car"]');

            // Also search in the full text for patterns
            const bedMatch = text.match(/(\d+)\s*(?:bed(?:room)?s?|Bed(?:room)?s?)/i);
            if (bedMatch) result.bedrooms = parseInt(bedMatch[1]);

            const bathMatch = text.match(/(\d+)\s*(?:bath(?:room)?s?|Bath(?:room)?s?)/i);
            if (bathMatch) result.bathrooms = parseInt(bathMatch[1]);

            const carMatch = text.match(/(\d+)\s*(?:car\s*(?:space|bay|garage)?s?|Car\s*(?:space|bay|garage)?s?|parking|garage|Garage)/i);
            if (carMatch) result.parking = parseInt(carMatch[1]);

            // Land size
            const landMatch = text.match(/(?:land\s*(?:size|area)?|block\s*size|lot\s*size)[\s:]*(\d[\d,]*\.?\d*)\s*(?:m²|sqm|m2)/i);
            if (landMatch) result.land_size = landMatch[1].replace(',', '') + ' m²';
            // Also try standalone m² patterns near "land"
            if (!result.land_size) {
                const landMatch2 = text.match(/(\d[\d,]*\.?\d*)\s*(?:m²|sqm|m2)\s*(?:land|block|lot)/i);
                if (landMatch2) result.land_size = landMatch2[1].replace(',', '') + ' m²';
            }

            // Internal/floor size
            const intMatch = text.match(/(?:internal\s*(?:size|area)?|floor\s*(?:size|area)?|living\s*area|building\s*(?:size|area))[\s:]*(\d[\d,]*\.?\d*)\s*(?:m²|sqm|m2)/i);
            if (intMatch) result.internal_size = intMatch[1].replace(',', '') + ' m²';

            // Agency
            const agencyEls = document.querySelectorAll('[class*="agency"], [class*="Agency"], [class*="brand"], [class*="office"]');
            for (const el of agencyEls) {
                const t = el.innerText.trim();
                if (t && t.length > 2 && t.length < 100) {
                    result.agency = t.split('\\n')[0].trim();
                    break;
                }
            }

            // Agent
            const agentEls = document.querySelectorAll('[class*="agent-name"], [class*="AgentName"], [class*="agent"] [class*="name"], [class*="Agent"] [class*="Name"]');
            for (const el of agentEls) {
                const t = el.innerText.trim();
                if (t && t.length > 2 && t.length < 80) {
                    result.agent = t;
                    break;
                }
            }
            // Fallback: look for agent section
            if (!result.agent) {
                const agentSection = document.querySelector('[class*="agent"], [class*="Agent"], [class*="contact"]');
                if (agentSection) {
                    const nameEl = agentSection.querySelector('h3, h4, strong, [class*="name"]');
                    if (nameEl) result.agent = nameEl.innerText.trim();
                }
            }

            // Listing type (house, unit, land, etc.)
            const typeMatch = text.match(/(?:Property Type|Type)[\s:]*([A-Za-z\s]+?)(?:\n|$)/i);
            if (typeMatch) result.listing_type = typeMatch[1].trim();

            // Sold info
            const soldPriceMatch = text.match(/(?:Sold|Sale)\s*(?:Price)?[\s:]*(\$[\d,]+)/i);
            if (soldPriceMatch) result.sold_price = soldPriceMatch[1];

            const soldDateMatch = text.match(/(?:Sold|Sale)\s*(?:Date|on)?[\s:]*(\d{1,2}\s+\w+\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i);
            if (soldDateMatch) result.sold_date = soldDateMatch[1];

            // Try structured data (JSON-LD)
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const s of scripts) {
                try {
                    const d = JSON.parse(s.textContent);
                    if (d['@type'] === 'Product' || d['@type'] === 'RealEstateListing' || d['@type'] === 'Residence') {
                        if (d.name && !result.address) result.address = d.name;
                        if (d.offers && d.offers.price && !result.price_text) {
                            result.price_text = '$' + Number(d.offers.price).toLocaleString();
                        }
                    }
                    // SingleFamilyResidence or similar
                    if (d.numberOfBedrooms && !result.bedrooms) result.bedrooms = parseInt(d.numberOfBedrooms);
                    if (d.numberOfBathroomsTotal && !result.bathrooms) result.bathrooms = parseInt(d.numberOfBathroomsTotal);
                } catch(e) {}
            }

            // Look for icon-based features (common in real estate sites)
            const allElements = document.querySelectorAll('[class*="bed"], [class*="bath"], [class*="car"], [class*="Bed"], [class*="Bath"], [class*="Car"]');
            for (const el of allElements) {
                const cls = (el.className || '').toLowerCase();
                const val = parseInt(el.innerText.trim());
                if (!isNaN(val)) {
                    if (cls.includes('bed') && !result.bedrooms) result.bedrooms = val;
                    else if (cls.includes('bath') && !result.bathrooms) result.bathrooms = val;
                    else if (cls.includes('car') && !result.parking) result.parking = val;
                }
            }

            return result;
        }""")

        for key, val in data.items():
            if val is not None:
                detail[key] = val

    except PlaywrightTimeout:
        logger.warning(f"Timeout loading detail page: {url}")
    except Exception as e:
        logger.error(f"Error on detail page {url}: {e}")

    return detail

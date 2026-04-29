"""REIWA scraper — orchestrator for one suburb's daily scrape.

Helpers extracted to keep this module under the MCP push size limit:
  scraper_utils    — URL builders, listing_id, normalise_agency, constants
  scraper_dates    — listing-date parsing
  scraper_card     — grid card parser
  scraper_detail   — detail page fetcher + verify_disappeared_listings + debug_detail
  scraper_browser  — page loader + debug_page + compare_suburb

This file keeps scrape_suburb (the per-suburb orchestrator) plus
re-exports the helpers app.py imports under their original names.
"""

import re
import time
import random
import logging

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

from scraper_utils import (
    REIWA_BASE, MAX_PAGES, UA, DETAIL_TABS, CHROMIUM_PATH,
    _clean_listing_url, _build_url, _build_sold_url, _listing_id, _normalise_agency,
)
from scraper_dates import _parse_date_text, _extract_date
from scraper_card import _parse_card
from scraper_detail import (
    _fetch_detail, _fetch_details_batch,
    verify_disappeared_listings, debug_detail,
)
from scraper_browser import (
    _get_reiwa_total, _count_cards, _extract_all_listing_urls_js,
    _load_listing_page, debug_page, compare_suburb,
)

logger = logging.getLogger(__name__)


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

                for fb_page in range(1, MAX_PAGES + 1):
                    if recovered >= missing:
                        break
                    fb_url = _build_url(suburb_slug, fb_page)
                    if not _load_listing_page(listing_page, fb_url):
                        break

                    html = listing_page.content()
                    fb_soup = BeautifulSoup(html, "html.parser")

                    try:
                        fb_js_urls = _extract_all_listing_urls_js(listing_page)
                    except Exception:
                        fb_js_urls = []

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

                    if new_on_fb_page == 0 and fb_page > pages_scraped:
                        if recovered < missing:
                            if fb_page > pages_scraped + 3:
                                break
                        else:
                            break
                    time.sleep(0.3)

                if recovered:
                    results['stats']['forsale_count'] = len(results['forsale_listings'])
                    logger.info(f"{suburb_name}: recovered {recovered}/{missing} missed listing(s), new total: {results['stats']['forsale_count']}")

            # === SOLD (up to 10 pages — REIWA shows ~20 sold per page; high-
            # turnover suburbs like Ellenbrook can have recently-sold listings
            # past page 4. Stop early on empty/duplicate pages.)
            if progress_callback:
                progress_callback('Scraping sold pages...')

            SOLD_MAX_PAGES = 10
            sold_seen = set()
            for pg in range(1, SOLD_MAX_PAGES + 1):
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

                new_on_page = 0
                for card in cards:
                    rec = _parse_card(card, suburb_name)
                    card_url = rec['url']

                    if card_url and card_url in sold_seen:
                        continue
                    if card_url:
                        sold_seen.add(card_url)
                        new_on_page += 1

                    rec['status'] = 'sold'
                    rec['reiwa_url'] = card_url
                    results['sold_listings'].append(rec)

                results['stats']['sold_pages_scraped'] = pg
                logger.info(f"{suburb_name} sold p{pg}: {len(cards)} cards, {new_on_page} new")

                if new_on_page == 0 and pg > 1:
                    # Page returned only duplicates — REIWA likely loops back to
                    # earlier results. No point scanning further.
                    break
                time.sleep(random.uniform(0.3, 0.8))

            results['stats']['sold_count'] = len(results['sold_listings'])

        except Exception as e:
            logger.error(f"Fatal error scraping {suburb_name}: {e}")
            results['errors'].append(f"Fatal error: {str(e)}")
        finally:
            browser.close()

    return results

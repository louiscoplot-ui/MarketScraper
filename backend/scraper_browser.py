"""Browser/page helpers + debug_page + compare_suburb — extracted from
scraper.py. compare_suburb uses fetch_detail (from scraper_detail) to filter
out already-sold listings from REIWA's missing-from-DB diff."""

import re
import time
import logging

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

from scraper_utils import (
    UA, CHROMIUM_PATH, MAX_PAGES, build_url, clean_listing_url,
)
from scraper_detail import fetch_detail

logger = logging.getLogger(__name__)


def get_reiwa_total(soup):
    """Extract REIWA's total listing count (e.g. '49 Properties Found')."""
    for el in soup.find_all(["h1", "h2", "h3", "span", "div", "p"]):
        txt = el.get_text(strip=True)
        m = re.search(r"(\d+)\s+(?:propert|listing|result)", txt, re.I)
        if m:
            return int(m.group(1))
    return None


def count_cards(page):
    """Count p-card elements currently in the DOM."""
    return page.evaluate("""() => document.querySelectorAll('[class*="p-card"]').length""")


def extract_all_listing_urls_js(page):
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


def load_listing_page(page, url, retries=3):
    """Load a REIWA listing page, wait for cards, scroll repeatedly to load all."""
    for attempt in range(1, retries + 1):
        try:
            page.goto(url, wait_until="networkidle", timeout=40000)
            try:
                page.wait_for_selector('[class*="p-card"]', timeout=8000)
            except Exception:
                pass

            prev_count = 0
            no_change_rounds = 0
            for scroll_round in range(12):
                page.evaluate("window.scrollBy(0, window.innerHeight * 1.5)")
                page.wait_for_timeout(600)
                cur_count = count_cards(page)
                if cur_count > prev_count:
                    prev_count = cur_count
                    no_change_rounds = 0
                else:
                    no_change_rounds += 1
                    if no_change_rounds >= 3:
                        break

            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1500)

            final_count = count_cards(page)
            if final_count > prev_count:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(1200)

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


def debug_page(suburb_slug):
    """Debug: see what the scraper sees on a REIWA for-sale page."""
    url = build_url(suburb_slug, 1)
    result = {'url': url, 'title': '', 'cards_found': 0,
              'sample_card': '', 'text_preview': '', 'error': None}

    try:
        with sync_playwright() as p:
            launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
            if CHROMIUM_PATH:
                launch_opts['executable_path'] = CHROMIUM_PATH
            browser = p.chromium.launch(**launch_opts)
            context = browser.new_context(user_agent=UA,
                                          viewport={'width': 1280, 'height': 800},
                                          locale='en-AU')
            page = context.new_page()

            load_listing_page(page, url)
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
        'missing_from_db': [],
        'sold_excluded': [],
        'extra_in_db': [],
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
            context = browser.new_context(user_agent=UA,
                                          viewport={'width': 1280, 'height': 800},
                                          locale='en-AU')
            page = context.new_page()

            all_reiwa_urls = set()
            page_num = 1
            consecutive_empty = 0
            failed_pages = 0

            while page_num <= MAX_PAGES:
                url = build_url(suburb_slug, page_num)
                if not load_listing_page(page, url):
                    failed_pages += 1
                    if failed_pages >= 2:
                        logger.warning(f"{suburb_name} compare: {failed_pages} page loads failed, stopping")
                        break
                    logger.info(f"{suburb_name} compare: page {page_num} load failed, skipping to next")
                    page_num += 1
                    continue

                html = page.content()
                soup = BeautifulSoup(html, "html.parser")

                if page_num == 1:
                    result['reiwa_total'] = get_reiwa_total(soup)

                js_urls = extract_all_listing_urls_js(page)
                before = len(all_reiwa_urls)
                for u in js_urls:
                    all_reiwa_urls.add(u.rstrip('/'))

                EXCLUDE = ["/real-estate-agent/", "/agency/", "/suburb/", "/news/", "/advice/"]
                for a_tag in soup.find_all("a", href=True):
                    href = a_tag["href"]
                    if any(x in href for x in EXCLUDE):
                        continue
                    clean = clean_listing_url(href)
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

            reiwa_set = {u.rstrip('/') for u in all_reiwa_urls}
            db_set = {u.rstrip('/') for u in db_urls}

            initial_missing = sorted(reiwa_set - db_set)

            sold_excluded = []
            real_missing = []
            detail_page = context.new_page()
            detail_page.route("**/*", lambda route: route.abort()
                              if route.request.resource_type in ("image", "media", "font", "stylesheet")
                              else route.continue_())
            for url in initial_missing:
                detail = fetch_detail(detail_page, url)
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


_get_reiwa_total = get_reiwa_total
_count_cards = count_cards
_extract_all_listing_urls_js = extract_all_listing_urls_js
_load_listing_page = load_listing_page

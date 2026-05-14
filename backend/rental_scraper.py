"""REIWA rental scraper — nightly headless run.

Mirrors the sales scraper pattern (Playwright + BeautifulSoup, polite
delays, address+suburb composite key) but writes to its own
rental_listings / rental_owners tables so the rental module stays
isolated from the sales pipeline. Owner-typed fields (owner_name,
owner_phone, notes) live in rental_owners and are NEVER touched here
— same separation rule as listing_notes for sales.

Runnable as:
    cd backend && python rental_scraper.py
    (DATABASE_URL provided by the GHA cron secret in prod)

Status lifecycle per row:
  - First time scraped:       INSERT status='New'
  - Already in DB, seen now:  UPDATE status='Active', clear date_leased
  - In DB, absent this run:   UPDATE status='Leased', date_leased=today
"""

import os
import re
import sys
import time
import random
import logging
from datetime import datetime
from pathlib import Path

# Make `database`, `scraper_utils` etc. importable when invoked as a
# top-level script (cron `python rental_scraper.py`).
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from playwright.sync_api import sync_playwright  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

import database  # noqa: E402
from database import get_db  # noqa: E402
from scraper_utils import REIWA_BASE, UA, CHROMIUM_PATH  # noqa: E402


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('rental_scraper')


# Politeness — DO NOT REDUCE. REIWA's anti-scrape rate-limits
# aggressively; the sales scraper uses 0.3-1.0s between pages and 5-15s
# between suburbs. Rentals share the same infrastructure → same delays.
PAGE_DELAY = (1.0, 2.0)
SUBURB_DELAY = (5.0, 7.0)
MAX_PAGES = 20  # REIWA shows ~20 rentals/page — covers any inner-west suburb

PROPERTY_TYPES = (
    'House', 'Unit', 'Apartment', 'Townhouse',
    'Villa', 'Studio', 'Duplex', 'Terrace',
)


def _slug(name):
    """Suburb name → REIWA URL slug. 'Shenton Park' → 'shenton-park'."""
    s = (name or '').strip().lower()
    s = re.sub(r"[^a-z0-9\s-]", '', s)
    s = re.sub(r"\s+", '-', s)
    return s.strip('-')


def _build_url(suburb_slug, page=1):
    u = (f"{REIWA_BASE}/rental-properties/{suburb_slug}/"
         "?includesurroundingsuburbs=false&sortby=default")
    return u if page == 1 else u + f"&page={page}"


def _parse_date_listed(card_text):
    """REIWA shows the listing date as 'today', 'yesterday', 'N days ago',
    'N weeks ago' or a 'DD Mon' shortform — normalise to ISO YYYY-MM-DD
    so the day-on-market math (and downstream sorting) stays simple."""
    if not card_text:
        return ''
    now = datetime.utcnow().date()
    txt = card_text.lower()
    if 'today' in txt:
        return now.isoformat()
    if 'yesterday' in txt:
        from datetime import timedelta
        return (now - timedelta(days=1)).isoformat()
    m = re.search(r'(\d{1,3})\s*days?\s*ago', txt)
    if m:
        from datetime import timedelta
        return (now - timedelta(days=int(m.group(1)))).isoformat()
    m = re.search(r'(\d{1,3})\s*weeks?\s*ago', txt)
    if m:
        from datetime import timedelta
        return (now - timedelta(weeks=int(m.group(1)))).isoformat()
    m = re.search(r'\b(\d{1,2})\s+([a-z]{3})\b', txt)
    if m:
        for fmt in ('%d %b', '%d %B'):
            try:
                dt = datetime.strptime(f"{m.group(1)} {m.group(2)}", fmt)
                dt = dt.replace(year=now.year)
                if dt.date() > now:
                    dt = dt.replace(year=now.year - 1)
                return dt.date().isoformat()
            except ValueError:
                continue
    return ''


def _days_on_market(date_listed_iso):
    if not date_listed_iso:
        return ''
    try:
        dt = datetime.strptime(date_listed_iso, '%Y-%m-%d').date()
        return str(max(0, (datetime.utcnow().date() - dt).days))
    except ValueError:
        return ''


def _parse_card(card, suburb_name):
    """Extract one rental listing from a REIWA grid card. Same DOM shape
    as the sales card (h2.p-details__add → address, span.u-grey-dark →
    beds/baths/cars, agent__logo + agent__name) — REIWA reuses the
    template across listing types."""
    h2 = card.find('h2', class_='p-details__add')
    address = h2.get_text(strip=True) if h2 else ''
    address = re.sub(r",?\s*" + re.escape(suburb_name) + r"$", '', address, flags=re.I).strip()
    if not address:
        return None

    # Listing URL — REIWA rental detail slugs end in -<7-digit-id>/.
    url = ''
    if h2:
        a = h2.find('a', href=True)
        if a:
            href = a['href']
            url = REIWA_BASE + href if href.startswith('/') else href
    if not url:
        for a in card.find_all('a', href=True):
            href = a['href']
            if re.search(r'-\d{6,8}/?$', href):
                url = REIWA_BASE + href if href.startswith('/') else href
                break

    card_text = card.get_text(' ', strip=True)

    # Price per week — REIWA uses "$X pw" or "$X per week" labels.
    price_week = ''
    m = re.search(r'\$([\d,]+(?:\.\d+)?)\s*(?:pw|p/w|per\s*week|/\s*week)', card_text, re.I)
    if m:
        price_week = f"${m.group(1)}"
    else:
        m = re.search(r'\$([\d,]+)\s*(?=pw|per\s*week|/wk|/week)', card_text, re.I)
        if m:
            price_week = f"${m.group(1)}"

    ptype = ''
    for t in PROPERTY_TYPES:
        if re.search(r'\b' + t + r'\b', card_text, re.I):
            ptype = t
            break
    if not ptype:
        ptype = 'Other'

    nums = [s.get_text(strip=True) for s in card.find_all('span', class_='u-grey-dark')
            if s.get_text(strip=True).isdigit()]
    beds = nums[0] if len(nums) > 0 else ''
    baths = nums[1] if len(nums) > 1 else ''
    cars = nums[2] if len(nums) > 2 else ''

    agency = ''
    logo = card.find('a', class_='agent__logo')
    if logo:
        sr = logo.find('span', class_='u-sr-only')
        if sr:
            agency = sr.get_text(strip=True)

    agent = ''
    nd = card.find('div', class_='agent__name')
    if nd:
        a = nd.find('a', class_='-ignore-theme')
        if a:
            agent = a.get_text(strip=True)

    date_listed = _parse_date_listed(card_text)

    return {
        'address': address,
        'url': url,
        'price_week': price_week,
        'property_type': ptype,
        'beds': beds, 'baths': baths, 'cars': cars,
        'agency': agency, 'agent': agent,
        'date_listed': date_listed,
        'days_on_market': _days_on_market(date_listed),
    }


def _load_page(page, url):
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=20000)
        try:
            page.wait_for_selector('h2.p-details__add', timeout=8000)
        except Exception:
            # Empty suburb (no rentals listed) — still a successful load.
            pass
        return True
    except Exception as e:
        log.warning(f"Failed to load {url}: {e}")
        return False


def scrape_suburb(suburb_name):
    """Walk every rental page for one suburb, return list of dicts.
    Empty list on failure or empty suburb — never raises."""
    slug = _slug(suburb_name)
    if not slug:
        log.warning(f"Empty slug for suburb {suburb_name!r} — skipping")
        return []

    results = []
    seen = set()
    launch_opts = {'headless': True, 'args': ['--no-sandbox', '--disable-setuid-sandbox']}
    if CHROMIUM_PATH:
        launch_opts['executable_path'] = CHROMIUM_PATH

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_opts)
        context = browser.new_context(
            user_agent=UA,
            viewport={'width': 1280, 'height': 800},
            locale='en-AU',
        )
        page = context.new_page()
        # Skip heavy assets — same trick the sales detail-fetcher uses.
        page.route("**/*", lambda route: route.abort()
                   if route.request.resource_type in ('image', 'media', 'font', 'stylesheet')
                   else route.continue_())

        try:
            for pg in range(1, MAX_PAGES + 1):
                url = _build_url(slug, pg)
                if not _load_page(page, url):
                    break
                soup = BeautifulSoup(page.content(), 'html.parser')
                cards = soup.find_all(True, class_=lambda c: c and 'p-card' in c)
                # Dedup nested p-card elements — sales scraper does the same.
                cards = [c for c in cards
                         if c.find_parent(True, class_=lambda x: x and 'p-card' in x) is None]
                if not cards:
                    break

                new_on_page = 0
                for card in cards:
                    rec = _parse_card(card, suburb_name)
                    if not rec or not rec.get('address'):
                        continue
                    key = rec['address'].strip().lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    results.append(rec)
                    new_on_page += 1

                log.info(f"[{suburb_name}] p{pg}: {len(cards)} cards, "
                         f"{new_on_page} new (total={len(results)})")

                if new_on_page == 0 and pg > 1:
                    break
                time.sleep(PAGE_DELAY[0] + random.uniform(0, PAGE_DELAY[1] - PAGE_DELAY[0]))
        finally:
            browser.close()

    return results


def _today_iso():
    return datetime.utcnow().date().isoformat()


def _merge_into_db(suburb_name, scraped):
    """Apply New/Active/Leased status transitions for one suburb. Inserts
    new addresses, updates seen ones, and flips disappeared rows to
    'Leased'. rental_owners is NEVER written here — operator data stays
    pristine through every scrape."""
    conn = get_db()
    try:
        existing_rows = conn.execute(
            "SELECT id, address, status FROM rental_listings WHERE suburb = ?",
            (suburb_name,)
        ).fetchall()
        existing_by_key = {dict(r)['address'].strip().lower(): dict(r)
                           for r in existing_rows}

        seen_keys = set()
        new_count = 0
        active_count = 0
        leased_count = 0
        now_iso = datetime.utcnow().isoformat()

        for rec in scraped:
            key = rec['address'].strip().lower()
            seen_keys.add(key)
            prev = existing_by_key.get(key)
            if prev is None:
                conn.execute(
                    "INSERT INTO rental_listings "
                    "(address, suburb, status, price_week, property_type, "
                    " beds, baths, cars, agency, agent, "
                    " date_listed, days_on_market, date_leased, url, "
                    " first_seen, last_seen) "
                    "VALUES (?, ?, 'New', ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)",
                    (
                        rec['address'], suburb_name,
                        rec.get('price_week') or '',
                        rec.get('property_type') or '',
                        rec.get('beds') or '',
                        rec.get('baths') or '',
                        rec.get('cars') or '',
                        rec.get('agency') or '',
                        rec.get('agent') or '',
                        rec.get('date_listed') or '',
                        rec.get('days_on_market') or '',
                        rec.get('url') or '',
                        now_iso, now_iso,
                    )
                )
                new_count += 1
            else:
                conn.execute(
                    "UPDATE rental_listings SET "
                    "status = 'Active', "
                    "price_week = ?, property_type = ?, "
                    "beds = ?, baths = ?, cars = ?, "
                    "agency = ?, agent = ?, "
                    "date_listed = ?, days_on_market = ?, "
                    "date_leased = '', url = ?, last_seen = ? "
                    "WHERE id = ?",
                    (
                        rec.get('price_week') or '',
                        rec.get('property_type') or '',
                        rec.get('beds') or '',
                        rec.get('baths') or '',
                        rec.get('cars') or '',
                        rec.get('agency') or '',
                        rec.get('agent') or '',
                        rec.get('date_listed') or '',
                        rec.get('days_on_market') or '',
                        rec.get('url') or '',
                        now_iso, prev['id'],
                    )
                )
                active_count += 1

        # Anything in DB but not seen this run → Leased.
        today = _today_iso()
        for key, prev in existing_by_key.items():
            if key in seen_keys:
                continue
            if prev['status'] == 'Leased':
                continue  # already flagged
            conn.execute(
                "UPDATE rental_listings SET status = 'Leased', date_leased = ?, "
                "last_seen = ? WHERE id = ?",
                (today, now_iso, prev['id'])
            )
            leased_count += 1

        conn.commit()
        return new_count, active_count, leased_count
    finally:
        conn.close()


def main():
    log.info(f"DATABASE_URL set: {bool(os.environ.get('DATABASE_URL'))}")
    log.info(f"Driver: {'postgres' if database.USE_POSTGRES else 'sqlite (local)'}")

    database.init_db()

    conn = get_db()
    rows = conn.execute(
        "SELECT name FROM rental_suburbs WHERE active = 1 ORDER BY name"
    ).fetchall()
    conn.close()
    suburbs = [dict(r)['name'] for r in rows]
    if not suburbs:
        log.warning("No active rental_suburbs — nothing to scrape.")
        return

    log.info(f"Starting rental scrape across {len(suburbs)} suburb(s)")
    started = time.time()
    summary = []

    for i, name in enumerate(suburbs, 1):
        log.info(f"--- {i}/{len(suburbs)}: {name} ---")
        try:
            scraped = scrape_suburb(name)
            new_n, active_n, leased_n = _merge_into_db(name, scraped)
            log.info(f"[{name}] done — scraped={len(scraped)} "
                     f"new={new_n} active={active_n} leased={leased_n}")
            summary.append({
                'name': name, 'scraped': len(scraped),
                'new': new_n, 'active': active_n, 'leased': leased_n,
            })
        except Exception as e:
            log.exception(f"[{name}] crashed: {e}")
            summary.append({'name': name, 'error': str(e)})

        if i < len(suburbs):
            delay = SUBURB_DELAY[0] + random.uniform(0, SUBURB_DELAY[1] - SUBURB_DELAY[0])
            log.info(f"sleeping {delay:.1f}s (polite delay)")
            time.sleep(delay)

    elapsed = (time.time() - started) / 60.0
    log.info(f"=== Rental scrape finished in {elapsed:.1f} min ===")
    for s in summary:
        if 'error' in s:
            log.info(f"  {s['name']}: ERROR — {s['error']}")
        else:
            log.info(f"  {s['name']}: scraped={s['scraped']} new={s['new']} "
                     f"active={s['active']} leased={s['leased']}")


if __name__ == '__main__':
    main()

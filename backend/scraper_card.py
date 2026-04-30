"""Card parser — extracts listing fields from a REIWA grid card.
Extracted from scraper.py."""

import re

from scraper_utils import clean_listing_url, normalise_agency
from scraper_dates import extract_date


def parse_card(card, suburb_name):
    """Parse one listing card using REIWA's actual CSS classes."""
    h2 = card.find("h2", class_="p-details__add")
    address = h2.get_text(strip=True) if h2 else ""
    address = re.sub(r",?\s*" + re.escape(suburb_name) + r"$", "", address, flags=re.I).strip()

    EXCLUDE_URL_PATTERNS = ["/real-estate-agent/", "/agency/", "/suburb/", "/news/", "/advice/"]

    url = ""
    if h2:
        a = h2.find("a", href=True)
        if a and not any(x in a["href"] for x in EXCLUDE_URL_PATTERNS):
            url = clean_listing_url(a["href"]) or ""
    if not url:
        for a in card.find_all("a", href=True):
            href = a["href"]
            if any(x in href for x in EXCLUDE_URL_PATTERNS):
                continue
            clean = clean_listing_url(href)
            if clean:
                url = clean
                break
    if not url:
        for a in card.find_all("a", href=True):
            href = a["href"]
            if any(x in href for x in ["/buy/", "/sold/", "/for-sale/"]) and not any(x in href for x in EXCLUDE_URL_PATTERNS):
                url = ("https://reiwa.com.au" + href) if href.startswith("/") else href
                break

    if not address and url:
        m = re.search(r"\.com\.au/(.+)-\d{5,8}/?$", url)
        if m:
            slug = re.sub(r"-" + suburb_name.lower().replace(" ", "-") + "$", "",
                          m.group(1), flags=re.I)
            address = " ".join(p.capitalize() for p in slug.split("-"))
    if not address:
        address = "Address not disclosed"

    # Price detection — text labels first, then $-based formulas.
    TEXT_PRICE_LABELS = re.compile(
        r"\b(?:auction|price\s+on\s+application|by\s+negotiation|"
        r"expressions?\s+of\s+interest|eoi|"
        r"offers?\s+clos(?:e|ing)|bids?\s+clos(?:e|ing)|"
        r"all\s+offers?(?:\s+presented)?|best\s+offers?|"
        r"under\s+instructions|price\s+guide)\b",
        re.I,
    )
    CONTACT_RE = re.compile(r"^(?:contact|call)\s+[\w\s&|.\'\-]{1,40}$", re.I)
    MODIFIER_DOLLAR = re.compile(
        r"((?:early|mid|late|high|low|offers?\s+(?:from|over|above|around)|"
        r"from|above|over|around|new\s+price\s*-?\s*)"
        r"\s*\$[\d,\.]+\s*[MmKk]?(?:illion)?s?)",
        re.I,
    )
    DOLLAR_RANGE = re.compile(r"\$([\d,]+)\s*[-–]\s*\$([\d,]+)")
    PLAIN_DOLLAR = re.compile(r"\$(\d{1,3}(?:,\d{3})+|\d+\.\d+[MmKk]|\d+[MmKk])")

    price = ""
    for el in card.find_all(["span", "div", "p", "strong", "h2", "h3"]):
        txt = el.get_text(strip=True)
        if not txt or len(txt) > 120 or len(txt) < 2:
            continue
        if "p-details__add" in " ".join(el.get("class", [])):
            continue
        txt = re.sub(r"save listing.*$", "", txt, flags=re.I).strip()
        if not txt:
            continue

        if TEXT_PRICE_LABELS.search(txt):
            price = txt
            break
        if CONTACT_RE.match(txt):
            price = txt
            break
        m = MODIFIER_DOLLAR.search(txt)
        if m:
            price = m.group(1).strip()
            break
        m = DOLLAR_RANGE.search(txt)
        if m:
            price = f"${m.group(1)} - ${m.group(2)}"
            break
        m = PLAIN_DOLLAR.search(txt)
        if m:
            raw = m.group(1).replace(",", "").lower()
            try:
                v = float(re.sub(r"[mk]", "", raw))
                if "m" in raw:
                    v *= 1_000_000
                elif "k" in raw:
                    v *= 1_000
                if v >= 100_000:
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
            agency = normalise_agency(sr.get_text(strip=True))

    agent = ""
    nd = card.find("div", class_="agent__name")
    if nd:
        a = nd.find("a", class_="-ignore-theme")
        if a:
            agent = a.get_text(strip=True)

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
        "listing_date": extract_date(card),
    }


_parse_card = parse_card

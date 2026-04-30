"""REIWA listing-date parsing — extracted from scraper.py."""

import re
from datetime import datetime, timedelta


def parse_date_text(text):
    """Parse REIWA's listing-age wording into dd/mm/yyyy, or empty.

    Strict: every pattern REQUIRES an 'Added' / 'Listed' / 'Posted' prefix.
    Used on grid cards where false positives from 'Properties you may be
    interested in' sidebars would otherwise contaminate every row.
    """
    if not text:
        return ""
    today = datetime.now()
    s = text.lower()

    PREFIX = r"(?:added|listed|posted)"

    if re.search(PREFIX + r"\s+today\b", s):
        return today.strftime("%d/%m/%Y")
    if re.search(PREFIX + r"\s+yesterday\b", s):
        return (today - timedelta(days=1)).strftime("%d/%m/%Y")

    m = re.search(PREFIX + r"\s+(\d+)\s+days?(?:\s+ago)?\b", s)
    if m:
        try:
            return (today - timedelta(days=int(m.group(1)))).strftime("%d/%m/%Y")
        except (ValueError, OverflowError):
            pass

    m = re.search(PREFIX + r"\s+(\d+)\s+weeks?(?:\s+ago)?\b", s)
    if m:
        try:
            return (today - timedelta(weeks=int(m.group(1)))).strftime("%d/%m/%Y")
        except (ValueError, OverflowError):
            pass

    m = re.search(PREFIX + r"\s+(\d+)\s+months?(?:\s+ago)?\b", s)
    if m:
        try:
            return (today - timedelta(days=int(m.group(1)) * 30)).strftime("%d/%m/%Y")
        except (ValueError, OverflowError):
            pass

    m = re.search(PREFIX + r"\s+(?:on\s+)?(\d{1,2})\s+([A-Za-z]{3,})", text, re.I)
    if m:
        try:
            dt = datetime.strptime(
                f"{m.group(1)} {m.group(2)[:3].capitalize()} {today.year}",
                "%d %b %Y",
            )
            if dt > today:
                dt = dt.replace(year=dt.year - 1)
            return dt.strftime("%d/%m/%Y")
        except ValueError:
            pass

    return ""


# Month name → number mapping
_MONTHS = {m.lower(): i for i, m in enumerate(
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], 1
)}
_MONTHS.update({m.lower(): i for i, m in enumerate(
    ['January', 'February', 'March', 'April', 'May', 'June',
     'July', 'August', 'September', 'October', 'November', 'December'], 1
)})


def parse_date_relaxed(text):
    """Looser parser for the detail-page header area.

    Looks for bare 'D Month YYYY' / 'D/M/YYYY' patterns *without* requiring
    an 'Added/Listed/Posted' prefix. ONLY safe to call on a small slice of
    the detail page (e.g. first 800 chars) where the listing metadata sits
    — running it on full page text would match sidebar dates and dates of
    other recently-sold properties.

    Falls back gracefully (returns "") on no match. Returns dd/mm/yyyy.
    """
    if not text:
        return ""
    today = datetime.now()

    # 1. "Listed Xth Month Year" / "First listed: Month Year" / etc.
    #    REIWA's own header sometimes uses past-tense passive voice.
    m = re.search(
        r"(?:list\w*|posted|added|first\s+seen|date)\s*:?\s*"
        r"(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"([A-Za-z]{3,9})\s+(\d{4})",
        text, re.I,
    )
    if m:
        try:
            mo = _MONTHS.get(m.group(2).lower())
            if mo:
                dt = datetime(int(m.group(3)), mo, int(m.group(1)))
                return dt.strftime("%d/%m/%Y")
        except (ValueError, KeyError):
            pass

    # 2. Bare "D Month YYYY" — standalone date in the header area
    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"([A-Za-z]{3,9})\s+(\d{4})\b",
        text, re.I,
    )
    if m:
        try:
            mo = _MONTHS.get(m.group(2).lower())
            if mo:
                year = int(m.group(3))
                if 2000 <= year <= today.year + 1:
                    dt = datetime(year, mo, int(m.group(1)))
                    if dt <= today:
                        return dt.strftime("%d/%m/%Y")
        except (ValueError, KeyError):
            pass

    # 3. Numeric DD/MM/YYYY or DD-MM-YYYY
    m = re.search(r"\b(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{4})\b", text)
    if m:
        try:
            d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 2000 <= y <= today.year + 1 and 1 <= mo <= 12 and 1 <= d <= 31:
                dt = datetime(y, mo, d)
                if dt <= today:
                    return dt.strftime("%d/%m/%Y")
        except ValueError:
            pass

    return ""


def extract_date(card):
    """Date from a grid card. Tries <time> tag first, then prefix-based
    text parsing — never the relaxed parser, since cards live next to
    sidebar widgets that would poison the result."""
    for el in card.find_all(["span", "div", "p", "time"]):
        if el.name == "time":
            v = el.get("datetime", "") or el.get_text(strip=True)
            try:
                dt = datetime.strptime(v.strip()[:10], "%Y-%m-%d")
                return dt.strftime("%d/%m/%Y")
            except ValueError:
                pass
        txt = el.get_text(strip=True)
        if not txt or len(txt) > 120:
            continue
        result = parse_date_text(txt)
        if result:
            return result
    full = card.get_text(" ", strip=True)
    if full and len(full) < 3000:
        return parse_date_text(full)
    return ""


# Backwards-compat aliases
_parse_date_text = parse_date_text
_extract_date = extract_date

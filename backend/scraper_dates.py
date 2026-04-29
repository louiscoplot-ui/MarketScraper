"""REIWA listing-date parsing — extracted from scraper.py."""

import re
from datetime import datetime, timedelta


def parse_date_text(text):
    """Parse REIWA's listing-age wording into dd/mm/yyyy, or empty.

    Strict: every pattern REQUIRES an 'Added' / 'Listed' / 'Posted' prefix.
    This avoids false matches from sidebars like 'Properties you may be
    interested in' which contain stray date-like text ('New', '2 hours ago'
    on agent cards, 'Just listed' category labels, etc.) and were making
    every listing get today's date.
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


def extract_date(card):
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
    # Fallback: scan the whole card text (helps when the date sits inside a
    # longer composite element).
    full = card.get_text(" ", strip=True)
    if full and len(full) < 3000:
        return parse_date_text(full)
    return ""


# Backwards-compat aliases
_parse_date_text = parse_date_text
_extract_date = extract_date

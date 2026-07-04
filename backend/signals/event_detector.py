"""SENTINEL S1 — pure event-detection logic.

Turns two per-listing states (previous scrape vs current scrape) into a
list of market events for the `listing_events` ledger. No DB access, no
Flask import — every function here is pure and unit-testable. The DB
integration lives in signals/diff_engine.py (same compare pass that feeds
listing_transitions) and scripts/backfill_events.py.

Design notes (see docs/sentinel-decisions.md):
- normalize_address() here is the SENTINEL normaliser (D1). It is a NEW
  function: database.normalize_address() output is stored in three tables
  and joined by live features, so it must not change. This one is only
  used for Sentinel matching (relisted detection, prediction ledger).
- Event types (S1 spec): price_drop, price_rise, withdrawn, relisted,
  agency_change, sold, back_on_market.
"""
import re

from signals.diff_engine import _price_to_int, _days_between

EVENT_TYPES = (
    'price_drop', 'price_rise', 'withdrawn', 'relisted',
    'agency_change', 'sold', 'back_on_market',
)

# Street-type abbreviations — superset of database._STREET_ABBREVS, extended
# with the types REIWA spells out that the legacy map ignores. Everything
# maps to one canonical short form.
_STREET_ABBREVS = {
    'street': 'st', 'road': 'rd', 'avenue': 'av', 'ave': 'av',
    'drive': 'dr', 'court': 'ct', 'place': 'pl', 'crescent': 'cres',
    'parade': 'pde', 'highway': 'hwy', 'hway': 'hwy', 'terrace': 'tce',
    'lane': 'ln', 'close': 'cl', 'boulevard': 'bvd', 'boulevarde': 'bvd',
    'blvd': 'bvd', 'esplanade': 'esp', 'gardens': 'gdns', 'grove': 'gr',
    'circle': 'cir', 'circuit': 'cct', 'promenade': 'prom',
    'entrance': 'ent', 'mews': 'mews', 'rise': 'rise', 'way': 'way',
    'loop': 'loop', 'vista': 'vista', 'green': 'green', 'quays': 'qys',
}

# Trailing state/postcode: ", WA 6011", "WA", "6011".
_TRAILING_STATE_RE = re.compile(r'\b(wa)?\s*\d{4}\s*$')
_TRAILING_WA_RE = re.compile(r'\bwa\s*$')


def normalize_address(addr, suburb=None):
    """Sentinel address normaliser — one canonical string per property.

    Handles the real REIWA/RP-Data variants that break the legacy
    normaliser (see docs/sentinel-decisions.md D1):
      '2/80 Marine Parade', '2 / 80 Marine Pde', 'Unit 2, 80 Marine Parade'
        -> '2/80 marine pde'
      '110A Rochdale Road' -> '110a rochdale rd'   (suffix kept — a real
        distinct dwelling; strata unit forms converge, suffixes stay)
      '12 Jarrad Street, Cottesloe WA 6011' (suburb passed) -> '12 jarrad st'
    Returns '' for empty / undisclosed addresses so callers skip matching.
    """
    if not addr:
        return ''
    s = str(addr).lower().strip()
    if 'not disclosed' in s or 'address withheld' in s:
        return ''
    # unify punctuation: commas/periods/apostrophes/hyphens -> space
    s = re.sub(r"[,\.'’]", ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    # unit forms -> canonical 'u/N' prefix
    s = re.sub(r'^unit\s+(\d+[a-z]?)\s+', r'\1/', s)     # 'unit 2 80 x' -> '2/80 x'
    s = re.sub(r'^(\d+[a-z]?)\s*/\s*', r'\1/', s)        # '2 / 80' -> '2/80'
    # strip trailing state/postcode FIRST ('… cottesloe wa 6011' ends with
    # the postcode, not the suburb), then the suburb itself when known
    s = _TRAILING_STATE_RE.sub('', s).strip()
    s = _TRAILING_WA_RE.sub('', s).strip()
    if suburb:
        sub = str(suburb).lower().strip()
        if sub and s.endswith(' ' + sub):
            s = s[: -len(sub) - 1].strip()
    # street-type abbreviations
    for full, short in _STREET_ABBREVS.items():
        s = re.sub(r'\b' + re.escape(full) + r'\b', short, s)
    return re.sub(r'\s+', ' ', s).strip()


def _ev(listing, event_type, old_value, new_value, detected_at=None,
        source='daily_diff'):
    return {
        'listing_id': listing.get('id'),
        'suburb_id': listing.get('suburb_id'),
        'address': listing.get('address'),
        'event_type': event_type,
        'old_value': None if old_value is None else str(old_value),
        'new_value': None if new_value is None else str(new_value),
        'detected_at': detected_at,   # None -> DB default (now)
        'source': source,
    }


def detect_events(previous, current, withdrawn_ok=True):
    """Compare one listing's previous snapshot vs current row.

    previous: dict with status/price_text/agency/sold_price (the snapshot),
              or None for a listing never seen before (no events — relist-
              by-address is handled separately, see detect_relist_by_address).
    current:  dict with id/suburb_id/address/status/price_text/agency/
              sold_price/sold_date/withdrawn_date/first_seen.
    withdrawn_ok: False when the recent scrape series for this suburb is
              not trustworthy (D2 — the caller checks the last 3 scrape_logs);
              suppresses withdrawn emission, everything else still flows.

    Returns a list of event dicts — several per listing are possible
    (e.g. price_drop + agency_change in the same run), unlike
    diff_engine._classify which picks one transition by priority.
    """
    if previous is None:
        return []
    events = []
    old_status = previous.get('status')
    new_status = current.get('status')

    # --- status-driven events -------------------------------------------
    if old_status in ('active', 'under_offer') and new_status == 'withdrawn':
        if withdrawn_ok and not (current.get('sold_date') or '').strip():
            events.append(_ev(
                current, 'withdrawn', old_status,
                current.get('withdrawn_date') or 'withdrawn',
            ))
    elif old_status == 'withdrawn' and new_status in ('active', 'under_offer'):
        events.append(_ev(current, 'relisted', old_status, new_status))
    elif old_status == 'under_offer' and new_status == 'active':
        events.append(_ev(current, 'back_on_market', old_status, new_status))
    elif old_status != 'sold' and new_status == 'sold':
        events.append(_ev(
            current, 'sold', previous.get('price_text'),
            current.get('sold_price') or current.get('sold_date') or 'sold',
        ))

    # --- price events (independent of status ones, D3: raw facts, no
    # threshold — thresholds belong to the signal engine) ----------------
    old_p = _price_to_int(previous.get('price_text'))
    new_p = _price_to_int(current.get('price_text'))
    if old_p and new_p and new_p != old_p and new_status != 'sold':
        etype = 'price_drop' if new_p < old_p else 'price_rise'
        events.append(_ev(current, etype, old_p, new_p))

    # --- agency change on the same listing ------------------------------
    old_agency = (previous.get('agency') or '').strip()
    new_agency = (current.get('agency') or '').strip()
    if old_agency and new_agency and old_agency.lower() != new_agency.lower():
        events.append(_ev(current, 'agency_change', old_agency, new_agency))

    return events


def detect_relist_by_address(new_listing, withdrawn_candidates,
                             max_months=18):
    """Relist detection across REIWA listing IDs (the case diff_engine's
    same-row flip cannot see: a real withdrawal usually comes back as a NEW
    listing with a new URL/ID).

    new_listing: a current listings row that has NO snapshot (first seen
                 this run).
    withdrawn_candidates: iterable of dicts (listings rows with
                 status='withdrawn' in the SAME suburb — caller pre-filters
                 by suburb_id so same street names in other suburbs can
                 never collide) with address/agency/withdrawn_date.

    Returns a list of 0-2 events: relisted (+ agency_change when the agency
    differs). Conservative: exact normalized-address match only, and the
    prior withdrawal must be recent (<= max_months, when its date survived).
    """
    key = normalize_address(new_listing.get('address'))
    if not key:
        return []
    for cand in withdrawn_candidates:
        if normalize_address(cand.get('address')) != key:
            continue
        days = _days_between(cand.get('withdrawn_date'), None)
        if days is not None and days > max_months * 30:
            continue
        events = [_ev(new_listing, 'relisted',
                      'withdrawn', new_listing.get('status'))]
        old_agency = (cand.get('agency') or '').strip()
        new_agency = (new_listing.get('agency') or '').strip()
        if old_agency and new_agency and old_agency.lower() != new_agency.lower():
            events.append(_ev(new_listing, 'agency_change',
                              old_agency, new_agency))
        return events
    return []

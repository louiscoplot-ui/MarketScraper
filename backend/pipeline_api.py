"""Appraisal Pipeline routes — endpoints + helper functions."""

import re
import sys
import json
import logging
import threading
import traceback
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, date
from io import BytesIO
from flask import request, jsonify, send_file

from database import get_db, normalize_address, USE_POSTGRES
from admin_api import get_user_allowed_suburb_names, user_can_access_suburb
from pipeline_letter import render_letter_docx


# Tracks ongoing OSM prefetch jobs so we don't kick off duplicate threads
# while the first one is still warming. Keyed by lowercase suburb name.
# {suburb_lower: {'status': 'warming'|'ready', 'started_at': datetime}}
_osm_jobs = {}
_osm_jobs_lock = threading.Lock()

logger = logging.getLogger(__name__)


_ADDR_RE = re.compile(r'^(\d+)([A-Za-z]?)\s+(.+)$')
# Strata / unit prefix: "2/80 Mooro Drive" → drop the "2/" so OSM + the
# LandGate registry (both keyed on the main house number, not the strata
# unit) actually find neighbours. Without this strip _parse_address used
# to early-return None for any unit address, leaving every "N/NN" source
# sale with zero pipeline targets.
_UNIT_PREFIX_RE = re.compile(r'^\d+\s*/\s*')
# Letter-suffix house number: "110A Rochdale Road" → "110 Rochdale Road".
# The bare regex above (_ADDR_RE) already tolerates a single trailing
# letter via group 2, but stripping it BEFORE parse keeps the street
# cache + OSM query keyed on the underlying house, so 110, 110A, 110B
# all hit the same cache entry instead of three separate ones.
_LETTER_SUFFIX_RE = re.compile(r'^(\d+)[A-Za-z]+(\s+)')
INSERT_CHUNK = 50
NEIGHBOUR_MAX_DISTANCE = 30
NEIGHBOUR_COUNT = 4
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
# 8s is enough for Overpass to respond in the common case; 18s used to
# stack into multi-minute generations whenever one street happened to
# be slow. We also pre-warm the cache in parallel below so a single
# slow street can't bottleneck the rest.
OVERPASS_TIMEOUT_SECONDS = 8
OSM_CACHE_TTL_DAYS = 30


def _source_limit(days):
    return min(max(days * 3, 5), 60)


def _parse_address(addr):
    if not addr:
        return None
    addr = addr.strip()
    # Normalise the house-number portion BEFORE the main regex so OSM,
    # the street cache, and the neighbour-distance maths all see the
    # underlying integer. Order matters: strip the strata prefix first
    # (drops everything up to and including "/"), then strip any letter
    # suffix that remains on the building number.
    addr = _UNIT_PREFIX_RE.sub('', addr, count=1)
    addr = _LETTER_SUFFIX_RE.sub(r'\1\2', addr, count=1)
    # "259 259 Curtin Avenue" → "259 Curtin Avenue" (scrape artefact).
    parts = addr.split()
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit() and parts[0] == parts[1]:
        addr = ' '.join([parts[0]] + parts[2:])
    m = _ADDR_RE.match(addr)
    if not m:
        return None
    try:
        num = int(m.group(1))
    except ValueError:
        return None
    return num, m.group(2), m.group(3).strip()


def _street_cache_key(street, suburb):
    return f"{(street or '').strip().lower()}|{(suburb or '').strip().lower()}"


def _osm_street_numbers_cached(conn, street, suburb):
    """Cached lookup; returns list[int] of every house number we've seen
    on this street (across HV, listings, and OSM). Returns None when the
    cache row is missing OR older than OSM_CACHE_TTL_DAYS so the caller
    re-fetches from Overpass and refreshes the row."""
    key = _street_cache_key(street, suburb)
    try:
        row = conn.execute(
            "SELECT numbers, fetched_at FROM street_address_cache WHERE street_key = ?",
            (key,)
        ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    try:
        d = dict(row)
        fetched = d.get('fetched_at')
        if fetched:
            try:
                # Postgres returns datetime, SQLite returns ISO/space-separated string.
                if isinstance(fetched, datetime):
                    fetched_dt = fetched
                else:
                    fetched_dt = datetime.fromisoformat(str(fetched).replace(' ', 'T').replace('Z', ''))
                if datetime.utcnow() - fetched_dt > timedelta(days=OSM_CACHE_TTL_DAYS):
                    return None
            except (ValueError, TypeError):
                # Unparseable timestamp — treat as stale and re-fetch.
                return None
        nums = json.loads(d.get('numbers') or '[]')
        return [int(n) for n in nums]
    except Exception:
        return None


def _osm_street_numbers_store(conn, street, suburb, numbers):
    key = _street_cache_key(street, suburb)
    payload = json.dumps(sorted(set(int(n) for n in numbers)))
    try:
        if USE_POSTGRES:
            conn.execute(
                "INSERT INTO street_address_cache (street_key, numbers) "
                "VALUES (?, ?) "
                "ON CONFLICT (street_key) DO UPDATE SET "
                "numbers = EXCLUDED.numbers, fetched_at = CURRENT_TIMESTAMP",
                (key, payload)
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO street_address_cache "
                "(street_key, numbers, fetched_at) VALUES (?, ?, datetime('now'))",
                (key, payload)
            )
        conn.commit()
    except Exception as e:
        logger.debug(f"street cache write failed: {e}")


def _osm_fetch_street_numbers(street, suburb):
    """One Overpass query → all house numbers on the street within the
    suburb's admin area. Returns list of ints, empty on any failure.
    OSM data is open + free; usage is light (cached 30 days per street).
    """
    if not street or not suburb:
        return []
    street_clean = street.split(',')[0].strip()
    suburb_clean = suburb.strip()
    if not street_clean or not suburb_clean:
        return []

    # admin_level 7-9 covers Australian suburbs / localities reliably.
    query = (
        '[out:json][timeout:15];'
        f'area["name"~"^{suburb_clean}$",i]["admin_level"~"^[789]$"]->.s;'
        '('
        f'node(area.s)["addr:housenumber"]["addr:street"~"^{street_clean}$",i];'
        f'way(area.s)["addr:housenumber"]["addr:street"~"^{street_clean}$",i];'
        ');'
        'out tags;'
    )
    try:
        body = urllib.parse.urlencode({'data': query}).encode('utf-8')
        req = urllib.request.Request(
            OVERPASS_URL, data=body,
            headers={
                'User-Agent': 'SuburbDesk/1.0 (real-estate prospecting; '
                              'contact: louiscoplot@bellepropertycottesloe.com.au)',
                'Content-Type': 'application/x-www-form-urlencoded',
            }
        )
        with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        logger.info(f"Overpass lookup failed for {street_clean}/{suburb_clean}: {e}")
        return []

    nums = []
    for el in payload.get('elements', []):
        tags = (el.get('tags') or {})
        raw = (tags.get('addr:housenumber') or '').strip()
        if not raw:
            continue
        # OSM may store '123A', '123-125', '123/4'. Take the leading
        # integer if it's clean — units & strata not useful for letter mailing.
        m = re.match(r'^(\d+)\s*$', raw)
        if not m:
            continue
        try:
            nums.append(int(m.group(1)))
        except ValueError:
            continue
    if nums:
        logger.info(f"Overpass: {len(set(nums))} numbers on {street_clean}, {suburb_clean}")
    return sorted(set(nums))


def _real_neighbours(conn, source_addr, source_suburb, has_hv,
                     count=NEIGHBOUR_COUNT, max_distance=NEIGHBOUR_MAX_DISTANCE):
    """Return real addresses on the same street near the source.

    Pulls candidates from hot_vendor_properties (RP Data — exhaustive
    ownership records) first, falling back to listings. Filters by:
      - same street name (case-insensitive)
      - same parity (odd source → odd targets only, never both sides)
      - within ±max_distance house numbers
      - excludes the source itself
    Returns up to `count` closest matches, sorted by distance then number.
    Empty list when no real neighbour can be found — the pipeline
    skips that source rather than mailing a fake address.
    """
    parsed = _parse_address(source_addr)
    if not parsed:
        return []
    src_num, _suffix, street = parsed
    src_parity = src_num % 2
    street_lower = street.lower()
    src_norm = normalize_address(source_addr) or ''

    candidates = {}

    def consider(addr_str):
        if not addr_str:
            return
        a = addr_str.strip()
        if not a:
            return
        n = (normalize_address(a) or '').lower()
        if not n or n == src_norm or n in candidates:
            return
        p = _parse_address(a)
        if not p:
            return
        num_c, _suf, str_c = p
        if str_c.lower() != street_lower:
            return
        if num_c % 2 != src_parity:
            return
        d = abs(num_c - src_num)
        if d == 0 or d > max_distance:
            return
        candidates[n] = (d, num_c, a)

    # OSM is the source of truth for "what house numbers exist on this
    # street" — agents got 18A and 40B suggested for 26 Mengler Avenue
    # because HV/listings happened to have those two but not the actual
    # nearest neighbours (24, 28). Use OSM first to get the real numbers,
    # then enrich with HV/listings (so the letter has the owner name)
    # only as a secondary signal. Cache means subsequent runs are fast.
    cached = _osm_street_numbers_cached(conn, street, source_suburb)
    if cached is None:
        nums = _osm_fetch_street_numbers(street, source_suburb)
        _osm_street_numbers_store(conn, street, source_suburb, nums)
    else:
        nums = cached

    for n in nums:
        if n == src_num:
            continue
        if n % 2 != src_parity:
            continue
        d = abs(n - src_num)
        if d == 0 or d > max_distance:
            continue
        addr = f"{n} {street}"
        norm = (normalize_address(addr) or '').lower()
        if norm and norm not in candidates:
            candidates[norm] = (d, n, addr)

    # Fall back to HV / listings only when OSM had nothing for this
    # street (unknown / not mapped). Even there, we still apply the
    # parity + distance filter so we don't surface a far-away outlier.
    if not candidates:
        if has_hv:
            try:
                rows = conn.execute(
                    "SELECT address FROM hot_vendor_properties "
                    "WHERE LOWER(address) LIKE ? LIMIT 1000",
                    (f"% {street_lower}",)
                ).fetchall()
                for r in rows:
                    consider(dict(r).get('address'))
            except Exception as e:
                logger.debug(f"hot_vendor neighbour lookup failed: {e}")
        try:
            rows = conn.execute(
                "SELECT l.address FROM listings l "
                "JOIN suburbs s ON l.suburb_id = s.id "
                "WHERE LOWER(l.address) LIKE ? AND LOWER(s.name) = LOWER(?) "
                "LIMIT 1000",
                (f"% {street_lower}", source_suburb or '')
            ).fetchall()
            for r in rows:
                consider(dict(r).get('address'))
        except Exception as e:
            logger.debug(f"listings neighbour lookup failed: {e}")

    if not candidates:
        return []
    ranked = sorted(candidates.values(), key=lambda c: (c[0], c[1]))
    return [c[2] for c in ranked[:count]]


def _hot_vendors_table_exists(conn):
    try:
        if USE_POSTGRES:
            row = conn.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'hot_vendor_properties' LIMIT 1"
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'hot_vendor_properties' LIMIT 1"
            ).fetchone()
        return bool(row)
    except Exception:
        return False


def _match_hot_vendor(conn, target_address):
    try:
        norm = normalize_address(target_address)
        if not norm:
            return None, None
        row = conn.execute(
            "SELECT current_owner, final_score FROM hot_vendor_properties "
            "WHERE normalized_address = ? "
            "ORDER BY final_score DESC LIMIT 1",
            (norm,)
        ).fetchone()
        if not row:
            return None, None
        d = dict(row)
        return d.get('current_owner'), d.get('final_score')
    except Exception:
        return None, None


def _enrich_owner_names(conn, suburb=None):
    """Back-fill pipeline_tracking.target_owner_name from
    hot_vendor_properties.current_owner whenever the pipeline row
    has no owner yet. Matches on normalized_address. Idempotent —
    cheap to call before every read of the pipeline.

    Bulk-rewritten: was 1 SELECT + 1 UPDATE per missing row, which on
    200 rows ran 400 queries and pushed Pipeline page-loads past the
    Vercel 25s edge timeout. Now: 2 queries total — 1 IN-clause SELECT
    over hot_vendor_properties keyed on the normalised target addresses,
    and 1 executemany UPDATE."""
    if not _hot_vendors_table_exists(conn):
        return 0
    try:
        if suburb:
            rows = conn.execute(
                "SELECT id, target_address FROM pipeline_tracking "
                "WHERE (target_owner_name IS NULL OR target_owner_name = '') "
                "AND source_suburb_lower = LOWER(?)",
                (suburb,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, target_address FROM pipeline_tracking "
                "WHERE target_owner_name IS NULL OR target_owner_name = ''"
            ).fetchall()
    except Exception as e:
        logger.warning(f"enrich_owner_names lookup failed: {e}")
        return 0

    # Group pipeline ids by their normalised target address. Multiple
    # pipeline rows can share an address (re-mailings on different dates).
    norm_to_ids = {}
    for r in rows:
        target_addr = r['target_address']
        if not target_addr:
            continue
        norm = normalize_address(target_addr)
        if not norm:
            continue
        norm_to_ids.setdefault(norm, []).append(r['id'])

    if not norm_to_ids:
        return 0

    # Single SELECT for every owner we need. ORDER BY final_score DESC
    # plus the dict-build below picks the highest-scoring match per
    # address, mirroring the per-row LIMIT 1 from the legacy version.
    norms = list(norm_to_ids.keys())
    try:
        placeholders = ','.join(['?'] * len(norms))
        owner_rows = conn.execute(
            f"SELECT normalized_address, current_owner FROM hot_vendor_properties "
            f"WHERE normalized_address IN ({placeholders}) "
            f"AND current_owner IS NOT NULL AND current_owner != '' "
            f"ORDER BY final_score DESC",
            norms
        ).fetchall()
    except Exception as e:
        logger.warning(f"enrich_owner_names bulk lookup failed: {e}")
        return 0

    norm_to_owner = {}
    for o in owner_rows:
        d = dict(o)
        # First-seen wins because we ORDER BY final_score DESC, so the
        # highest-scoring row for each normalized_address lands first.
        norm_to_owner.setdefault(d['normalized_address'], d['current_owner'])

    update_params = []
    for norm, ids in norm_to_ids.items():
        owner = norm_to_owner.get(norm)
        if not owner:
            continue
        for pipeline_id in ids:
            update_params.append((owner, pipeline_id))

    if not update_params:
        return 0

    # Access the raw driver cursor for executemany — _Conn doesn't
    # expose it, but both sqlite3 and psycopg2 cursors support the
    # method. Translate '?' to '%s' for psycopg2.
    try:
        raw = getattr(conn, '_conn', None) or conn
        cur = raw.cursor()
        sql = "UPDATE pipeline_tracking SET target_owner_name = ? WHERE id = ?"
        if USE_POSTGRES:
            sql = sql.replace('?', '%s')
        cur.executemany(sql, update_params)
        conn.commit()
    except Exception as e:
        logger.warning(f"enrich_owner_names bulk update failed: {e}")
        return 0

    updated = len(update_params)
    logger.info(f"Enriched {updated} pipeline owner names from hot_vendor_properties (bulk)")
    return updated


def _serialize_entries(rows):
    out = []
    for r in rows:
        d = dict(r)
        for k, v in list(d.items()):
            if isinstance(v, (date, datetime)):
                d[k] = v.isoformat()
        out.append(d)
    return out


def _price_to_int(*candidates):
    """Best-effort dollar amount from any price representation.

    Handles every shape we receive across listings.sold_price,
    listings.price_text, RP Data CSV imports, and manual UI input:

      "$5,605,000"           → 5_605_000
      "5605000"              → 5_605_000
      "5605000.0"            → 5_605_000   (was: 56_050_000 — the bug
                                            that surfaced $56M source
                                            sales next to $5M houses
                                            in the Pipeline)
      Decimal('5605000.00')  → 5_605_000
      5605000                → 5_605_000
      "low $1m"              → 1_000_000   (was: 1)
      "from $775k"           → 775_000     (was: 775)
      "Offers from $1,250,000" → 1_250_000

    Returns the first usable match across `candidates`. None when no
    candidate parses, or when every parsed value is below the $100
    junk floor."""
    for c in candidates:
        if c is None or c == '':
            continue
        # Numeric / numeric-string fast path — captures Decimal, float,
        # int, and decimal strings like "5605000.0" via float() before
        # the regex strips the decimal point and inflates by 10×.
        try:
            f = float(c)
            if f >= 100:
                return int(round(f))
        except (TypeError, ValueError):
            pass
        # Free-text path — first $-amount with optional m/k suffix.
        # Same logic as report_api._parse_price; multiplies by 10^suffix
        # instead of dropping the suffix and treating "low $1m" as $1.
        s = str(c).lower().replace(',', '')
        m = re.search(
            r'\$?\s*(\d+(?:\.\d+)?)\s*(m(?:il(?:lion)?)?|k|thousand)?\b',
            s,
        )
        if not m:
            continue
        try:
            val = float(m.group(1))
        except ValueError:
            continue
        suffix = m.group(2) or ''
        if suffix.startswith('m'):
            val *= 1_000_000
        elif suffix.startswith('k') or suffix == 'thousand':
            val *= 1_000
        if val >= 100:
            return int(round(val))
    return None


def _bulk_insert_pipeline(conn, rows):
    if not rows:
        return 0

    inserted = 0
    # source_suburb_lower kept in sync at write time so the indexed
    # filter `source_suburb_lower = LOWER(?)` on read can use
    # idx_pipeline_suburb_lower instead of full-scanning the table.
    cols = ('source_address', 'source_suburb', 'source_suburb_lower',
            'source_sold_date', 'source_price', 'target_address',
            'target_owner_name', 'hot_vendor_score')
    n_cols = len(cols)

    enriched_rows = [
        (r[0], r[1], (r[1] or '').strip().lower(), r[2], r[3], r[4], r[5], r[6])
        for r in rows
    ]

    for i in range(0, len(enriched_rows), INSERT_CHUNK):
        chunk = enriched_rows[i:i + INSERT_CHUNK]
        single = '(' + ', '.join(['?'] * n_cols) + ", 'sent')"
        values_clause = ', '.join([single] * len(chunk))
        sql = (
            f"INSERT INTO pipeline_tracking ({', '.join(cols)}, status) "
            f"VALUES {values_clause} "
            f"ON CONFLICT (target_address, sent_date) DO NOTHING"
        )
        flat_params = [v for row in chunk for v in row]
        cur = conn.execute(sql, flat_params)
        if cur.rowcount and cur.rowcount > 0:
            inserted += cur.rowcount

    return inserted


def _gather_sources_for_target(conn, target_address, source_suburb):
    """Distinct nearby sales for a target. Dedupes by source_address so
    duplicate pipeline_tracking rows don't make the letter say
    'sold for X — for X respectively'."""
    rows = conn.execute(
        """
        SELECT source_address, source_price, source_sold_date, target_owner_name
        FROM pipeline_tracking
        WHERE LOWER(target_address) = LOWER(?)
          AND source_suburb_lower = LOWER(?)
        ORDER BY created_at DESC
        """,
        (target_address, source_suburb)
    ).fetchall()
    seen = set()
    deduped = []
    for r in rows:
        d = dict(r)
        key = (d.get('source_address') or '').strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(d)
    deduped.sort(key=lambda d: (d.get('source_address') or '').lower())
    return deduped


# ---------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------

def _generate_pipeline_for_suburb(suburb, days=7, enforce_acl=True):
    """Pure-Python pipeline generation — usable from background workers
    that have no Flask request context (e.g. the scrape_runner auto-gen
    after each suburb scrape). The HTTP route `pipeline_generate` is
    a thin wrapper around this with arg parsing + ACL.

    Returns the same dict shape the route returns minus `entries` (which
    is only useful for the UI — callers that need entries hit the HTTP
    endpoint). Never raises for ACL — `enforce_acl=False` skips the
    `user_can_access_suburb` check, which the scraper relies on since
    it runs as a background daemon, not a user request."""
    if enforce_acl and not user_can_access_suburb(suburb):
        return {'error': 'Suburb not in your allowed list', 'status': 403}

    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 90))

    cutoff_date = (datetime.utcnow() - timedelta(days=days)).date().isoformat()
    src_limit = _source_limit(days)

    conn = get_db()
    has_hv = _hot_vendors_table_exists(conn)

    sold_rows = conn.execute(
        """
        SELECT l.address, l.sold_price, l.price_text, l.sold_date,
               l.first_seen, l.last_seen, s.name AS suburb_name,
               COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) AS effective_date
        FROM listings l
        JOIN suburbs s ON l.suburb_id = s.id
        WHERE l.status = 'sold'
          AND LOWER(s.name) = LOWER(?)
          AND COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) >= ?
        ORDER BY COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) DESC,
                 l.first_seen DESC
        LIMIT ?
        """,
        (suburb, cutoff_date, src_limit)
    ).fetchall()
    sold_count = len(sold_rows)

    streets_to_fetch = []
    seen = set()
    for r in sold_rows:
        parsed = _parse_address(r['address'])
        if not parsed:
            continue
        _, _, street = parsed
        key = (street.lower(), (r['suburb_name'] or '').lower())
        if key in seen:
            continue
        seen.add(key)
        if _osm_street_numbers_cached(conn, street, r['suburb_name']) is None:
            streets_to_fetch.append((street, r['suburb_name']))
    # Defensive dedup — `seen` above already collapses (street, suburb)
    # duplicates within sold_rows, but tuples are hashable so dict.fromkeys
    # is cheap and protects against any future caller that bypasses `seen`.
    streets_to_fetch = list(dict.fromkeys(streets_to_fetch))
    if streets_to_fetch:
        logger.info(f"[pipeline] pre-warming OSM cache for {len(streets_to_fetch)} streets in parallel")
        def _warm(pair):
            street, sub = pair
            try:
                nums = _osm_fetch_street_numbers(street, sub)
            except Exception:
                nums = []
            return (street, sub, nums)
        with ThreadPoolExecutor(max_workers=6) as ex:
            for street, sub, nums in ex.map(_warm, streets_to_fetch):
                _osm_street_numbers_store(conn, street, sub, nums)

    insert_rows = []
    skipped_no_neighbour = 0
    for r in sold_rows:
        source_address = r['address']
        source_suburb = r['suburb_name']
        # ONLY use the actual sold_price from REIWA's "Last Sold on …"
        # block — never fall back to price_text. The asking price is
        # often very different from the transaction price (vendor
        # bid up / down) and surfacing it as "sold for $X" was
        # inventing data. NULL when sold_price is missing.
        source_price = _price_to_int(r['sold_price'])
        # ONLY use the real sold_date — never fall back to first_seen
        # (which was baking the date the listing was first scraped into
        # source_sold_date for every sale, surfacing as "all sold 28 Apr"
        # when the user first scraped the suburb on the 28th). NULL is
        # honest; the UI shows "—" rather than a fake unified date.
        source_sold_date = (r['sold_date'] or '').strip() or None
        targets = _real_neighbours(conn, source_address, source_suburb, has_hv)
        if not targets:
            skipped_no_neighbour += 1
            continue
        for target in targets:
            if has_hv:
                owner, score = _match_hot_vendor(conn, target)
            else:
                owner, score = None, None
            insert_rows.append((
                source_address, source_suburb, source_sold_date,
                source_price, target, owner, score,
            ))

    generated = _bulk_insert_pipeline(conn, insert_rows)
    conn.commit()

    # Always return the raw source sales — even when generated=0
    # (every neighbour already in pipeline OR no neighbours found).
    # The Pipeline UI surfaces these so the user can SEE the sales
    # found and add manual targets if auto-discovery missed them.
    raw_sales = []
    for r in sold_rows:
        d = dict(r)
        sold_date = (d.get('sold_date') or '').strip() or None
        first_seen = (d.get('first_seen') or '')[:10]
        if sold_date and sold_date == first_seen:
            sold_date = None  # extract_date corruption guard
        raw_sales.append({
            'source_address': d.get('address'),
            'source_suburb': d.get('suburb_name'),
            'source_price': _price_to_int(d.get('sold_price')),
            'source_sold_date': sold_date,
        })
    conn.close()

    return {
        'generated': generated,
        'sold_count': sold_count,
        'suburb': suburb,
        'cap_applied': sold_count >= src_limit,
        'skipped_no_neighbour': skipped_no_neighbour,
        'recent_sales': raw_sales,
    }


def pipeline_generate():
    suburb = (request.args.get('suburb') or '').strip()
    if not suburb:
        return jsonify({'error': 'suburb is required'}), 400
    if not user_can_access_suburb(suburb):
        return jsonify({'error': 'Suburb not in your allowed list'}), 403

    days_arg = request.args.get('days') or 7
    result = _generate_pipeline_for_suburb(suburb, days=days_arg, enforce_acl=False)
    if isinstance(result, dict) and result.get('status'):
        return jsonify({'error': result['error']}), result['status']

    # The HTTP endpoint also returns the latest 500 entries so the UI
    # can render the table without a second round-trip. Background
    # callers don't need this.
    conn = get_db()
    rows = conn.execute(
        """
        SELECT * FROM pipeline_tracking
        WHERE source_suburb_lower = LOWER(?)
        ORDER BY created_at DESC
        LIMIT 500
        """,
        (suburb,)
    ).fetchall()
    entries = _serialize_entries(rows)
    conn.close()

    result['entries'] = entries
    return jsonify(result)


def pipeline_manual_add():
    data = request.get_json(silent=True) or {}
    source_address = (data.get('source_address') or '').strip()
    source_suburb = (data.get('source_suburb') or '').strip()
    if not source_address:
        return jsonify({'error': 'source_address is required'}), 400
    if not source_suburb:
        return jsonify({'error': 'source_suburb is required'}), 400
    if not user_can_access_suburb(source_suburb):
        return jsonify({'error': 'Suburb not in your allowed list'}), 403

    source_price = _price_to_int(data.get('source_price'))
    source_sold_date = (data.get('source_sold_date') or '').strip() or \
        date.today().isoformat()

    explicit_targets = data.get('target_addresses') or []
    if not isinstance(explicit_targets, list):
        return jsonify({'error': 'target_addresses must be a list'}), 400
    explicit_targets = [t.strip() for t in explicit_targets
                        if isinstance(t, str) and t.strip()]

    conn = get_db()
    has_hv = _hot_vendors_table_exists(conn)

    if explicit_targets:
        targets = explicit_targets
    else:
        targets = _real_neighbours(conn, source_address, source_suburb, has_hv)
        if not targets:
            conn.close()
            return jsonify({
                'error': (
                    f"No real neighbours found near '{source_address}' in our "
                    "data (RP Data + listings). Provide target_addresses "
                    "explicitly to override."
                )
            }), 400

    insert_rows = []
    for target in targets:
        if has_hv:
            owner, score = _match_hot_vendor(conn, target)
        else:
            owner, score = None, None
        insert_rows.append((
            source_address, source_suburb, source_sold_date,
            source_price, target, owner, score,
        ))

    generated = _bulk_insert_pipeline(conn, insert_rows)
    conn.commit()

    rows = conn.execute(
        """
        SELECT * FROM pipeline_tracking
        WHERE LOWER(source_address) = LOWER(?)
          AND source_suburb_lower = LOWER(?)
          AND sent_date = ?
        ORDER BY target_address ASC
        """,
        (source_address, source_suburb, date.today().isoformat())
    ).fetchall()
    entries = _serialize_entries(rows)
    conn.close()

    return jsonify({
        'generated': generated,
        'attempted': len(targets),
        'targets': targets,
        'source_address': source_address,
        'source_suburb': source_suburb,
        'entries': entries,
    })


def pipeline_tracking_list():
    suburb = (request.args.get('suburb') or '').strip()
    status = (request.args.get('status') or '').strip()
    try:
        limit = int(request.args.get('limit') or 100)
    except ValueError:
        limit = 100
    limit = max(1, min(limit, 1000))

    _, allowed_names = get_user_allowed_suburb_names()
    if suburb and allowed_names is not None and suburb.lower() not in allowed_names:
        return jsonify({'error': 'Suburb not in your allowed list'}), 403

    conn = get_db()
    _enrich_owner_names(conn, suburb or None)
    sql = "SELECT * FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND source_suburb_lower = LOWER(?)"
        params.append(suburb)
    elif allowed_names is not None:
        if not allowed_names:
            conn.close()
            return jsonify({'entries': []})
        placeholders = ','.join(['?'] * len(allowed_names))
        sql += f" AND source_suburb_lower IN ({placeholders})"
        params.extend(allowed_names)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return jsonify({'entries': _serialize_entries(rows)})


def pipeline_tracking_grouped():
    suburb = (request.args.get('suburb') or '').strip()
    try:
        limit = int(request.args.get('limit') or 200)
    except ValueError:
        limit = 200
    limit = max(1, min(limit, 1000))
    # Optional day-window filter on the source sale date. Without it the
    # tracking table accumulates targets generated months ago and the
    # 7/14/30 day toggle on the Pipeline page becomes purely cosmetic.
    days_raw = (request.args.get('days') or '').strip()
    days = None
    if days_raw:
        try:
            days = max(1, min(int(days_raw), 365))
        except ValueError:
            days = None

    _, allowed_names = get_user_allowed_suburb_names()
    if suburb and allowed_names is not None and suburb.lower() not in allowed_names:
        return jsonify({'error': 'Suburb not in your allowed list'}), 403

    conn = get_db()
    # Auto-fill owner names from latest hot_vendor_properties data
    _enrich_owner_names(conn, suburb or None)

    sql = "SELECT * FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND source_suburb_lower = LOWER(?)"
        params.append(suburb)
    elif allowed_names is not None:
        if not allowed_names:
            conn.close()
            return jsonify({'groups': []})
        placeholders = ','.join(['?'] * len(allowed_names))
        sql += f" AND source_suburb_lower IN ({placeholders})"
        params.extend(allowed_names)
    if days is not None:
        cutoff_date = (datetime.utcnow() - timedelta(days=days)).date().isoformat()
        # source_sold_date is stored as TEXT but in two formats across the
        # life of the table: ISO YYYY-MM-DD (scraper + import_api today)
        # and legacy DD/MM/YYYY (older pipeline_tracking rows from before
        # the ISO conversion landed in scraper.py). A plain `>= cutoff`
        # compare only works for ISO; a SUBSTR-on-position-5 guard that
        # required '-' was rejecting every legacy row — including ones
        # actually within the window — which surfaced as an empty
        # Pipeline page for suburbs where most history predates the
        # format flip. Handle both formats in one OR clause: ISO rows
        # compare directly, DD/MM/YYYY rows are reconstructed to ISO
        # in-SQL via SUBSTR + concat then compared.
        sql += (
            " AND source_sold_date IS NOT NULL"
            " AND source_sold_date != ''"
            " AND ("
            "   ("
            "     SUBSTR(source_sold_date, 5, 1) = '-'"
            "     AND SUBSTR(source_sold_date, 1, 10) >= ?"
            "   )"
            "   OR ("
            "     SUBSTR(source_sold_date, 3, 1) = '/'"
            "     AND SUBSTR(source_sold_date, 6, 1) = '/'"
            "     AND ("
            "       SUBSTR(source_sold_date, 7, 4) || '-'"
            "       || SUBSTR(source_sold_date, 4, 2) || '-'"
            "       || SUBSTR(source_sold_date, 1, 2)"
            "     ) >= ?"
            "   )"
            " )"
        )
        params.extend([cutoff_date, cutoff_date])
    sql += " ORDER BY target_address ASC, created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    groups = {}
    for raw in rows:
        r = dict(raw)
        for k, v in list(r.items()):
            if isinstance(v, (date, datetime)):
                r[k] = v.isoformat()
        key = (r['target_address'].lower().strip(),
               (r.get('source_suburb') or '').lower().strip())
        if key not in groups:
            groups[key] = {
                'target_address': r['target_address'],
                'source_suburb': r.get('source_suburb'),
                'target_owner_name': r.get('target_owner_name'),
                'hot_vendor_score': r.get('hot_vendor_score'),
                'status': r.get('status'),
                'sent_date': r.get('sent_date'),
                'response_date': r.get('response_date'),
                'notes': r.get('notes'),
                # 1/0 from SQLite, bool from psycopg2 — coerce to bool for JSON.
                'contacted': bool(r.get('contacted')),
                'contacted_at': r.get('contacted_at'),
                'representative_id': r.get('id'),
                'row_ids': [],
                'sources': [],
                '_source_addrs_seen': set(),
            }
        g = groups[key]
        g['row_ids'].append(r['id'])
        src_addr_key = (r.get('source_address') or '').strip().lower()
        if src_addr_key and src_addr_key not in g['_source_addrs_seen']:
            g['_source_addrs_seen'].add(src_addr_key)
            g['sources'].append({
                'source_address': r.get('source_address'),
                'source_price': r.get('source_price'),
                'source_sold_date': r.get('source_sold_date'),
                'row_id': r.get('id'),
            })
        if not g.get('target_owner_name') and r.get('target_owner_name'):
            g['target_owner_name'] = r.get('target_owner_name')
        if g.get('hot_vendor_score') is None and r.get('hot_vendor_score') is not None:
            g['hot_vendor_score'] = r.get('hot_vendor_score')

    grouped = list(groups.values())
    for g in grouped:
        g['sources'].sort(key=lambda s: (s.get('source_address') or '').lower())
        g.pop('_source_addrs_seen', None)
    grouped.sort(key=lambda g: (
        (g['sources'][0].get('source_address') if g['sources'] else g['target_address'] or '').lower()
    ))
    grouped = grouped[:limit]
    return jsonify({'groups': grouped, 'count': len(grouped)})


def pipeline_tracking_update(id):
    data = request.get_json(silent=True) or {}
    allowed = ('status', 'response_date', 'notes', 'target_owner_name', 'contacted')

    # Build (column, value) pairs in one pass — keeps coerced values
    # like contacted/contacted_at aligned with their placeholders.
    pairs = []  # list of (sql_fragment, value)
    for key in allowed:
        if key not in data:
            continue
        if key == 'contacted':
            v = 1 if data[key] else 0
            pairs.append(("contacted = ?", v))
            pairs.append(("contacted_at = ?",
                          datetime.utcnow().isoformat() if v else None))
        else:
            pairs.append((f"{key} = ?", data[key]))

    if not pairs:
        return jsonify({'error': 'No updatable fields provided'}), 400

    propagate_owner = 'target_owner_name' in data

    conn = get_db()
    target_row = conn.execute(
        "SELECT target_address, source_suburb FROM pipeline_tracking WHERE id = ?",
        (id,)
    ).fetchone()
    if not target_row:
        conn.close()
        return jsonify({'error': 'Not found'}), 404

    if not user_can_access_suburb(target_row['source_suburb']):
        conn.close()
        return jsonify({'error': 'Not authorised for that suburb'}), 403

    if propagate_owner:
        conn.execute(
            "UPDATE pipeline_tracking SET target_owner_name = ? "
            "WHERE LOWER(target_address) = LOWER(?) AND source_suburb_lower = LOWER(?)",
            (data['target_owner_name'], target_row['target_address'], target_row['source_suburb'])
        )

    # Apply every non-target_owner_name update for THIS row only.
    other_pairs = [p for p in pairs if not p[0].startswith('target_owner_name')]
    if other_pairs:
        sql_frags = [p[0] for p in other_pairs]
        sql_params = [p[1] for p in other_pairs] + [id]
        try:
            conn.execute(
                f"UPDATE pipeline_tracking SET {', '.join(sql_frags)} WHERE id = ?",
                sql_params
            )
        except Exception as e:
            # Most likely cause: contacted/contacted_at column missing
            # because migrations haven't run (fresh deploy). Strip
            # those fields and retry once with the fields the schema
            # definitely has, so the user's other edits still land.
            logger.warning(f"PATCH retry without contacted columns: {e}")
            safe_pairs = [p for p in other_pairs
                          if not p[0].startswith('contacted')]
            if safe_pairs:
                sql_frags = [p[0] for p in safe_pairs]
                sql_params = [p[1] for p in safe_pairs] + [id]
                conn.execute(
                    f"UPDATE pipeline_tracking SET {', '.join(sql_frags)} WHERE id = ?",
                    sql_params
                )

    conn.commit()
    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(_serialize_entries([row])[0])


def pipeline_tracking_clear():
    if (request.args.get('confirm') or '').lower() != 'yes':
        return jsonify({
            'error': 'Add ?confirm=yes to actually delete. This is destructive.'
        }), 400

    suburb = (request.args.get('suburb') or '').strip()
    status = (request.args.get('status') or '').strip()
    if not suburb and not status:
        return jsonify({
            'error': 'At least suburb or status must be provided. '
                     'Refusing to wipe the entire table.'
        }), 400

    _, allowed_names = get_user_allowed_suburb_names()
    if suburb and allowed_names is not None and suburb.lower() not in allowed_names:
        return jsonify({'error': 'Suburb not in your allowed list'}), 403

    conn = get_db()
    sql = "DELETE FROM pipeline_tracking WHERE 1=1"
    params = []
    if suburb:
        sql += " AND source_suburb_lower = LOWER(?)"
        params.append(suburb)
    elif allowed_names is not None:
        # Status-only delete from a non-admin user must stay scoped to
        # their suburbs — otherwise they could nuke everyone's pipeline.
        if not allowed_names:
            conn.close()
            return jsonify({'deleted': 0, 'suburb': None, 'status': status or None})
        placeholders = ','.join(['?'] * len(allowed_names))
        sql += f" AND source_suburb_lower IN ({placeholders})"
        params.extend(allowed_names)
    if status:
        sql += " AND status = ?"
        params.append(status)
    cur = conn.execute(sql, params)
    deleted = cur.rowcount or 0
    conn.commit()
    conn.close()
    return jsonify({'deleted': deleted, 'suburb': suburb or None, 'status': status or None})


def pipeline_letter_download(id):
    conn = get_db()
    # SECURITY: do NOT call _enrich_owner_names(conn, None) here — that
    # would run a global UPDATE across every tenant's pipeline_tracking
    # rows before we'd even verified the caller owns this letter. The
    # enrich happens AFTER the ACL check below, scoped to the caller's
    # source_suburb.
    row = conn.execute(
        "SELECT * FROM pipeline_tracking WHERE id = ?", (id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Letter not found'}), 404

    entry = dict(row)
    target_address = entry.get('target_address') or ''
    source_suburb = entry.get('source_suburb') or ''

    if not user_can_access_suburb(source_suburb):
        conn.close()
        return jsonify({'error': 'Not authorised for that suburb'}), 403

    # Now safe — caller has access to this suburb, so enriching the
    # owner names for THIS suburb only is in scope.
    _enrich_owner_names(conn, source_suburb)

    sources = _gather_sources_for_target(conn, target_address, source_suburb)
    conn.close()

    if not sources:
        sources = [{
            'source_address': entry.get('source_address'),
            'source_price': entry.get('source_price'),
            'source_sold_date': entry.get('source_sold_date'),
        }]

    owner_name = entry.get('target_owner_name')
    if not owner_name:
        for s in sources:
            n = (s.get('target_owner_name') or '').strip()
            if n:
                owner_name = n
                break

    # Pass the calling user's profile so the signature/footer reflects
    # their agency + contact details. Falls back to env vars then '' inside
    # the renderer if a field is empty.
    from admin_api import get_current_user
    me = get_current_user() or {}
    user_profile = {
        'agency_name': me.get('agency_name'),
        'agent_name': me.get('agent_name'),
        'agent_phone': me.get('agent_phone'),
        'agent_email': me.get('agent_email'),
    }
    doc = render_letter_docx(target_address, owner_name, source_suburb, sources, user_profile=user_profile)

    buf = BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe = re.sub(r'[^\w\s-]', '', target_address)[:60].strip().replace(' ', '_')
    filename = f"letter_{safe or 'letter'}.docx"
    return send_file(
        buf,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=filename,
    )


def pipeline_enrich_owners():
    """Manual trigger — back-fill owner names across the whole pipeline
    (or one suburb) from the latest hot_vendor_properties data. Useful
    right after uploading a fresh RP Data CSV."""
    suburb = (request.args.get('suburb') or '').strip() or None
    # Multi-tenant scope: a non-admin call without ?suburb= would bulk-
    # rewrite target_owner_name across every tenant's pipeline rows.
    # Require an explicit, in-scope suburb for non-admins; admins keep
    # the global option.
    _user, allowed_names = get_user_allowed_suburb_names()
    if allowed_names is not None:
        if not suburb:
            return jsonify({
                'error': 'suburb query param required (only admins can enrich globally)'
            }), 403
        if not user_can_access_suburb(suburb):
            return jsonify({'error': 'Not authorised for that suburb'}), 403
    conn = get_db()
    updated = _enrich_owner_names(conn, suburb)
    conn.close()
    return jsonify({'updated': updated, 'suburb': suburb})


def pipeline_recent_sales():
    """Lightweight read of sales matching ?suburb=X&days=N. No
    generation, no DB writes — just returns the raw sold listings so
    the Pipeline page can SHOW the sales the day-window toggle
    selects, regardless of whether targets have been generated yet."""
    suburb = (request.args.get('suburb') or '').strip()
    if not suburb:
        return jsonify({'sales': []})
    if not user_can_access_suburb(suburb):
        return jsonify({'error': 'Suburb not in your allowed list'}), 403
    try:
        days = int(request.args.get('days') or 30)
    except ValueError:
        days = 30
    days = max(1, min(days, 365))
    cutoff_date = (datetime.utcnow() - timedelta(days=days)).date().isoformat()

    conn = get_db()
    rows = conn.execute(
        """
        SELECT l.address, l.sold_price, l.price_text, l.sold_date,
               l.first_seen, l.last_seen, l.reiwa_url, l.agent, l.agency,
               s.name AS suburb_name,
               COALESCE(l.sold_date, SUBSTR(l.first_seen, 1, 10)) AS effective_date
        FROM listings l
        JOIN suburbs s ON l.suburb_id = s.id
        WHERE l.status = 'sold'
          AND LOWER(s.name) = LOWER(?)
          AND l.sold_date IS NOT NULL
          AND l.sold_date != ''
          AND l.sold_date != SUBSTR(l.first_seen, 1, 10)
          AND l.sold_date >= ?
        ORDER BY l.sold_date DESC, l.first_seen DESC
        LIMIT 200
        """,
        (suburb, cutoff_date)
    ).fetchall()
    conn.close()

    sales = []
    for r in rows:
        d = dict(r)
        # Live corruption guard: if sold_date equals the date portion
        # of first_seen, it was set by the extract_date bug (REIWA's
        # sold-card <time> returned the scrape day, not the actual
        # sold date). Treat as unknown rather than displaying a wrong
        # uniform date for every listing scraped that day. This runs
        # at every request so even if the one-shot migration hasn't
        # executed (Render deploy lag), the API doesn't lie.
        sold_date = (d.get('sold_date') or '').strip() or None
        first_seen = (d.get('first_seen') or '')[:10]
        if sold_date and sold_date == first_seen:
            sold_date = None
        sales.append({
            'source_address': d.get('address'),
            'source_suburb': d.get('suburb_name'),
            'source_price': _price_to_int(d.get('sold_price')),
            'source_sold_date': sold_date,
            'reiwa_url': d.get('reiwa_url'),
            'agent': d.get('agent'),
            'agency': d.get('agency'),
        })
    return jsonify({'sales': sales, 'suburb': suburb, 'days': days})


def _streets_in_suburb(conn, suburb):
    """Distinct street names with a recent SOLD listing in this suburb —
    Pipeline only generates targets from sold sources, so warming OSM
    for streets where nothing's been sold is wasted Overpass quota.
    Was previously pulling EVERY listing (active+UO+sold+withdrawn)
    which on a fresh account dragged the warm-up to 1+ minute."""
    rows = conn.execute(
        "SELECT DISTINCT l.address FROM listings l "
        "JOIN suburbs s ON l.suburb_id = s.id "
        "WHERE LOWER(s.name) = LOWER(?) "
        "AND l.status = 'sold' "
        "AND l.address IS NOT NULL "
        "ORDER BY l.last_seen DESC "
        "LIMIT 60",
        (suburb,)
    ).fetchall()
    streets = set()
    for r in rows:
        parsed = _parse_address(dict(r).get('address'))
        if parsed:
            streets.add(parsed[2])
    return sorted(streets)


def _osm_prefetch_worker(suburb):
    """Background thread — warm the OSM cache for every street in the
    suburb. Catches all exceptions and prints to stderr so a failure
    can't silently kill the thread (Flask doesn't propagate background
    thread errors, and we'd never know why a suburb stays 'warming')."""
    suburb_key = (suburb or '').strip().lower()
    try:
        conn = get_db()
        try:
            streets = _streets_in_suburb(conn, suburb)
            todo = [s for s in streets
                    if _osm_street_numbers_cached(conn, s, suburb) is None]
            # Defensive dedup — _streets_in_suburb already returns a set,
            # but if a future caller passes a non-set iterable the executor
            # would happily fire the same Overpass query N times.
            todo = list(dict.fromkeys(todo))
            if todo:
                logger.info(f"[osm-prefetch] {suburb}: warming {len(todo)} streets")
                with ThreadPoolExecutor(max_workers=6) as ex:
                    def _warm(street):
                        try:
                            return street, _osm_fetch_street_numbers(street, suburb)
                        except Exception:
                            return street, []
                    for street, nums in ex.map(_warm, todo):
                        try:
                            _osm_street_numbers_store(conn, street, suburb, nums)
                        except Exception:
                            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception:
        # Print full trace to stderr — see Render logs to debug. We also
        # log via logger.exception so structured-log consumers catch it.
        traceback.print_exc(file=sys.stderr)
        logger.exception(f"[osm-prefetch] worker crashed for suburb={suburb}")
    finally:
        with _osm_jobs_lock:
            _osm_jobs[suburb_key] = {
                'status': 'ready',
                'finished_at': datetime.utcnow(),
            }


def _osm_suburb_cache_status(conn, suburb):
    """Returns 'ready' | 'empty'. 'ready' = at least one fresh cached
    row exists for this suburb. 'empty' = no fresh cache. Stale rows
    (older than OSM_CACHE_TTL_DAYS) are treated as misses to match
    _osm_street_numbers_cached's read behaviour."""
    sub = (suburb or '').strip().lower()
    if not sub:
        return 'empty'
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM street_address_cache "
            "WHERE street_key LIKE ? AND fetched_at IS NOT NULL",
            (f"%|{sub}",)
        ).fetchone()
    except Exception:
        return 'empty'
    if not row:
        return 'empty'
    n = dict(row).get('n') or 0
    return 'ready' if n > 0 else 'empty'


def pipeline_osm_status(suburb):
    """Returns the OSM prefetch state for a suburb. If no fresh cache
    exists, kicks off a background warm thread and returns 'warming' so
    the frontend can poll until 'ready' lands. Cached suburbs return
    'ready' instantly with no work."""
    suburb = (suburb or '').strip()
    if not suburb:
        return jsonify({'status': 'empty'}), 400
    if not user_can_access_suburb(suburb):
        return jsonify({'error': 'Suburb not in your allowed list'}), 403

    suburb_key = suburb.lower()
    # If a worker is already running for this suburb, just report warming
    # without spawning another thread.
    with _osm_jobs_lock:
        job = _osm_jobs.get(suburb_key)
        if job and job.get('status') == 'warming':
            return jsonify({'status': 'warming'})

    conn = get_db()
    cache_state = _osm_suburb_cache_status(conn, suburb)
    conn.close()

    if cache_state == 'ready':
        return jsonify({'status': 'ready'})

    # Cache empty — fire off a background warm and return warming so the
    # frontend can poll. The thread updates _osm_jobs[suburb_key] when
    # done; subsequent polls flip to 'ready' once the cache is populated.
    with _osm_jobs_lock:
        _osm_jobs[suburb_key] = {
            'status': 'warming',
            'started_at': datetime.utcnow(),
        }
    t = threading.Thread(
        target=_osm_prefetch_worker, args=(suburb,), daemon=True
    )
    t.start()
    return jsonify({'status': 'warming'})


# ---------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------

def pipeline_admin_backfill():
    """One-shot admin tool: regenerate pipeline_tracking for every active
    suburb using a 60-day window. Use case — the GHA daily cron didn't
    auto-generate pipeline rows until cab84d5, so sales scraped between
    the format-flip and that fix sit in `listings` with no matching
    targets. This walks every suburb once to catch them up.

    Synchronous on purpose — admin-only, ad-hoc tool. Expect 1-5 minutes
    on a 15-suburb deployment depending on OSM cache state."""
    from admin_api import _require_admin
    _user, err = _require_admin()
    if err:
        return err

    conn = get_db()
    suburb_rows = conn.execute(
        "SELECT DISTINCT name FROM suburbs WHERE active = 1 ORDER BY name"
    ).fetchall()
    conn.close()
    names = [r['name'] for r in suburb_rows if r['name']]

    results = []
    for name in names:
        try:
            pg = _generate_pipeline_for_suburb(name, days=60, enforce_acl=False)
            results.append({
                'suburb': name,
                'generated': pg.get('generated', 0),
                'sold_count': pg.get('sold_count', 0),
            })
            logger.info(
                f"[backfill] {name}: {pg.get('generated', 0)} targets from "
                f"{pg.get('sold_count', 0)} sales"
            )
        except Exception as e:
            logger.warning(f"[backfill] {name} failed: {e}")
            results.append({
                'suburb': name,
                'error': str(e),
            })

    return jsonify({'results': results, 'suburbs_processed': len(names)})


def register_pipeline_routes(app):
    app.add_url_rule('/api/pipeline/generate', endpoint='pipeline_generate',
                     view_func=pipeline_generate, methods=['GET'])
    app.add_url_rule('/api/pipeline/manual-add', endpoint='pipeline_manual_add',
                     view_func=pipeline_manual_add, methods=['POST'])
    app.add_url_rule('/api/pipeline/tracking', endpoint='pipeline_tracking_list',
                     view_func=pipeline_tracking_list, methods=['GET'])
    app.add_url_rule('/api/pipeline/tracking/grouped', endpoint='pipeline_tracking_grouped',
                     view_func=pipeline_tracking_grouped, methods=['GET'])
    app.add_url_rule('/api/pipeline/tracking/<int:id>', endpoint='pipeline_tracking_update',
                     view_func=pipeline_tracking_update, methods=['PATCH'])
    app.add_url_rule('/api/pipeline/tracking', endpoint='pipeline_tracking_clear',
                     view_func=pipeline_tracking_clear, methods=['DELETE'])
    app.add_url_rule('/api/pipeline/letter/<int:id>/download',
                     endpoint='pipeline_letter_download',
                     view_func=pipeline_letter_download, methods=['GET'])
    app.add_url_rule('/api/pipeline/enrich-owners', endpoint='pipeline_enrich_owners',
                     view_func=pipeline_enrich_owners, methods=['POST'])
    app.add_url_rule('/api/pipeline/recent-sales',
                     endpoint='pipeline_recent_sales',
                     view_func=pipeline_recent_sales, methods=['GET'])
    app.add_url_rule('/api/pipeline/osm-status/<path:suburb>',
                     endpoint='pipeline_osm_status',
                     view_func=pipeline_osm_status, methods=['GET'])
    app.add_url_rule('/api/admin/pipeline-backfill',
                     endpoint='pipeline_admin_backfill',
                     view_func=pipeline_admin_backfill, methods=['POST'])
    logger.info(
        "Pipeline routes: /api/pipeline/{generate,manual-add,tracking,letter/<id>/download,enrich-owners,osm-status/<suburb>}"
    )

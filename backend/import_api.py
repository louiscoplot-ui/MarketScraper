"""CSV / Excel import for RP Data / CoreLogic property exports.

UPDATE-ONLY mode: every row is matched against an existing listings
row (suburb_id + normalized_address). On match we overwrite sold_date
and sold_price. On no match we skip — REIWA scrape stays the source
of truth for what's IN the table; RP Data only enriches dates.

Two header strategies:
1. Named headers — fuzzy match against COLUMN_ALIASES (RP Data web
   exports occasionally include them).
2. Positional fallback — RP Data CLI exports drop straight into data
   with no header row at all. We detect this shape and use the
   documented fixed-position layout.
"""

import io
import csv
import re
import logging
from datetime import datetime, date
from flask import request, jsonify

from database import get_db, normalize_address

logger = logging.getLogger(__name__)


COLUMN_ALIASES = {
    'address':      ['property address', 'address', 'street address',
                     'full address', 'street'],
    'suburb':       ['suburb', 'locality', 'area', 'town/suburb'],
    'postcode':     ['postcode', 'post code', 'zip'],
    'sold_date':    ['sale date', 'last sold date', 'date sold',
                     'settlement date', 'sold date', 'transaction date',
                     'contract date'],
    'sold_price':   ['sale price', 'last sold price', 'sold price',
                     'price', 'transaction price'],
    'bedrooms':     ['bedrooms', 'beds', 'bed', 'bedrooms count'],
    'bathrooms':    ['bathrooms', 'baths', 'bath', 'bathrooms count'],
    'parking':      ['car spaces', 'parking', 'cars', 'car', 'garage',
                     'car spaces count'],
    'land_size':    ['land size', 'land area', 'lot size', 'site area',
                     'land (m²)', 'land m²'],
    'internal_size': ['floor area', 'internal area', 'internal size',
                      'building area', 'internal (m²)'],
    'listing_type': ['property type', 'type', 'dwelling type'],
    'agent':        ['agent', 'selling agent', 'sales agent'],
    'agency':       ['agency', 'agency name', 'sales agency',
                     'selling agency'],
    'owner':        ['owner name', 'current owner', 'owner',
                     'registered owner', 'purchaser', 'purchaser name'],
}


# RP Data's no-header export uses this fixed positional layout. Verified
# against actual exports: address, suburb, state, postcode, type, beds,
# baths, cars, land, internal, ?, price, date, ...
RPDATA_POSITIONAL = {
    'address':      0,
    'suburb':       1,
    'postcode':     3,
    'listing_type': 4,
    'bedrooms':     5,
    'bathrooms':    6,
    'parking':      7,
    'land_size':    8,
    'internal_size': 9,
    'sold_price':   11,
    'sold_date':    12,
}

AU_STATE_CODES = {'WA', 'NSW', 'VIC', 'QLD', 'SA', 'TAS', 'NT', 'ACT'}


def _parse_price(text):
    if text is None or text == '':
        return None
    s = str(text).strip()
    if not s or s == '-':
        return None
    m_short = re.match(r'^\$?(\d+(?:\.\d+)?)\s*([MmKk])\b', s)
    if m_short:
        try:
            v = float(m_short.group(1))
        except ValueError:
            return None
        suffix = m_short.group(2).lower()
        v *= 1_000_000 if suffix == 'm' else 1_000
        return int(v) if v >= 10_000 else None
    digits = re.sub(r'[^\d.]', '', s)
    if not digits:
        return None
    try:
        v = float(digits)
    except (ValueError, TypeError):
        return None
    return int(v) if v >= 10_000 else None


def _parse_date(text):
    if not text:
        return None
    s = str(text).strip()
    if not s or s == '-':
        return None

    s = s.split('T')[0].split(' ', 1)
    # Keep only the first 1-3 tokens to handle 'YYYY-MM-DD HH:MM:SS' (1)
    # or '08 Aug 2025' (3 tokens — keep them) or '8-Aug-25' (1 token).
    if len(s) == 1:
        rest = s[0]
    else:
        # If the second token looks like time (has ':') drop it
        if ':' in s[1]:
            rest = s[0]
        else:
            rest = ' '.join(s)
    s = rest.strip()

    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass

    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$', s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$', s)
    if m:
        try:
            yr = int(m.group(3))
            yr = 2000 + yr if yr < 70 else 1900 + yr
            return date(yr, int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    for fmt in (
        '%d %b %Y', '%d %B %Y',
        '%b %d %Y', '%B %d %Y',
        '%d-%b-%y', '%d-%b-%Y',
        '%d-%B-%y', '%d-%B-%Y',
    ):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue

    return None


def _is_header_row(cells):
    norm = [(c or '').strip().lower() for c in cells]
    hits = 0
    for aliases in COLUMN_ALIASES.values():
        for alias in aliases:
            if alias in norm:
                hits += 1
                break
    return hits >= 3


def _detect_columns(header):
    norm = [(h or '').strip().lower() for h in header]
    out = {}
    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in norm:
                out[canonical] = norm.index(alias)
                break
    return out


def _looks_like_rpdata_positional(row):
    """RP Data no-header CSV: col 0 is an uppercase street address, col 1
    is the suburb, col 2 is an Australian state code. Strong signature.
    """
    if not row or len(row) < 5:
        return False
    addr = (row[0] or '').strip()
    suburb = (row[1] or '').strip()
    state = (row[2] or '').strip().upper()
    if not re.match(r'^\d+\w*\s+[A-Z]', addr):
        return False
    if not suburb:
        return False
    if state not in AU_STATE_CODES:
        return False
    return True


def _strip_suburb_from_address(addr, suburb):
    if not addr:
        return addr
    addr = addr.strip().rstrip(',').strip()
    if not suburb:
        return addr
    suburb_lower = suburb.lower()
    addr_lower = addr.lower()
    pos = addr_lower.find(suburb_lower)
    if pos > 0:
        return addr[:pos].strip().rstrip(',').strip()
    return addr


def _read_rows(file_storage):
    name = (file_storage.filename or '').lower()
    if name.endswith('.csv'):
        try:
            text = file_storage.read().decode('utf-8-sig')
        except UnicodeDecodeError:
            file_storage.seek(0)
            text = file_storage.read().decode('latin-1', errors='replace')
        reader = csv.reader(io.StringIO(text))
        return list(reader), None
    if name.endswith('.xlsx') or name.endswith('.xls'):
        try:
            from openpyxl import load_workbook
        except ImportError:
            return None, 'openpyxl not installed on the server'
        try:
            wb = load_workbook(file_storage, data_only=True, read_only=True)
        except Exception as e:
            return None, f'Could not open Excel file: {e}'
        ws = wb.active
        rows = []
        for r in ws.iter_rows(values_only=True):
            rows.append([('' if c is None else str(c)) for c in r])
        return rows, None
    return None, 'Unsupported file extension. Use .csv or .xlsx.'


def _find_header_index(rows, scan_limit=20):
    for i in range(min(scan_limit, len(rows))):
        if _is_header_row(rows[i]):
            return i
    return -1  # -1 == no header found, caller decides what to do


def import_rpdata():
    """POST /api/listings/import-rpdata.

    multipart/form-data:
        file (required) — .csv or .xlsx export from RP Data / CoreLogic
        suburb (optional) — fallback if neither named header nor
                            positional layout has a suburb column

    UPDATE-ONLY: rows that don't match an existing listing are skipped
    (counted as no_match), NEVER inserted as new rows.
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded. Use multipart field "file".'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    rows, err = _read_rows(file)
    if err:
        return jsonify({'error': err}), 400
    if not rows:
        return jsonify({'error': 'File is empty'}), 400

    # Two paths to figure out where data lives:
    # 1. Try to find a named header anywhere in the first 20 rows.
    # 2. If none, see if row 0 looks like RP Data's positional shape.
    header_idx = _find_header_index(rows)
    cols = {}
    data_rows = []
    layout_used = ''

    if header_idx >= 0:
        cols = _detect_columns(rows[header_idx])
        data_rows = rows[header_idx + 1:]
        layout_used = 'named-header'
    elif _looks_like_rpdata_positional(rows[0]):
        cols = dict(RPDATA_POSITIONAL)
        data_rows = rows
        layout_used = 'rpdata-positional'

    if 'address' not in cols:
        return jsonify({
            'error': (
                "Could not parse the file's structure. Expected either a "
                "named header row (Property Address / Suburb / Sale Date / "
                "Sale Price), OR an RP Data positional layout where col 0 = "
                "address, col 1 = suburb, col 2 = state."
            ),
            'first_row_seen': [str(c) for c in rows[0][:10]],
            'header_row_index': header_idx,
        }), 400

    fallback_suburb = (request.form.get('suburb') or '').strip()

    conn = get_db()

    suburb_rows = conn.execute("SELECT id, name, slug FROM suburbs").fetchall()
    suburb_by_name = {r['name'].lower(): r for r in suburb_rows}

    matched = 0
    no_match = 0
    skipped = 0
    date_updates = 0
    price_updates = 0
    errors = []
    now_iso = datetime.utcnow().isoformat()

    for row_idx, row in enumerate(data_rows, start=(header_idx + 2 if header_idx >= 0 else 1)):
        if not row or all((c is None or str(c).strip() in ('', '-')) for c in row):
            continue

        try:
            def cell(key):
                idx = cols.get(key)
                if idx is None or idx >= len(row):
                    return ''
                v = row[idx]
                if v is None:
                    return ''
                s = str(v).strip()
                # RP Data uses '-' as the empty placeholder
                return '' if s == '-' else s

            addr_raw = cell('address')
            if not addr_raw:
                skipped += 1
                continue

            suburb_name = cell('suburb') or fallback_suburb
            if not suburb_name:
                skipped += 1
                if len(errors) < 20:
                    errors.append(f"Row {row_idx}: no suburb column / fallback")
                continue

            suburb_row = suburb_by_name.get(suburb_name.lower())
            if not suburb_row:
                no_match += 1
                continue

            suburb_id = suburb_row['id']
            address = _strip_suburb_from_address(addr_raw, suburb_name)
            norm_addr = normalize_address(address)
            if not norm_addr:
                skipped += 1
                continue

            sold_date = _parse_date(cell('sold_date'))
            sold_price = _parse_price(cell('sold_price'))

            existing = conn.execute(
                "SELECT id, sold_date, sold_price, status FROM listings "
                "WHERE suburb_id = ? AND normalized_address = ? LIMIT 1",
                (suburb_id, norm_addr)
            ).fetchone()

            if not existing:
                no_match += 1
                continue

            updates = []
            params = []
            if sold_date and sold_date != existing['sold_date']:
                updates.append("sold_date = ?")
                params.append(sold_date)
                date_updates += 1
            if sold_price:
                price_str = str(sold_price)
                if price_str != (existing['sold_price'] or ''):
                    updates.append("sold_price = ?")
                    params.append(price_str)
                    price_updates += 1

            if existing['status'] != 'sold':
                updates.append("status = 'sold'")

            if updates:
                updates.append("last_seen = ?")
                params.append(now_iso)
                params.append(existing['id'])
                conn.execute(
                    f"UPDATE listings SET {', '.join(updates)} WHERE id = ?",
                    params
                )
            matched += 1
        except Exception as e:
            skipped += 1
            if len(errors) < 20:
                errors.append(f"Row {row_idx}: {type(e).__name__}: {e}")
            try:
                conn.commit()
            except Exception:
                pass

    conn.commit()
    conn.close()

    return jsonify({
        'matched': matched,
        'no_match': no_match,
        'skipped': skipped,
        'date_updates': date_updates,
        'price_updates': price_updates,
        'total_rows': len(data_rows),
        'layout_used': layout_used,
        'detected_columns': cols,
        'errors': errors,
    })


def register_import_routes(app):
    app.add_url_rule(
        '/api/listings/import-rpdata',
        endpoint='import_rpdata',
        view_func=import_rpdata,
        methods=['POST']
    )
    logger.info("Import routes registered: POST /api/listings/import-rpdata")

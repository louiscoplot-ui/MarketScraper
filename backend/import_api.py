"""CSV / Excel import for RP Data / CoreLogic property exports.

UPDATE-ONLY mode: every row in the upload is matched against an
existing listings row (suburb + normalized_address). On match we
overwrite sold_date and sold_price with the RP Data values. On no
match we simply skip — the user's intent is to fix dates that the
REIWA scraper got wrong, NOT to grow the table.

Workflow:
    Agent exports CSV/xlsx of recent sales from RP Data ->
    POST file as multipart/form-data 'file' ->
    Each row matched against listings(normalized_address, suburb_id) ->
    Match: UPDATE sold_date, sold_price, status='sold'
    No match: skip (counted)

Wire into app.py with two lines:
    from import_api import register_import_routes
    register_import_routes(app)
"""

import io
import csv
import re
import logging
from datetime import datetime, date
from flask import request, jsonify

from database import get_db, normalize_address

logger = logging.getLogger(__name__)


# RP Data, CoreLogic, Pricefinder — they all ship slightly different
# column names. Lower-cased fuzzy match against any alias.
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


def _parse_price(text):
    if text is None or text == '':
        return None
    s = str(text).strip()
    if not s:
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
    """Parse various date formats, return ISO 'YYYY-MM-DD' or None.

    Australian convention: DD before MM. RP Data also uses '8-Aug-25'
    abbreviated month with 2-digit year — that's why DD-Mon-YY is in
    the format list. %y handles 2-digit year per Python rules
    (00-68 = 20xx, 69-99 = 19xx, fine for Australian sale dates).
    """
    if not text:
        return None
    s = str(text).strip()
    if not s:
        return None

    # Strip time component and timezone if any
    s = s.split(' ')[0] if 'T' not in s else s.split('T')[0]
    s = s.split(' ')[0]  # belt-and-braces

    # ISO YYYY-MM-DD
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass

    # DD/MM/YYYY or DD-MM-YYYY (Australian)
    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$', s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    # DD/MM/YY or DD-MM-YY (2-digit year)
    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$', s)
    if m:
        try:
            yr = int(m.group(3))
            yr = 2000 + yr if yr < 70 else 1900 + yr
            return date(yr, int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    # Named-month formats including '8-Aug-25' (RP Data default)
    for fmt in (
        '%d-%b-%y', '%d-%b-%Y',
        '%d-%B-%y', '%d-%B-%Y',
        '%d %b %Y', '%d %B %Y',
        '%b %d %Y', '%B %d %Y',
    ):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue

    return None


def _is_header_row(cells):
    """True if a CSV row looks like a header (≥3 known column aliases)."""
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
    """RP Data sometimes prepends a few intro/title rows before the real
    header. Scan the first `scan_limit` rows for one that smells like a
    header (≥3 known aliases). Fall back to row 0 if none found.
    """
    for i in range(min(scan_limit, len(rows))):
        if _is_header_row(rows[i]):
            return i
    return 0


def import_rpdata():
    """POST /api/listings/import-rpdata.

    multipart/form-data:
        file (required) — .csv or .xlsx export from RP Data / CoreLogic
        suburb (optional) — fallback if the CSV has no Suburb column

    UPDATE-ONLY mode: rows that don't match an existing listing are
    skipped, NOT inserted. The intent is to fix sold_date precision
    on what the scraper already has, not to grow the table from
    third-party data.
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded. Use multipart field "file".'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    rows, err = _read_rows(file)
    if err:
        return jsonify({'error': err}), 400
    if not rows or len(rows) < 2:
        return jsonify({'error': 'File needs a header row + at least one data row'}), 400

    header_idx = _find_header_index(rows)
    header = rows[header_idx]
    cols = _detect_columns(header)
    data_rows = rows[header_idx + 1:]

    if 'address' not in cols:
        return jsonify({
            'error': 'Could not find an Address column. Expected one of: '
                     + ', '.join(COLUMN_ALIASES['address']),
            'header_seen': [str(h) for h in header],
            'header_row_index': header_idx,
        }), 400

    fallback_suburb = (request.form.get('suburb') or '').strip()

    conn = get_db()

    suburb_rows = conn.execute("SELECT id, name, slug FROM suburbs").fetchall()
    suburb_by_name = {r['name'].lower(): r for r in suburb_rows}

    matched = 0       # listings updated with new dates
    no_match = 0      # rows skipped because address/suburb not in our DB
    skipped = 0       # rows skipped for other reasons (empty, parse fail, etc.)
    date_updates = 0
    price_updates = 0
    errors = []
    now_iso = datetime.utcnow().isoformat()

    for row_idx, row in enumerate(data_rows, start=header_idx + 2):
        if not row or all((c is None or str(c).strip() == '') for c in row):
            continue

        try:
            def cell(key):
                idx = cols.get(key)
                if idx is None or idx >= len(row):
                    return ''
                return ('' if row[idx] is None else str(row[idx])).strip()

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
                # Unknown suburb — RP Data has it but we don't track it. Skip silently.
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

            # If the listing wasn't already marked sold, RP Data's word
            # is final — they only export actual transactions. Keeps us
            # from leaving a stale 'active' row when a sale slipped past
            # the scraper.
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
            else:
                # Row matched but had no new info to apply — count as match
                # since the existing row is consistent with RP Data.
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
        'header_row_index': header_idx,
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

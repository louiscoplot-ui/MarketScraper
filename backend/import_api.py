"""CSV / Excel import for RP Data / CoreLogic property exports.

Updates the listings table with accurate sold_date / sold_price from
agency property-data tools. Solves the REIWA scraping date-precision
gap — RP Data publishes the actual settlement date, REIWA shows
'Sold X days ago' badges that decay over time and only land in our
DB if the scraper happens to catch them on the right day.

Workflow:
    Agent exports CSV (or .xlsx) of recent suburb sales from RP Data
    → POSTs the file here as multipart/form-data 'file'
    → Each row is matched against listings(normalized_address, suburb)
    → Match : UPDATE sold_date, sold_price, status='sold'
    → No match : INSERT a new listings row as status='sold'

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


# RP Data and CoreLogic export with slightly different header names —
# fuzzy match by lowercasing both sides and looking for any alias match.
COLUMN_ALIASES = {
    'address':      ['property address', 'address', 'street address', 'full address'],
    'suburb':       ['suburb', 'locality', 'area'],
    'postcode':     ['postcode', 'post code', 'zip'],
    'sold_date':    ['sale date', 'last sold date', 'date sold', 'settlement date',
                     'sold date', 'transaction date'],
    'sold_price':   ['sale price', 'last sold price', 'sold price', 'price',
                     'transaction price'],
    'bedrooms':     ['bedrooms', 'beds', 'bed', 'bedrooms count'],
    'bathrooms':    ['bathrooms', 'baths', 'bath', 'bathrooms count'],
    'parking':      ['car spaces', 'parking', 'cars', 'car', 'garage'],
    'land_size':    ['land size', 'land area', 'lot size', 'site area'],
    'internal_size': ['floor area', 'internal area', 'internal size', 'building area'],
    'listing_type': ['property type', 'type', 'dwelling type'],
    'agent':        ['agent', 'selling agent', 'sales agent'],
    'agency':       ['agency', 'agency name', 'sales agency'],
    'owner':        ['owner name', 'current owner', 'owner', 'registered owner'],
}


def _parse_price(text):
    """Coerce '$2,700,000', '2.7M', 2700000, ... to int. Returns None on
    junk or values < 10k (likely cents or accidentally truncated)."""
    if text is None or text == '':
        return None
    s = str(text).strip()
    if not s:
        return None
    # Handle "$1.2M" / "2.7m" suffix shorthand
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
    """Parse various date formats. Returns ISO 'YYYY-MM-DD' or None."""
    if not text:
        return None
    s = str(text).strip()
    if not s:
        return None

    # Strip time component if present ("2024-01-15 12:34:56" → "2024-01-15")
    s = s.split(' ')[0]
    s = s.split('T')[0]

    # ISO already
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    if m:
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return d.isoformat()
        except ValueError:
            pass

    # DD/MM/YYYY or DD-MM-YYYY (Australian convention — day first)
    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$', s)
    if m:
        try:
            d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            return d.isoformat()
        except ValueError:
            pass

    # "15 Jan 2024" / "15 January 2024" / "Jan 15 2024"
    for fmt in ('%d %b %Y', '%d %B %Y', '%b %d %Y', '%B %d %Y'):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue

    return None


def _detect_columns(header):
    """Map canonical column names → actual column indices in the header."""
    norm = [(h or '').strip().lower() for h in header]
    out = {}
    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in norm:
                out[canonical] = norm.index(alias)
                break
    return out


def _strip_suburb_from_address(addr, suburb):
    """RP Data addresses tend to be 'XX Street SUBURB STATE POSTCODE'.
    Strip the suburb/state/postcode tail to keep only the street part —
    so 'normalize_address' compares against listings.address consistently.
    """
    if not addr:
        return addr
    addr = addr.strip().rstrip(',').strip()
    if not suburb:
        return addr
    suburb_lower = suburb.lower()
    addr_lower = addr.lower()
    pos = addr_lower.find(suburb_lower)
    if pos > 0:
        # Keep everything before the suburb, strip trailing comma/space
        return addr[:pos].strip().rstrip(',').strip()
    return addr


def _read_rows(file_storage):
    """Return a list of rows from CSV or XLSX. Returns (rows, error_msg)."""
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


def import_rpdata():
    """POST /api/listings/import-rpdata.

    multipart/form-data:
        file (required): .csv or .xlsx export from RP Data / CoreLogic
        suburb (optional): override / fallback suburb if the CSV doesn't
                           include a suburb column

    Returns:
        matched   — listings updated with new sold_date / sold_price
        inserted  — new sold listings created (for sales we hadn't scraped)
        skipped   — rows we couldn't process (no address, unknown suburb, ...)
        errors    — first 20 error messages for debugging
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

    header = rows[0]
    cols = _detect_columns(header)

    if 'address' not in cols:
        return jsonify({
            'error': 'Could not find an Address column. Expected header like one of: '
                     + ', '.join(COLUMN_ALIASES['address']),
            'header_seen': [str(h) for h in header],
        }), 400

    fallback_suburb = (request.form.get('suburb') or '').strip()

    conn = get_db()

    suburb_rows = conn.execute("SELECT id, name, slug FROM suburbs").fetchall()
    suburb_by_name = {r['name'].lower(): r for r in suburb_rows}

    matched = 0
    inserted = 0
    skipped = 0
    errors = []
    now_iso = datetime.utcnow().isoformat()

    for row_idx, row in enumerate(rows[1:], start=2):
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
                    errors.append(f"Row {row_idx}: no suburb column and no fallback suburb provided")
                continue

            suburb_row = suburb_by_name.get(suburb_name.lower())
            if not suburb_row:
                skipped += 1
                if len(errors) < 20:
                    errors.append(f"Row {row_idx}: suburb '{suburb_name}' not in our DB (add it first)")
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

            if existing:
                # Update only fields RP Data clearly improved on — sold_date
                # is the high-value one. Don't overwrite a non-empty sold_price
                # with a missing CSV value.
                updates = []
                params = []
                if sold_date:
                    updates.append("sold_date = ?")
                    params.append(sold_date)
                if sold_price:
                    updates.append("sold_price = ?")
                    params.append(str(sold_price))
                # Mark as sold even if previously active — RP Data only lists
                # actual transactions, so a row in the export = a real sale.
                updates.append("status = 'sold'")
                updates.append("last_seen = ?")
                params.append(now_iso)

                params.append(existing['id'])
                conn.execute(
                    f"UPDATE listings SET {', '.join(updates)} WHERE id = ?",
                    params
                )
                matched += 1
            else:
                # Insert a fresh sold listing for sales the scraper didn't catch.
                # reiwa_url is required NOT NULL — we synthesise a stable
                # placeholder so the unique index is happy and we can
                # distinguish RP-imported rows later if needed.
                synthetic_url = f"rpdata:{suburb_row['slug']}/{norm_addr.replace(' ', '-')}"
                conn.execute(
                    """
                    INSERT INTO listings (
                        suburb_id, address, normalized_address, reiwa_url,
                        status, first_seen, last_seen,
                        sold_price, sold_date,
                        bedrooms, bathrooms, parking,
                        land_size, internal_size,
                        agent, agency, listing_type, source
                    ) VALUES (?, ?, ?, ?, 'sold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rpdata')
                    ON CONFLICT (reiwa_url) DO NOTHING
                    """,
                    (
                        suburb_id, address, norm_addr, synthetic_url,
                        now_iso, now_iso,
                        str(sold_price) if sold_price else None,
                        sold_date,
                        _safe_int(cell('bedrooms')),
                        _safe_int(cell('bathrooms')),
                        _safe_int(cell('parking')),
                        cell('land_size') or None,
                        cell('internal_size') or None,
                        cell('agent') or None,
                        cell('agency') or None,
                        cell('listing_type') or None,
                    )
                )
                inserted += 1
        except Exception as e:
            skipped += 1
            if len(errors) < 20:
                errors.append(f"Row {row_idx}: {type(e).__name__}: {e}")
            try:
                conn.commit()  # reset txn on Postgres after any per-row failure
            except Exception:
                pass

    conn.commit()
    conn.close()

    return jsonify({
        'matched': matched,
        'inserted': inserted,
        'skipped': skipped,
        'total_rows': len(rows) - 1,
        'detected_columns': cols,
        'errors': errors,
    })


def _safe_int(text):
    if text is None or text == '':
        return None
    try:
        return int(re.sub(r'[^\d]', '', str(text)) or 0) or None
    except (ValueError, TypeError):
        return None


def register_import_routes(app):
    app.add_url_rule(
        '/api/listings/import-rpdata',
        endpoint='import_rpdata',
        view_func=import_rpdata,
        methods=['POST']
    )
    logger.info("Import routes registered: POST /api/listings/import-rpdata")

"""Property reconstruction — groups CSV transactions by address, picks the
latest sale as the "current state" of the property, and computes
holding_yrs / gain / CAGR vs the prior sale.

Extracted from hot_vendor_scoring.py to make targeted fixes to the
owner-detection logic (which is format-specific and will keep evolving
as we add more CSV layouts) cheap to push via MCP.
"""

import numpy as np
import pandas as pd


_MISSING_OWNER = ('-', 'nan', 'None', '', 'NaN')


def _clean_name(val):
    if val is None or pd.isna(val):
        return None
    s = str(val).strip()
    return None if s in _MISSING_OWNER else s


def _clean_str(v):
    return _clean_name(v)


def detect_current_owner(last, columns):
    """Pick the buyer (current owner). NEVER fall back to the seller.

    RP Data CSV formats put the buyer in different positions:
    - 22-col (Cottesloe-style): col16/col17 = buyer
        owner1/owner2 = seller of that transaction — never use
    - 21-col (Ellenbrook-style): owner1/owner2 = buyer directly

    When the buyer columns are empty in 22-col format (very recent sales
    where Landgate hasn't recorded the buyer yet), we explicitly return
    a placeholder rather than fall back to the seller — falling back would
    silently put the wrong name on every prospecting letter.

    Returns (current_owner1, current_owner2). current_owner1 is always a
    string; current_owner2 may be None.
    """
    if 'col16' in columns:
        # 22-col format: ONLY col16/col17 are the buyer; never owner1
        o1 = _clean_name(last.get('col16'))
        o2 = _clean_name(last.get('col17'))
    else:
        # 21-col format: owner1/owner2 are the buyer
        o1 = _clean_name(last.get('owner1'))
        o2 = _clean_name(last.get('owner2'))

    if o1:
        return o1, o2
    # Buyer not recorded — return empty so downstream consumers don't
    # paste the placeholder into a prospecting letter ("Dear N/A —
    # verify on Landgate,"). The Excel pipeline still detects empty
    # owners via OWNER_NA == '' and amber-flags them for manual lookup.
    return '', None


def reconstruct_properties(clean_df, today):
    """Group transactions by address → one row per property with derived
    metrics (holding, gain, CAGR) and current owner."""
    clean_df = clean_df.sort_values(['address', 'sale_dt']).reset_index(drop=True)
    columns = list(clean_df.columns)
    props = []

    for addr, grp in clean_df.groupby('address'):
        grp = grp.sort_values('sale_dt').reset_index(drop=True)
        n = len(grp)
        last = grp.iloc[-1]

        curr_owner1, curr_owner2 = detect_current_owner(last, columns)

        row = {
            'address': addr.strip(),
            'suburb': str(last.get('suburb', '')).strip() if 'suburb' in grp.columns else '',
            'prop_type': last['prop_type'],
            'bedrooms': last.get('bedrooms', None),
            'bathrooms': last.get('bathrooms', None),
            'land_area': last.get('land_area', None),
            'n_sales': n,
            'last_sale_price': last['price'],
            'last_sale_date': last['sale_dt'].date(),
            'owner_purchase_price': last['price'],
            'owner_purchase_date': last['sale_dt'].date(),
            'holding_yrs': round((today - last['sale_dt'].date()).days / 365.25, 1),
            'agency': _clean_str(last.get('agency')),
            'agent': _clean_str(last.get('agent')),
            'current_owner1': curr_owner1,
            'current_owner2': curr_owner2,
            'first_sale_price': grp.iloc[0]['price'],
            'first_sale_date': grp.iloc[0]['sale_dt'].date(),
        }

        if n >= 2:
            prev = grp.iloc[-2]
            gain_dollar = last['price'] - prev['price']
            gain_pct = (gain_dollar / prev['price']) * 100 if prev['price'] > 0 else None
            yrs_between = (last['sale_dt'].date() - prev['sale_dt'].date()).days / 365.25
            row['owner_gain_dollar'] = round(gain_dollar, 0) if gain_pct is not None else None
            row['owner_gain_pct'] = round(gain_pct, 1) if gain_pct is not None else None
            if gain_pct is not None and yrs_between > 0:
                cagr = ((last['price'] / prev['price']) ** (1 / yrs_between) - 1) * 100
                row['owner_cagr'] = round(float(np.clip(cagr, -20, 50)), 2)
            else:
                row['owner_cagr'] = None
            row['total_gain_pct'] = round(
                (last['price'] - grp.iloc[0]['price']) / grp.iloc[0]['price'] * 100, 1
            ) if grp.iloc[0]['price'] > 0 else None
        else:
            row['owner_gain_dollar'] = None
            row['owner_gain_pct'] = None
            row['owner_cagr'] = None
            row['total_gain_pct'] = None

        props.append(row)

    return pd.DataFrame(props)

"""Hot Vendor Lead Scoring v4 — auto-calibrated pipeline.

Loads an RP Data / Landgate CSV (20/21/22-col variants auto-detected),
filters non-market transactions, reconstructs one row per property,
computes latent profit + auto-calibrated weights, scores each property
and segments via dynamic quantiles.

Heavy property reconstruction (with owner-column detection per format)
lives in hot_vendor_reconstruct.py. Excel export lives in
hot_vendor_excel.py. This module owns the maths + the orchestrator.
"""

import io
import logging
from datetime import date

import numpy as np
import pandas as pd

from hot_vendor_reconstruct import reconstruct_properties

logger = logging.getLogger(__name__)


CUTOFF_RECENT = date(2023, 1, 1)


_MISSING = ('', '-', 'N/A', 'nan', 'None', 'NaN')


def _safe_int(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    if s in _MISSING:
        return None
    try:
        return int(float(s.replace(',', '')))
    except (ValueError, TypeError):
        return None


def _safe_float(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    if s in _MISSING:
        return None
    try:
        return float(s.replace(',', ''))
    except (ValueError, TypeError):
        return None


CSV_COLS_22 = [
    'address', 'suburb', 'state', 'postcode', 'property_type',
    'bedrooms', 'bathrooms', 'car_spaces', 'land_area', 'floor_area', 'col10',
    'sale_price', 'sale_date', 'col13', 'agency', 'agent',
    'col16', 'col17', 'col18', 'owner1', 'owner2', 'col21'
]
CSV_COLS_21 = [
    'address', 'suburb', 'state', 'postcode', 'council', 'property_type',
    'bedrooms', 'bathrooms', 'car_spaces', 'land_area', 'floor_area', 'col11',
    'sale_price', 'sale_date', 'col14', 'col15', 'agency', 'agent',
    'owner1', 'owner2', 'col20'
]
CSV_COLS_20 = [
    'address', 'suburb', 'state', 'postcode', 'council', 'property_type',
    'bedrooms', 'bathrooms', 'car_spaces', 'land_area', 'floor_area', 'col11',
    'sale_price', 'sale_date', 'col14', 'col15', 'agency', 'agent',
    'owner1', 'owner2'
]


def _looks_like_price(val):
    s = str(val).replace('$', '').replace(',', '').strip()
    try:
        v = float(s)
        return 1_000 < v < 100_000_000
    except (ValueError, TypeError):
        return False


def _looks_like_date(val):
    try:
        pd.to_datetime(str(val), dayfirst=True)
        return True
    except (ValueError, TypeError):
        return False


def _read_csv_with_format_detection(file_bytes):
    buf = io.BytesIO(file_bytes)
    sample = pd.read_csv(buf, header=None, nrows=5)
    ncols = sample.shape[1]

    candidates = {22: [CSV_COLS_22], 21: [CSV_COLS_21], 20: [CSV_COLS_20]}
    best_cols = None

    if ncols in candidates:
        for col_list in candidates[ncols]:
            try:
                buf.seek(0)
                test_df = pd.read_csv(buf, header=None, names=col_list[:ncols], nrows=5)
                price_ok = test_df['sale_price'].apply(_looks_like_price).sum() >= 3
                date_ok = test_df['sale_date'].apply(_looks_like_date).sum() >= 3
                if price_ok and date_ok:
                    best_cols = col_list
                    break
            except Exception:
                continue

    if best_cols is None:
        logger.warning(f"CSV format not recognised ({ncols} cols), auto-detecting by position")
        generic = [f'col{i}' for i in range(ncols)]
        buf.seek(0)
        test_df = pd.read_csv(buf, header=None, names=generic, nrows=10)
        price_col = date_col = None
        for col in generic:
            vals = test_df[col].astype(str)
            if vals.str.contains(r'\$[\d,]+').sum() >= 3:
                price_col = col
            if vals.apply(_looks_like_date).sum() >= 3 and price_col and col != price_col:
                date_col = col
                break
        if price_col:
            generic[generic.index(price_col)] = 'sale_price'
        if date_col:
            generic[generic.index(date_col)] = 'sale_date'
        generic[0] = 'address'
        if ncols > 4:
            generic[4] = 'property_type'
        best_cols = generic

    buf.seek(0)
    df = pd.read_csv(buf, header=None, names=best_cols[:ncols])
    logger.info(f"CSV loaded: {len(df):,} raw transactions ({ncols} cols)")
    return df


def _classify_property_type(t):
    t = str(t).lower()
    if any(x in t for x in ['house', 'duplex', 'terrace', 'semi']):
        return 'House'
    if any(x in t for x in ['unit', 'flat', 'highrise', 'townhouse', 'villa']):
        return 'Apartment'
    return None


def _detect_price_thresholds(df):
    sample_prices = pd.to_numeric(
        df['sale_price'].astype(str).str.replace('[$,]', '', regex=True),
        errors='coerce'
    ).dropna()
    rough_median = sample_prices[sample_prices > 100_000].median()

    if rough_median > 1_000_000:
        return {'post_1995': 50_000, 'post_2000': 100_000, 'post_2005': 200_000, 'type': 'premium'}
    if rough_median > 500_000:
        return {'post_1995': 40_000, 'post_2000': 80_000, 'post_2005': 150_000, 'type': 'mid'}
    return {'post_1995': 30_000, 'post_2000': 60_000, 'post_2005': 120_000, 'type': 'standard'}


def _filter_nonmarket(df, thresholds):
    def flag(row):
        p = row['price']
        yr = row['sale_dt'].year
        if p < 1000:
            return 'Nominal title transfer (<$1k)'
        if p < thresholds['post_1995'] and yr >= 1995:
            return f"Impossible price post-1995 (<${thresholds['post_1995']:,})"
        if p < thresholds['post_2000'] and yr >= 2000:
            return f"Impossible price post-2000 (<${thresholds['post_2000']:,})"
        if p < thresholds['post_2005'] and yr >= 2005:
            return f"Suspicious price post-2005 (<${thresholds['post_2005']:,})"
        return None

    df['excl_reason'] = df.apply(flag, axis=1)

    df_sorted = df[df['excl_reason'].isna()].sort_values(['address', 'sale_dt'])
    prev_prices = {}
    collapse_idx = []
    for idx, row in df_sorted.iterrows():
        addr = row['address']
        if addr in prev_prices and prev_prices[addr] > 300_000:
            if row['price'] < prev_prices[addr] * 0.15:
                collapse_idx.append(idx)
                continue
        prev_prices[addr] = row['price']
    df.loc[collapse_idx, 'excl_reason'] = 'Price collapse >85% vs prior sale'

    excluded = df[df['excl_reason'].notna()].copy()
    clean = df[df['excl_reason'].isna()].copy()
    return clean, excluded


def _clean_dataframe(file_bytes):
    df = _read_csv_with_format_detection(file_bytes)
    df['prop_type'] = df['property_type'].apply(_classify_property_type)
    df = df[df['prop_type'].notna()].copy()

    df['price'] = pd.to_numeric(
        df['sale_price'].astype(str).str.replace('[$,]', '', regex=True),
        errors='coerce'
    )
    df = df[df['price'].notna()].copy()

    df['sale_dt'] = pd.to_datetime(df['sale_date'], dayfirst=True, errors='coerce')
    df = df[df['sale_dt'].notna()].copy()

    thresholds = _detect_price_thresholds(df)
    clean, excluded = _filter_nonmarket(df, thresholds)
    logger.info(f"Cleaning: {len(excluded)} excluded, {len(clean):,} retained ({thresholds['type']} suburb)")
    return clean, excluded, len(df), thresholds


def _add_estimated_value(prop_df, clean_df):
    prop_df['land_area_m2'] = pd.to_numeric(
        prop_df['land_area'].astype(str).str.replace(',', ''), errors='coerce'
    )
    clean_df = clean_df.copy()
    clean_df['land_area_m2'] = pd.to_numeric(
        clean_df['land_area'].astype(str).str.replace(',', ''), errors='coerce'
    )

    recent = clean_df[clean_df['sale_dt'].dt.date >= CUTOFF_RECENT].copy()
    recent['price_per_m2'] = recent['price'] / recent['land_area_m2']
    recent = recent[recent['price_per_m2'].between(200, 80_000)]

    med_house = recent[recent['prop_type'] == 'House']['price_per_m2'].median()
    med_apt = recent[recent['prop_type'] == 'Apartment']['price_per_m2'].median()

    def estimate(row):
        if pd.isna(row['land_area_m2']) or row['land_area_m2'] <= 0:
            return None
        rate = med_house if row['prop_type'] == 'House' else med_apt
        return round(row['land_area_m2'] * rate, 0) if not np.isnan(rate) else None

    prop_df['estimated_value'] = prop_df.apply(estimate, axis=1)
    prop_df['potential_profit'] = np.where(
        prop_df['estimated_value'].notna() & (prop_df['owner_purchase_price'] > 0),
        prop_df['estimated_value'] - prop_df['owner_purchase_price'], np.nan
    )
    prop_df['potential_profit_pct'] = np.where(
        prop_df['potential_profit'].notna() & (prop_df['owner_purchase_price'] > 0),
        prop_df['potential_profit'] / prop_df['owner_purchase_price'] * 100, np.nan
    )
    return prop_df, med_house, med_apt


def _build_suburb_profile(prop_df):
    median_hold = prop_df['holding_yrs'].median()
    pct_long = float((prop_df['holding_yrs'] > 20).mean())
    pct_high_gain = float((prop_df['owner_gain_pct'].dropna() > 200).mean())
    pct_1sale = float((prop_df['n_sales'] == 1).mean())
    med_price = float(prop_df['last_sale_price'].median())
    median_gain_pct = round(float(prop_df['owner_gain_pct'].dropna().median()), 1) \
        if not prop_df['owner_gain_pct'].dropna().empty else 0
    return {
        'median_hold': round(median_hold, 1),
        'pct_long_hold': round(pct_long, 3),
        'pct_high_gain': round(pct_high_gain, 3),
        'pct_1sale': round(pct_1sale, 3),
        'med_price': round(med_price, 0),
        'median_gain_pct': median_gain_pct,
        'is_premium': bool(med_price > 1_000_000),
        'is_mature': bool(pct_long > 0.20),
        'is_high_gain': bool(pct_high_gain > 0.20),
    }


def _auto_calibrate_weights(profile):
    w_hold = 0.50
    w_type = 0.15
    w_freq = 0.03 if profile['pct_1sale'] > 0.35 else 0.05
    w_prof = 0.08 if profile['is_premium'] else 0.05

    perf_budget = round(1.0 - w_hold - w_type - w_freq - w_prof, 4)

    if profile['is_mature'] and profile['is_high_gain']:
        gain_ratio, cagr_ratio = 0.70, 0.30
    elif profile['is_mature']:
        gain_ratio, cagr_ratio = 0.55, 0.45
    elif profile['median_hold'] < 10:
        gain_ratio, cagr_ratio = 0.40, 0.60
    else:
        gain_ratio, cagr_ratio = 0.50, 0.50

    w_gain = round(perf_budget * gain_ratio, 4)
    w_cagr = round(perf_budget * cagr_ratio, 4)
    diff = round(1.0 - (w_hold + w_type + w_gain + w_cagr + w_freq + w_prof), 4)
    w_gain = round(w_gain + diff, 4)

    weights = {
        'hold': w_hold, 'type': w_type, 'gain': w_gain,
        'cagr': w_cagr, 'freq': w_freq, 'profit': w_prof,
    }
    rationale = []
    if profile['is_mature']:
        rationale.append(f"mature ({profile['pct_long_hold']*100:.0f}% hold >20yrs)")
    if profile['is_high_gain']:
        rationale.append(f"high-gain ({profile['pct_high_gain']*100:.0f}% made >200%)")
    if profile['is_premium']:
        rationale.append(f"premium (median ${profile['med_price']:,.0f})")
    if profile['pct_1sale'] > 0.35:
        rationale.append(f"thin history ({profile['pct_1sale']*100:.0f}% single-sale)")
    return weights, rationale


def _holding_score(yrs, median):
    r = yrs / median if median > 0 else 1
    if r < 0.4: return 10
    if r < 0.6: return 25
    if r < 0.8: return 40
    if r < 1.0: return 55
    if r < 1.2: return 70
    if r < 1.5: return 85
    return 100


def _type_score_mult(t):
    return (100, 1.3) if t == 'House' else (60, 0.9)


def _gain_score(g):
    if pd.isna(g): return 40
    if g < 0:     return 15
    if g < 15:    return 28
    if g < 30:    return 42
    if g < 50:    return 55
    if g < 75:    return 68
    if g < 100:   return 80
    if g < 200:   return 90
    return 100


def _cagr_score(c):
    if pd.isna(c): return 40
    if c < 0:     return 15
    if c < 3:     return 28
    if c < 6:     return 42
    if c < 10:    return 58
    if c < 15:    return 72
    if c < 20:    return 88
    return 100


def _frequency_score(n):
    if n == 1: return 30
    if n == 2: return 45
    if n == 3: return 60
    if n == 4: return 75
    if n == 5: return 88
    return 100


def _profit_score(p):
    if pd.isna(p): return 40
    if p < 0:     return 10
    if p < 20:    return 25
    if p < 50:    return 40
    if p < 100:   return 58
    if p < 200:   return 72
    if p < 400:   return 88
    return 100


def _apply_scoring(prop_df, weights, profile):
    median = profile['median_hold']
    prop_df['hold_score'] = prop_df['holding_yrs'].apply(lambda y: _holding_score(y, median))
    prop_df[['type_score', 'type_mult']] = prop_df['prop_type'].apply(
        lambda t: pd.Series(_type_score_mult(t))
    )
    prop_df['gain_score'] = prop_df['owner_gain_pct'].apply(_gain_score)
    prop_df['cagr_score'] = prop_df['owner_cagr'].apply(_cagr_score)
    prop_df['freq_score'] = prop_df['n_sales'].apply(_frequency_score)
    prop_df['prof_score'] = prop_df['potential_profit_pct'].apply(_profit_score)

    prop_df['raw_score'] = (
        prop_df['hold_score'] * weights['hold']
        + prop_df['type_score'] * weights['type']
        + prop_df['gain_score'] * weights['gain']
        + prop_df['cagr_score'] * weights['cagr']
        + prop_df['freq_score'] * weights['freq']
        + prop_df['prof_score'] * weights['profit']
    )
    prop_df['adj_score'] = prop_df['raw_score'] * prop_df['type_mult']

    mn, mx = prop_df['adj_score'].min(), prop_df['adj_score'].max()
    rng = (mx - mn) or 1
    prop_df['final_score'] = ((prop_df['adj_score'] - mn) / rng * 100).round(1)

    q82 = float(prop_df['final_score'].quantile(0.82))
    q62 = float(prop_df['final_score'].quantile(0.62))
    q40 = float(prop_df['final_score'].quantile(0.40))

    def categorize(s):
        if s >= q82: return 'HOT'
        if s >= q62: return 'WARM'
        if s >= q40: return 'MEDIUM'
        return 'LOW'

    prop_df['category'] = prop_df['final_score'].apply(categorize)
    prop_df = prop_df.sort_values('final_score', ascending=False).reset_index(drop=True)
    prop_df['rank'] = prop_df.index + 1
    return prop_df, q82, q62, q40


def _date_to_dmy(d):
    if d is None or pd.isna(d):
        return None
    if hasattr(d, 'strftime'):
        return d.strftime('%d/%m/%Y')
    return str(d)


def _serialize_properties(prop_df):
    rows = []
    for _, r in prop_df.iterrows():
        rows.append({
            'address': r['address'],
            'suburb': r.get('suburb') if not pd.isna(r.get('suburb')) else None,
            'type': r['prop_type'],
            'bedrooms': _safe_int(r.get('bedrooms')),
            'bathrooms': _safe_int(r.get('bathrooms')),
            'last_sale_price': _safe_int(r.get('last_sale_price')),
            'owner_purchase_price': _safe_int(r.get('owner_purchase_price')),
            'owner_purchase_date': _date_to_dmy(r.get('owner_purchase_date')),
            'holding_years': _safe_float(r.get('holding_yrs')),
            'sales_count': _safe_int(r.get('n_sales')) or 0,
            'owner_gain_dollars': _safe_int(r.get('owner_gain_dollar')),
            'owner_gain_pct': _safe_float(r.get('owner_gain_pct')),
            'cagr': _safe_float(r.get('owner_cagr')),
            'estimated_value': _safe_int(r.get('estimated_value')),
            'potential_profit': _safe_int(r.get('potential_profit')),
            'potential_profit_pct': _safe_float(r.get('potential_profit_pct')),
            'hold_score': _safe_int(r.get('hold_score')) or 0,
            'type_score': _safe_int(r.get('type_score')) or 0,
            'gain_score': _safe_int(r.get('gain_score')) or 0,
            'cagr_score': _safe_int(r.get('cagr_score')) or 0,
            'freq_score': _safe_int(r.get('freq_score')) or 0,
            'prof_score': _safe_int(r.get('prof_score')) or 0,
            'final_score': _safe_float(r.get('final_score')) or 0.0,
            'category': r.get('category'),
            'rank': _safe_int(r.get('rank')) or 0,
            'current_owner': r.get('current_owner1') if not pd.isna(r.get('current_owner1')) else None,
            'agency': r.get('agency') if not pd.isna(r.get('agency')) else None,
            'agent': r.get('agent') if not pd.isna(r.get('agent')) else None,
        })
    return rows


def score_csv(file_bytes, suburb=None, today=None):
    today = today or date.today()

    clean_df, excluded, raw_count, thresholds = _clean_dataframe(file_bytes)

    detected_suburb = suburb
    if not detected_suburb and 'suburb' in clean_df.columns and not clean_df['suburb'].empty:
        try:
            detected_suburb = str(clean_df['suburb'].mode()[0]).strip()
        except (IndexError, KeyError):
            detected_suburb = ''
    detected_suburb = detected_suburb or 'UNKNOWN'

    prop_df = reconstruct_properties(clean_df, today)
    prop_df, med_house, med_apt = _add_estimated_value(prop_df, clean_df)
    profile = _build_suburb_profile(prop_df)
    weights, rationale = _auto_calibrate_weights(profile)
    prop_df, q82, q62, q40 = _apply_scoring(prop_df, weights, profile)

    excl_summary = (
        excluded['excl_reason'].value_counts().reset_index().to_dict('records')
        if len(excluded) else []
    )

    logger.info(
        f"v4 scoring done: {len(prop_df)} properties, "
        f"HOT≥{q82:.1f} ({(prop_df['category']=='HOT').sum()}), "
        f"WARM≥{q62:.1f} ({(prop_df['category']=='WARM').sum()})"
    )

    return {
        'suburb': detected_suburb,
        'today': today.strftime('%d/%m/%Y'),
        'raw_count': raw_count,
        'kept_count': len(clean_df),
        'excluded_count': len(excluded),
        'thresholds': thresholds,
        'profile': profile,
        'weights': weights,
        'rationale': rationale,
        'median_m2_house': float(med_house) if not pd.isna(med_house) else None,
        'median_m2_apt': float(med_apt) if not pd.isna(med_apt) else None,
        'q_hot': q82,
        'q_warm': q62,
        'q_medium': q40,
        'excluded': excl_summary,
        'properties': _serialize_properties(prop_df),
    }

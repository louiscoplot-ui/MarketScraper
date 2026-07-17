"""Reports .docx rendering — the 4 branded intelligence reports.

Reuses the Acton | Belle letter chrome from pipeline_letter.py verbatim
(full-bleed BRAND_GREEN #386350 header band with the logo, agency footer
block, Arial body, A4 portrait) so a report and a letter printed the
same morning look like one document family. The agent identity comes
from the calling user's profile with the same env-var fallbacks as the
letters (_resolve).

Content rules (enforced upstream in reports_engine / reports_narrative,
respected again here):
  * A None metric renders as "n/a" — never a substituted number.
  * Engine flags are printed with their block so the reader sees the
    small-sample / partial-baseline caveats on paper, not just in JSON.
  * Competitive data is AGENCY-level only. The vendor_benchmark variant
    is vendor-safe: no agency names, no competitor addresses at all.
  * The rentals block in the deep dive is an explicit placeholder — no
    simulated rental data.
"""

import os
import re
from datetime import datetime

from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_ORIENT

from time_utils import perth_now
from pipeline_letter import (
    BRAND_GREEN, _green_header, _agency_footer, _resolve, _shade_cell,
    AGENCY_LINE_1_DEFAULT, AGENCY_LINE_2_DEFAULT, AGENCY_LINE_3_DEFAULT,
)

GREEN_RGB = RGBColor(0x38, 0x63, 0x50)
GREY_RGB = RGBColor(0x55, 0x55, 0x55)


# ---------------------------------------------------------------- chrome

def _new_report_doc(user_profile, title, subtitle):
    """A4 portrait doc with the letter header band + footer + report
    title block. Returns the Document ready for content paragraphs."""
    profile = user_profile or {}
    agency_name = _resolve(profile, 'agency_name', 'AGENCY_NAME')
    agent_name = _resolve(profile, 'agent_name', 'AGENT_NAME')
    line_1 = (os.environ.get('AGENCY_ADDRESS') or AGENCY_LINE_1_DEFAULT).strip()
    line_2 = (os.environ.get('AGENCY_CONTACT') or AGENCY_LINE_2_DEFAULT).strip()
    line_3 = (os.environ.get('AGENCY_LEGAL') or AGENCY_LINE_3_DEFAULT).strip()

    doc = Document()
    for section in doc.sections:
        # Same explicit A4 portrait setup as the letters — the server's
        # default docx template opens landscape otherwise.
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(0.8)
        section.bottom_margin = Cm(2.0)
        section.left_margin = Cm(2.0)
        section.right_margin = Cm(2.0)

    _green_header(doc)
    _agency_footer(doc, agency_name, line_1, line_2, line_3)
    # _green_header ends with a 2cm envelope-window spacer that letters
    # need but reports don't — tighten it so page 1 keeps its room.
    doc.paragraphs[-1].paragraph_format.space_after = Cm(0.4)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = p.add_run(perth_now().strftime('%d/%m/%Y'))
    r.font.size = Pt(10); r.font.name = 'Arial'; r.font.color.rgb = GREY_RGB

    tp = doc.add_paragraph()
    tr = tp.add_run(title)
    tr.font.size = Pt(20); tr.font.name = 'Arial'; tr.bold = True
    tr.font.color.rgb = GREEN_RGB
    sp = doc.add_paragraph()
    st = sp.add_run(subtitle)
    st.font.size = Pt(10.5); st.font.name = 'Arial'; st.font.color.rgb = GREY_RGB
    if agent_name:
        pp = doc.add_paragraph()
        rr = pp.add_run(f'Prepared by {agent_name}'
                        + (f' | {agency_name}' if agency_name else ''))
        rr.font.size = Pt(9.5); rr.font.name = 'Arial'; rr.font.color.rgb = GREY_RGB
    return doc


def _h2(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run(text)
    r.font.size = Pt(13); r.font.name = 'Arial'; r.bold = True
    r.font.color.rgb = GREEN_RGB
    return p


def _h3(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run(text)
    r.font.size = Pt(11); r.font.name = 'Arial'; r.bold = True
    return p


def _body(doc, text, size=10.5, italic=False, grey=False):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run(text)
    r.font.size = Pt(size); r.font.name = 'Arial'
    r.italic = italic
    if grey:
        r.font.color.rgb = GREY_RGB
    return p


def _flags(doc, flags):
    """Print engine caveats (small samples, missing metrics) in small
    grey italics — the honesty layer must be ON the page."""
    for f in flags or []:
        _body(doc, f'⚠ {f}', size=9, italic=True, grey=True)


def _narrative(doc, narratives, key):
    """Interpretation paragraph for a block, when the AI layer produced
    one. Absent narrative = the report ships numbers-only (by design)."""
    text = (narratives or {}).get(key)
    if text:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(4)
        p.paragraph_format.space_after = Pt(6)
        r = p.add_run(text)
        r.font.size = Pt(10.5); r.font.name = 'Arial'; r.italic = True


def _table(doc, headers, rows):
    """Bordered table with a brand-green header row. `rows` is a list of
    lists of display strings."""
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        p = hdr[i].paragraphs[0]
        r = p.add_run(str(h))
        r.font.size = Pt(9); r.font.name = 'Arial'; r.bold = True
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        _shade_cell(hdr[i], BRAND_GREEN)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ''
            p = cells[i].paragraphs[0]
            r = p.add_run('n/a' if v is None else str(v))
            r.font.size = Pt(9); r.font.name = 'Arial'
    return t


def _fmt(v, suffix=''):
    """Display value — None stays visibly 'n/a', never a made-up figure."""
    if v is None:
        return 'n/a'
    return f'{v}{suffix}'


def _sample(n):
    return f'n={n}' if n is not None else 'n=?'


# ------------------------------------------------------------ per-suburb

def _suburb_page(doc, m, narratives, first):
    """One Suburb Intelligence page. `m` is an engine metrics dict."""
    if not first:
        doc.add_page_break()
    _h2(doc, m.get('suburb') or f"Suburb #{m.get('suburb_id')}")
    if m.get('error'):
        _body(doc, f"Data unavailable for this suburb: {m['error']}",
              italic=True, grey=True)
        return
    c = m['counts']
    _body(doc, f"{c['active']} active · {c['under_offer']} under offer · "
               f"{c['sold']} sold on record · {c['withdrawn']} withdrawn "
               f"(all figures from the SuburbDesk scrape of REIWA data)",
          size=9.5, grey=True)

    # Momentum
    mom = m['momentum']
    _h3(doc, f"Momentum score: {_fmt(mom.get('score'), ' / 100')}")
    comp_rows = []
    for name, comp in (mom.get('components') or {}).items():
        comp_rows.append([
            name.replace('_', ' '),
            f"{int(comp['weight'] * 100)}%",
            _fmt(comp.get('value')),
            _fmt(comp.get('baseline')),
            _fmt(comp.get('score')),
        ])
    if comp_rows:
        _table(doc, ['Component', 'Weight', 'Current', 'Baseline', 'Score'],
               comp_rows)
    _flags(doc, mom.get('flags'))
    _narrative(doc, narratives, 'momentum')

    # Velocity
    v = m['velocity']
    _h3(doc, 'Velocity')
    rc, pc = v['recent_cohort'], v['previous_cohort']
    _table(doc, ['Metric', 'Value'], [
        ['DOM median — active listings',
         f"{_fmt(v.get('dom_median_active'), ' days')} ({_sample(v.get('dom_sample'))})"],
        ['DOM acceleration (new cohort vs previous)',
         _fmt(v.get('dom_acceleration_pct'), '%')],
        ['New listings — last 30 days', rc['n']],
        ['New listings — previous 30 days', pc['n']],
        ['Absorbed within 21 days (recent cohort)',
         f"{_fmt(rc.get('pct_absorbed_21d'), '%')} ({_sample(rc.get('eligible_21d'))})"],
        ['Absorbed within 21 days (previous cohort)',
         f"{_fmt(pc.get('pct_absorbed_21d'), '%')} ({_sample(pc.get('eligible_21d'))})"],
    ])
    _flags(doc, v.get('flags'))
    _narrative(doc, narratives, 'velocity')

    # Pricing
    d = m['discount']
    _h3(doc, 'Pricing — list-to-sale discount')
    if d.get('available'):
        _body(doc, f"Median discount vs the ask at first sighting: "
                   f"{d['median_pct']}% over the last {d['window_days']} days "
                   f"({_sample(d['sample_size'])}).")
    else:
        _body(doc, 'Original asking price not captured for enough sales — '
                   'discount unavailable (not estimated).',
              italic=True, grey=True)
    _flags(doc, d.get('flags'))
    _narrative(doc, narratives, 'pricing')

    # Stock
    sa = m['stock_aging']
    mos = m['months_of_supply']
    _h3(doc, 'Stock')
    b = sa['buckets']
    _table(doc, ['Months of supply', '<30 days', '30–60', '60–90', '90+ days'], [[
        _fmt(mos.get('value')),
        b['under_30d'], b['d30_60'], b['d60_90'], b['over_90d'],
    ]])
    _body(doc, f"Months of supply = actives ÷ (sales over 90 days ÷ 3); "
               f"sales in window: {mos.get('sold_90d')}.", size=9, grey=True)
    _flags(doc, mos.get('flags'))
    _flags(doc, sa.get('flags'))
    _narrative(doc, narratives, 'stock')

    # Competitive (agency level only)
    ash = m['agency_share']
    _h3(doc, 'Competitive — share of new listings (agency level)')
    rows = []
    roll = {x['agency']: x for x in ash['rolling_90d']}
    for x in ash['current_month'][:8]:
        r90 = roll.get(x['agency'])
        rows.append([x['agency'], f"{x['count']} ({x['pct']}%)",
                     f"{r90['count']} ({r90['pct']}%)" if r90 else 'n/a'])
    if rows:
        _table(doc, ['Agency', 'This month', 'Rolling 3 months'], rows)
    else:
        _body(doc, 'No new listings recorded this calendar month.',
              italic=True, grey=True)
    _flags(doc, ash.get('flags'))
    _narrative(doc, narratives, 'competitive')

    # Flags
    sf = m['stale_flags']
    _h3(doc, f"Stale-campaign flags (> {sf['threshold_days']} days with "
             f"≥ 1 price cut) — {sf['count']}")
    if sf['items']:
        _table(doc, ['Address', 'DOM', 'Current ask', 'Price cuts', 'Agency'],
               [[i['address'], i['dom'], i.get('price_text'),
                 i['price_cuts'], i.get('agency')] for i in sf['items']])
    else:
        _body(doc, 'No stale flagged campaigns right now.', grey=True)
    _flags(doc, sf.get('flags'))
    _narrative(doc, narratives, 'flags')


# ------------------------------------------------------------ generators

def build_suburb_intelligence(metrics, narratives, user_profile):
    doc = _new_report_doc(
        user_profile, 'Suburb Intelligence Report',
        'One page per suburb — momentum, velocity, pricing, stock, '
        'competitive position and campaign flags.')
    for i, m in enumerate(metrics):
        _suburb_page(doc, m, narratives, first=(i == 0))
    return doc


def build_director_dashboard(metrics, narratives, user_profile):
    doc = _new_report_doc(
        user_profile, 'Director Dashboard',
        'Portfolio heat map, listing-share movement and opportunity '
        'register across your suburbs.')
    ok = [m for m in metrics if not m.get('error')]
    errs = [m for m in metrics if m.get('error')]

    _h2(doc, 'Momentum heat map')
    _table(doc, ['Suburb', 'Momentum', 'Months of supply', 'DOM median',
                 'Absorbed ≤21d', 'Active', 'Sold 90d'],
           [[m['suburb'],
             _fmt(m['momentum'].get('score')),
             _fmt(m['months_of_supply'].get('value')),
             _fmt(m['velocity'].get('dom_median_active')),
             _fmt(m['velocity']['recent_cohort'].get('pct_absorbed_21d'), '%'),
             m['counts']['active'],
             m['months_of_supply'].get('sold_90d')] for m in ok])
    for m in ok:
        partial = [f for f in m['momentum'].get('flags', [])
                   if 'baseline' in f]
        if partial:
            _body(doc, f"{m['suburb']}: {partial[0]}", size=9,
                  italic=True, grey=True)
    _narrative(doc, narratives, 'heat_map')

    _h2(doc, 'Listing-share movement (agency level)')
    for m in ok:
        ash = m['agency_share']
        _h3(doc, m['suburb'])
        roll = {x['agency']: x for x in ash['rolling_90d']}
        rows = [[x['agency'], f"{x['count']} ({x['pct']}%)",
                 (lambda r90: f"{r90['count']} ({r90['pct']}%)" if r90 else 'n/a')(roll.get(x['agency']))]
                for x in ash['current_month'][:6]]
        if rows:
            _table(doc, ['Agency', 'This month', 'Rolling 3 months'], rows)
        else:
            _body(doc, 'No new listings this calendar month.', grey=True)
        _flags(doc, ash.get('flags'))
    _narrative(doc, narratives, 'share_movement')

    _h2(doc, 'Opportunity register — stale campaigns with price cuts')
    opp = []
    for m in ok:
        for i in m['stale_flags']['items']:
            opp.append([m['suburb'], i['address'], i['dom'],
                        i.get('price_text'), i['price_cuts']])
    opp.sort(key=lambda x: -(x[2] or 0))
    if opp:
        _table(doc, ['Suburb', 'Address', 'DOM', 'Current ask', 'Price cuts'],
               opp[:30])
    else:
        _body(doc, 'No flagged opportunities right now.', grey=True)
    _narrative(doc, narratives, 'opportunities')

    _h2(doc, 'House view')
    _narrative(doc, narratives, 'house_view')
    if not (narratives or {}).get('house_view'):
        _body(doc, 'Narrative unavailable for this run — the figures above '
                   'are complete and unaffected.', italic=True, grey=True)

    for m in errs:
        _body(doc, f"{m['suburb']}: data unavailable ({m['error']})",
              italic=True, grey=True)
    return doc


def build_monthly_deep_dive(metrics, narratives, user_profile):
    doc = _new_report_doc(
        user_profile, 'Monthly Deep Dive',
        'Discount spread, price-band structure and stale-campaign detail.')
    ok = [m for m in metrics if not m.get('error')]

    _h2(doc, 'List-to-sale discount spread')
    _table(doc, ['Suburb', 'Median discount', 'Sample', 'Window',
                 'Sales without captured ask'],
           [[m['suburb'],
             _fmt(m['discount'].get('median_pct'), '%'),
             m['discount'].get('sample_size'),
             f"{m['discount'].get('window_days')} days",
             m['discount'].get('sales_without_captured_ask')] for m in ok])
    for m in ok:
        _flags(doc, [f"{m['suburb']}: {f}" for f in m['discount'].get('flags', [])])
    _narrative(doc, narratives, 'discount')

    _h2(doc, 'Price bands')
    for m in ok:
        _h3(doc, m['suburb'])
        _table(doc, ['Band', 'Active', 'DOM median', 'Discount median'],
               [[b['band'], b['active_count'],
                 f"{_fmt(b.get('dom_median'), ' d')} ({_sample(b.get('dom_sample'))})",
                 f"{_fmt(b.get('discount_median_pct'), '%')} ({_sample(b.get('discount_sample'))})"]
                for b in m['price_bands']])
    _body(doc, 'Medians on fewer than 5 observations are withheld (n/a) '
               'rather than published.', size=9, italic=True, grey=True)
    _narrative(doc, narratives, 'price_bands')

    _h2(doc, 'Stale campaigns — detail')
    any_items = False
    for m in ok:
        sf = m['stale_flags']
        if not sf['items']:
            continue
        any_items = True
        _h3(doc, f"{m['suburb']} (threshold {sf['threshold_days']} days)")
        _table(doc, ['Address', 'DOM', 'Current ask', 'Price cuts', 'Agency'],
               [[i['address'], i['dom'], i.get('price_text'),
                 i['price_cuts'], i.get('agency')] for i in sf['items']])
    if not any_items:
        _body(doc, 'No stale flagged campaigns across the selected suburbs.',
              grey=True)
    _narrative(doc, narratives, 'stale')

    _h2(doc, 'Rental market')
    _body(doc, 'This block activates with the rentals scrape for your '
               'account — no rental data is simulated in the meantime.',
          italic=True, grey=True)
    return doc


def build_vendor_benchmark(metrics, narratives, user_profile):
    """Vendor-safe variant: aggregated market facts only — no competitor
    agencies, no competitor addresses, nothing a vendor shouldn't see."""
    doc = _new_report_doc(
        user_profile, 'Vendor Market Benchmark',
        'How the market is moving in your suburb — timeframes, pricing '
        'outcomes and absorption, from tracked listing data.')
    ok = [m for m in metrics if not m.get('error')]

    _h2(doc, 'Market conditions')
    _table(doc, ['Suburb', 'Homes for sale', 'Months of supply',
                 'DOM median', 'Under offer / sold ≤21 days',
                 'Median list-to-sale discount'],
           [[m['suburb'],
             m['counts']['active'],
             _fmt(m['months_of_supply'].get('value')),
             _fmt(m['velocity'].get('dom_median_active'), ' days'),
             _fmt(m['velocity']['recent_cohort'].get('pct_absorbed_21d'), '%'),
             _fmt(m['discount'].get('median_pct'), '%')] for m in ok])
    for m in ok:
        for f in (m['months_of_supply'].get('flags', [])
                  + m['discount'].get('flags', [])):
            _body(doc, f"{m['suburb']}: {f}", size=9, italic=True, grey=True)
    _narrative(doc, narratives, 'market_conditions')

    _h2(doc, 'By price band')
    for m in ok:
        _h3(doc, m['suburb'])
        _table(doc, ['Band', 'Homes for sale', 'DOM median', 'Discount median'],
               [[b['band'], b['active_count'],
                 _fmt(b.get('dom_median'), ' days'),
                 _fmt(b.get('discount_median_pct'), '%')]
                for b in m['price_bands']])
    _body(doc, 'Values shown as n/a rest on samples too small to publish '
               'responsibly.', size=9, italic=True, grey=True)
    _narrative(doc, narratives, 'bands')
    return doc


REPORT_BUILDERS = {
    'suburb_intelligence': (build_suburb_intelligence, 'Suburb_Intelligence'),
    'director_dashboard': (build_director_dashboard, 'Director_Dashboard'),
    'monthly_deep_dive': (build_monthly_deep_dive, 'Monthly_Deep_Dive'),
    'vendor_benchmark': (build_vendor_benchmark, 'Vendor_Benchmark'),
}


def build_report(report_type, metrics, narratives, user_profile):
    """Dispatch to the right generator. Returns (Document, filename)."""
    builder, stem = REPORT_BUILDERS[report_type]
    doc = builder(metrics, narratives, user_profile)
    suburb_bit = ''
    if len(metrics) == 1:
        safe = re.sub(r'[^\w\s-]', '', metrics[0].get('suburb') or '')
        suburb_bit = '_' + safe.strip().replace(' ', '_') if safe else ''
    stamp = datetime.utcnow().strftime('%Y%m%d')
    return doc, f"SuburbDesk_{stem}{suburb_bit}_{stamp}.docx"

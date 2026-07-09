import { useEffect, useState } from 'react'

// One global FAQ button + slide-in panel for the whole app.
// Lives at main.jsx root level so it survives auth state and view
// transitions. The print view (/pipeline/print) is the only place it
// is intentionally NOT mounted — letters need a clean canvas.

const SECTIONS = [
  {
    id: 'general',
    label: 'General',
    items: [
      ['What is SuburbDesk?',
        'SuburbDesk is a daily prospecting tool for Perth real estate agents. It tracks your suburb markets in real time, identifies likely sellers, and helps you send personalised prospecting letters — all before your competitors make their first call.'],
      ['When is data updated?',
        'Market data is scraped from REIWA.com.au every night at midnight Perth time. Your morning digest email arrives shortly after.'],
      ['How do I get support?',
        'Email suburbdesk@gmail.com — we typically respond same business day.'],
    ],
  },
  {
    id: 'listings',
    label: 'Listings',
    items: [
      ['Where does this data come from?',
        'Publicly available listings from REIWA.com.au, updated every night at midnight Perth time for your assigned suburbs.'],
      ['What do the status filters mean?',
        'Active = currently for sale. Under Offer = offer accepted. Sold = settled. Withdrawn = removed without selling.'],
      ['How do I add a note?',
        'Click "+ Note" next to any listing. Notes are private to your account and persist across scrapes.'],
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: [
      ['What is the Pipeline?',
        'Automatically identified homeowners most likely to sell soon, based on recent neighbour sales in your suburbs. Refreshed every morning after the scrape.'],
      ['How are targets selected?',
        'When a property sells nearby, SuburbDesk flags neighbouring properties as prospecting targets. Neighbour sales are the strongest predictor of future listing decisions.'],
      ['How do I send a prospecting letter?',
        'Click the letter icon next to any target. A personalised Word document with recent nearby sales is generated instantly. Download and send.'],
    ],
  },
  {
    id: 'report',
    label: 'Market Report',
    items: [
      ['What does the Market Report show?',
        'Active count, median price, median days on market, under offer rate, and week-on-week changes for your suburbs. Updated every morning.'],
      ['How do I use this in a listing presentation?',
        'Use the trend chart screenshot in your CMA. Example: "Cottesloe absorbed 23 sales in 30 days at a median of $2.1M" is a compelling vendor statement.'],
    ],
  },
  {
    id: 'hot-vendors',
    label: 'Hot Vendors',
    items: [
      ['What is a Hot Vendor Score?',
        'A 0-100 score per property owner based on holding period (50%), property type (20%), and capital gain (30%). Higher = more likely to sell soon.'],
      ['Where does the data come from?',
        'You import your own RP Data or CoreLogic export (from your existing licence). Your data is never shared with other users on the platform.'],
      ['Why do scores expire after 60 days?',
        'Market conditions change. Re-importing keeps your prospecting targets current and accurate.'],
      ['What do HOT / WARM / MEDIUM / LOW mean?',
        'HOT (75-100) = call today. WARM (50-74) = monitor closely. MEDIUM (25-49) = longer term watch. LOW (0-24) = low priority.'],
    ],
  },
  {
    id: 'rental',
    label: 'Rental',
    items: [
      ['Why track rentals?',
        'Landlords rented for 2+ years are strong selling prospects. Track them here and add owner contact details directly.'],
      ['How do I add owner contact details?',
        'Click the owner field on any rental listing and type directly. Saved to your account only.'],
    ],
  },
  {
    id: 'history',
    label: 'History',
    items: [
      ['What is the History tab?',
        'A ledger of every nightly scrape — when it ran, how many listings were for sale / sold / new / withdrawn, and any errors. It\'s about trusting the data pipeline.'],
    ],
  },
  {
    id: 'today',
    label: 'Dashboard',
    items: [
      ['What is the Dashboard?',
        'Your morning brief: what changed overnight. The top vendor signals for your suburbs, KPIs (fresh signals, hot/watch counts), the metro market-pulse trend, signals by suburb, and sales that just fell through — in one glance.'],
      ['What is "Market pulse"?',
        'The metro median asking price over time, built from the nightly market snapshots. The trend fills in as more days of data accumulate.'],
    ],
  },
  {
    id: 'signals',
    label: 'Signals',
    items: [
      ['What are Signals?',
        'The raw event stream behind the scores — every new listing, price cut, withdrawal, relisting and sale as it\'s detected, each scored 0-100 by how likely the owner is to sell. Hot Vendors is the ranked digest of this firehose.'],
      ['What does the score mean?',
        '60+ = strong signal, act now. 35-60 = worth watching. Below 35 = lower priority. Filter by New / Actioned / Dismissed.'],
    ],
  },
  {
    id: 'appraisals',
    label: 'Appraisals',
    items: [
      ['What is the Appraisals tab?',
        'Log an appraisal request and SuburbDesk auto-schedules J+30 / J+60 / J+90 follow-ups so nothing slips. Track open vs won / lost and your commission ROI.'],
    ],
  },
  {
    id: 'fallen',
    label: 'Sales Fallen Through',
    items: [
      ['What is "Sales Fallen Through"?',
        'Under-offer listings that returned to active in the last 14 days — the sale collapsed and the vendor\'s confidence in their agent is shaken. A ~2-week window to approach a genuinely motivated seller.'],
    ],
  },
]

// Map the current view (URL hash, kept in sync by App.jsx) to the FAQ
// section, so the "?" opens on the page you're actually looking at.
const HASH_TO_SECTION = {
  today: 'today', listings: 'listings', signals: 'signals', pipeline: 'pipeline',
  appraisals: 'appraisals', report: 'report', 'hot-vendors': 'hot-vendors',
  rentals: 'rental', fallen: 'fallen', logs: 'history',
}
function sectionForHash() {
  try {
    const h = (window.location.hash || '').replace(/^#/, '')
    return HASH_TO_SECTION[h] || 'general'
  } catch { return 'general' }
}

export default function FaqPanel() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState(sectionForHash)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    // Lock body scroll while the panel is open.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open])

  const active = SECTIONS.find(s => s.id === section) || SECTIONS[0]

  return (
    <>
      <button
        type="button"
        aria-label="Open help and FAQ"
        onClick={() => { setSection(sectionForHash()); setOpen(true) }}
        style={s.btn}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)' }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
      >?</button>

      {open && (
        <>
          <div style={s.overlay} onClick={() => setOpen(false)} />
          <aside style={s.panel} role="dialog" aria-label="Help and FAQ">
            <header style={s.head}>
              <div style={s.title}>Help &amp; FAQ</div>
              <button
                type="button"
                aria-label="Close help"
                onClick={() => setOpen(false)}
                style={s.close}
              >×</button>
            </header>
            <div style={s.tabs}>
              {SECTIONS.map(sec => (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => setSection(sec.id)}
                  style={{
                    ...s.tab,
                    ...(sec.id === section ? s.tabActive : {}),
                  }}
                >{sec.label}</button>
              ))}
            </div>
            <div style={s.body}>
              {active.items.map(([q, a], i) => (
                <div key={i} style={s.qa}>
                  <div style={s.q}>{q}</div>
                  <div style={s.a}>{a}</div>
                </div>
              ))}
            </div>
          </aside>
        </>
      )}
    </>
  )
}

const ACCENT = '#386350'

const s = {
  btn: {
    position: 'fixed',
    right: 20, bottom: 20,
    width: 40, height: 40,
    borderRadius: '50%',
    background: ACCENT,
    color: '#fff',
    border: 'none',
    fontSize: 20,
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    zIndex: 1000,
    transition: 'transform 0.12s ease',
    fontFamily: 'system-ui, -apple-system, Arial, sans-serif',
  },
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.25)',
    zIndex: 1100,
  },
  panel: {
    position: 'fixed', top: 0, right: 0, bottom: 0,
    width: 340,
    background: '#fff',
    boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
    zIndex: 1101,
    display: 'flex', flexDirection: 'column',
    fontFamily: 'system-ui, -apple-system, Arial, sans-serif',
    animation: 'sd-faq-in 0.18s ease-out',
  },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 18px',
    borderBottom: '1px solid #e5e7eb',
  },
  title: { fontSize: 15, fontWeight: 600, color: '#111827' },
  close: {
    background: 'none', border: 'none',
    fontSize: 22, lineHeight: 1, color: '#6b7280',
    cursor: 'pointer', padding: 0, width: 24, height: 24,
  },
  tabs: {
    display: 'flex', flexWrap: 'wrap', gap: 6,
    padding: '12px 14px',
    borderBottom: '1px solid #f1f5f9',
  },
  tab: {
    background: '#f3f4f6', color: '#374151',
    border: '1px solid transparent',
    borderRadius: 999, padding: '4px 10px',
    fontSize: 12, cursor: 'pointer',
  },
  tabActive: {
    background: ACCENT, color: '#fff',
    borderColor: ACCENT,
  },
  body: {
    overflowY: 'auto', flex: 1,
    padding: '12px 18px 24px',
  },
  qa: { marginBottom: 18 },
  q: { fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 },
  a: { fontSize: 13, color: '#4b5563', lineHeight: 1.5 },
}

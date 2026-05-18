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
        'Market data is scraped from REIWA.com.au every morning at 5am Perth time. Your morning digest email arrives shortly after.'],
      ['How do I get support?',
        'Email suburbdesk@gmail.com — we typically respond same business day.'],
    ],
  },
  {
    id: 'listings',
    label: 'Listings',
    items: [
      ['Where does this data come from?',
        'Publicly available listings from REIWA.com.au, updated every morning at 5am for your assigned suburbs.'],
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
      ['What do HOT / WARM / MEDIUM / COLD mean?',
        'HOT (75-100) = call today. WARM (50-74) = monitor closely. MEDIUM (25-49) = longer term watch. COLD (0-24) = low priority.'],
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
        'Daily market snapshots showing how listing volumes, median prices and days-on-market have evolved over time for your suburbs.'],
    ],
  },
]

export default function FaqPanel() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState('general')

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
        onClick={() => setOpen(true)}
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

// Reports view — the branded Word intelligence pack (INTELLIGENCE
// section, right after Market Report). Pick suburbs, pick one of the 4
// report types, get a .docx built server-side (SQL metrics + constrained
// AI narrative + Acton|Belle chrome).
//
// Two hard rules inherited from the auth/timeout architecture:
//   * BACKEND_DIRECT only — the generation (calculations + one Claude
//     call + docx build) legitimately runs 20-40s, which the Vercel
//     proxy would kill at 25s.
//   * fetch + blob for the download — window.open / <a href> bypass the
//     X-Access-Key interceptor in main.jsx and would 401.

import { useState } from 'react'
import { MultiSelect } from '../components/ui'
import { BACKEND_DIRECT, getAccessKey } from '../lib/api'

const REPORT_TYPES = [
  {
    type: 'suburb_intelligence',
    title: 'Suburb Intelligence',
    desc: 'One page per suburb — momentum score, velocity, pricing, '
      + 'stock aging, agency share and stale-campaign flags, each with '
      + 'an interpretation paragraph.',
  },
  {
    type: 'director_dashboard',
    title: 'Director Dashboard',
    desc: 'One page across all your suburbs — momentum heat map, '
      + 'listing-share movement, opportunity register and a house view.',
  },
  {
    type: 'monthly_deep_dive',
    title: 'Monthly Deep Dive',
    desc: 'Discount spread, price-band structure and stale-campaign '
      + 'detail. Rentals block activates with the rental scrape.',
  },
  {
    type: 'vendor_benchmark',
    title: 'Vendor Benchmark',
    desc: 'Vendor-safe handout — days on market, discount and absorption '
      + 'by price band. No competitor names anywhere.',
  },
]

export default function Reports({ suburbs }) {
  // Empty selection = every suburb the user can see (mirrors the Market
  // Report selector semantics — the backend scopes server-side anyway).
  const [selected, setSelected] = useState([])
  const [generating, setGenerating] = useState(null) // report type in flight
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null) // last filename downloaded

  const generate = async (type) => {
    if (generating) return
    setGenerating(type)
    setError(null)
    setDone(null)
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/reports/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': getAccessKey(),
        },
        body: JSON.stringify({ type, suburbs: selected }),
      })
      if (!res.ok) {
        let msg = `Server error ${res.status}`
        try {
          const data = await res.json()
          if (data && data.error) msg = data.error
        } catch { /* HTML 502 from a cold dyno — keep the status code */ }
        throw new Error(msg)
      }
      // fetch + blob (never window.open — it would drop the auth header).
      const blob = await res.blob()
      let filename = 'SuburbDesk_Report.docx'
      const cd = res.headers.get('Content-Disposition') || ''
      const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)
      if (m) filename = decodeURIComponent(m[1])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDone(filename)
    } catch (e) {
      console.error('Report generation failed:', e)
      setError(e.message || 'Could not generate the report — please try again.')
    } finally {
      setGenerating(null)
    }
  }

  const nSel = selected.length === 0 ? suburbs.length : selected.length

  return (
    <div style={{ padding: '24px 30px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 6px', color: 'var(--text)' }}>
            Reports
          </h2>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-muted)' }}>
            {nSel} suburb{nSel === 1 ? '' : 's'} · branded Word documents, ready to send
          </div>
        </div>
        <MultiSelect
          options={suburbs.map(s => ({ value: s.id, label: s.name }))}
          selected={selected}
          placeholder="All suburbs"
          allLabel="All"
          onChange={setSelected}
          style={{ maxWidth: 420 }}
        />
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, fontSize: 13.5,
          background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <span>⚠ {error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}
          >×</button>
        </div>
      )}
      {done && !error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, fontSize: 13.5,
          background: 'var(--accent-soft, #ebf0ee)', border: '1px solid var(--accent, #386350)',
          color: 'var(--accent, #386350)',
        }}>
          Downloaded {done}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {REPORT_TYPES.map(rt => {
          const busy = generating === rt.type
          return (
            <div
              key={rt.type}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 14, padding: '18px 20px', boxShadow: 'var(--shadow-card)',
                display: 'flex', flexDirection: 'column', gap: 10,
              }}
            >
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 15.5, fontWeight: 600, color: 'var(--text)' }}>
                {rt.title}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)', flex: 1 }}>
                {rt.desc}
              </div>
              <button
                type="button"
                onClick={() => generate(rt.type)}
                disabled={!!generating}
                style={{
                  padding: '9px 16px', borderRadius: 8, border: 'none',
                  background: busy ? 'var(--surface-hover)' : 'var(--accent, #386350)',
                  color: busy ? 'var(--text-muted)' : '#fff',
                  fontWeight: 600, fontSize: 13.5,
                  cursor: generating ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {busy && <span className="loading-spinner loading-spinner-sm" />}
                {busy ? 'Generating… (20–40s)' : 'Generate Word report'}
              </button>
            </div>
          )
        })}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Generation runs the calculations and the narrative pass server-side —
        expect 20–40 seconds. Metrics with small samples are flagged in the
        document rather than smoothed over.
      </div>
    </div>
  )
}

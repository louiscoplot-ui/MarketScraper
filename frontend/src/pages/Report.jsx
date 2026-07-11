// Market Report view — extracted from App.jsx to keep modules under
// the MCP push size limit. All state still lives in App.jsx; this
// component is purely presentational.

import { useRef, useEffect, useState } from 'react'
import { getDeskMode } from '../lib/deskFlag'
import { MultiSelect, Chip } from '../components/ui'
import DeskMap from '../components/DeskMap'

const PERTH_TZ = 'Australia/Perth'

// Compact money for the price-change delta: $150k / $1.2M. Sign is added
// by the caller so this only formats the magnitude.
function abbrevMoney(n) {
  const a = Math.abs(Number(n) || 0)
  if (a >= 1_000_000) {
    const m = a / 1_000_000
    return `$${(a >= 10_000_000 ? Math.round(m) : m.toFixed(1)).toString().replace(/\.0$/, '')}M`
  }
  if (a >= 1_000) return `$${Math.round(a / 1000)}k`
  return `$${Math.round(a)}`
}

// Strict dd/mm/yyyy. Mirrors Pipeline.jsx:43 — kept in sync manually
// since Pipeline doesn't export it. Operators in WA expect dd/mm/yyyy
// over the ISO yyyy-mm-dd that Postgres / market_snapshots returns.
function formatDateAU(value) {
  if (!value) return '—'
  const s = String(value).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`
  return s
}

// Single source of truth for WHEN-column formatting in the Price
// Changes table. Handles every shape Postgres / SQLite can serialise
// (space separator, microseconds, +00 short tz, no tz at all). Output
// rules:
//   < 1h   → "Just now" / "X min ago"
//   < 24h  → "Xh ago"
//   ≥ 24h  → "3 May 2026 21:51"  (always day + month + YEAR + time —
//            the older "Fri 1 May" bucket was dropped per UX feedback,
//            year was the missing detail operators wanted)
//
// Microseconds are stripped because JS Date only supports ms precision
// — the raw ".431894" suffix used to slip through and produce Invalid
// Date in some browsers, leaking the raw ISO string into the cell.
function formatWhen(raw) {
  if (!raw) return '—'
  // 1. Replace SQL space separator with ISO 'T'
  // 2. Drop sub-second fractional digits ('.431894') so JS Date parses
  // 3. Pad Postgres '+00' short-form to '+00:00' so all browsers accept
  let cleaned = String(raw).replace(' ', 'T').replace(/(\.\d+)/, '')
  cleaned = cleaned.replace(/([+-])(\d{2})$/, '$1$2:00')
  // No timezone → naive UTC (matches backend's datetime.utcnow().isoformat())
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(cleaned)) cleaned += 'Z'
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return '—'
  const now = new Date()
  const diffMs = now - d
  const diffH = diffMs / (1000 * 60 * 60)
  if (diffH < 1) {
    const mins = Math.floor(diffMs / 60000)
    return mins <= 1 ? 'Just now' : `${mins} min ago`
  }
  if (diffH < 24) return `${Math.floor(diffH)}h ago`
  // ≥ 24h → absolute date in Australian DD/MM/YYYY, in PERTH time so the
  // cell matches the hover tooltip (was d.getHours()/getDate() = the
  // viewer's browser timezone, diverging for anyone outside Perth).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PERTH_TZ, hourCycle: 'h23',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)
  const g = (t) => (parts.find(p => p.type === t) || {}).value || ''
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}`
}

// Tooltip for the WHEN cell — full date + time so the operator can
// hover for an exact value when they want one. Uses formatWhen's
// parsing so any string formatWhen accepts also works here.
function fmtFullTooltip(raw) {
  if (!raw) return ''
  let cleaned = String(raw).replace(' ', 'T').replace(/(\.\d+)/, '')
  cleaned = cleaned.replace(/([+-])(\d{2})$/, '$1$2:00')
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(cleaned)) cleaned += 'Z'
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-AU', {
    timeZone: PERTH_TZ,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function Report({ report, suburbs, reportSuburbs, setReportSuburbs, fetchReport, reportLoading }) {
  // Render the header + suburb selector even while loading so the
  // checkboxes update instantly when the user toggles them. The data
  // area below swaps to a loading indicator until the new fetch lands.

  // Debounce fetchReport across rapid checkbox clicks. User clicking
  // 3 suburbs in a row would previously fire 3 backend calls (each a
  // cold-start risk); now only the FINAL selection 500ms after the
  // last click hits the API. Replaces requestAnimationFrame which
  // was there to ensure the checkbox tick paints before the heavy
  // data-area re-render — the 500ms delay solves the same paint-
  // priority problem (the tick paints well before fetchReport runs)
  // while also collapsing rapid clicks into one request.
  const fetchTimerRef = useRef(null)
  const scheduleFetch = (selection) => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null
      fetchReport(selection)
    }, 500)
  }
  // Cancel any pending fetch on unmount so navigating away doesn't
  // fire a stale request after the component is gone.
  useEffect(() => () => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
  }, [])

  // Desk: drag the divider to resize the left/right columns. Persisted so
  // each operator keeps the layout they like.
  const [reportSplit, setReportSplit] = useState(() => {
    try { const v = parseFloat(localStorage.getItem('report_split')); return v >= 0.3 && v <= 0.8 ? v : 0.58 } catch { return 0.58 }
  })
  const gridRef = useRef(null)
  const splitRef = useRef(reportSplit)
  useEffect(() => { splitRef.current = reportSplit }, [reportSplit])
  // Hover / dragging feedback for the divider handle — inline styles
  // can't express :hover, so a tiny state pair drives the colour.
  const [splitHover, setSplitHover] = useState(false)
  const [splitDragging, setSplitDragging] = useState(false)
  const startReportResize = (e) => {
    e.preventDefault()
    // During the drag, write the column widths DIRECTLY to the grid node —
    // setState per mousemove re-rendered the entire report (KPIs, lists,
    // MapLibre map) dozens of times a second and made the drag stutter.
    // React state (and localStorage) only commit once, on mouseup.
    const onMove = (ev) => {
      // Button released outside the browser window → no mouseup ever
      // fires here; end the drag on the first re-entering move.
      if (ev.buttons === 0) { onUp(); return }
      const node = gridRef.current
      const rect = node && node.getBoundingClientRect()
      if (!rect || !rect.width) return
      let f = (ev.clientX - rect.left) / rect.width
      f = Math.max(0.3, Math.min(0.8, f))
      splitRef.current = f
      node.style.gridTemplateColumns = `${f}fr 10px ${(1 - f).toFixed(3)}fr`
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      document.body.style.userSelect = ''
      setSplitDragging(false)
      setReportSplit(splitRef.current)
      try { localStorage.setItem('report_split', String(splitRef.current)) } catch { /* ignore */ }
    }
    document.body.style.userSelect = 'none'
    setSplitDragging(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
  }

  // ── Desk redesign — full render of mock #report. ──
  if (getDeskMode() === 'desk' && report && !report.error) {
    const sm = report.summary || {}, pr = report.price || {}, dm = report.dom || {}
    const money = (n) => n ? `$${Number(n).toLocaleString('en-AU')}` : '—'
    const kpis = [
      { l: 'Active', v: sm.active || 0, c: 'var(--status-good)' },
      { l: 'Under Offer', v: sm.under_offer || 0, c: 'var(--status-watch)' },
      { l: 'Sold', v: sm.sold || 0, c: 'var(--status-info)' },
      { l: 'Median price', v: pr.median ? abbrevMoney(pr.median) : '—', c: 'var(--accent)' },
      { l: 'Avg days on market', v: dm.avg ?? '—', c: 'var(--text)' },
      { l: 'Stale (60+ days)', v: dm.stale_count || 0, c: 'var(--status-alert)' },
    ]
    const share = (report.market_share || []).filter(a => (a.agency || '').toLowerCase() !== 'unknown').slice(0, 9)
    const drops = (report.price_drops || []).slice(0, 12)
    // Real map: geocode each covered suburb to its centroid (free, cached).
    const mapSuburbs = (report.suburbs || []).slice(0, 12).map(x => Array.isArray(x)
      ? { name: x[0], total: x[1] && x[1].total } : { name: x })
    const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', boxShadow: 'var(--shadow-card)', display: 'flex', flexDirection: 'column', minHeight: 0 }
    const pTitle = { fontFamily: 'var(--font-ui)', fontSize: 15.5, fontWeight: 600, color: 'var(--text)', marginBottom: 14 }
    return (
      <div style={{ padding: '24px 30px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 6px', color: 'var(--text)' }}>Market Report</h2>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-muted)' }}>
              {reportSuburbs.size > 0 && reportSuburbs.size < suburbs.length ? `${reportSuburbs.size} suburbs` : `${suburbs.length} suburbs`} · rolling window{reportLoading ? ' · refreshing…' : ''}
            </div>
          </div>
          {/* Suburb selector — desk has no sidebar, so surface it here.
              Same fetch path as classic (debounced). Empty = all suburbs. */}
          <MultiSelect
            options={suburbs.map(s => ({ value: s.id, label: s.name }))}
            selected={[...reportSuburbs]}
            placeholder="All suburbs"
            allLabel="All"
            onChange={(arr) => { const next = new Set(arr); setReportSuburbs(next); if (next.size > 0) scheduleFetch(next) }}
            style={{ maxWidth: 420 }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {kpis.map(k => (
            <div key={k.l} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 13, padding: '16px 17px', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.l}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 33, letterSpacing: '-0.02em', lineHeight: 0.9, color: 'var(--text)' }}>{k.v}</span>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: k.c }} />
              </div>
            </div>
          ))}
        </div>

        <div ref={gridRef} style={{ flex: 1, display: 'grid', gridTemplateColumns: `${reportSplit}fr 10px ${(1 - reportSplit).toFixed(3)}fr`, gap: 6, minHeight: 0 }}>
          {/* left */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
            <div style={{ ...card, flex: 1, overflow: 'hidden' }}>
              <div style={pTitle}>Market share by agency <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>· active listings</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', paddingRight: 8 }}>
                {share.length === 0 ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}>No data.</div> : share.map(a => (
                  <div key={a.agency} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--text)', width: 160, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.agency}</span>
                    <div style={{ flex: 1, height: 10, background: 'var(--bg)', borderRadius: 999, overflow: 'hidden' }}><div style={{ height: '100%', width: `${a.pct}%`, background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 80%, white), var(--accent))', borderRadius: 999 }} /></div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)', minWidth: 82, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{a.count} · {a.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ ...card, flex: 1, overflow: 'hidden' }}>
              <div style={pTitle}>Price movements <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>· % change vs previous asking</span></div>
              <div style={{ overflowY: 'auto' }}>
                {drops.length === 0 ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}>No recent price changes.</div> : drops.map((m, i) => {
                  const cut = (m.delta_amount ?? 0) < 0
                  // delta 0 happens when only the price TEXT changed
                  // ("Offers From $1.1m" → "$1,100,000") — not a rise.
                  const zero = m.delta_amount === 0
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ minWidth: 0, flex: 1 }}><div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.address}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{m.suburb} · was {m.old_price || '—'}</div></div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{m.new_price || '—'}</span>
                      {m.delta_pct != null && Math.abs(m.delta_pct) <= 200 && (zero
                        ? <span title="Asking price unchanged" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999, minWidth: 66, textAlign: 'center', flexShrink: 0, background: 'var(--status-off-bg)', color: 'var(--status-off-text)' }}>No change</span>
                        : <span title="Change vs previous asking price" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999, minWidth: 66, textAlign: 'center', flexShrink: 0, background: cut ? 'var(--status-alert-bg)' : 'var(--status-info-bg)', color: cut ? 'var(--status-alert-text)' : 'var(--status-info-text)' }}>{cut ? '▼' : '▲'} {Math.abs(Math.round(m.delta_pct))}%</span>)}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {/* drag to resize left / right */}
          <div onMouseDown={startReportResize} title="Drag to resize"
            onMouseEnter={() => setSplitHover(true)} onMouseLeave={() => setSplitHover(false)}
            style={{ cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 4, height: 46, borderRadius: 999, background: (splitDragging || splitHover) ? 'var(--accent)' : 'var(--text-faint)' }} />
          </div>
          {/* right */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 160, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <DeskMap
                items={mapSuburbs}
                label="Coverage by suburb"
                addressOf={(x) => x.name}
                suburbOf={() => ''}
                colorOf={() => 'var(--accent)'}
                popupOf={(x) => `${x.name}${x.total != null ? ` · ${x.total} listing${x.total !== 1 ? 's' : ''}` : ''}`}
              />
            </div>
            {/* Twin of the left "Price movements" panel — when there are no
                drops, both would show the same empty line side by side, so
                this one disappears and the coverage map takes the column. */}
            {drops.length > 0 && (
            <div style={{ ...card, flex: 1, overflow: 'hidden' }}>
              <div style={pTitle}>Recent price changes</div>
              <div style={{ overflowY: 'auto' }}>
                {drops.slice(0, 8).map((m, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 92px', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ minWidth: 0 }}><div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>{m.address}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{m.suburb}</div></div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, textAlign: 'right', color: 'var(--text)' }}>{m.new_price || '—'}</span>
                  </div>
                ))}
              </div>
            </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="report-view">
      <h2>Market Report{reportSuburbs.size > 0 && reportSuburbs.size < suburbs.length
        ? ` — ${[...reportSuburbs].map(id => suburbs.find(s => s.id === id)?.name).filter(Boolean).join(', ')}`
        : ''}</h2>
      <div className="report-suburb-selector">
        {/* One chips multi-select replaces the 18 native checkboxes. The
            component's built-in All / Clear drive the same fetch path;
            selecting nothing leaves the last report on screen (no fetch),
            exactly as before. */}
        <MultiSelect
          options={suburbs.map(s => ({ value: s.id, label: s.name }))}
          selected={[...reportSuburbs]}
          placeholder="All suburbs"
          allLabel="All"
          onChange={(arr) => {
            const next = new Set(arr)
            setReportSuburbs(next)
            if (next.size > 0) scheduleFetch(next)
          }}
          style={{ maxWidth: 640 }}
        />
      </div>
      {/* Inline "updating…" hint when refreshing a previously-loaded
          report — keeps the old data visible so toggling suburbs
          doesn't blank the page. The big spinner is only shown when
          there's literally nothing to display (very first load). */}
      {report && reportLoading && (
        <div style={{
          fontSize: 12,
          padding: '6px 10px', marginBottom: 12,
          display: 'inline-flex', alignItems: 'center', gap: 8,
          background: 'var(--status-info-bg)', border: '1px solid var(--status-info)',
          color: 'var(--status-info-text)', borderRadius: 6,
        }}>
          <span style={{
            width: 12, height: 12, borderRadius: '50%',
            border: '2px solid color-mix(in srgb, var(--status-info-text) 25%, transparent)',
            borderTopColor: 'var(--status-info-text)',
            animation: 'sd-spin 0.8s linear infinite',
            display: 'inline-block',
          }} />
          Updating market report…
          <style>{`@keyframes sd-spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
      {!report ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 12, padding: '48px 24px', textAlign: 'center',
        }}>
          <div className="loading-spinner" />
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
            Loading market report…
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 380, lineHeight: 1.5 }}>
            Crunching listings, agency share, price changes and snapshots.
            First load can take 15–30 seconds while the server warms up.
          </div>
        </div>
      ) : report.error ? (
        // Backend 4xx bodies ({'error': ...}) reach here as-is (fetch
        // helper doesn't throw on 4xx) — show them instead of a fake
        // all-zero report. The selector above stays usable to recover.
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 8, padding: '48px 24px', textAlign: 'center',
        }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
            {String(report.error)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 380, lineHeight: 1.5 }}>
            No report could be built for this selection. Try different suburbs above.
          </div>
        </div>
      ) : (
      <>
      <div className="report-grid">
        <div className="report-card">
          <h3>Overview</h3>
          <div className="report-stats">
            <div className="report-stat"><span className="stat-val">{report.summary?.active || 0}</span><span className="stat-label">Active</span></div>
            <div className="report-stat"><span className="stat-val">{report.summary?.under_offer || 0}</span><span className="stat-label">Under Offer</span></div>
            <div className="report-stat"><span className="stat-val">{report.summary?.sold || 0}</span><span className="stat-label">Sold</span></div>
            <div className="report-stat"><span className="stat-val">{report.summary?.withdrawn || 0}</span><span className="stat-label">Withdrawn</span></div>
          </div>
        </div>

        <div className="report-card">
          <h3>Price Range (Active)</h3>
          <div className="report-stats">
            <div className="report-stat"><span className="stat-val">{report.price?.min ? `$${report.price.min.toLocaleString('en-AU')}` : '-'}</span><span className="stat-label">Min</span></div>
            <div className="report-stat"><span className="stat-val">{report.price?.median ? `$${report.price.median.toLocaleString('en-AU')}` : '-'}</span><span className="stat-label">Median</span></div>
            <div className="report-stat"><span className="stat-val">{report.price?.max ? `$${report.price.max.toLocaleString('en-AU')}` : '-'}</span><span className="stat-label">Max</span></div>
            <div className="report-stat"><span className="stat-val">{report.price?.count_with_price || 0}/{report.summary?.active || 0}</span><span className="stat-label">With Price</span></div>
          </div>
        </div>

        <div className="report-card">
          <h3>Days on Market (Active)</h3>
          <div className="report-stats">
            <div className="report-stat"><span className="stat-val">{report.dom?.avg ?? '-'}</span><span className="stat-label">Average</span></div>
            <div className="report-stat"><span className="stat-val">{report.dom?.median ?? '-'}</span><span className="stat-label">Median</span></div>
            <div className="report-stat"><span className="stat-val">{report.dom?.max ?? '-'}</span><span className="stat-label">Max</span></div>
            <div className="report-stat stale"><span className="stat-val">{report.dom?.stale_count || 0}</span><span className="stat-label">Stale (60+)</span></div>
          </div>
        </div>

        <div className="report-card">
          <h3>Property Types</h3>
          <div className="report-list">
            {(report.property_types || []).map(([type, count]) => (
              <div key={type} className="report-list-row">
                <span>{type}</span><span className="report-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="report-tables">
        {report.withdrawn_listings?.length > 0 && (
          <div className="report-table-section">
            <h3>Withdrawn Listings — Prospecting Targets</h3>
            <table>
              <thead><tr><th>Address</th><th>Suburb</th><th>Price</th><th>Agent</th><th>Agency</th><th>Link</th></tr></thead>
              <tbody>
                {report.withdrawn_listings.map((l, i) => (
                  <tr key={i} className="withdrawn-row">
                    <td>{l.address}</td><td>{l.suburb}</td><td>{l.price || '-'}</td>
                    <td>{l.agent || '-'}</td><td>{l.agency || '-'}</td>
                    <td className="link-cell">{l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(report.market_share || []).length > 0 && (
          <div className="report-table-section">
            <h3>Market Share (Active Listings)</h3>
            <div className="market-share-bars">
              {report.market_share.slice(0, 10).map((ms, i) => (
                <div key={ms.agency} className="share-row">
                  <span className="share-name">{ms.agency}</span>
                  <div className="share-bar-bg">
                    <div className="share-bar-fill" style={{ width: `${ms.pct}%`, opacity: 1 - (i * 0.06) }} />
                  </div>
                  <span className="share-val">{ms.count} ({ms.pct}%)</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.suburb_market_share && Object.keys(report.suburb_market_share).length > 1 && (
          <div className="report-table-section">
            <h3>Market Share by Suburb</h3>
            {Object.entries(report.suburb_market_share).map(([suburb, agencies]) => (
              <div key={suburb} className="suburb-share-block">
                <h4>{suburb}</h4>
                <div className="market-share-bars compact">
                  {agencies.slice(0, 5).map((ms, i) => (
                    <div key={ms.agency} className="share-row">
                      <span className="share-name">{ms.agency}</span>
                      <div className="share-bar-bg">
                        <div className="share-bar-fill" style={{ width: `${ms.pct}%`, opacity: 1 - (i * 0.08) }} />
                      </div>
                      <span className="share-val">{ms.count} ({ms.pct}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {(report.price_drops || []).length > 0 && (
          <div className="report-table-section">
            <h3>Price Changes — Motivated Sellers <span className="muted-count">(latest 15)</span></h3>
            <table>
              <thead><tr><th>Address</th><th>Suburb</th><th>Old Price</th><th>New Price</th><th>Change</th><th>When</th><th>Agent</th><th>Agency</th><th>Link</th></tr></thead>
              <tbody>
                {report.price_drops.map((pd, i) => (
                  <tr key={i} className={pd.drop_amount ? 'price-drop-row' : ''}>
                    <td>{pd.address}</td>
                    <td>{pd.suburb}</td>
                    <td className="price-cell old-price">{pd.old_price || '-'}</td>
                    <td className="price-cell">{pd.new_price || '-'}</td>
                    <td className="num">
                      {pd.delta_amount != null ? (
                        // Signed delta. A cut is the motivated-seller
                        // signal → alert (red, per the status grammar);
                        // a rise is neutral information → info (blue);
                        // 0 = only the price TEXT changed → no signal.
                        pd.delta_amount < 0 ? (
                          <Chip status="alert" size="sm" dot={false}>
                            −{abbrevMoney(pd.delta_amount)} · −{Math.abs(pd.delta_pct)}%
                          </Chip>
                        ) : pd.delta_amount > 0 ? (
                          <Chip status="info" size="sm" dot={false}>
                            +{abbrevMoney(pd.delta_amount)} · +{pd.delta_pct}%
                          </Chip>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>No change</span>
                        )
                      ) : (
                        // Prices we can't parse into numbers (e.g. "Offers
                        // over $X" → "Under negotiation"): show the real
                        // before→after text, never an invented delta.
                        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {pd.old_price || '—'} → {pd.new_price || '—'}
                        </span>
                      )}
                    </td>
                    <td className="when-cell" title={fmtFullTooltip(pd.changed_at)}>
                      {formatWhen(pd.changed_at)}
                    </td>
                    <td>{pd.agent || '-'}</td>
                    <td>{pd.agency || '-'}</td>
                    <td className="link-cell">{pd.reiwa_url ? <a href={pd.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(report.snapshots || []).length > 0 && (() => {
          const dates = [...new Set(report.snapshots.map(s => s.snapshot_date))].sort()
          const latestDate = dates[dates.length - 1]
          const prevDate = dates.length > 1 ? dates[dates.length - 2] : null
          const latest = report.snapshots.filter(s => s.snapshot_date === latestDate)
          const prev = prevDate ? report.snapshots.filter(s => s.snapshot_date === prevDate) : []
          const sumField = (arr, f) => arr.reduce((s, x) => s + (x[f] || 0), 0)
          const latestActive = sumField(latest, 'active_count')
          const latestUO = sumField(latest, 'under_offer_count')
          const medians = latest.map(s => s.median_price).filter(Boolean)
          const latestMedian = medians.length > 0 ? Math.round(medians.reduce((a,b) => a+b, 0) / medians.length) : null
          // Deltas only compare suburbs present on BOTH dates. A partial
          // scrape night (Cloudflare, quota) or a single-suburb manual
          // scrape would otherwise read as a huge fake market swing.
          // Headline totals stay the full latest-date sums.
          const latestIds = new Set(latest.map(s => s.suburb_id))
          const commonIds = new Set(prev.map(s => s.suburb_id).filter(id => latestIds.has(id)))
          const latestC = latest.filter(s => commonIds.has(s.suburb_id))
          const prevC = prev.filter(s => commonIds.has(s.suburb_id))
          const activeDelta = commonIds.size > 0 ? sumField(latestC, 'active_count') - sumField(prevC, 'active_count') : null
          const uoDelta = commonIds.size > 0 ? sumField(latestC, 'under_offer_count') - sumField(prevC, 'under_offer_count') : null
          const avgMedian = (arr) => { const ps = arr.map(s => s.median_price).filter(Boolean); return ps.length ? ps.reduce((a,b) => a+b, 0) / ps.length : null }
          const latestMedianC = avgMedian(latestC)
          const prevMedianC = avgMedian(prevC)
          const medianDeltaPct = latestMedianC != null && prevMedianC ? (latestMedianC - prevMedianC) / prevMedianC * 100 : null
          const fmtDelta = (d) => d === 0 ? '=' : d > 0 ? `+${d}` : `${d}`
          return (
            <div className="report-table-section">
              <h3>Market Trends</h3>
              <p className="trend-subtitle">{dates.length} snapshot{dates.length > 1 ? 's' : ''} recorded (latest: {formatDateAU(latestDate)})</p>
              <div className="trend-cards">
                <div className="trend-card">
                  <span className="trend-val">{latestActive}</span>
                  <span className="trend-label">Active Listings</span>
                  {activeDelta !== null && <span className={`trend-delta ${activeDelta > 0 ? 'up' : activeDelta < 0 ? 'down' : ''}`}>{fmtDelta(activeDelta)} vs prev</span>}
                </div>
                <div className="trend-card">
                  <span className="trend-val">{latestUO}</span>
                  <span className="trend-label">Under Offer</span>
                  {uoDelta !== null && <span className={`trend-delta ${uoDelta > 0 ? 'up' : uoDelta < 0 ? 'down' : ''}`}>{fmtDelta(uoDelta)} vs prev</span>}
                </div>
                {latestMedian && (
                  <div className="trend-card">
                    <span className="trend-val">${latestMedian.toLocaleString('en-AU')}</span>
                    <span className="trend-label" title="Average of each suburb's median asking price">Median Price (avg across suburbs)</span>
                    {medianDeltaPct !== null && <span className={`trend-delta ${medianDeltaPct > 0 ? 'up' : medianDeltaPct < 0 ? 'down' : ''}`}>{medianDeltaPct > 0 ? '+' : ''}{medianDeltaPct.toFixed(1)}% vs prev</span>}
                  </div>
                )}
              </div>
              {dates.length > 1 && (
                <table className="snapshot-table">
                  <thead>
                    <tr><th>Date</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th><th>New</th><th title="Average of each suburb's median asking price">Median (avg)</th><th>Avg DOM</th></tr>
                  </thead>
                  <tbody>
                    {dates.slice().reverse().map(date => {
                      const snaps = report.snapshots.filter(s => s.snapshot_date === date)
                      return (
                        <tr key={date}>
                          <td>{formatDateAU(date)}</td>
                          <td className="num">{sumField(snaps, 'active_count')}</td>
                          <td className="num">{sumField(snaps, 'under_offer_count')}</td>
                          <td className="num">{sumField(snaps, 'sold_count')}</td>
                          <td className="num">{sumField(snaps, 'withdrawn_count')}</td>
                          <td className="num">{sumField(snaps, 'new_count')}</td>
                          <td className="num">{(() => { const ps = snaps.map(s => s.median_price).filter(Boolean); return ps.length ? `$${Math.round(ps.reduce((a,b)=>a+b,0)/ps.length).toLocaleString('en-AU')}` : '-' })()}</td>
                          <td className="num">{(() => { const ds = snaps.map(s => s.avg_dom).filter(Boolean); return ds.length ? Math.round(ds.reduce((a,b)=>a+b,0)/ds.length) : '-' })()}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )
        })()}

        <div className="report-table-section">
          <h3>Top Agencies</h3>
          <table>
            <thead><tr><th>Agency</th><th>Total</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th></tr></thead>
            <tbody>
              {(report.agencies || []).map(([name, stats]) => (
                <tr key={name}>
                  <td>{name}</td><td className="num">{stats.total}</td>
                  <td className="num">{stats.active}</td><td className="num">{stats.under_offer}</td>
                  <td className="num">{stats.sold}</td><td className="num">{stats.withdrawn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="report-table-section">
          <h3>Top Agents</h3>
          <table>
            <thead><tr><th>Agent</th><th>Total</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th></tr></thead>
            <tbody>
              {(report.agents || []).map(([name, stats]) => (
                <tr key={name}>
                  <td>{name}</td><td className="num">{stats.total}</td>
                  <td className="num">{stats.active}</td><td className="num">{stats.under_offer}</td>
                  <td className="num">{stats.sold}</td><td className="num">{stats.withdrawn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {report.stale_listings?.length > 0 && (
          <div className="report-table-section">
            <h3>Stale Listings (60+ Days) — Potential Leads</h3>
            <table>
              <thead><tr><th>Address</th><th>Suburb</th><th>Price</th><th>Agent</th><th>Agency</th><th>DOM</th><th>Link</th></tr></thead>
              <tbody>
                {report.stale_listings.map((l, i) => (
                  <tr key={i} className="stale-row">
                    <td>{l.address}</td><td>{l.suburb}</td><td>{l.price || '-'}</td>
                    <td>{l.agent || '-'}</td><td>{l.agency || '-'}</td>
                    <td title="60+ days on the market">
                      <Chip status="alert" size="sm">Stale · {l.dom}d</Chip>
                    </td>
                    <td className="link-cell">{l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(report.suburbs || []).length > 1 && (
          <div className="report-table-section">
            <h3>Suburb Breakdown</h3>
            <table>
              <thead><tr><th>Suburb</th><th>Total</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th></tr></thead>
              <tbody>
                {report.suburbs.map(([name, stats]) => (
                  <tr key={name}>
                    <td>{name}</td><td className="num">{stats.total}</td>
                    <td className="num">{stats.active}</td><td className="num">{stats.under_offer}</td>
                    <td className="num">{stats.sold}</td><td className="num">{stats.withdrawn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}

// Rental module — table of REIWA rental listings per suburb, with an
// inline-editable owner column (operator data lives in rental_owners,
// the nightly scraper never touches it). Mirrors ListingsView's
// patterns: localStorage compact-mode toggle, BACKEND_DIRECT upload,
// debounced PATCH on cell blur with save-flash, contextual sidebar
// drives the suburb selection from App.jsx.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { apiJson, BACKEND_DIRECT, getAccessKey, readCache, writeCache } from '../lib/api'


// Suburb-scoped cache key. Stale-while-revalidate — hydrate the table
// from localStorage on suburb change, then refresh in the background
// so the operator never sees an empty spinner after the first visit.
const RENTAL_CACHE_KEY = (suburb) => `rentals_${(suburb || '').toLowerCase()}`


// Premium colour system — distinct from sales so an operator never
// confuses a leased rental with a sold sale. Saffron + teal + slate
// palette, all in the same lightness band so contrast against the
// dark table header reads cleanly.
const STATUS_STYLES = {
  New:    { bg: '#eff6ff', color: '#1e40af', label: 'New' },
  Active: { bg: '#f0fdfa', color: '#0f766e', label: 'Active' },
  Leased: { bg: '#f8fafc', color: '#64748b', label: 'Leased', italic: true },
}


// Visible columns in their canonical order. owner_* / notes are
// tagged so we can render the cream tint without an extra prop drill.
const COLS = [
  { key: 'status',        label: 'Status' },
  { key: 'address',       label: 'Address',     bold: true },
  { key: 'price_week',    label: 'Price / Week' },
  { key: 'property_type', label: 'Type' },
  { key: 'beds',          label: 'Beds',    num: true },
  { key: 'baths',         label: 'Baths',   num: true },
  { key: 'cars',          label: 'Cars',    num: true },
  { key: 'agency',        label: 'Agency' },
  { key: 'agent',         label: 'Agent' },
  { key: 'date_listed',   label: 'Date Listed' },
  { key: 'days_on_market', label: 'DOM',   num: true },
  { key: 'owner_name',    label: 'Owner Name',  owner: true },
  { key: 'owner_phone',   label: 'Owner Phone', owner: true },
  { key: 'notes',         label: 'Notes',       owner: true },
  { key: 'url',           label: 'Link' },
]


function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || { bg: '#f3f4f6', color: '#374151', label: status || '—' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 10,
      fontSize: 11, fontWeight: 700, background: s.bg, color: s.color,
      fontStyle: s.italic ? 'italic' : 'normal',
      letterSpacing: 0.3, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}


// DOM badge — green ≤14, orange ≤30, red >30. Empty / NaN → muted "—".
function DomBadge({ days }) {
  const n = parseInt(days, 10)
  if (!days || isNaN(n)) return <span style={{ color: '#9ca3af' }}>—</span>
  let bg = '#dcfce7', color = '#166534'  // fresh
  if (n > 30)      { bg = '#fee2e2'; color = '#991b1b' }  // stale
  else if (n > 14) { bg = '#ffedd5'; color = '#9a3412' }  // warming up
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 8,
      fontSize: 11, fontWeight: 700, background: bg, color,
      minWidth: 28, textAlign: 'center',
    }}>{n}</span>
  )
}


// Reusable inline editor — applied to owner_name / owner_phone / notes.
// Hover shows a dotted underline; focus turns the cell into a real
// input with a cream background; commit on blur or Enter; revert on
// Esc; save-flash green for 1.2s. Matches the sales saveNote pattern.
function EditableCell({ value, onSave, compact }) {
  const [draft, setDraft] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState(false)
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setDraft(value || '')
  }, [value])
  const commit = async () => {
    focusedRef.current = false
    if ((draft || '') === (value || '')) return
    setSaving(true)
    try {
      await onSave(draft)
      setFlash(true)
      setTimeout(() => setFlash(false), 1200)
    } catch (e) {
      alert(`Save failed: ${e.message}`)
      setDraft(value || '')
    } finally {
      setSaving(false)
    }
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focusedRef.current = true }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur()
        if (e.key === 'Escape') { setDraft(value || ''); e.target.blur() }
      }}
      disabled={saving}
      style={{
        width: '100%', boxSizing: 'border-box',
        padding: compact ? '2px 4px' : '4px 6px',
        fontSize: compact ? 12 : 13,
        border: '1px solid transparent',
        borderBottom: '1px dashed transparent',
        background: flash ? '#dcfce7' : 'transparent',
        borderRadius: 3,
        transition: 'background 0.4s, border-color 0.15s',
        color: '#111827',
      }}
      onMouseEnter={(e) => {
        if (!focusedRef.current) e.currentTarget.style.borderBottom = '1px dashed #9ca3af'
      }}
      onMouseLeave={(e) => {
        if (!focusedRef.current) e.currentTarget.style.borderBottom = '1px dashed transparent'
      }}
    />
  )
}


function SkeletonRows({ count = 5, cols = COLS.length + 1 }) {
  // Placeholder rows during the initial fetch — keeps the table
  // skeleton in place so the header / filters don't jump.
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} style={{ padding: '10px' }}>
              <div style={{
                height: 12, background: '#e5e7eb', borderRadius: 4,
                animation: 'rental-pulse 1.4s ease-in-out infinite',
                width: j === 1 ? '85%' : `${40 + ((i + j) % 4) * 12}%`,
              }} />
            </td>
          ))}
        </tr>
      ))}
      <style>{`
        @keyframes rental-pulse {
          0%, 100% { opacity: 0.6; }
          50%      { opacity: 1; }
        }
      `}</style>
    </>
  )
}


export default function RentalView({ suburb: suburbProp, setSuburb: setSuburbProp } = {}) {
  // When App.jsx drives the sidebar selection it passes (suburbProp,
  // setSuburbProp); fall back to fully-internal state when mounted
  // standalone (the dropdown re-appears in that mode).
  const controlled = typeof suburbProp === 'string' && typeof setSuburbProp === 'function'
  const [suburbs, setSuburbs] = useState([])
  const [internalSuburb, setInternalSuburb] = useState('')
  const suburb = controlled ? suburbProp : internalSuburb
  const setSuburb = controlled ? setSuburbProp : setInternalSuburb

  const [listings, setListings] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef(null)

  // Status filter toggles — both ON by default = show everything.
  // Pure client-side filter on already-loaded rows, no refetch.
  const [showAvailable, setShowAvailable] = useState(true)  // New + Active
  const [showLeased,    setShowLeased]    = useState(true)

  // Persist compact preference so the operator's density choice
  // survives reloads — same key family as the other tables
  // (listings_compact, hv_compact).
  const [compact, setCompact] = useState(() => {
    try {
      const v = localStorage.getItem('rentals_compact')
      return v === null ? false : v === '1'
    } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('rentals_compact', compact ? '1' : '0') } catch {}
  }, [compact])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await apiJson('/api/rentals/suburbs')
        if (cancelled) return
        const arr = data.suburbs || []
        setSuburbs(arr)
        if (arr.length > 0 && !suburb) setSuburb(arr[0].name)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchListings = useCallback(async (suburbName, { silent = false } = {}) => {
    if (!suburbName) return
    if (!silent) setLoading(true)
    setError('')
    try {
      const data = await apiJson(`/api/rentals/${encodeURIComponent(suburbName)}`)
      const next = data.listings || []
      setListings(next)
      writeCache(RENTAL_CACHE_KEY(suburbName), next)
    } catch (e) {
      setError(e.message)
      if (!silent) setListings([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // Stale-while-revalidate: render the cached snapshot synchronously
  // when the suburb changes (no blank table while the network round-
  // trips), then refresh in the background. Skip the spinner entirely
  // on a cache hit so the operator perceives the switch as instant.
  useEffect(() => {
    if (!suburb) return
    const cached = readCache(RENTAL_CACHE_KEY(suburb))
    if (Array.isArray(cached) && cached.length > 0) {
      setListings(cached)
      fetchListings(suburb, { silent: true })
    } else {
      setListings([])
      fetchListings(suburb)
    }
  }, [suburb, fetchListings])

  const patchOwner = useCallback(async (row, field, value) => {
    await apiJson('/api/rentals/owner', {
      method: 'PATCH',
      body: JSON.stringify({
        address: row.address,
        suburb: row.suburb,
        owner_name: field === 'owner_name' ? value : (row.owner_name || ''),
        owner_phone: field === 'owner_phone' ? value : (row.owner_phone || ''),
        notes: field === 'notes' ? value : (row.notes || ''),
      }),
    })
    // Optimistic update + cache write so the saved value survives a
    // tab switch without a refetch.
    setListings(prev => {
      const next = prev.map(r =>
        (r.address === row.address && r.suburb === row.suburb)
          ? { ...r, [field]: value }
          : r
      )
      writeCache(RENTAL_CACHE_KEY(row.suburb), next)
      return next
    })
  }, [])

  // Counters drive the toggle pill labels. Cheap to recompute — the
  // backend caps rental_listings per suburb at REIWA's natural ceiling.
  const counts = useMemo(() => {
    let avail = 0, leased = 0
    for (const r of listings) {
      if (r.status === 'Leased') leased++
      else avail++  // 'New' + 'Active' (and anything weird falls into avail)
    }
    return { avail, leased }
  }, [listings])

  const filtered = useMemo(() => {
    return listings.filter(r => {
      const isLeased = r.status === 'Leased'
      if (isLeased) return showLeased
      return showAvailable
    })
  }, [listings, showAvailable, showLeased])

  const onImportClick = () => fileInputRef.current?.click()
  const onFileChange = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setImporting(true)
    setImportMsg('')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', f)
      // BACKEND_DIRECT — Vercel 25s edge timeout would kill big sheets.
      const res = await fetch(`${BACKEND_DIRECT}/api/rentals/import`, {
        method: 'POST',
        headers: { 'X-Access-Key': getAccessKey() },
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setImportMsg(`✓ ${data.imported} listings imported across ${
        (data.suburbs || []).length} suburb sheet(s)${
        data.skipped ? ` — ${data.skipped} sheet(s) skipped` : ''}`)
      if (suburb) fetchListings(suburb)
      setTimeout(() => setImportMsg(''), 8000)
    } catch (err) {
      setError(`Import failed: ${err.message}`)
    } finally {
      setImporting(false)
    }
  }

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------
  const pad = compact ? '5px 8px' : '9px 12px'
  const fontSize = compact ? 12 : 13

  return (
    <div>
      {/* Header band ------------------------------------------------ */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 16, marginBottom: 14, flexWrap: 'wrap',
      }}>
        <div>
          <h2 style={{
            margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a',
            letterSpacing: -0.3,
          }}>
            Rental{suburb ? <span style={{ color: '#64748b', fontWeight: 500 }}> — {suburb}</span> : ''}
          </h2>
          <div style={{
            marginTop: 6, fontSize: 12, color: '#64748b',
            display: 'flex', gap: 14, flexWrap: 'wrap',
          }}>
            <span><strong style={{ color: '#0f172a' }}>{counts.avail}</strong> for rent</span>
            <span style={{ color: '#cbd5e1' }}>·</span>
            <span><strong style={{ color: '#0f172a' }}>{counts.leased}</strong> leased</span>
            <span style={{ color: '#cbd5e1' }}>·</span>
            <span><strong style={{ color: '#0f172a' }}>{suburbs.length}</strong> suburb{suburbs.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Standalone-mount fallback dropdown — hidden when the
              parent (App.jsx sidebar) controls the selection. */}
          {!controlled && (
            <select
              value={suburb}
              onChange={(e) => setSuburb(e.target.value)}
              style={{
                padding: '7px 10px', fontSize: 13,
                border: '1px solid #d1d5db', borderRadius: 6, background: 'white',
              }}
            >
              {!suburbs.length && <option value="">No suburbs available</option>}
              {suburbs.map(s => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
          )}

          <PillToggle
            on={showAvailable}
            onClick={() => setShowAvailable(v => !v)}
            label={`For Rent (${counts.avail})`}
            colorOn="#0f766e" bgOn="#ccfbf1"
          />
          <PillToggle
            on={showLeased}
            onClick={() => setShowLeased(v => !v)}
            label={`Leased (${counts.leased})`}
            colorOn="#475569" bgOn="#e2e8f0"
          />
          <button
            type="button"
            onClick={() => setCompact(c => !c)}
            title="Toggle compact density"
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              background: compact ? '#0f172a' : 'white',
              color: compact ? 'white' : '#0f172a',
              border: '1px solid #0f172a',
              borderRadius: 6, cursor: 'pointer',
            }}
          >
            {compact ? '⊟ Compact' : '⊞ Compact'}
          </button>
          <input
            type="file"
            ref={fileInputRef}
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
          <button
            type="button"
            onClick={onImportClick}
            disabled={importing}
            style={{
              padding: '7px 14px', fontSize: 13, fontWeight: 600,
              background: importing ? '#94a3b8' : '#386351',
              color: 'white', border: 'none', borderRadius: 6,
              cursor: importing ? 'progress' : 'pointer',
            }}
          >
            {importing ? '⏳ Importing…' : '⬆ Import Excel'}
          </button>
        </div>
      </div>

      {importMsg && (
        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: '#dcfce7', color: '#065f46',
          border: '1px solid #86efac', borderRadius: 6, fontSize: 13,
        }}>{importMsg}</div>
      )}
      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: '#fee2e2', color: '#991b1b',
          border: '1px solid #fca5a5', borderRadius: 6, fontSize: 13,
        }}>{error}</div>
      )}

      {/* Table ----------------------------------------------------- */}
      <div style={{
        border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse', fontSize,
            background: 'white',
          }}>
            <thead>
              <tr style={{ background: '#1e293b' }}>
                {COLS.map(c => (
                  <th key={c.key} style={{
                    textAlign: c.num ? 'center' : 'left',
                    padding: compact ? '7px 8px' : '10px 12px',
                    fontWeight: 600, fontSize: 10.5, color: '#cbd5e1',
                    textTransform: 'uppercase', letterSpacing: 0.6,
                    whiteSpace: 'nowrap',
                  }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows count={5} />
              ) : !filtered.length ? (
                <tr>
                  <td colSpan={COLS.length} style={{
                    padding: '48px 24px', textAlign: 'center', color: '#64748b',
                  }}>
                    <div style={{ fontSize: 36, marginBottom: 8, lineHeight: 1 }}>🏠</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
                      No rental listings for this suburb
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      {listings.length > 0
                        ? 'Adjust the status filters above to see the other rows.'
                        : suburb
                          ? "Tonight's scrape will load them, or import an Excel file."
                          : 'Pick a suburb in the sidebar.'}
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((r, idx) => {
                  const zebra = idx % 2 === 1 ? '#f8fafc' : 'white'
                  return (
                    <tr
                      key={`${r.suburb}|${r.address}`}
                      style={{ borderBottom: '1px solid #f1f5f9', background: zebra }}
                    >
                      {COLS.map(c => {
                        const ownerTint = c.owner ? '#fefce8' : undefined
                        const cellStyle = {
                          padding: pad,
                          verticalAlign: 'middle',
                          background: ownerTint,
                          textAlign: c.num ? 'center' : 'left',
                          color: c.bold ? '#0f172a' : '#334155',
                          fontWeight: c.bold ? 600 : 400,
                          whiteSpace: c.key === 'address' || c.key === 'notes' ? 'normal' : 'nowrap',
                        }
                        if (c.key === 'status') {
                          return <td key={c.key} style={cellStyle}><StatusBadge status={r.status} /></td>
                        }
                        if (c.key === 'days_on_market') {
                          return <td key={c.key} style={cellStyle}><DomBadge days={r.days_on_market} /></td>
                        }
                        if (c.owner) {
                          return (
                            <td key={c.key} style={cellStyle}>
                              <EditableCell
                                value={r[c.key]}
                                onSave={(v) => patchOwner(r, c.key, v)}
                                compact={compact}
                              />
                            </td>
                          )
                        }
                        if (c.key === 'url') {
                          if (!r.url) return <td key={c.key} style={{ ...cellStyle, color: '#cbd5e1' }}>—</td>
                          return (
                            <td key={c.key} style={cellStyle}>
                              <a
                                href={r.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open on REIWA"
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  color: '#386351', fontWeight: 600, textDecoration: 'none',
                                  fontSize: 12,
                                }}
                              >
                                REIWA <span aria-hidden="true">↗</span>
                              </a>
                            </td>
                          )
                        }
                        return <td key={c.key} style={cellStyle}>{r[c.key] || '—'}</td>
                      })}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}


function PillToggle({ on, onClick, label, colorOn = '#386351', bgOn = '#d1fae5' }) {
  // Match the sales filter-btn look (rounded rect, soft fill when
  // active, outline when off) without pulling in the global CSS class —
  // keeps RentalView self-contained for now.
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px', fontSize: 12, fontWeight: 600,
        border: `1px solid ${on ? colorOn : '#cbd5e1'}`,
        background: on ? bgOn : 'white',
        color: on ? colorOn : '#64748b',
        borderRadius: 999, cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

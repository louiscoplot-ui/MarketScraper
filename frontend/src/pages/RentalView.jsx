// Rental module — table of REIWA rental listings per suburb, with an
// inline-editable owner column (operator data lives in rental_owners,
// the nightly scraper never touches it). Mirrors ListingsView's
// patterns: localStorage compact-mode toggle, BACKEND_DIRECT upload,
// debounced PATCH on cell blur with save-flash, contextual sidebar
// drives the suburb selection from App.jsx.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { apiJson, BACKEND_DIRECT, getAccessKey, readCache, writeCache } from '../lib/api'
import { formatIsoDate } from '../hooks/useListings'
import { getDeskMode } from '../lib/deskFlag'


// Suburb-scoped cache key. Stale-while-revalidate — hydrate the table
// from localStorage on suburb change, then refresh in the background
// so the operator never sees an empty spinner after the first visit.
// lib/api.js prefixes this with `sd_cache_v3_<16hex>_` so values are
// scoped per access_key and per cache version. No TTL — entries live
// until CACHE_VERSION bumps or the user clears storage.
const RENTAL_CACHE_KEY = (suburb) =>
  `rentals_${String(suburb || '').trim().toLowerCase()}`


// Premium colour system — distinct from sales so an operator never
// confuses a leased rental with a sold sale. Saffron + teal + slate
// palette, all in the same lightness band so contrast against the
// dark table header reads cleanly.
const STATUS_STYLES = {
  New:    { bg: '#eff6ff', color: '#1e40af', label: 'New' },
  Active: { bg: '#f0fdfa', color: '#0f766e', label: 'Active' },
  Leased: { bg: 'var(--bg)', color: 'var(--text-muted)', label: 'Leased', italic: true },
}


// Visible columns in their canonical order. owner_* / notes are
// tagged so we can render the cream tint without an extra prop drill.
// `width` is the target column width in px — assigned through a <col>
// element so the table can shrink long agency/agent strings (ellipsis)
// while keeping the numeric columns tight. Total target: ~1240 px,
// fits a 1366-wide viewport with the sidebar open.
const COLS = [
  { key: 'status',         label: 'Status',      width: 80, sortable: true },
  { key: 'address',        label: 'Address',     width: 200, bold: true, sortable: true },
  { key: 'price_week',     label: 'Price/wk',    width: 90, sortable: true },
  { key: 'property_type',  label: 'Type',        width: 80, sortable: true },
  { key: 'beds',           label: 'Bed',         width: 42, num: true, sortable: true },
  { key: 'baths',          label: 'Bath',        width: 42, num: true },
  { key: 'cars',           label: 'Car',         width: 42, num: true },
  { key: 'agency',         label: 'Agency',      width: 130, truncate: true },
  { key: 'agent',          label: 'Agent',       width: 110, truncate: true },
  { key: 'date_listed',    label: 'Listed',      width: 90, sortable: true, date: true },
  { key: 'days_on_market', label: 'Days',        width: 56, num: true, sortable: true },
  { key: 'owner_name',     label: 'Owner Name',  width: 130, owner: true },
  { key: 'owner_phone',    label: 'Owner Phone', width: 120, owner: true },
  { key: 'notes',          label: 'Notes',       width: 170, owner: true },
  { key: 'url',            label: 'Link',        width: 60 },
]


// Display-only: always render "address, suburb" uniformly, whatever the
// source. Excel-imported rows already carry the suburb inside the address
// ("38/34 Davies Road, Claremont"); REIWA-scraped rows don't ("2 Windsor
// Court"). Dedup so we never produce "…, Claremont, Claremont". Touches
// NOTHING in the DB — address & suburb stay separate columns (the import
// matching key); this recomposes the string on the fly at render time.
function displayAddress(address, suburb) {
  const a = String(address || '').trim().replace(/[,\s]+$/, '')
  const s = String(suburb || '').trim()
  if (!a) return s
  if (!s) return a
  const la = a.toLowerCase()
  const ls = s.toLowerCase()
  const idx = la.lastIndexOf(ls)
  // Suburb already at the very end as a whole word (start of string, or
  // preceded by a comma/space)? Don't append it a second time.
  if (idx >= 0 && idx + ls.length === la.length) {
    const before = idx === 0 ? '' : a[idx - 1]
    if (idx === 0 || before === ' ' || before === ',') return a
  }
  return `${a}, ${s}`
}


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
  if (!days || isNaN(n)) return <span style={{ color: 'var(--text-faint)' }}>—</span>
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
        color: 'var(--text)',
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


export default function RentalView({ selectedNames } = {}) {
  // App.jsx drives the suburb selection by passing an array of names
  // (multi-select). When the array is missing / not an array, the
  // component falls back to a self-contained mode with a single-suburb
  // dropdown so standalone mounts (e.g. a future direct route) still
  // work without props.
  const controlled = Array.isArray(selectedNames)
  const [suburbs, setSuburbs] = useState([])
  const [internalSuburb, setInternalSuburb] = useState('')
  // Canonical list of suburb names this view is rendering data for.
  // Empty array = nothing to fetch / nothing to show.
  const activeNames = controlled
    ? selectedNames
    : (internalSuburb ? [internalSuburb] : [])

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

  // Agency / agent dropdowns — populated from the loaded listings.
  // Agent options are scoped by the selected agency so an operator
  // doesn't have to scroll through 200 names from other agencies.
  // Selecting an agency resets the agent (a stale agent name from a
  // different agency would yield zero rows).
  const [selectedAgency, setSelectedAgency] = useState('')
  const [selectedAgent,  setSelectedAgent]  = useState('')
  useEffect(() => { setSelectedAgent('') }, [selectedAgency])

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

  // Internal suburb list — only used to populate the standalone-mode
  // dropdown. Controlled mode reads the list from App.jsx via the
  // sidebar so this effect is a no-op cost for that path.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await apiJson('/api/rentals/suburbs')
        if (cancelled) return
        const arr = data.suburbs || []
        setSuburbs(arr)
        if (!controlled && arr.length > 0 && !internalSuburb) {
          setInternalSuburb(arr[0].name)
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Surfaced in the header so the operator can see how many of the
  // selected suburbs successfully responded — { loaded, total } pair.
  // total === 0 hides the indicator entirely (single-suburb or empty
  // selection case).
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, total: 0 })

  // Single-suburb fetch + cache write. AbortSignal-aware so the
  // sequential batch can be cancelled mid-run when the selection
  // changes. apiJson doesn't accept a signal, so we go to raw fetch
  // here.
  const fetchOne = useCallback(async (suburbName, signal) => {
    const key = getAccessKey()
    const res = await fetch(`/api/rentals/${encodeURIComponent(suburbName)}`, {
      headers: key ? { 'X-Access-Key': key } : {},
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${suburbName}`)
    const data = await res.json()
    const rows = data.listings || []
    const cacheKey = RENTAL_CACHE_KEY(suburbName)
    writeCache(cacheKey, rows)
    try { console.log('[RentalView] cache WRITE', cacheKey, 'rows:', rows.length) } catch {}
    return rows
  }, [])

  // Stable status order — same one the backend SQL applies, kept in
  // sync here so the multi-suburb merge sort matches single-suburb
  // ordering exactly.
  const STATUS_RANK = { New: 0, Active: 1, Leased: 2 }
  const sortMerged = (rows) => {
    return [...rows].sort((a, b) => {
      const sa = STATUS_RANK[a.status] ?? 3
      const sb = STATUS_RANK[b.status] ?? 3
      if (sa !== sb) return sa - sb
      return (b.date_listed || '').localeCompare(a.date_listed || '')
    })
  }

  // Multi-suburb stale-while-revalidate.
  //
  // Why NOT Promise.all on N suburbs: a 15-suburb selection used to
  // fan out 15 concurrent requests against the Render free dyno; the
  // dyno saturated, some responses never landed, the try/finally
  // never resolved on those promises, and setLoading(false) never
  // fired → spinner forever.
  //
  // Sequential batching of 3 with a 500 ms gap between batches keeps
  // the dyno breathing, and the try/finally fires PER REQUEST so a
  // single suburb timeout can never trap the whole load. Per-suburb
  // failures are counted, not raised — the table renders what
  // succeeded plus a "Loaded X / Y" badge for the rest.
  const activeKey = activeNames.join('|')
  useEffect(() => {
    if (!activeNames.length) {
      setListings([])
      setLoadProgress({ loaded: 0, total: 0 })
      setLoading(false)
      return
    }

    // Cache pass: stream-render whatever's already on disk for every
    // selected suburb. Treat any Array (including []) as a hit — empty
    // results ARE valid for suburbs the scraper hasn't touched yet.
    const cached = []
    let allHit = true
    for (const name of activeNames) {
      const c = readCache(RENTAL_CACHE_KEY(name))
      if (Array.isArray(c)) cached.push(...c)
      else allHit = false
    }
    try {
      console.log('[RentalView] cache READ', activeKey,
                  allHit ? `HIT (${cached.length} merged rows)` : 'MISS')
    } catch {}
    if (cached.length > 0 || allHit) {
      setListings(sortMerged(cached))
    }

    const controller = new AbortController()
    const signal = controller.signal
    if (!allHit) setLoading(true)
    setError('')
    setLoadProgress({ loaded: 0, total: activeNames.length })

    ;(async () => {
      const all = []
      const BATCH = 3
      const BATCH_PAUSE_MS = 500
      let loaded = 0
      try {
        for (let i = 0; i < activeNames.length; i += BATCH) {
          if (signal.aborted) return
          const slice = activeNames.slice(i, i + BATCH)
          // Inside each batch we can run in parallel — 3 concurrent
          // requests is well within Render's comfort zone even mid-
          // cold-start. The pause between batches is what matters.
          const settled = await Promise.allSettled(
            slice.map(n => fetchOne(n, signal))
          )
          if (signal.aborted) return
          for (let j = 0; j < settled.length; j++) {
            const r = settled[j]
            if (r.status === 'fulfilled') {
              all.push(...r.value)
              loaded += 1
            } else {
              // Don't bubble — log + skip so one bad suburb doesn't
              // sink the whole table. AbortError is silent (it's a
              // cancel, not a failure).
              const err = r.reason
              if (err && err.name !== 'AbortError') {
                console.warn('[RentalView] suburb fetch failed:',
                             slice[j], err.message || err)
              }
            }
          }
          setLoadProgress({ loaded, total: activeNames.length })
          // Live-update the table on each batch so the operator sees
          // rows stream in instead of waiting for the full set.
          setListings(sortMerged(all))
          // Clear the visible spinner as soon as the FIRST batch
          // returns ANY rows — the remaining batches keep loading
          // silently in the background. Avoids the "stare at a
          // spinner while 12 more suburbs trickle in" UX.
          if (loaded > 0 && !signal.aborted) setLoading(false)
          if (i + BATCH < activeNames.length) {
            await new Promise(r => setTimeout(r, BATCH_PAUSE_MS))
          }
        }
        if (loaded === 0 && activeNames.length > 0) {
          setError('All suburb fetches failed — check connection and retry.')
        }
      } finally {
        // ALWAYS clear the spinner — even on abort, mid-batch error,
        // or empty result. This is the bug that produced the
        // "spinner infini" report.
        if (!signal.aborted) setLoading(false)
      }
    })()

    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, fetchOne])

  const patchOwner = useCallback(async (row, field, value) => {
    // Send ONLY the field that changed — backend rental_api's PATCH
    // route is now partial-body aware (key-presence drives the SET
    // list). The previous "send-all-3-fields" pattern raced: a fast
    // tab from owner_name to owner_phone made the phone PATCH carry
    // a stale owner_name back to the server.
    await apiJson('/api/rentals/owner', {
      method: 'PATCH',
      body: JSON.stringify({
        address: row.address,
        suburb: row.suburb,
        [field]: value,
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

  // Build the two dropdowns from the already-loaded data — no extra
  // API call. Agents are filtered by selectedAgency so the dropdown
  // stays manageable on suburbs with 20+ agencies.
  const uniqueAgencies = useMemo(
    () => [...new Set(listings.map(r => r.agency).filter(Boolean))].sort(),
    [listings]
  )
  const uniqueAgents = useMemo(() => {
    const pool = selectedAgency
      ? listings.filter(r => r.agency === selectedAgency)
      : listings
    return [...new Set(pool.map(r => r.agent).filter(Boolean))].sort()
  }, [listings, selectedAgency])

  const filteredBase = useMemo(() => {
    return listings.filter(r => {
      const isLeased = r.status === 'Leased'
      if (isLeased && !showLeased) return false
      if (!isLeased && !showAvailable) return false
      if (selectedAgency && r.agency !== selectedAgency) return false
      if (selectedAgent && r.agent !== selectedAgent) return false
      return true
    })
  }, [listings, showAvailable, showLeased, selectedAgency, selectedAgent])

  // Click-to-sort table headers. Mirrors the ListingsView pattern
  // (useListings.js:125): same field toggles direction, new field
  // resets to the column's natural default ("desc" for dates / DOM /
  // price so the freshest / highest rows lead, "asc" for strings).
  const [sortField, setSortField] = useState('date_listed')
  const [sortDir, setSortDir] = useState('desc')
  const DESC_DEFAULT = new Set(['date_listed', 'days_on_market', 'price_week'])
  const toggleSort = useCallback((field) => {
    setSortField(prev => {
      if (prev === field) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        return prev
      }
      setSortDir(DESC_DEFAULT.has(field) ? 'desc' : 'asc')
      return field
    })
  }, [])

  const _priceToInt = (v) => {
    if (v == null) return 0
    const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10)
    return Number.isFinite(n) ? n : 0
  }

  const filtered = useMemo(() => {
    if (!sortField) return filteredBase
    const arr = [...filteredBase]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      let va, vb
      if (sortField === 'price_week') {
        va = _priceToInt(a.price_week); vb = _priceToInt(b.price_week)
      } else if (sortField === 'beds' || sortField === 'days_on_market') {
        va = Number(a[sortField] || 0); vb = Number(b[sortField] || 0)
      } else if (sortField === 'date_listed') {
        // ISO YYYY-MM-DD sorts lexicographically; empty pushed to end
        // when ascending, to top when descending — same convention as
        // ListingsView's listing_date sort.
        va = a.date_listed || ''; vb = b.date_listed || ''
      } else {
        va = (a[sortField] || '').toString().toLowerCase()
        vb = (b[sortField] || '').toString().toLowerCase()
      }
      if (va < vb) return -1 * dir
      if (va > vb) return 1 * dir
      return 0
    })
    return arr
  }, [filteredBase, sortField, sortDir])

  // Export Excel — multi-sheet workbook served from the rental_api
  // export route. Goes through BACKEND_DIRECT (Vercel proxy would
  // 504 on a 15-suburb workbook build during cold start). Streams
  // straight to disk via blob, no JSON round-trip.
  const [exporting, setExporting] = useState(false)
  const onExportExcel = async () => {
    if (exporting) return
    setExporting(true)
    setError('')
    try {
      // When exactly one suburb is selected we narrow the export to
      // that suburb; otherwise we export everything the user can see
      // (the backend re-resolves scope anyway, so this is just a UX
      // convenience, not an authz boundary).
      const qs = activeNames.length === 1
        ? `?suburb=${encodeURIComponent(activeNames[0])}`
        : ''
      const res = await fetch(`${BACKEND_DIRECT}/api/rentals/export${qs}`, {
        headers: { 'X-Access-Key': getAccessKey() || '' },
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.json()
          if (j && j.error) msg = j.error
        } catch {}
        throw new Error(msg)
      }
      const blob = await res.blob()
      // Pull the filename out of Content-Disposition so date / suburb
      // labelling matches the backend's choice.
      let filename = 'rental_export.xlsx'
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
    } catch (e) {
      setError(`Export failed: ${e.message}`)
    } finally {
      setExporting(false)
    }
  }

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
      // Prefer the backend's human summary — it distinguishes enriched
      // from out-of-scope suburbs skipped (a 26-sheet export imported into
      // 15 tracked suburbs should read as NORMAL, not an error). Fall back
      // to a computed line for older backends without `summary`.
      if (data.summary) {
        setImportMsg(data.summary)
      } else {
        const ins = data.inserted ?? data.imported ?? 0
        const enr = data.enriched ?? 0
        const sk = data.skipped ?? 0
        const subN = (data.suburbs || []).length
        setImportMsg(
          `${ins} listings added, ${enr} enriched across ${subN} suburb${subN !== 1 ? 's' : ''}`
          + (sk ? ` — ${sk} skipped` : '')
        )
      }
      // Refresh every currently-displayed suburb so freshly-imported
      // rows appear without a manual reload, regardless of whether
      // the operator is in single- or multi-suburb mode.
      if (activeNames.length) {
        try {
          // Use the same fetchOne primitive (no AbortSignal needed —
          // import refresh is a one-shot user action, not on a
          // suburb-switch race path). Promise.allSettled so a single
          // failed suburb doesn't sink the post-import refresh.
          const settled = await Promise.allSettled(
            activeNames.map(n => fetchOne(n))
          )
          const fresh = []
          for (const r of settled) {
            if (r.status === 'fulfilled') fresh.push(...r.value)
          }
          setListings(sortMerged(fresh))
        } catch (e) {
          setError(`Refresh failed after import: ${e.message}`)
        }
      }
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
  const pad = compact ? '3px 6px' : '8px 10px'
  const fontSize = compact ? 11.5 : 13

  // ── Desk redesign — the custom Rental grid mismapped fields (showed
  // "Total, …" aggregate rows + owner names under Rent). Disabled: desk
  // now falls through to the CLASSIC rental table below (correct data +
  // its own renderCell), styled by the [data-desk] .desk-rental veneer,
  // with the sidebar hidden. A faithful #rental rebuild will reuse that
  // table, not a hand-mapped grid. ──
  if (false && getDeskMode() === 'desk') {
    const rc = (s) => s === 'Active' ? 'var(--status-good)' : s === 'New' ? 'var(--status-info)' : s === 'Leased' ? 'var(--status-off)' : 'var(--status-watch)'
    const cfg = (r) => [r.beds, r.baths, r.cars].map(x => (x == null ? '–' : x)).join('·')
    const GRID = '1.5fr 120px 84px 66px 96px 1fr 46px'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ padding: '20px 30px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, marginBottom: 12 }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)', padding: '5px 18px' }}>Sales</span>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: '#fff', background: 'var(--accent)', borderRadius: 7, padding: '5px 18px' }}>Rental</span>
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 28, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Rental · lettings</h2>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>{filtered.length} listings · {suburbs.length} suburbs</div>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: '60%', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '9px 14px 9px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              <span>Address</span><span>Suburb</span><span style={{ textAlign: 'right' }}>Rent</span><span style={{ textAlign: 'center' }}>Bd·Ba·Cr</span><span>Available</span><span>Agency</span><span style={{ textAlign: 'right' }}>DOM</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading && filtered.length === 0 ? <div style={{ padding: 24, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Loading rentals…</div>
                : filtered.length === 0 ? <div style={{ padding: 24, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>No rental listings.</div>
                : filtered.map((r, i) => (
                  <div key={r.id ?? i} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', padding: '9px 14px 9px 12px', borderBottom: '1px solid var(--border)', borderLeft: `3px solid ${rc(r.status)}`, background: `color-mix(in srgb, ${rc(r.status)} 9%, var(--surface))` }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayAddress(r.address, r.suburb)}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.suburb || ''}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, textAlign: 'right', color: 'var(--text)' }}>{r.price_week ? `$${r.price_week}` : '—'}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>{cfg(r)}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{formatIsoDate(r.date_listed) || '–'}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.agency || '–'}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'right', color: 'var(--text-muted)' }}>{r.days_on_market ?? '–'}</span>
                  </div>
                ))}
            </div>
          </div>
          <div className="desk-map" style={{ flex: 1, borderRadius: 0, border: 'none', minHeight: 0 }}>
            <div className="desk-map-label">Rental map · {filtered.length} listings</div>
            {filtered.slice(0, 40).map((r, i) => { const s = String(r.address || i); let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 0xffff; return <span key={r.id ?? i} style={{ position: 'absolute', top: `${16 + (h % 66)}%`, left: `${12 + ((h >> 4) % 72)}%`, width: 11, height: 11, borderRadius: '50%', background: rc(r.status), border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.2)' }} /> })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Header band ------------------------------------------------ */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 16, marginBottom: 14, flexWrap: 'wrap',
      }}>
        <div>
          <h2 style={{
            margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)',
            letterSpacing: -0.3,
          }}>
            Rental{(() => {
              // Header reflects the multi-select state:
              //   1 name  → "Rental — Cottesloe"
              //   N names → "Rental — N suburbs"
              //   0       → just "Rental"
              if (activeNames.length === 1) {
                return <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> — {activeNames[0]}</span>
              }
              if (activeNames.length > 1) {
                return <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> — {activeNames.length} suburbs</span>
              }
              return ''
            })()}
          </h2>
          <div style={{
            marginTop: 6, fontSize: 12, color: 'var(--text-muted)',
            display: 'flex', gap: 14, flexWrap: 'wrap',
          }}>
            <span><strong style={{ color: 'var(--text)' }}>{counts.avail}</strong> for rent</span>
            <span style={{ color: 'var(--border)' }}>·</span>
            <span><strong style={{ color: 'var(--text)' }}>{counts.leased}</strong> leased</span>
            <span style={{ color: 'var(--border)' }}>·</span>
            <span><strong style={{ color: 'var(--text)' }}>{suburbs.length}</strong> suburb{suburbs.length !== 1 ? 's' : ''}</span>
            <span style={{ color: 'var(--border)' }}>·</span>
            {/* Legend for the Days badge — its meaning was colour-only. */}
            <span title="Days on market">
              Days: <span style={{ color: '#166534', fontWeight: 600 }}>≤14 fresh</span>{' '}
              <span style={{ color: '#9a3412', fontWeight: 600 }}>≤30 warming</span>{' '}
              <span style={{ color: '#991b1b', fontWeight: 600 }}>30+ stale</span>
            </span>
            {/* Show "Loaded X / Y" only when a multi-suburb load is in
                flight OR when fewer suburbs succeeded than were
                requested (partial-failure visibility). */}
            {loadProgress.total > 1 && (loading || loadProgress.loaded < loadProgress.total) && (
              <>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span style={{
                  color: loadProgress.loaded < loadProgress.total && !loading ? '#b45309' : 'var(--text-muted)',
                }}>
                  Loaded <strong style={{ color: 'var(--text)' }}>{loadProgress.loaded}</strong> / {loadProgress.total} suburbs
                </span>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Standalone-mount fallback dropdown — hidden when the
              parent (App.jsx sidebar) controls the selection. */}
          {!controlled && (
            <select
              value={internalSuburb}
              onChange={(e) => setInternalSuburb(e.target.value)}
              style={{
                padding: '7px 10px', fontSize: 13,
                border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
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
            colorOn="var(--text-muted)" bgOn="var(--border)"
          />
          <select
            value={selectedAgency}
            onChange={(e) => setSelectedAgency(e.target.value)}
            title={selectedAgency || 'Filter by agency'}
            style={{
              padding: '6px 8px', fontSize: 12, maxWidth: 160,
              border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
            }}
          >
            <option value="">All Agencies</option>
            {uniqueAgencies.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            title={selectedAgent || 'Filter by agent'}
            style={{
              padding: '6px 8px', fontSize: 12, maxWidth: 160,
              border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
            }}
          >
            <option value="">All Agents</option>
            {uniqueAgents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button
            type="button"
            onClick={() => setCompact(c => !c)}
            title="Toggle compact density"
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              background: compact ? 'var(--text)' : 'var(--surface)',
              color: compact ? 'white' : 'var(--text)',
              border: '1px solid var(--text)',
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
            onClick={onExportExcel}
            disabled={exporting || activeNames.length === 0}
            title={activeNames.length === 0
              ? 'Select at least one suburb in the sidebar'
              : (activeNames.length === 1
                  ? `Export ${activeNames[0]} as .xlsx`
                  : `Export all ${activeNames.length} selected suburbs`)}
            style={{
              padding: '7px 14px', fontSize: 13, fontWeight: 600,
              background: (exporting || activeNames.length === 0)
                ? 'var(--text-faint)' : '#0f766e',
              color: 'var(--surface)', border: 'none', borderRadius: 6,
              cursor: (exporting || activeNames.length === 0)
                ? 'not-allowed' : 'pointer',
            }}
          >
            {exporting ? '⏳ Exporting…' : '⬇ Export Excel'}
          </button>
          <button
            type="button"
            onClick={onImportClick}
            disabled={importing}
            style={{
              padding: '7px 14px', fontSize: 13, fontWeight: 600,
              background: importing ? 'var(--text-faint)' : 'var(--accent)',
              color: 'var(--surface)', border: 'none', borderRadius: 6,
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
        border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="desk-rental" style={{
            width: '100%', borderCollapse: 'collapse', fontSize,
            background: 'var(--surface)', tableLayout: 'fixed',
          }}>
            {/* Explicit column widths so long agency / agent strings
                truncate with ellipsis instead of pushing Notes off-
                screen. tableLayout:'fixed' makes the browser honour
                them. */}
            <colgroup>
              {COLS.map(c => (
                <col key={c.key} style={{ width: c.width ? `${c.width}px` : 'auto' }} />
              ))}
            </colgroup>
            <thead>
              <tr style={{ background: 'var(--accent)' }}>
                {COLS.map(c => {
                  const isSorted = c.sortable && sortField === c.key
                  return (
                    <th
                      key={c.key}
                      onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                      style={{
                        textAlign: c.num ? 'center' : 'left',
                        padding: compact ? '5px 6px' : '10px 10px',
                        fontWeight: 600, fontSize: 10.5,
                        color: isSorted ? 'var(--accent-fg)' : 'rgba(255,255,255,.72)',
                        textTransform: 'uppercase', letterSpacing: 0.6,
                        whiteSpace: 'nowrap',
                        cursor: c.sortable ? 'pointer' : 'default',
                        userSelect: 'none',
                      }}
                      title={c.sortable ? 'Click to sort' : undefined}
                    >
                      {c.label}
                      {c.sortable && (
                        <span style={{
                          marginLeft: 4,
                          color: isSorted ? 'var(--accent-fg)' : 'rgba(255,255,255,.5)',
                          opacity: isSorted ? 1 : 0.5,
                        }}>
                          {isSorted ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows count={5} />
              ) : !filtered.length ? (
                <tr>
                  <td colSpan={COLS.length} style={{
                    padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)',
                  }}>
                    <div style={{ fontSize: 36, marginBottom: 8, lineHeight: 1 }}>🏠</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                      No rental listings for this suburb
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      {listings.length > 0
                        ? 'Adjust the status filters above to see the other rows.'
                        : activeNames.length
                          ? "Tonight's scrape will load them, or import an Excel file."
                          : 'Select a suburb to view listings.'}
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((r, idx) => {
                  const zebra = idx % 2 === 1 ? 'var(--bg)' : 'var(--surface)'
                  return (
                    <tr
                      key={`${r.suburb}|${r.address}`}
                      style={{ borderBottom: '1px solid var(--border)', background: zebra }}
                    >
                      {COLS.map(c => {
                        const ownerTint = c.owner ? '#fefce8' : undefined
                        const truncate = c.truncate
                        const cellStyle = {
                          padding: pad,
                          verticalAlign: 'middle',
                          background: ownerTint,
                          textAlign: c.num ? 'center' : 'left',
                          color: c.bold ? 'var(--text)' : 'var(--text)',
                          fontWeight: c.bold ? 600 : 400,
                          whiteSpace: (c.key === 'address' || c.key === 'notes') ? 'normal' : 'nowrap',
                          overflow: truncate ? 'hidden' : 'visible',
                          textOverflow: truncate ? 'ellipsis' : 'clip',
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
                          if (!r.url) return <td key={c.key} style={{ ...cellStyle, color: 'var(--border)' }}>—</td>
                          return (
                            <td key={c.key} style={cellStyle}>
                              <a
                                href={r.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open on REIWA"
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  color: 'var(--accent)', fontWeight: 600, textDecoration: 'none',
                                  fontSize: 12,
                                }}
                              >
                                REIWA <span aria-hidden="true">↗</span>
                              </a>
                            </td>
                          )
                        }
                        if (c.key === 'address') {
                          // Uniform "address, suburb" everywhere (dedup'd).
                          const shown = displayAddress(r.address, r.suburb)
                          return (
                            <td key={c.key} style={cellStyle}
                                title={truncate ? shown : undefined}>
                              {shown || '—'}
                            </td>
                          )
                        }
                        // Date columns flagged via COLS.date — render
                        // as DD/MM/YYYY (AU format) using the same
                        // formatIsoDate helper the Listings view uses.
                        const raw = r[c.key]
                        const cellValue = raw
                          ? (c.date ? (formatIsoDate(raw) || raw) : raw)
                          : '—'
                        return (
                          <td
                            key={c.key}
                            style={cellStyle}
                            title={truncate && r[c.key] ? r[c.key] : undefined}
                          >{cellValue}</td>
                        )
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


function PillToggle({ on, onClick, label, colorOn = 'var(--accent)', bgOn = '#d1fae5' }) {
  // Match the sales filter-btn look (rounded rect, soft fill when
  // active, outline when off) without pulling in the global CSS class —
  // keeps RentalView self-contained for now.
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px', fontSize: 12, fontWeight: 600,
        border: `1px solid ${on ? colorOn : 'var(--border)'}`,
        background: on ? bgOn : 'var(--surface)',
        color: on ? colorOn : 'var(--text-muted)',
        borderRadius: 999, cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

// Listings table + filter bar — extracted from App.jsx to keep modules
// under the MCP push size limit. State stays in App.jsx; this is a
// presentational component that takes everything via props.

import { useState, useRef, useEffect } from 'react'
import { StickyNote, Plus, X, ExternalLink } from 'lucide-react'
import EditableDateCell from '../components/EditableDateCell'
import EditableTextCell from '../components/EditableTextCell'
import StickyHScroll from '../components/StickyHScroll'
import DeskMap from '../components/DeskMap'
import { Chip, Select } from '../components/ui'
import PropertyDetail from './PropertyDetail'
import { getDeskMode } from '../lib/deskFlag'


// HTML5 date input emits YYYY-MM-DD. listing_date in the DB is
// DD/MM/YYYY, the rest are stored as ISO. Convert at the boundary.
function isoToDmy(iso) {
  if (!iso) return null
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
}

// Human labels for the status Chip. The Chip itself picks the colour
// via resolveStatus (active→good, under_offer→watch, sold→info,
// withdrawn→alert) so a screen can never invent one.
const STATUS_LABEL = {
  active: 'Active',
  under_offer: 'Under Offer',
  sold: 'Sold',
  withdrawn: 'Withdrawn',
}

// AA-safe label colour for the ACTIVE filter buttons — the strong tones
// (statusColors) stay on border + tint, but at 11px on their own 20%
// tint they sit at 2.6-3.9:1. The darker -text tokens pass 4.5:1.
const STATUS_TEXT = {
  active: 'var(--status-active-text)',
  under_offer: 'var(--status-under-offer-text)',
  sold: 'var(--status-sold-text)',
  withdrawn: 'var(--status-withdrawn-text)',
}


export default function ListingsView({
  selectedStatuses, toggleStatus, statusColors,
  selectedAgency, setSelectedAgency, uniqueAgencies,
  selectedAgent, setSelectedAgent, uniqueAgents,
  filteredListings, allListings, suburbs, checkedSuburbs,
  toggleCheckSuburb, selectAllCheck, deselectAllCheck,
  sortField, sortDir, toggleSort,
  calcDOM, formatIsoDate, deleteListing, updateListing, mirrorListing,
  bootLoading, onNavigate, hasRental = false,
}) {
  // Note editor state — `editing` holds the listing whose note we're
  // editing (or null). PATCH writes to listing_notes keyed on the
  // normalised address so the note follows the property across re-
  // listings (REIWA reposting a withdrawn property → new id, same address).
  const [noteEditing, setNoteEditing] = useState(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  // Desk mode: clicking an address opens the internal property dossier
  // (mock 03) instead of linking out to REIWA. Classic keeps the link.
  const [detail, setDetail] = useState(null)
  const isDesk = getDeskMode() === 'desk'
  // Desk suburb multiselect — stays open while toggling (closes only on
  // outside click), so the operator can add/remove several without
  // reopening it each time.
  const [subPickerOpen, setSubPickerOpen] = useState(false)
  // Collapsible lateral map — persisted; hiding it gives the table the
  // full width (Status/Listed/DOM columns fit without horizontal scroll).
  const [mapOpen, setMapOpen] = useState(() => {
    try { return localStorage.getItem('listings_map_open') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('listings_map_open', mapOpen ? '1' : '0') } catch { /* ignore */ }
  }, [mapOpen])
  // Draggable table|map divider — the fraction of width given to the
  // TABLE (0.40–0.94). Persisted, so the operator sets it once and the
  // Listed/DOM columns stay in view. Default leans table-heavy.
  const splitRef = useRef(null)
  const [tableSplit, setTableSplit] = useState(() => {
    try { const v = parseFloat(localStorage.getItem('listings_table_split') || '0.72'); return (v >= 0.4 && v <= 0.94) ? v : 0.72 } catch { return 0.72 }
  })
  const tableSplitRef = useRef(tableSplit)
  useEffect(() => { tableSplitRef.current = tableSplit }, [tableSplit])
  const [splitHover, setSplitHover] = useState(false)
  const startSplitResize = (e) => {
    e.preventDefault()
    const onMove = (ev) => {
      const el = splitRef.current; if (!el) return
      const r = el.getBoundingClientRect()
      if (!r.width) return
      const frac = Math.max(0.4, Math.min(0.94, (ev.clientX - r.left) / r.width))
      setTableSplit(frac)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem('listings_table_split', String(tableSplitRef.current)) } catch {}
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const subPickerRef = useRef(null)
  useEffect(() => {
    if (!subPickerOpen) return
    const h = (e) => { if (subPickerRef.current && !subPickerRef.current.contains(e.target)) setSubPickerOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [subPickerOpen])
  const wrapperRef = useRef(null)
  // Compact mode defaults ON for first-time visitors (denser table fits
  // more on a laptop screen). User toggles persist after that.
  const [compact, setCompact] = useState(() => {
    try {
      const v = localStorage.getItem('listings_compact')
      return v === null ? true : v === '1'
    } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('listings_compact', compact ? '1' : '0') } catch {}
  }, [compact])

  // Resizable Price column — default tight, drag the right edge of the
  // header to widen when reading a long price string. Persisted across
  // reloads so the agent's preferred width sticks.
  const [priceWidth, setPriceWidth] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem('listings_price_width') || '100', 10)
      return Number.isFinite(saved) && saved > 40 ? saved : 100
    } catch { return 100 }
  })
  const priceWidthRef = useRef(priceWidth)
  useEffect(() => { priceWidthRef.current = priceWidth }, [priceWidth])

  const startPriceResize = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = priceWidthRef.current
    const onMove = (ev) => {
      const next = Math.max(60, Math.min(600, startW + (ev.clientX - startX)))
      setPriceWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
      try { localStorage.setItem('listings_price_width', String(priceWidthRef.current)) } catch {}
    }
    document.body.classList.add('col-resizing')
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const openNote = (l) => {
    setNoteEditing(l)
    setNoteDraft(l.note || '')
  }
  const closeNote = () => {
    setNoteEditing(null)
    setNoteDraft('')
  }
  const saveNote = () => {
    if (!noteEditing || noteSaving) return
    // Optimistic: close + mirror locally immediately so the UI feels
    // instant. The Render free tier cold-start can take 30-60s — we
    // don't make the agent wait. Revert + alert if the request fails.
    // noteSaving guards against a double-click landing two PATCHes
    // before closeNote() unmounts the modal.
    setNoteSaving(true)
    const target = noteEditing
    const previous = target.note || null
    const draft = noteDraft.trim() || null
    mirrorListing(target.id, { note: draft })
    closeNote()
    fetch('/api/listings/note', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: target.address, note: noteDraft }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || `Save failed (${res.status})`)
        }
      })
      .catch((e) => {
        mirrorListing(target.id, { note: previous })
        // Name the property in the alert — the modal already closed
        // (optimistic), so without the address the agent can't tell
        // which note failed to save (D17: "alerte tardive sans contexte").
        alert(`Could not save note for ${target.address}: ${e.message}`)
      })
      .finally(() => setNoteSaving(false))
  }

  // Hide Suburb when the filter is on a single suburb — every row
  // would carry the same value, the column adds clutter without info.
  // Internal size and Type stay always-visible: the agent uses them
  // to spot land vs house vs apartment differences at a glance.
  const showSuburb = filteredListings.length > 0
    && !filteredListings.every(l => l.suburb_name === filteredListings[0].suburb_name)
  // Internal size is blank for most REIWA listings — when NO row in the
  // current set has it, the column is pure dead width; drop it so the
  // meaningful columns (Listed/DOM/Status) fit without scrolling.
  const showInternal = filteredListings.some(l => l.internal_size)

  // Smart column visibility — hide a date column when BOTH:
  //   (a) the filter excludes its status (e.g. Withdrawn off), AND
  //   (b) no row in the current filtered set has that date
  //       (so a stray sold_date on an Under Offer row still shows).
  // ALL = empty filter = show every column that has data.
  const filterAll = selectedStatuses.size === 0
  const anyListing = filteredListings.some(l => l.listing_date)
  const anySold = filteredListings.some(l => l.sold_date)
  const anyWithdrawn = filteredListings.some(l => l.withdrawn_date)

  const showListed = anyListing || selectedStatuses.has('active') || selectedStatuses.has('under_offer')
  const showDom = showListed
  const showSold = anySold || selectedStatuses.has('sold')
  const showWithdrawn = anyWithdrawn || selectedStatuses.has('withdrawn')

  // DISPLAY ONLY — never mutates the scraped address (l.address is used
  // verbatim for sorting, export, letters, dossier, and geocoding; the
  // full address is always on hover). When every visible row is the same
  // suburb, we merely hide the redundant ", Claremont WA 6010" tail.
  // Anchored on the COMMA + suburb so a street that contains the suburb
  // word ("5 Claremont Street, Claremont") is never truncated wrongly.
  const displayAddr = (l) => {
    const a = String(l.address || '')
    if (showSuburb || !l.suburb_name) return a
    const sub = String(l.suburb_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const out = a.replace(new RegExp(`\\s*,\\s*${sub}\\b.*$`, 'i'), '').trim()
    return out || a   // never return empty
  }

  // Column definitions — header + body render from the same list.
  // `cell(row)` returns the cell content; the <td> wrapper is added
  // here so the key + className stay in one place.
  const columns = [
    { field: 'address', label: 'Address', sortable: true, className: 'address-cell',
      cell: (l) => isDesk
        ? <a href={l.reiwa_url || '#'} onClick={(e) => { e.preventDefault(); setDetail(l) }}
             style={{ cursor: 'pointer' }} title={l.address}>{displayAddr(l)}</a>
        : (l.reiwa_url
            ? <a href={l.reiwa_url} target="_blank" rel="noopener" title={l.address}>{displayAddr(l)}</a>
            : l.address) },
    { field: '__note', label: 'Note', sortable: false, className: 'note-cell',
      style: isDesk ? { maxWidth: 130 } : undefined,
      cell: (l) => {
        const text = (l.note || '').trim()
        const has = !!text
        return (
          <button
            className={`btn-note ${has ? 'has-note' : 'empty-note'}`}
            title={has ? text : 'Click to add a note about this listing'}
            onClick={() => openNote(l)}
          >
            {has
              ? <><StickyNote size={13} strokeWidth={2} aria-hidden="true" style={{ verticalAlign: 'text-bottom' }} />&nbsp;{text}</>
              : <><Plus size={13} strokeWidth={2} aria-hidden="true" style={{ verticalAlign: 'text-bottom' }} />&nbsp;Note</>}
          </button>
        )
      } },
    showSuburb && { field: 'suburb_name', label: 'Suburb', sortable: true,
      cell: (l) => l.suburb_name },
    { field: 'price_text', label: 'Price', sortable: true, className: 'price-cell resizable-cell',
      style: { width: priceWidth, minWidth: priceWidth, maxWidth: priceWidth },
      headerExtra: (
        <span
          className="col-resize-handle"
          onMouseDown={startPriceResize}
          onClick={(e) => e.stopPropagation()}
          title="Drag to resize"
        />
      ),
      cell: (l) => (
        <EditableTextCell
          value={l.price_text}
          placeholder="+ add price"
          onSave={(val) => updateListing(l.id, { price_text: val })}
        />
      ) },
    // Desk mode merges Bed/Bath/Car into one column (3 columns' worth of
    // width was the single biggest reason Listed/DOM needed a horizontal
    // scroll to reach) — classic keeps them separate + individually sortable.
    !isDesk && { field: 'bedrooms', label: 'Bed', sortable: true, className: 'num',
      cell: (l) => l.bedrooms ?? '-' },
    !isDesk && { field: 'bathrooms', label: 'Bath', sortable: true, className: 'num',
      cell: (l) => l.bathrooms ?? '-' },
    !isDesk && { field: 'parking', label: 'Car', sortable: true, className: 'num',
      cell: (l) => l.parking ?? '-' },
    isDesk && { field: '__bbc', label: 'Bd·Ba·Cr', sortable: false, className: 'num',
      cell: (l) => [l.bedrooms, l.bathrooms, l.parking].map(x => x ?? '–').join('·') },
    { field: 'land_size', label: 'Land', sortable: true,
      cell: (l) => l.land_size || '-' },
    showInternal && { field: 'internal_size', label: isDesk ? 'Int.' : 'Internal', sortable: true,
      cell: (l) => l.internal_size || '-' },
    { field: 'agency', label: 'Agency', sortable: true, className: 'agency-cell',
      cell: (l) => l.agency || '-' },
    { field: 'agent', label: 'Agent', sortable: true, className: 'agent-cell',
      style: isDesk ? { maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined,
      cell: (l) => l.agent || '-' },
    showListed && { field: 'listing_date', label: 'Listed', sortable: true, className: 'date-cell',
      cell: (l) => (
        <EditableDateCell
          value={l.listing_date}
          onSave={(iso) => updateListing(l.id, { listing_date: isoToDmy(iso) })}
        />
      ) },
    showDom && { field: 'dom', label: 'DOM', sortable: true, className: 'num',
      cellClass: (l) => `num ${(calcDOM(l) ?? 0) >= 60 ? 'stale' : ''}`,
      cell: (l) => {
        const d = calcDOM(l)
        return (
          <>
            {d != null ? d : '-'}
            {(d ?? 0) >= 60 && <span className="stale-flag" title="60+ days on market — potential lead">!</span>}
          </>
        )
      } },
    showWithdrawn && { field: 'withdrawn_date', label: 'Withdrawn', sortable: true, className: 'date-cell',
      cell: (l) => (
        <EditableDateCell
          value={l.withdrawn_date}
          onSave={(iso) => updateListing(l.id, { withdrawn_date: iso })}
        />
      ) },
    showSold && { field: 'sold_date', label: 'Sold', sortable: true, className: 'date-cell',
      cell: (l) => (
        <EditableDateCell
          value={l.sold_date}
          onSave={(iso) => updateListing(l.id, { sold_date: iso })}
        />
      ) },
    { field: 'status', label: 'Status', sortable: true,
      cell: (l) => (
        <Chip status={l.status}>
          {STATUS_LABEL[l.status] || (l.status || '').replace('_', ' ')}
        </Chip>
      ) },
    { field: 'listing_type', label: 'Type', sortable: true,
      cell: (l) => l.listing_type
        ? <span className="type-pill">{l.listing_type}</span>
        : '-' },
    // REIWA link on every row so the agent can open the live listing straight
    // from the table without going through the dossier popup. Icon-only in
    // desk (saves width), "View" text in classic.
    { field: '__link', label: isDesk ? '' : 'Link', sortable: false, className: 'link-cell',
      cell: (l) => l.reiwa_url
        ? (isDesk
            ? <a href={l.reiwa_url} target="_blank" rel="noopener" title="Open on REIWA" aria-label="Open on REIWA" style={{ display: 'inline-flex', alignItems: 'center' }}><ExternalLink size={14} strokeWidth={2.25} aria-hidden="true" /></a>
            : <a href={l.reiwa_url} target="_blank" rel="noopener">View</a>)
        : (isDesk ? '' : '-') },
    { field: '__del', label: '', sortable: false, className: 'link-cell',
      cell: (l) => (
        <button className="btn-delete-row" title={`Delete this ${l.status} listing`} onClick={() => deleteListing(l)}>
          <X size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ) },
  ].filter(Boolean)

  // Suburbs currently in scope (for the desk-mode context line). Falls
  // back to the total when nothing is explicitly checked (= all shown).
  // Explicit selection: the Set holds exactly the suburbs shown.
  const scopeCount = checkedSuburbs.size

  // ── Desk redesign — full, clean render of mock #prospecting. Separate
  // from classic (returned below) so nothing old bleeds through. ──
  if (isDesk) {
    const ST = { active: 'good', under_offer: 'watch', sold: 'info', withdrawn: 'alert' }
    const stColor = (s) => `var(--status-${ST[s] || 'off'})`
    const cfg = (l) => [l.bedrooms, l.bathrooms, l.parking].map(x => (x == null ? '–' : x)).join('·')
    const GRID = '1.55fr 78px 92px 66px 58px 1fr 92px 74px 46px'
    const HEADERS = [
      { l: 'Address', f: 'address' }, { l: 'Suburb', f: 'suburb_name' },
      { l: 'Price', f: 'price_text', a: 'right' }, { l: 'Bd·Ba·Cr', a: 'center' },
      { l: 'Land', f: 'land_size', a: 'right' }, { l: 'Agency', f: 'agency' },
      { l: 'Agent', f: 'agent' }, { l: 'Listed', f: 'listing_date' }, { l: 'DOM', f: 'dom', a: 'right' },
    ]
    // c = strong tone (dot, active border) · t/bg = AA text/background
    // pair from tokens.css. No hardcoded hex (tokens.css rule).
    const STATUS_PILLS = [
      { k: 'active', l: 'Active', c: 'var(--status-good)', t: 'var(--status-good-text)', bg: 'var(--status-good-bg)' },
      { k: 'under_offer', l: 'Under Offer', c: 'var(--status-watch)', t: 'var(--status-watch-text)', bg: 'var(--status-watch-bg)' },
      { k: 'sold', l: 'Sold', c: 'var(--status-info)', t: 'var(--status-info-text)', bg: 'var(--status-info-bg)' },
      { k: 'withdrawn', l: 'Withdrawn', c: 'var(--status-alert)', t: 'var(--status-alert-text)', bg: 'var(--status-alert-bg)' },
    ]
    // Per-status totals for the current suburb scope, summed from the
    // suburb rows (active_count / under_offer_count / …) — same source as
    // the classic sidebar counters. Independent of the status filter, so
    // the operator always sees the full breakdown.
    const scopeSubs = suburbs.filter(s => checkedSuburbs.has(s.id))
    const statusCounts = {
      active: scopeSubs.reduce((n, s) => n + (s.active_count || 0), 0),
      under_offer: scopeSubs.reduce((n, s) => n + (s.under_offer_count || 0), 0),
      sold: scopeSubs.reduce((n, s) => n + (s.sold_count || 0), 0),
      withdrawn: scopeSubs.reduce((n, s) => n + (s.withdrawn_count || 0), 0),
    }
    // Compact density: tighter rows + font so more fit without scrolling.
    const rowPad = compact ? '5px 14px 5px 12px' : '9px 14px 9px 12px'
    const rowFs = compact ? 11.5 : 12
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* header + filters */}
        <div style={{ padding: compact ? '16px 30px 12px' : '22px 30px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, marginBottom: 12 }}>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: '#fff', background: 'var(--accent)', borderRadius: 7, padding: '5px 18px' }}>Sales</span>
                {hasRental ? (
                  <button type="button" onClick={() => onNavigate && onNavigate('rentals')}
                    style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)', padding: '5px 18px', background: 'transparent', border: 'none', borderRadius: 7, cursor: 'pointer' }}
                    title="Switch to Rental">
                    Rental
                  </button>
                ) : (
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)', padding: '5px 14px', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    Rental <span title="Rental is not enabled on your account — ask your admin to switch it on" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.08em', background: 'var(--status-off-bg)', color: 'var(--status-off-text)', borderRadius: 4, padding: '1px 5px', cursor: 'help' }}>ASK ADMIN</span>
                  </span>
                )}
              </div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Prospecting · Sales</h2>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
                {filteredListings.length} results · {scopeCount} suburbs{selectedAgency ? ` · ${selectedAgency}` : ''} · {compact ? 'compact' : 'comfortable'} view
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setMapOpen(m => !m)} title={mapOpen ? 'Hide the map — more room for columns' : 'Show the map'}
              style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: mapOpen ? 'var(--accent)' : 'var(--text)', border: `1px solid ${mapOpen ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, padding: '7px 13px', background: 'var(--surface)', cursor: 'pointer' }}>
              {mapOpen ? 'Map ⇥' : '⇤ Map'}
            </button>
            <button onClick={() => setCompact(c => !c)} title="Toggle density"
              style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 13px', background: 'var(--surface)', cursor: 'pointer' }}>
              {compact ? 'Compact' : 'Comfortable'}
            </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {suburbs.filter(s => checkedSuburbs.has(s.id)).slice(0, 8).map(s => (
              <button key={s.id} type="button" onClick={() => toggleCheckSuburb && toggleCheckSuburb(s.id)} title={`Remove ${s.name}`}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--accent-soft)' }}
                style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent-soft)', borderRadius: 999, padding: '6px 12px' }}>
                {s.name} <span style={{ opacity: 0.6 }}>×</span>
              </button>
            ))}
            {checkedSuburbs.size > 8 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', border: '1px dashed var(--border)', borderRadius: 999, padding: '6px 12px' }}>+ {checkedSuburbs.size - 8} more</span>}
            {suburbs.length > 0 && toggleCheckSuburb && (
              <div ref={subPickerRef} style={{ position: 'relative', order: -1 }}>
                <button type="button" onClick={() => setSubPickerOpen(o => !o)} title="Add or remove suburbs"
                  style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500, color: subPickerOpen ? 'var(--accent)' : 'var(--text-muted)', border: `1px dashed ${subPickerOpen ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 999, padding: '6px 12px', background: 'var(--surface)', cursor: 'pointer' }}>
                  + suburb ▾
                </button>
                {subPickerOpen && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-pop)', padding: 6, minWidth: 210, maxHeight: 340, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', gap: 6, padding: '4px 6px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
                      <button type="button" onClick={() => selectAllCheck && selectAllCheck()} style={{ flex: 1, fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', background: 'var(--accent-soft)', border: 'none', borderRadius: 6, padding: '5px 0', cursor: 'pointer' }}>All</button>
                      <button type="button" onClick={() => deselectAllCheck && deselectAllCheck()} style={{ flex: 1, fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 0', cursor: 'pointer' }}>Clear</button>
                    </div>
                    {suburbs.map(s => {
                      const on = checkedSuburbs.has(s.id)
                      return (
                        <button key={s.id} type="button" onClick={() => toggleCheckSuburb(s.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <span style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'transparent', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{on ? '✓' : ''}</span>
                          {s.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />
            {STATUS_PILLS.map(p => {
              const on = selectedStatuses.has(p.k)
              return (
                <button key={p.k} type="button" onClick={() => toggleStatus(p.k)}
                  onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--surface-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = on ? p.bg : 'transparent' }}
                  style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', borderRadius: 999, padding: '6px 13px', background: on ? p.bg : 'transparent', color: on ? p.t : 'var(--text-muted)', border: `1px solid ${on ? p.c : 'var(--border)'}` }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.c }} />{p.l}
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: 0 }}>{statusCounts[p.k]}</span>
                </button>
              )
            })}
            <Select size="sm" value={selectedAgency} onChange={e => setSelectedAgency(e.target.value)}
              options={[{ value: '', label: 'All Agencies' }, ...uniqueAgencies.map(a => ({ value: a, label: a }))]} />
            <Select size="sm" value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)}
              options={[{ value: '', label: 'All Agents' }, ...uniqueAgents.map(a => ({ value: a, label: a }))]} />
          </div>
        </div>

        {/* split: table | draggable divider | map */}
        <div ref={splitRef} style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: mapOpen ? `${(tableSplit * 100).toFixed(1)}%` : '100%', minWidth: 0, borderRight: mapOpen ? '1px solid var(--border)' : 'none', display: 'flex', flexDirection: 'column' }}>
            {/* Full classic table — all columns + editable price/dates +
                note + external link + delete — styled editorially by the
                [data-desk] CSS. Horizontal scroll via StickyHScroll keeps
                every column reachable. */}
            <div className={`table-wrapper listings-table-wrapper ${compact ? 'compact' : ''}`} ref={wrapperRef}
              style={{ flex: 1, minHeight: 0, maxHeight: 'none', border: 'none', borderRadius: 0 }}>
              <table className="listings-table">
                <thead>
                  <tr>
                    {columns.map(c => (
                      <th key={c.field} onClick={c.sortable ? () => toggleSort(c.field) : undefined}
                        className={[c.sortable && 'sortable', c.className].filter(Boolean).join(' ') || undefined} style={c.style}>
                        {c.label}{c.sortable && sortField === c.field && (sortDir === 'asc' ? ' ↑' : ' ↓')}{c.headerExtra}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredListings.map(l => (
                    <tr key={l.id ?? `row-${l.address}-${l.suburb_name}`} className={`status-${l.status}`}>
                      {columns.map(c => {
                        const cls = c.cellClass ? c.cellClass(l) : c.className
                        return <td key={c.field} className={cls} style={c.style}>{c.cell(l)}</td>
                      })}
                    </tr>
                  ))}
                  {filteredListings.length === 0 && bootLoading && (
                    <tr><td colSpan={columns.length} className="loading-cell"><div className="loading-stack"><div className="loading-spinner" /><div className="loading-title">Loading listings…</div><div className="loading-sub">First load can take 15–30 seconds while the server warms up.</div></div></td></tr>
                  )}
                  {filteredListings.length === 0 && !bootLoading && (
                    <tr><td colSpan={columns.length} className="empty">{suburbs.length === 0 ? 'Add a suburb to get started' : 'No listings match the current filters.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <StickyHScroll targetRef={wrapperRef} />
          </div>
          {/* draggable divider — set exactly how much room the map gets */}
          {mapOpen && (
            <div
              onMouseDown={startSplitResize}
              onMouseEnter={() => setSplitHover(true)}
              onMouseLeave={() => setSplitHover(false)}
              title="Drag to resize the map"
              style={{ width: 10, flexShrink: 0, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', background: (splitHover ? 'var(--surface-hover)' : 'transparent') }}>
              <div style={{ width: 4, height: 42, borderRadius: 999, background: splitHover ? 'var(--accent)' : 'var(--border)' }} />
            </div>
          )}
          {/* real map — MapLibre + free OSM tiles, exact per-address pins.
              Collapsible + resizable: at laptop widths the map was hiding
              key columns (Status/Listed/DOM), so the agent trades room via
              the divider or hides it entirely. */}
          {mapOpen && (
            <div style={{ width: `${((1 - tableSplit) * 100).toFixed(1)}%`, minWidth: 0, minHeight: 0 }}>
              <DeskMap items={filteredListings} label={`Perth metro · ${filteredListings.length} listings`}
                domOf={(l) => calcDOM(l)} onSelect={(l) => setDetail(l)} />
            </div>
          )}
        </div>

        {detail && <PropertyDetail listing={detail} listings={allListings || filteredListings} calcDOM={calcDOM} formatIsoDate={formatIsoDate} onClose={() => setDetail(null)} />}

        {noteEditing && (
          <div className="note-modal-overlay" onClick={closeNote}>
            <div className="note-modal" onClick={(e) => e.stopPropagation()}>
              <div className="note-modal-header">
                <div><div className="note-modal-title">Note</div><div className="note-modal-sub">{noteEditing.address}</div></div>
                <button className="btn-icon" onClick={closeNote} title="Close">×</button>
              </div>
              <textarea className="note-textarea" autoFocus value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Spoke with the owner, considering selling next quarter…" rows={6}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote(); if (e.key === 'Escape') closeNote() }} />
              <div className="note-modal-footer">
                <span className="note-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>
                <div className="note-modal-actions">
                  <button className="btn btn-ghost btn-sm" onClick={closeNote}>Cancel</button>
                  <button className="btn btn-primary btn-sm" onClick={saveNote} disabled={noteSaving}>{noteSaving ? 'Saving…' : 'Save note'}</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Desk-mode page header — serif title + mono context line. Hidden
          in classic via CSS ([data-desk] scope in desk.css). */}
      <div className="desk-page-head">
        <h2 className="desk-page-title">Prospecting · Sales</h2>
        <div className="desk-page-sub">
          {filteredListings.length} listing{filteredListings.length !== 1 ? 's' : ''}
          {scopeCount > 0 && ` · ${scopeCount} suburb${scopeCount !== 1 ? 's' : ''}`}
          {selectedAgency && ` · ${selectedAgency}`}
          {selectedAgent && ` · ${selectedAgent}`}
          {compact ? ' · compact view' : ''}
        </div>

        {/* Suburb scope as removable chips (mock 02) — replaces the classic
            checkbox sidebar (hidden in desk). Functional: × toggles a
            suburb off, the picker adds one back. */}
        {suburbs && suburbs.length > 0 && toggleCheckSuburb && (
          <div className="desk-suburb-chips">
            {suburbs.filter(s => checkedSuburbs.has(s.id)).map(s => (
              <span key={s.id} className="desk-chip" onClick={() => toggleCheckSuburb(s.id)} title={`Remove ${s.name}`}>
                {s.name} <span className="desk-chip-x">×</span>
              </span>
            ))}
            {suburbs.some(s => !checkedSuburbs.has(s.id)) && (
              <select
                className="desk-chip-add"
                value=""
                onChange={e => { const id = Number(e.target.value); if (id) toggleCheckSuburb(id) }}
                title="Add a suburb to the view"
              >
                <option value="">+ add suburb</option>
                {suburbs.filter(s => !checkedSuburbs.has(s.id)).map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            {selectAllCheck && (
              <button type="button" className="desk-chip-link" onClick={checkedSuburbs.size === suburbs.length ? deselectAllCheck : selectAllCheck}>
                {checkedSuburbs.size === suburbs.length ? 'Clear all' : 'All suburbs'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="filters">
        <button
          className={`filter-btn ${filterAll ? 'active' : ''}`}
          onClick={() => toggleStatus(null)}
        >
          ALL
        </button>
        {['active', 'under_offer', 'sold', 'withdrawn'].map(s => (
          <button
            key={s}
            className={`filter-btn ${selectedStatuses.has(s) ? 'active' : ''}`}
            onClick={() => toggleStatus(s)}
            style={selectedStatuses.has(s)
              ? { borderColor: statusColors[s], backgroundColor: statusColors[s] + '33', color: STATUS_TEXT[s] }
              : { borderColor: statusColors[s] }}
          >
            {s.replace('_', ' ').toUpperCase()}
          </button>
        ))}
        <div className="filter-separator" />

        <Select
          size="sm"
          value={selectedAgency}
          onChange={e => setSelectedAgency(e.target.value)}
          options={[{ value: '', label: 'All Agencies' },
                    ...uniqueAgencies.map(a => ({ value: a, label: a }))]}
        />

        <Select
          size="sm"
          value={selectedAgent}
          onChange={e => setSelectedAgent(e.target.value)}
          options={[{ value: '', label: 'All Agents' },
                    ...uniqueAgents.map(a => ({ value: a, label: a }))]}
        />

        <button
          className={`filter-btn ${compact ? 'active' : ''}`}
          onClick={() => setCompact(c => !c)}
          title="Toggle compact density"
        >
          Compact
        </button>

        <span className="listing-count">
          {filteredListings.length} listing{filteredListings.length !== 1 ? 's' : ''}
          {checkedSuburbs.size > 0 && checkedSuburbs.size < suburbs.length && ` (${checkedSuburbs.size} suburb${checkedSuburbs.size > 1 ? 's' : ''})`}
          {selectedAgency && ` · ${selectedAgency}`}
          {selectedAgent && ` · ${selectedAgent}`}
        </span>
      </div>

      <div className="desk-split">
      <div className={`table-wrapper listings-table-wrapper ${compact ? 'compact' : ''}`} ref={wrapperRef}>
        <table className="listings-table">
          <thead>
            <tr>
              {columns.map(c => (
                <th
                  key={c.field}
                  onClick={c.sortable ? () => toggleSort(c.field) : undefined}
                  className={[c.sortable && 'sortable', c.className].filter(Boolean).join(' ') || undefined}
                  style={c.style}
                >
                  {c.label}
                  {c.sortable && sortField === c.field && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                  {c.headerExtra}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredListings.map((l, i) => (
              <tr key={l.id ?? `row-${l.address}-${l.suburb_name}`} className={`status-${l.status}`}>
                {columns.map(c => {
                  const cls = c.cellClass ? c.cellClass(l) : c.className
                  return (
                    <td key={c.field} className={cls} style={c.style}>
                      {c.cell(l)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {filteredListings.length === 0 && bootLoading && (
              <tr>
                <td colSpan={columns.length} className="loading-cell">
                  <div className="loading-stack">
                    <div className="loading-spinner" />
                    <div className="loading-title">Loading listings…</div>
                    <div className="loading-sub">
                      First load can take 15–30 seconds while the server warms up.
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {filteredListings.length === 0 && !bootLoading && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  {suburbs.length === 0
                    ? 'Add a suburb to get started'
                    : (allListings && allListings.length > 0
                        ? 'No listings match the current filters — adjust or clear the filters above.'
                        : 'No listings yet. Click "Scrape" to fetch data.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Desk-mode lateral map (mock 02). Striped placeholder + status
          pins — matches the design; hidden in classic via CSS. */}
      <div className="desk-map desk-prospect-map">
        <div className="desk-map-label">Map · Perth metro · {filteredListings.length} pins</div>
        {filteredListings.slice(0, 40).map((l, i) => {
          const st = l.status === 'under_offer' ? 'watch' : l.status === 'sold' ? 'info' : l.status === 'withdrawn' ? 'alert' : 'good'
          const s = String(l.address || i)
          let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 0xffff
          return <span key={l.id ?? i} style={{ position: 'absolute', top: `${16 + (h % 66)}%`, left: `${12 + ((h >> 4) % 72)}%`, width: 11, height: 11, borderRadius: '50%', background: `var(--status-${st})`, border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.2)' }} />
        })}
      </div>
      </div>
      <StickyHScroll targetRef={wrapperRef} />

      {detail && (
        <PropertyDetail
          listing={detail}
          listings={allListings || filteredListings}
          calcDOM={calcDOM}
          formatIsoDate={formatIsoDate}
          onClose={() => setDetail(null)}
        />
      )}

      {noteEditing && (
        <div className="note-modal-overlay" onClick={closeNote}>
          <div className="note-modal" onClick={(e) => e.stopPropagation()}>
            <div className="note-modal-header">
              <div>
                <div className="note-modal-title">Note</div>
                <div className="note-modal-sub">{noteEditing.address}</div>
              </div>
              <button className="btn-icon" onClick={closeNote} title="Close">×</button>
            </div>
            <textarea
              className="note-textarea"
              autoFocus
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Spoke with the owner, considering selling next quarter…"
              rows={6}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote()
                if (e.key === 'Escape') closeNote()
              }}
            />
            <div className="note-modal-footer">
              <span className="note-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>
              <div className="note-modal-actions">
                <button className="btn btn-ghost btn-sm" onClick={closeNote}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveNote}
                  disabled={noteSaving}
                >
                  {noteSaving ? 'Saving…' : 'Save note'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

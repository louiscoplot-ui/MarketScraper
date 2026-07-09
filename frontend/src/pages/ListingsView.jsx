// Listings table + filter bar — extracted from App.jsx to keep modules
// under the MCP push size limit. State stays in App.jsx; this is a
// presentational component that takes everything via props.

import { useState, useRef, useEffect } from 'react'
import { StickyNote, Plus, X } from 'lucide-react'
import EditableDateCell from '../components/EditableDateCell'
import EditableTextCell from '../components/EditableTextCell'
import StickyHScroll from '../components/StickyHScroll'
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


export default function ListingsView({
  selectedStatuses, toggleStatus, statusColors,
  selectedAgency, setSelectedAgency, uniqueAgencies,
  selectedAgent, setSelectedAgent, uniqueAgents,
  filteredListings, suburbs, checkedSuburbs,
  toggleCheckSuburb, selectAllCheck, deselectAllCheck,
  sortField, sortDir, toggleSort,
  calcDOM, formatIsoDate, deleteListing, updateListing, mirrorListing,
  bootLoading,
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

  // Column definitions — header + body render from the same list.
  // `cell(row)` returns the cell content; the <td> wrapper is added
  // here so the key + className stay in one place.
  const columns = [
    { field: 'address', label: 'Address', sortable: true, className: 'address-cell',
      cell: (l) => isDesk
        ? <a href={l.reiwa_url || '#'} onClick={(e) => { e.preventDefault(); setDetail(l) }}
             style={{ cursor: 'pointer' }} title="Open property dossier">{l.address}</a>
        : (l.reiwa_url
            ? <a href={l.reiwa_url} target="_blank" rel="noopener">{l.address}</a>
            : l.address) },
    { field: '__note', label: 'Note', sortable: false, className: 'note-cell',
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
    { field: 'bedrooms', label: 'Bed', sortable: true, className: 'num',
      cell: (l) => l.bedrooms ?? '-' },
    { field: 'bathrooms', label: 'Bath', sortable: true, className: 'num',
      cell: (l) => l.bathrooms ?? '-' },
    { field: 'parking', label: 'Car', sortable: true, className: 'num',
      cell: (l) => l.parking ?? '-' },
    { field: 'land_size', label: 'Land', sortable: true,
      cell: (l) => l.land_size || '-' },
    { field: 'internal_size', label: 'Internal', sortable: true,
      cell: (l) => l.internal_size || '-' },
    { field: 'agency', label: 'Agency', sortable: true, className: 'agency-cell',
      cell: (l) => l.agency || '-' },
    { field: 'agent', label: 'Agent', sortable: true, className: 'agent-cell',
      cell: (l) => l.agent || '-' },
    showListed && { field: 'listing_date', label: 'Listed', sortable: true, className: 'date-cell',
      cell: (l) => (
        <EditableDateCell
          value={l.listing_date}
          onSave={(iso) => updateListing(l.id, { listing_date: isoToDmy(iso) })}
        />
      ) },
    showDom && { field: 'dom', label: 'DOM', sortable: true,
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
    { field: '__link', label: 'Link', sortable: false, className: 'link-cell',
      cell: (l) => l.reiwa_url
        ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a>
        : '-' },
    { field: '__del', label: '', sortable: false, className: 'link-cell',
      cell: (l) => (
        <button className="btn-delete-row" title={`Delete this ${l.status} listing`} onClick={() => deleteListing(l)}>
          <X size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ) },
  ].filter(Boolean)

  // Suburbs currently in scope (for the desk-mode context line). Falls
  // back to the total when nothing is explicitly checked (= all shown).
  const scopeCount = checkedSuburbs.size > 0 ? checkedSuburbs.size : suburbs.length

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
    const STATUS_PILLS = [
      { k: 'active', l: 'Active', c: '#16A34A' }, { k: 'under_offer', l: 'Under Offer', c: '#D97706' },
      { k: 'sold', l: 'Sold', c: '#2563EB' }, { k: 'withdrawn', l: 'Withdrawn', c: '#DC2626' },
    ]
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
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)', padding: '5px 14px', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  Rental <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '.08em', background: 'var(--border)', color: 'var(--text-muted)', borderRadius: 4, padding: '1px 5px' }}>ACCOUNT</span>
                </span>
              </div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Prospecting · Sales</h2>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
                {filteredListings.length} results · {scopeCount} suburbs{selectedAgency ? ` · ${selectedAgency}` : ''} · {compact ? 'compact' : 'comfortable'} view
              </div>
            </div>
            <button onClick={() => setCompact(c => !c)} title="Toggle density"
              style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 13px', background: 'var(--surface)', cursor: 'pointer' }}>
              {compact ? 'Compact' : 'Comfortable'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {suburbs.filter(s => checkedSuburbs.has(s.id)).slice(0, 8).map(s => (
              <span key={s.id} onClick={() => toggleCheckSuburb && toggleCheckSuburb(s.id)} title={`Remove ${s.name}`}
                style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid #cdddd5', borderRadius: 999, padding: '6px 12px' }}>
                {s.name} <span style={{ opacity: 0.6 }}>×</span>
              </span>
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
                        <div key={s.id} onClick={() => toggleCheckSuburb(s.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <span style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'transparent', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{on ? '✓' : ''}</span>
                          {s.name}
                        </div>
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
                <span key={p.k} onClick={() => toggleStatus(p.k)}
                  style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', borderRadius: 999, padding: '6px 13px', background: on ? p.c + '1f' : 'transparent', color: on ? p.c : 'var(--text-muted)', border: `1px solid ${on ? p.c : 'var(--border)'}` }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.c }} />{p.l}
                </span>
              )
            })}
            <Select size="sm" value={selectedAgency} onChange={e => setSelectedAgency(e.target.value)}
              options={[{ value: '', label: 'All Agencies' }, ...uniqueAgencies.map(a => ({ value: a, label: a }))]} />
            <Select size="sm" value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)}
              options={[{ value: '', label: 'All Agents' }, ...uniqueAgents.map(a => ({ value: a, label: a }))]} />
          </div>
        </div>

        {/* split: table | map */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: '58%', minWidth: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
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
                        className={c.sortable ? 'sortable' : undefined} style={c.style}>
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
          {/* map */}
          <div className="desk-map" style={{ flex: 1, borderRadius: 0, border: 'none', minHeight: 0 }}>
            <div className="desk-map-label">Map · Perth metro · {filteredListings.length} pins</div>
            {filteredListings.slice(0, 48).map((l, i) => {
              const s = String(l.address || i); let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 0xffff
              return <span key={l.id ?? i} style={{ position: 'absolute', top: `${16 + (h % 66)}%`, left: `${12 + ((h >> 4) % 72)}%`, width: 11, height: 11, borderRadius: '50%', background: stColor(l.status), border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.2)' }} />
            })}
          </div>
        </div>

        {detail && <PropertyDetail listing={detail} calcDOM={calcDOM} formatIsoDate={formatIsoDate} onClose={() => setDetail(null)} />}

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
              ? { borderColor: statusColors[s], backgroundColor: statusColors[s] + '33', color: statusColors[s] }
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
                  className={c.sortable ? 'sortable' : undefined}
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
                    : 'No listings yet. Click "Scrape" to fetch data.'}
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

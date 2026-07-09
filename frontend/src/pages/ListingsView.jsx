// Listings table + filter bar — extracted from App.jsx to keep modules
// under the MCP push size limit. State stays in App.jsx; this is a
// presentational component that takes everything via props.

import { useState, useRef, useEffect } from 'react'
import { StickyNote, Plus, X } from 'lucide-react'
import EditableDateCell from '../components/EditableDateCell'
import EditableTextCell from '../components/EditableTextCell'
import StickyHScroll from '../components/StickyHScroll'
import { Chip, Select } from '../components/ui'


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
      cell: (l) => l.reiwa_url
        ? <a href={l.reiwa_url} target="_blank" rel="noopener">{l.address}</a>
        : l.address },
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

  return (
    <>
      {/* Desk-mode page header — serif title + mono context line. Hidden
          in classic via CSS ([data-desk] scope in desk.css). */}
      <div className="desk-page-head">
        <h2 className="desk-page-title">Prospecting</h2>
        <div className="desk-page-sub">
          {filteredListings.length} listing{filteredListings.length !== 1 ? 's' : ''}
          {scopeCount > 0 && ` · ${scopeCount} suburb${scopeCount !== 1 ? 's' : ''}`}
          {selectedAgency && ` · ${selectedAgency}`}
          {selectedAgent && ` · ${selectedAgent}`}
          {compact ? ' · compact view' : ''}
        </div>
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

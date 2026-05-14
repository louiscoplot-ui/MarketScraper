// Rental module — table of REIWA rental listings per suburb, with an
// inline-editable owner column (operator data lives in rental_owners,
// the nightly scraper never touches it). Mirrors ListingsView's
// patterns: stale-while-revalidate cache, BACKEND_DIRECT for the
// Excel upload (Vercel's 25s edge timeout would kill a 5 MB upload
// mid-buffer), debounced PATCH on cell blur.

import { useState, useEffect, useRef } from 'react'
import { apiJson, BACKEND_DIRECT, getAccessKey } from '../lib/api'


const STATUS_STYLES = {
  New:    { bg: '#dbeafe', color: '#1e3a8a', label: 'New' },
  Active: { bg: '#d1fae5', color: '#065f46', label: 'Active' },
  Leased: { bg: '#e5e7eb', color: '#6b7280', label: 'Leased', italic: true },
}

const COLS = [
  ['status', 'Status'],
  ['address', 'Address'],
  ['price_week', 'Price/Week'],
  ['property_type', 'Type'],
  ['beds', 'Beds'],
  ['baths', 'Baths'],
  ['cars', 'Cars'],
  ['agency', 'Agency'],
  ['agent', 'Agent'],
  ['date_listed', 'Date Listed'],
  ['days_on_market', 'DOM'],
  ['owner_name', 'Owner Name'],
  ['owner_phone', 'Owner Phone'],
  ['notes', 'Notes'],
]


function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || { bg: '#f3f4f6', color: '#374151', label: status || '—' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 12, fontWeight: 600, background: s.bg, color: s.color,
      fontStyle: s.italic ? 'italic' : 'normal',
    }}>
      {s.label}
    </span>
  )
}


function EditableCell({ value, onSave }) {
  const [draft, setDraft] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  // Sync from parent whenever the row's value changes (refresh after
  // upload, suburb switch, etc.). Skip during active edit so we don't
  // clobber what the operator is typing.
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
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1200)
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
        if (e.key === 'Enter') { e.target.blur() }
        if (e.key === 'Escape') { setDraft(value || ''); e.target.blur() }
      }}
      disabled={saving}
      style={{
        width: '100%', boxSizing: 'border-box',
        padding: '4px 6px', fontSize: 13,
        border: '1px solid transparent',
        background: savedFlash ? '#dcfce7' : 'transparent',
        borderRadius: 4,
        transition: 'background 0.4s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.border = '1px solid #d1d5db' }}
      onMouseLeave={(e) => { if (!focusedRef.current) e.currentTarget.style.border = '1px solid transparent' }}
    />
  )
}


export default function RentalView({ suburb: suburbProp, setSuburb: setSuburbProp } = {}) {
  // When App.jsx drives the sidebar selection it passes (suburbProp,
  // setSuburbProp); fall back to fully-internal state if a future
  // caller mounts RentalView standalone. The dropdown also hides when
  // controlled to avoid the duplicate-selector confusion.
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

  const fetchListings = async (suburbName) => {
    if (!suburbName) return
    setLoading(true)
    setError('')
    try {
      const data = await apiJson(`/api/rentals/${encodeURIComponent(suburbName)}`)
      setListings(data.listings || [])
    } catch (e) {
      setError(e.message)
      setListings([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (suburb) fetchListings(suburb)
  }, [suburb])

  const patchOwner = async (row, field, value) => {
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
    // Optimistic in-place patch so the user sees their edit persist
    // without a full refetch (refetch flicker = annoying on a table).
    setListings(prev => prev.map(r =>
      (r.address === row.address && r.suburb === row.suburb)
        ? { ...r, [field]: value }
        : r
    ))
  }

  const onImportClick = () => fileInputRef.current?.click()
  const onFileChange = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-upload of the same file
    if (!f) return
    setImporting(true)
    setImportMsg('')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', f)
      // BACKEND_DIRECT — Excel uploads of 1-5 MB would hit Vercel's 25s
      // edge timeout while buffering, same trick HotVendor uploads use.
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
      // Refresh the current suburb table so freshly-imported rows
      // appear without a manual reload.
      if (suburb) fetchListings(suburb)
      setTimeout(() => setImportMsg(''), 8000)
    } catch (err) {
      setError(`Import failed: ${err.message}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        flexWrap: 'wrap',
      }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>
          Rentals{suburb ? ` — ${suburb}` : ''}
        </h2>
        {/* Hide the dropdown when the parent (App.jsx sidebar) is
            driving the selection — two selectors for the same value
            confuses operators and lets them desync. */}
        {!controlled && (
          <select
            value={suburb}
            onChange={(e) => setSuburb(e.target.value)}
            style={{
              padding: '6px 10px', fontSize: 14,
              border: '1px solid #d1d5db', borderRadius: 6, background: 'white',
            }}
          >
            {!suburbs.length && <option value="">No suburbs available</option>}
            {suburbs.map(s => (
              <option key={s.id} value={s.name}>{s.name}</option>
            ))}
          </select>
        )}
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {listings.length} listing{listings.length !== 1 ? 's' : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="file"
            ref={fileInputRef}
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
          <button
            onClick={onImportClick}
            disabled={importing}
            style={{
              padding: '8px 14px', fontSize: 13,
              background: importing ? '#9ca3af' : '#386351',
              color: 'white', border: 'none', borderRadius: 6,
              cursor: importing ? 'progress' : 'pointer', fontWeight: 600,
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
        }}>
          {importMsg}
        </div>
      )}
      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: '#fee2e2', color: '#991b1b',
          border: '1px solid #fca5a5', borderRadius: 6, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>
      ) : !listings.length ? (
        <div style={{ padding: 24, color: '#6b7280', fontSize: 14 }}>
          {suburb ? `No rentals yet in ${suburb}. Run a scrape or import an Excel file.` : 'Pick a suburb.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                {COLS.map(([k, label]) => (
                  <th key={k} style={{
                    textAlign: 'left', padding: '8px 10px', fontWeight: 600,
                    color: '#374151', fontSize: 11, textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}>{label}</th>
                ))}
                <th style={{ padding: '8px 10px' }}></th>
              </tr>
            </thead>
            <tbody>
              {listings.map((r) => (
                <tr key={`${r.suburb}|${r.address}`} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  {COLS.map(([k]) => (
                    <td key={k} style={{ padding: '6px 10px', verticalAlign: 'middle' }}>
                      {k === 'status' ? <StatusBadge status={r.status} />
                       : k === 'owner_name' || k === 'owner_phone' || k === 'notes' ? (
                         <EditableCell
                           value={r[k]}
                           onSave={(v) => patchOwner(r, k, v)}
                         />
                       )
                       : (r[k] || '—')}
                    </td>
                  ))}
                  <td style={{ padding: '6px 10px' }}>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noopener noreferrer"
                         style={{ fontSize: 12, color: '#386351' }}>
                        REIWA ↗
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

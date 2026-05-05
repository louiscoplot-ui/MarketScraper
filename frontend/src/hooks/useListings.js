import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchWithRetry } from '../lib/api'

const API = '/api'


function parseDateToSortable(dateStr) {
  if (!dateStr) return ''
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return dateStr
}


function realDate(l) {
  if (l.status === 'sold' && l.sold_date) return l.sold_date.slice(0, 10)
  if (l.status === 'withdrawn' && l.withdrawn_date) return l.withdrawn_date.slice(0, 10)
  if (l.listing_date) return parseDateToSortable(l.listing_date)
  return ''
}


export function calcDOM(listing) {
  const dateStr = listing.listing_date
  if (!dateStr) return null
  let start
  const ddmm = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (ddmm) start = new Date(parseInt(ddmm[3]), parseInt(ddmm[2]) - 1, parseInt(ddmm[1]))
  else start = new Date(dateStr)
  if (isNaN(start.getTime())) return null
  const end = listing.status === 'sold' && listing.sold_date
    ? new Date(listing.sold_date) : new Date()
  return Math.max(0, Math.floor((end - start) / (1000 * 60 * 60 * 24)))
}


export function formatIsoDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}


export function useListings({ checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, view }) {
  const [listings, setListings] = useState([])
  const [sortField, setSortField] = useState('')
  const [sortDir, setSortDir] = useState('desc')

  const fetchListings = useCallback(async () => {
    // Retry on cold-start failures (Vercel proxy kills the request at
    // 25s while Render warms up). Without this, an empty table sticks
    // until the user manually refreshes.
    try {
      const res = await fetchWithRetry(`${API}/listings`, {}, 4)
      if (res.ok) setListings(await res.json())
    } catch (e) {
      console.warn('fetchListings failed after retries:', e)
    }
  }, [])

  useEffect(() => { fetchListings() }, [fetchListings])

  useEffect(() => {
    setSortField('')
    setSortDir('desc')
  }, [checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, view])

  const DESC_DEFAULT_FIELDS = useMemo(
    () => new Set(['listing_date', 'sold_date', 'withdrawn_date', 'dom', 'price_text']),
    []
  )

  const toggleSort = useCallback((field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir(DESC_DEFAULT_FIELDS.has(field) ? 'desc' : 'asc')
    }
  }, [sortField, DESC_DEFAULT_FIELDS])

  const filteredListings = useMemo(() => {
    const filtered = listings.filter(l => {
      if (checkedSuburbs.size > 0 && !checkedSuburbs.has(l.suburb_id)) return false
      if (selectedStatuses.size > 0 && !selectedStatuses.has(l.status)) return false
      if (selectedAgent && l.agent !== selectedAgent) return false
      if (selectedAgency && l.agency !== selectedAgency) return false
      return true
    })

    return filtered.sort((a, b) => {
      if (!sortField) {
        const va = realDate(a)
        const vb = realDate(b)
        if (va && vb) return vb.localeCompare(va)
        if (va && !vb) return -1
        if (!va && vb) return 1
        const fa = (a.first_seen || '').slice(0, 10)
        const fb = (b.first_seen || '').slice(0, 10)
        return fb.localeCompare(fa)
      }
      let va, vb
      if (sortField === 'dom') {
        va = calcDOM(a) ?? -1
        vb = calcDOM(b) ?? -1
      } else if (sortField === 'listing_date') {
        va = parseDateToSortable(a.listing_date)
        vb = parseDateToSortable(b.listing_date)
      } else if (sortField === 'sold_date' || sortField === 'withdrawn_date') {
        va = a[sortField] ? a[sortField].slice(0, 10) : ''
        vb = b[sortField] ? b[sortField].slice(0, 10) : ''
      } else {
        va = a[sortField]
        vb = b[sortField]
      }
      if (va == null) va = ''
      if (vb == null) vb = ''
      let primary
      if (typeof va === 'number' && typeof vb === 'number') {
        primary = sortDir === 'asc' ? va - vb : vb - va
      } else {
        primary = sortDir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va))
      }
      if (primary !== 0) return primary
      const ra = realDate(a)
      const rb = realDate(b)
      if (ra !== rb) return String(rb).localeCompare(String(ra))
      const fa = (a.first_seen || '').slice(0, 10)
      const fb = (b.first_seen || '').slice(0, 10)
      return fb.localeCompare(fa)
    })
  }, [listings, checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, sortField, sortDir])

  const uniqueAgents = useMemo(
    () => [...new Set(listings.map(l => l.agent).filter(Boolean))].sort(),
    [listings]
  )

  const uniqueAgencies = useMemo(
    () => [...new Set(listings.map(l => l.agency).filter(Boolean))].sort(),
    [listings]
  )

  const deleteListing = useCallback(async (listing) => {
    if (!listing?.id) return
    const label = listing.address || `#${listing.id}`
    if (!confirm(`Delete this ${listing.status || 'listing'}?\n\n${label}\n\nThis removes the row from the database. Cannot be undone (but a future scrape will re-add it if the URL reappears on REIWA).`)) return
    const res = await fetch(`${API}/listings/${listing.id}`, { method: 'DELETE' })
    if (res.ok) fetchListings()
    else alert('Delete failed')
  }, [fetchListings])

  // PATCH a single field on a listing. `fields` is an object like
  // { listing_date: "30/04/2026" } or { sold_date: "2026-04-28" } or
  // { listing_date: null } to clear. Refreshes the full list on success
  // so the new value + sort take effect immediately.
  const updateListing = useCallback(async (id, fields) => {
    const res = await fetch(`${API}/listings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (res.ok) {
      fetchListings()
      return true
    }
    const err = await res.json().catch(() => ({}))
    alert(err.error || `Update failed (${res.status})`)
    return false
  }, [fetchListings])

  // Local-only mirror — updates client state without hitting the API.
  // Used after writes that go through a side-table endpoint (e.g. notes
  // via /api/listings/note) so the row reflects the change immediately
  // without a refetch round-trip.
  const mirrorListing = useCallback((id, fields) => {
    setListings(prev => prev.map(l => l.id === id ? { ...l, ...fields } : l))
  }, [])

  return {
    listings,
    fetchListings,
    filteredListings,
    sortField,
    sortDir,
    toggleSort,
    uniqueAgents,
    uniqueAgencies,
    deleteListing,
    updateListing,
    mirrorListing,
  }
}

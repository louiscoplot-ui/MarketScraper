import { useState, useEffect, useCallback, useMemo } from 'react'

const API = '/api'


// Parse REIWA's dd/mm/yyyy listing_date to YYYY-MM-DD (sortable as string)
function parseDateToSortable(dateStr) {
  if (!dateStr) return ''
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return dateStr
}


// Pick the most-relevant date for each listing for the default "newest first"
// sort, in a way that's robust when REIWA's listing_date is empty (which is
// the case for most rows on noisy suburbs):
//
//   sold      → sold_date
//   withdrawn → withdrawn_date
//   else      → listing_date if available, else first_seen
//
// CRITICAL: we DO NOT fall back to last_seen for the active path. last_seen
// is "the day our scraper last refreshed this row" which is ~today for
// every active listing — so using it would make every row tie at today's
// date and the sort would feel random. first_seen is "the day we first
// added this row" which is a real proxy for when the listing appeared.
function mostRecentDate(l) {
  if (l.status === 'sold' && l.sold_date) return l.sold_date.slice(0, 10)
  if (l.status === 'withdrawn' && l.withdrawn_date) return l.withdrawn_date.slice(0, 10)
  if (l.listing_date) return parseDateToSortable(l.listing_date)
  if (l.first_seen) return l.first_seen.slice(0, 10)
  if (l.last_seen) return l.last_seen.slice(0, 10)
  return ''
}


export function calcDOM(listing) {
  // DOM only when REIWA published a listing date — never fabricate from first_seen.
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


// Hook: holds full listings list, exposes filter+sort outputs, fetch helper.
// All filtering happens client-side so suburb/status toggles are instant
// (no network roundtrip per click).
export function useListings({ checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, view }) {
  const [listings, setListings] = useState([])
  const [sortField, setSortField] = useState('')
  const [sortDir, setSortDir] = useState('desc')

  const fetchListings = useCallback(async () => {
    const res = await fetch(`${API}/listings`)
    if (res.ok) setListings(await res.json())
  }, [])

  useEffect(() => { fetchListings() }, [fetchListings])

  // ALWAYS revert to "newest first" default whenever the user
  // navigates, filters, or otherwise interacts with the table layout.
  // Explicit column clicks (toggleSort) are the only way to override —
  // and they get cleared as soon as the next filter/tab change happens.
  useEffect(() => {
    setSortField('')
    setSortDir('desc')
  }, [checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, view])

  // Date-like fields default to descending on first click — clicking
  // "Listed" once should show the freshest listings at the top.
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
    // 1. Apply filters
    const filtered = listings.filter(l => {
      if (checkedSuburbs.size > 0 && !checkedSuburbs.has(l.suburb_id)) return false
      if (selectedStatuses.size > 0 && !selectedStatuses.has(l.status)) return false
      if (selectedAgent && l.agent !== selectedAgent) return false
      if (selectedAgency && l.agency !== selectedAgency) return false
      return true
    })

    // 2. Sort. Default = most-recent activity desc (status-aware).
    return filtered.sort((a, b) => {
      let primary = 0
      if (!sortField) {
        const va = mostRecentDate(a)
        const vb = mostRecentDate(b)
        if (va === vb) {
          // Equal sort keys (both might be empty or both today). Tie-break
          // by first_seen desc — earliest captured row goes last so freshly
          // added ones stay at the top.
          const fa = (a.first_seen || '').slice(0, 10)
          const fb = (b.first_seen || '').slice(0, 10)
          return String(fb).localeCompare(String(fa))
        }
        return String(vb).localeCompare(String(va))
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
      if (typeof va === 'number' && typeof vb === 'number') {
        primary = sortDir === 'asc' ? va - vb : vb - va
      } else {
        primary = sortDir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va))
      }
      // Tie-break: most-recent-activity desc.
      if (primary !== 0) return primary
      const ra = mostRecentDate(a)
      const rb = mostRecentDate(b)
      return String(rb).localeCompare(String(ra))
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
  }
}

import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchWithRetry, BACKEND_DIRECT, readCache, writeCache } from '../lib/api'

const API = '/api'
// GET /api/listings is the heaviest bootstrap call (full table for the
// user's allowed suburbs). Go direct to Render so a cold start doesn't
// 504 through Vercel's 25s edge proxy.
const BOOT_LISTINGS = `${BACKEND_DIRECT}/api/listings`
const LISTINGS_CACHE = 'listings'


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
  // Hydrate from localStorage synchronously so the table renders on
  // first paint — operator never stares at an empty page while Render
  // is waking up. Network refresh happens immediately after and
  // silently overwrites once it lands.
  const [listings, setListings] = useState(() => readCache(LISTINGS_CACHE) || [])
  // bootLoading flips to false once the first fetch completes (or
  // errors). The UI uses this + listings.length===0 to decide between
  // skeleton rows (first-time visitor, network in flight) and the
  // 'No listings' empty-state copy.
  const [bootLoading, setBootLoading] = useState(() => (readCache(LISTINGS_CACHE) || []).length === 0)
  const [sortField, setSortField] = useState('')
  const [sortDir, setSortDir] = useState('desc')

  // Progressive load — fetch the two priority statuses (the ones the
  // UI defaults to: active + under_offer) FIRST so the table is
  // populated within ~0.5-1s, then fetch sold + withdrawn in the
  // background and merge them in. Nothing is hidden — every status is
  // loaded eventually — but the user sees content immediately instead
  // of staring at a spinner while a 5000-row payload streams.
  //
  // Cache the merged result to localStorage so subsequent visits land
  // on real data on first paint (stale-while-revalidate).
  const fetchListings = useCallback(async () => {
    const fetchSet = async (statuses) => {
      const url = statuses
        ? `${BOOT_LISTINGS}?statuses=${encodeURIComponent(statuses)}`
        : BOOT_LISTINGS
      const res = await fetchWithRetry(url, {}, 4)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }
    try {
      const priority = await fetchSet('active,under_offer')
      setListings(priority)
      writeCache(LISTINGS_CACHE, priority)
      fetchSet('sold,withdrawn').then((rest) => {
        setListings((prev) => {
          const seen = new Set(prev.map((l) => l.id))
          const merged = prev.slice()
          for (const r of rest) if (!seen.has(r.id)) merged.push(r)
          writeCache(LISTINGS_CACHE, merged)
          return merged
        })
      }).catch((e) => console.warn('background fetch (sold/withdrawn) failed:', e))
    } catch (e) {
      console.warn('priority fetchListings failed after retries:', e)
    } finally {
      setBootLoading(false)
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
  // { listing_date: null } to clear. Updates ONLY the affected row in
  // local state from the response — no fetchListings() refetch — so
  // the user's scroll position, focus, and any in-progress edits on
  // other rows are preserved. Was triggering a full table reload
  // every time the user typed in a price cell.
  const updateListing = useCallback(async (id, fields) => {
    const res = await fetch(`${API}/listings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (res.ok) {
      try {
        const updated = await res.json()
        if (updated && typeof updated === 'object' && !updated.error) {
          setListings(prev => prev.map(l => l.id === id ? { ...l, ...updated } : l))
        }
      } catch {
        // PATCH succeeded but body wasn't JSON — mirror what the user
        // sent so the cell at least reflects the change locally.
        setListings(prev => prev.map(l => l.id === id ? { ...l, ...fields } : l))
      }
      return true
    }
    const err = await res.json().catch(() => ({}))
    alert(err.error || `Update failed (${res.status})`)
    return false
  }, [])

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
    bootLoading,
  }
}

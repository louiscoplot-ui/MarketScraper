import { useState, useEffect, useCallback, useRef } from 'react'
import HotVendorScoring from './HotVendorScoring'
import Pipeline from './pages/Pipeline'
import Report from './pages/Report'
import ListingsView from './pages/ListingsView'
import AppraisalsView from './pages/AppraisalsView'
import SignalsView from './pages/SignalsView'
import TodayView from './pages/TodayView'
import FallenView from './pages/FallenView'
import LoadingState from './components/LoadingState'
import AdminUsers from './pages/AdminUsers'
import RentalView from './pages/RentalView'
import TermsPage from './pages/TermsPage'
import PrivacyPage from './pages/PrivacyPage'
import Footer from './components/Footer'
import { ThemeModal, ScrapeModal, AccountModal } from './components/Modals'
import Header from './components/Header'
import Rail from './components/Rail'
import { useListings, calcDOM, formatIsoDate } from './hooks/useListings'
import { PRESETS, DEFAULT_THEME, THEME_STORAGE_KEY } from './themes'
import { fetchWithRetry, BACKEND_DIRECT, readCache, writeCache } from './lib/api'
import { searchSuburbs } from './lib/waSuburbs'
import { getDeskMode, setDeskMode, getDeskTone, setDeskTone } from './lib/deskFlag'
const API = '/api'
// Bootstrap fetches go direct to Render to bypass Vercel's 25s edge
// timeout — without this, a cold Render dyno (30-60s wake) returns
// 504 to the browser and the sidebar stays blank.
const BOOT_API = `${BACKEND_DIRECT}/api`
const SUBURBS_CACHE = 'suburbs'

const VALID_VIEWS = ['today', 'listings', 'signals', 'fallen', 'pipeline', 'report', 'hot-vendors', 'rentals', 'logs', 'admin', 'terms', 'privacy']

// Listings is the default view at login: it's the tab operators open most
// and it paints fast (cached listings), so the app is usable immediately.
// Today (the morning brief) sits one click away — its /api/brief/today
// call can be slow, so it no longer gates the initial render.
function readViewFromHash() {
  if (typeof window === 'undefined') return 'listings'
  const h = (window.location.hash || '').replace(/^#/, '')
  return VALID_VIEWS.includes(h) ? h : 'listings'
}

function App() {
  // Hydrate from cache so the sidebar paints instantly on returning
  // visits. Network refresh comes in afterwards and silently
  // overwrites — stale-while-revalidate.
  const [suburbs, setSuburbs] = useState(() => readCache(SUBURBS_CACHE) || [])
  const [suburbsLoading, setSuburbsLoading] = useState(() => (readCache(SUBURBS_CACHE) || []).length === 0)
  const [selectedSuburbs, setSelectedSuburbs] = useState(new Set())
  const [checkedSuburbs, setCheckedSuburbs] = useState(new Set())
  const [selectedStatuses, setSelectedStatuses] = useState(new Set(['active', 'under_offer']))
  const [newSuburb, setNewSuburb] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [scrapeStatus, setScrapeStatus] = useState({})
  const [showScrapeModal, setShowScrapeModal] = useState(false)
  // "Connecting…" state — modal opens synchronously on click so the
  // user sees feedback immediately instead of staring at a frozen
  // sidebar for 15-30s while Render cold-starts. Cleared the moment
  // the POST returns (success → normal progress, failure → error).
  const [scrapeConnecting, setScrapeConnecting] = useState(false)
  const [scrapeConnectError, setScrapeConnectError] = useState(null)
  const [logs, setLogs] = useState([])
  // LOOP-3: live "sale fallen" (under_offer → active) count for the badge.
  // Scoped server-side to the caller's suburbs. Best-effort — never blocks.
  const [saleFallenCount, setSaleFallenCount] = useState(0)
  const [view, setView] = useState(readViewFromHash)
  // Current user — fetched once on mount so Header can decide whether
  // to show the Rental tab (gated by rental_access / admin role) and
  // RentalView can branch on it too. Refresh-free; if the admin
  // toggles flags they need to reload to see the new tabs.
  // Stale-while-revalidate: hydrate `me` from localStorage on the very
  // first render so the Header gates (Rental tab, Admin tab) are decided
  // synchronously instead of flashing without the tab while /admin/me
  // is in flight. The cache key is access-key-scoped so signing out as
  // one user and in as another doesn't leak the previous role/flags.
  const [me, setMe] = useState(() => readCache('admin_me'))
  // Surfaced as a dismissible banner at the top of the app when
  // /api/admin/me fails after all retries — without it, the operator
  // sees the Admin / Rental tabs silently absent and blames the app.
  const [backendUnreachable, setBackendUnreachable] = useState(false)
  useEffect(() => {
    fetchWithRetry(`${BOOT_API}/admin/me`, {
      headers: { 'X-Access-Key': localStorage.getItem('agentdeck_access_key') || '' }
    }, 4)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.user) {
          setMe(d.user)
          writeCache('admin_me', d.user)
        } else {
          // 401 / null body — leave me as-is (cached) and surface the
          // backend-unreachable banner so the operator knows that
          // role-gated features may be incomplete.
          setBackendUnreachable(true)
        }
      })
      .catch(() => setBackendUnreachable(true))
  }, [])
  // Rental sidebar state — lifted out of RentalView so the left
  // sidebar can drive the table when the operator is on that tab.
  // Fetched lazily: the list is small and the call is gated by
  // /api/rentals/suburbs's own rental_access check, so a regular
  // sales user simply gets [] back and the rental sidebar (which only
  // renders when view === 'rentals' anyway) stays empty.
  const [rentalSuburbs, setRentalSuburbs] = useState(() => readCache('rental_suburbs') || [])
  // Multi-select with EXPLICIT semantics: the Set holds exactly the
  // suburb names currently being shown. Empty Set = nothing selected
  // (table renders "Select a suburb" empty state — no implicit "All"
  // shortcut, that confused operators who couldn't tell whether they
  // were filtered or not). Default-fills with every suburb on first
  // load so a fresh visit shows data, not an empty page.
  const [rentalSelected, setRentalSelected] = useState(new Set())
  const rentalDefaultedRef = useRef(false)
  useEffect(() => {
    fetchWithRetry(`${BOOT_API}/rentals/suburbs`, {
      headers: { 'X-Access-Key': localStorage.getItem('agentdeck_access_key') || '' }
    }, 4)
      .then(r => r.ok ? r.json() : { suburbs: [] })
      .then(d => {
        const arr = (d && d.suburbs) || []
        setRentalSuburbs(arr)
        writeCache('rental_suburbs', arr)
        // First successful load → seed the selection with every
        // suburb so the operator lands on populated data. After
        // that, the user's explicit picks own the state.
        if (!rentalDefaultedRef.current && arr.length > 0) {
          rentalDefaultedRef.current = true
          setRentalSelected(new Set(arr.map(s => s.name)))
        }
      })
      .catch(() => {})
  }, [])
  const toggleRentalSelection = (name) => {
    setRentalSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  // Derived list of names currently being shown — straight read of
  // the explicit Set.
  const rentalShownNames = [...rentalSelected]
  const [report, setReport] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState(false)
  const [reportSuburbs, setReportSuburbs] = useState(new Set())
  // Lifted Pipeline state: survives Pipeline mount/unmount across tab
  // switches so auto-generate doesn't re-fire (and re-create duplicate
  // pipeline_tracking rows) every time the user toggles back to the
  // Pipeline view.
  const [pipelineAutoGenerated, setPipelineAutoGenerated] = useState(new Set())
  const [selectedAgent, setSelectedAgent] = useState('')
  const [selectedAgency, setSelectedAgency] = useState('')
  const [showThemeModal, setShowThemeModal] = useState(false)
  const [showAccountModal, setShowAccountModal] = useState(false)
  // Prefetch/warm the whole app: once this flips true (shortly after the
  // first paint) every heavy tab is mounted in the background so its data
  // loads while the operator reads Listings, and every later tab switch is
  // instant (no re-mount, no re-fetch, state preserved). Deferred rather
  // than mounting everything on render 0 so the tab the user actually
  // landed on gets Render's first, connection-capped cold-start responses
  // before the background tabs start competing for them.
  const [warmBackground, setWarmBackground] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setWarmBackground(true), 1500)
    return () => clearTimeout(id)
  }, [])

  // "The Morning Desk" redesign — an isolated visual mode behind its own
  // flag (lib/deskFlag.js). State mirrors localStorage so React re-renders
  // on toggle; the setters below persist + re-apply the <html> attributes.
  // Classic stays the default and the one-click fallback.
  const [deskMode, setDeskModeState] = useState(getDeskMode)          // 'desk' | 'classic'
  const [deskTone, setDeskToneState] = useState(getDeskTone)          // ink|forest|slate|bone
  const enterDesk = () => { setDeskMode('desk'); setDeskModeState('desk') }
  const exitDesk = () => { setDeskMode('classic'); setDeskModeState('classic') }
  const pickTone = (t) => { setDeskTone(t); setDeskToneState(t) }
  const isDesk = deskMode === 'desk'

  // Rail navigation — mirrors Header.handleTabClick's report special-case
  // (the Market Report needs its data fetched/seeded on entry, not just a
  // view switch). Every other view is a plain setView.
  const handleNavigate = (v) => {
    if (v === 'report') {
      setView('report')
      if (!report && (!reportSuburbs || reportSuburbs.size === 0)) {
        const seed = new Set(checkedSuburbs)
        setReportSuburbs(seed)
        fetchReport(seed)
      } else {
        fetchReport(reportSuburbs)
      }
    } else {
      setView(v)
    }
  }

  const {
    listings, fetchListings, filteredListings,
    sortField, sortDir, toggleSort,
    uniqueAgents, uniqueAgencies, deleteListing, updateListing, mirrorListing,
    bootLoading: listingsBootLoading, soldLoadError,
  } = useListings({ checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, view })

  // Clear an agent/agency filter that's no longer valid for the current
  // suburb/status scope. Otherwise selecting one suburb while a filter
  // from "All" is still active leaves the dropdown on a stale value
  // showing "0 listings" (the filter matches nothing in the new scope).
  useEffect(() => {
    if (selectedAgent && !uniqueAgents.includes(selectedAgent)) {
      setSelectedAgent('')
    }
  }, [uniqueAgents, selectedAgent])
  useEffect(() => {
    if (selectedAgency && !uniqueAgencies.includes(selectedAgency)) {
      setSelectedAgency('')
    }
  }, [uniqueAgencies, selectedAgency])

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      return saved ? JSON.parse(saved) : DEFAULT_THEME
    } catch { return DEFAULT_THEME }
  })

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--bg', theme.bg)
    root.style.setProperty('--surface', theme.surface)
    root.style.setProperty('--surface-hover', theme.surfaceHover)
    root.style.setProperty('--border', theme.border)
    root.style.setProperty('--text', theme.text)
    root.style.setProperty('--text-muted', theme.textMuted)
    root.style.setProperty('--primary', theme.primary)
    root.style.setProperty('--primary-hover', theme.primary)
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme))
  }, [theme])

  const updateColor = (key, val) => setTheme(prev => ({ ...prev, [key]: val }))

  const pollRef = useRef(null)
  const scrapeStartRef = useRef(null)

  const fetchSuburbs = useCallback(async () => {
    // Hit Render directly to bypass Vercel's 25s edge timeout during
    // a cold start. Retry on transient failures so the sidebar lands
    // automatically once the dyno is warm.
    let res
    try {
      res = await fetchWithRetry(`${BOOT_API}/suburbs`, {}, 4)
    } catch (e) {
      console.warn('fetchSuburbs failed after retries:', e)
      setSuburbsLoading(false)
      return
    }
    if (res.ok) {
      const data = await res.json()
      setSuburbs(data)
      writeCache(SUBURBS_CACHE, data)
      setCheckedSuburbs(prev => {
        if (prev.size === 0 && data.length > 0) return new Set(data.map(s => s.id))
        return prev
      })
    }
    setSuburbsLoading(false)
  }, [])

  const fetchScrapeStatus = useCallback(async () => {
    // BOOT_API (= BACKEND_DIRECT) bypasses Vercel's 25 s edge timeout —
    // Render cold-starts (30-60 s after hibernation) used to kill the
    // proxy call, leaving the modal stuck on "loading" until the user
    // navigated away. NEVER POSTs scrape from here — only GET status.
    let data = {}
    try {
      const res = await fetch(`${BOOT_API}/scrape/status`)
      if (!res.ok) return
      data = await res.json() || {}
    } catch (e) {
      console.warn('fetchScrapeStatus failed:', e)
      return
    }
    setScrapeStatus(data)
    const anyRunning = Object.values(data).some(j => j.status === 'running')
    if (!anyRunning) {
      // No active job — make sure the modal is closed and polling is
      // stopped. Prevents a stale modal from reopening on mount when
      // the previous scrape finished but local state lagged behind.
      setShowScrapeModal(false)
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    // A job IS running on the backend — resume the modal + poll, do
    // NOT issue a new POST /scrape. Refreshing the page must not
    // relaunch a scrape, only reattach to the existing one.
    setShowScrapeModal(true)
    if (!pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${BOOT_API}/scrape/status`)
          if (!r.ok) return
          const d = await r.json() || {}
          setScrapeStatus(d)
          if (!Object.values(d).some(j => j.status === 'running')) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setSelectedStatuses(new Set(['active', 'under_offer']))
            fetchSuburbs()
            fetchListings()
          }
        } catch (e) {
          console.warn('scrape status poll failed:', e)
        }
      }, 2000)
    }
  }, [fetchSuburbs, fetchListings])

  const fetchLogs = useCallback(async () => {
    // BOOT_API bypasses Vercel 25s edge timeout — Render cold start
    // used to 504 here and silently swallow the logs panel.
    try {
      const res = await fetch(`${BOOT_API}/scrape/logs`)
      if (res.ok) setLogs(await res.json())
    } catch (e) {
      console.warn('fetchLogs failed:', e)
    }
  }, [])

  useEffect(() => {
    fetchSuburbs()
    fetchScrapeStatus()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // Sync view <-> URL hash so browser back/forward navigates between
  // tabs instead of leaving the app. pushState on user-driven view
  // changes; popstate pulls view back from the URL. First render is
  // skipped so the initial mount doesn't push a redundant entry.
  const isFirstViewRender = useRef(true)
  useEffect(() => {
    if (isFirstViewRender.current) {
      isFirstViewRender.current = false
      return
    }
    if (window.location.hash !== `#${view}`) {
      window.history.pushState({ view }, '', `#${view}`)
    }
  }, [view])

  useEffect(() => {
    const onPop = () => setView(readViewFromHash())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => { if (view === 'logs') fetchLogs() }, [view])

  // LOOP-3: fetch the live sale-fallen count once on mount (BACKEND_DIRECT
  // bypasses the Vercel edge timeout). Silently ignores failures.
  useEffect(() => {
    let cancelled = false
    fetch(`${BOOT_API}/signals/sale-fallen/count`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setSaleFallenCount(d.count || 0) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const suggestionsRef = useRef(null)

  const handleSuburbInput = (val) => {
    setNewSuburb(val)
    if (val.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    // Local filter against the bundled WA suburb list — instant, no
    // network. Previously this hit /api/suburbs/search which round-
    // tripped through Render (30-60s cold start) and the dropdown
    // looked dead until the dyno warmed up. The list is mirrored
    // from backend/wa_suburbs.py.
    const matches = searchSuburbs(val)
    setSuggestions(matches)
    setShowSuggestions(matches.length > 0)
  }

  const selectSuggestion = async (name) => {
    setSuggestions([])
    setShowSuggestions(false)
    setNewSuburb('')
    try {
      // BOOT_API (= BACKEND_DIRECT) bypasses Vercel's 25s edge timeout
      // and fetchWithRetry rides Render cold-starts (4 attempts with
      // exponential backoff). Previously a network rejection (CORS,
      // DNS, etc.) made fetch() throw → the entire async function
      // exited and the click looked like a no-op with no banner.
      const res = await fetchWithRetry(`${BOOT_API}/suburbs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() })
      }, 4)
      if (res.ok) {
        const data = await res.json()
        setCheckedSuburbs(prev => new Set([...prev, data.id]))
        fetchSuburbs()
        return
      }
      let msg = `Server error ${res.status}`
      let parsed = null
      try { parsed = await res.json() } catch {}
      if (parsed && parsed.error === 'Suburb already exists') {
        fetchSuburbs()
        return
      }
      alert((parsed && parsed.detail) || (parsed && parsed.error) || msg + ' — please refresh and try again.')
    } catch (e) {
      console.error('selectSuggestion failed:', e)
      alert(`Could not add suburb — ${e.message || 'network error'}. Please try again.`)
    }
  }

  useEffect(() => {
    const handler = (e) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addSuburb = async (e) => {
    e.preventDefault()
    if (!newSuburb.trim()) return
    setShowSuggestions(false)
    // BOOT_API + fetchWithRetry — bypass the 25s Vercel edge timeout
    // and survive Render cold starts. Wrapped in try/catch so a
    // network rejection still surfaces an alert instead of leaving
    // the user staring at an unchanged sidebar.
    let res
    try {
      res = await fetchWithRetry(`${BOOT_API}/suburbs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSuburb.trim() })
      }, 4)
    } catch (e) {
      console.error('addSuburb failed:', e)
      alert(`Could not add suburb — ${e.message || 'network error'}. Please try again.`)
      return
    }
    if (res.ok) {
      const data = await res.json()
      setNewSuburb('')
      setSuggestions([])
      setCheckedSuburbs(prev => new Set([...prev, data.id]))
      fetchSuburbs()
    } else {
      // Guard against Render returning an HTML 502 — JSON.parse would
      // crash the whole tab. Best-effort parse, fall through to the
      // status code if the body isn't JSON. Prefer the `detail` field
      // (added by the top-level create_suburb try/except wrap) when
      // available since it carries the real Postgres error message.
      let msg = `Server error ${res.status}`
      try {
        const data = await res.json()
        if (data && (data.detail || data.error)) {
          msg = data.detail || data.error
        }
      } catch {}
      alert(msg + ' — please refresh and try again.')
    }
  }

  const deleteSuburb = async (id, name) => {
    if (!confirm(`Delete ${name} and all its listings?`)) return
    // Optimistic UI: remove the suburb from local state right away so the
    // user gets instant feedback. Render's free tier cold-starts (~30-60s
    // after idle) used to make this feel like the click did nothing.
    const prevSuburbs = suburbs
    setSuburbs(s => s.filter(x => x.id !== id))
    setSelectedSuburbs(prev => { const n = new Set(prev); n.delete(id); return n })
    setCheckedSuburbs(prev => { const n = new Set(prev); n.delete(id); return n })
    try {
      const res = await fetch(`${BOOT_API}/suburbs/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Background re-sync — no await, doesn't block the UI.
      fetchSuburbs()
      fetchListings()
    } catch (e) {
      alert(`Could not delete ${name}: ${e.message}. Restoring.`)
      setSuburbs(prevSuburbs)
    }
  }

  const scrapeSuburb = async (id) => {
    // Belt + braces: the buttons already disable on isAnyScraping, but
    // the scrape_jobs map can be stale for ~1s between click and the
    // next status poll. A handler-level guard prevents a rapid second
    // click from posting before the first updates the state.
    if (scrapeStatus[id] && scrapeStatus[id].status === 'running') return
    scrapeStartRef.current = Date.now()
    // Open the modal SYNCHRONOUSLY with a "Connecting…" banner so the
    // user gets instant feedback. Without this, clicking Scrape on a
    // cold Render dyno = 15-30s of silence and the user reclicks
    // thinking the button is broken.
    setScrapeConnectError(null)
    setScrapeConnecting(true)
    setShowScrapeModal(true)
    let res
    try {
      res = await fetch(`${BOOT_API}/scrape/${id}`, { method: 'POST' })
    } catch (e) {
      console.warn('scrapeSuburb POST failed:', e)
      setScrapeConnecting(false)
      setScrapeConnectError(`${e.message || 'network error'}. Please try again.`)
      return
    }
    if (!res.ok) {
      let msg = `Server error ${res.status}`
      try {
        const data = await res.json()
        if (data && data.error) msg = data.error
      } catch {}
      setScrapeConnecting(false)
      setScrapeConnectError(msg)
      return
    }
    setScrapeConnecting(false)
    fetchScrapeStatus()
  }

  const scrapeSelected = async () => {
    if (checkedSuburbs.size === 0) return
    if (isAnyScraping) return  // re-entry guard, same reasoning as above
    scrapeStartRef.current = Date.now()
    setScrapeConnectError(null)
    setScrapeConnecting(true)
    setShowScrapeModal(true)
    let res
    try {
      res = await fetch(`${BOOT_API}/scrape/selected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suburb_ids: Array.from(checkedSuburbs) })
      })
    } catch (e) {
      console.warn('scrapeSelected POST failed:', e)
      setScrapeConnecting(false)
      setScrapeConnectError(`${e.message || 'network error'}. Please try again.`)
      return
    }
    if (!res.ok) {
      let msg = `Server error ${res.status}`
      try {
        const data = await res.json()
        if (data && data.error) msg = data.error
      } catch {}
      setScrapeConnecting(false)
      setScrapeConnectError(msg)
      return
    }
    setScrapeConnecting(false)
    fetchScrapeStatus()
  }

  const fetchReport = (suburbIds) => {
    const ids = suburbIds && suburbIds.size > 0 ? Array.from(suburbIds) : []
    const params = ids.length > 0 ? `?suburb_ids=${ids.join(',')}` : ''
    const cacheKey = `report_${ids.slice().sort().join(',') || '__all__'}`
    const cached = readCache(cacheKey)
    if (cached) {
      // Cache hit → instant render of the matching selection. No
      // spinner. Fetch refreshes silently in the background.
      setReport(cached)
      setReportLoading(false)
    } else {
      // Cache miss → CLEAR the previous selection's data immediately
      // and show the spinner. Otherwise the user toggles "Nedlands
      // only" and briefly sees the previous "All" report's data
      // mixed in for ~5s until the fetch lands — confusing because
      // suburbs they unchecked still appear in Market-Share-by-suburb
      // etc. Clean state during fetch is more honest.
      setReport(null)
      setReportLoading(true)
    }
    setReportError(false)
    fetchWithRetry(`${BACKEND_DIRECT}/api/report${params}`, {}, 4)
      .then(r => r.json())
      .then(data => {
        setReport(data)
        if (data && !data.error) writeCache(cacheKey, data)
      })
      .catch(() => {
        if (!cached) setReport(null)
        setReportError(true)
      })
      .finally(() => setReportLoading(false))
  }

  // Warm the Market Report in the background shortly after first paint —
  // so the tab opens instantly AND the Dashboard's market-pulse chart has
  // the all-suburbs snapshots to draw a real median-asking trend. Skipped
  // if a report is already loaded (e.g. hydrated from cache).
  useEffect(() => {
    const id = setTimeout(() => { if (!report) fetchReport(new Set()) }, 1800)
    return () => clearTimeout(id)
  }, [])

  const cancelScrape = async () => {
    // Route through BOOT_API (= BACKEND_DIRECT) so the cancel POST
    // bypasses Vercel's 25s edge timeout. Previously the cancel hit
    // the proxy and quietly died on Render cold-starts, leaving the
    // scrape thread alive and the modal stuck on "running" — which
    // is also why a page refresh "relaunched" the scrape (the job
    // never stopped, fetchScrapeStatus saw it still running on mount
    // and re-opened the modal).
    //
    // Optimistic close: stop polling + drop the in-memory scrape
    // status the instant the user clicks Cancel so the modal
    // disappears immediately. The backend cancel flag still
    // propagates to the worker (next cancel_check tick); when the
    // worker actually exits, the status will read 'cancelled' on
    // the next fetch, which is fine because the UI is already closed.
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setShowScrapeModal(false)
    setScrapeStatus({})
    try {
      await fetch(`${BOOT_API}/scrape/cancel`, { method: 'POST' })
    } catch (e) {
      console.warn('cancelScrape POST failed:', e)
    }
  }

  const toggleStatus = (status) => {
    setSelectedStatuses(prev => {
      const n = new Set(prev)
      if (status === null) return new Set()
      if (n.has(status)) n.delete(status)
      else n.add(status)
      return n
    })
  }

  const toggleViewSuburb = (id) => {
    setSelectedSuburbs(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const toggleCheckSuburb = (id) => {
    setCheckedSuburbs(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const selectAllCheck = () => setCheckedSuburbs(new Set(suburbs.map(s => s.id)))
  const deselectAllCheck = () => setCheckedSuburbs(new Set())

  const isAnyScraping = Object.values(scrapeStatus).some(j => j.status === 'running')

  // Status filter-button colours. Hex (not var()) because the filter bar
  // appends '33' for a ~20% alpha fill; kept in exact sync with the
  // status grammar tokens so the buttons match the Chips one-for-one:
  // good / watch / info / alert.
  const statusColors = {
    active: '#16A34A',       // --status-good
    under_offer: '#D97706',  // --status-watch
    sold: '#2563EB',         // --status-info
    withdrawn: '#DC2626',    // --status-alert
  }

  const scrapeJobs = Object.entries(scrapeStatus).map(([id, job]) => {
    const numericId = parseInt(id)
    const suburb = suburbs.find(s => s.id === numericId)
    return { id, name: suburb?.name || `Suburb ${numericId}`, ...job }
  }).filter(j => j.status === 'running' || j.status === 'completed' || j.status === 'error' || j.status === 'cancelled')

  const completedCount = scrapeJobs.filter(j => j.status === 'completed').length
  const totalJobs = scrapeJobs.length
  const elapsed = scrapeStartRef.current ? Math.floor((Date.now() - scrapeStartRef.current) / 1000) : 0
  const estimatedRemaining = completedCount > 0 && totalJobs > completedCount
    ? Math.floor((elapsed / completedCount) * (totalJobs - completedCount))
    : null

  const formatTime = (secs) => {
    if (secs < 60) return `${secs}s`
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}m ${s}s`
  }

  // Standalone legal pages — render outside the app shell so the
  // Header / sidebar / scrape controls don't surround them.
  if (view === 'terms') return <TermsPage />
  if (view === 'privacy') return <PrivacyPage />

  return (
    <div className={`app${isDesk ? ' desk' : ''}`}>
      {isDesk && (
        <Rail
          view={view}
          onNavigate={handleNavigate}
          me={me}
          counts={{ listings: filteredListings.length }}
          tone={deskTone}
          onTone={pickTone}
          onExit={exitDesk}
        />
      )}
      <div className="app-shell">
      {backendUnreachable && (
        <div style={{
          background: '#fef3c7', borderBottom: '1px solid #fcd34d',
          color: '#92400e', padding: '8px 16px', fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
        }}>
          <span>⚠️ Connection issue — some features may be unavailable. Refresh to retry.</span>
          <button
            type="button"
            onClick={() => setBackendUnreachable(false)}
            aria-label="Dismiss"
            style={{
              background: 'transparent', border: 'none', color: '#92400e',
              fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '0 4px',
            }}
          >×</button>
        </div>
      )}
      <Header
        me={me}
        view={view} setView={setView}
        checkedSuburbs={checkedSuburbs}
        selectedStatuses={selectedStatuses}
        selectedAgent={selectedAgent} selectedAgency={selectedAgency}
        filteredListingsCount={filteredListings.length}
        isAnyScraping={isAnyScraping}
        scrapeSelected={scrapeSelected}
        setShowScrapeModal={setShowScrapeModal}
        setReportSuburbs={setReportSuburbs} fetchReport={fetchReport}
        reportSuburbs={reportSuburbs} hasReport={!!report}
        setShowThemeModal={setShowThemeModal}
        setShowAccountModal={setShowAccountModal}
        railMode={isDesk}
        onEnterDesk={enterDesk}
      />

      {showAccountModal && (
        <AccountModal me={me} onClose={() => setShowAccountModal(false)} />
      )}

      {showThemeModal && (
        <ThemeModal
          theme={theme} setTheme={setTheme} defaultTheme={DEFAULT_THEME}
          presets={PRESETS} updateColor={updateColor}
          onClose={() => setShowThemeModal(false)}
        />
      )}

      {showScrapeModal && (scrapeJobs.length > 0 || scrapeConnecting || scrapeConnectError) && (
        <ScrapeModal
          scrapeJobs={scrapeJobs} isAnyScraping={isAnyScraping}
          completedCount={completedCount} totalJobs={totalJobs}
          elapsed={elapsed} estimatedRemaining={estimatedRemaining}
          formatTime={formatTime} cancelScrape={cancelScrape}
          connecting={scrapeConnecting} connectError={scrapeConnectError}
          onClose={() => {
            setShowScrapeModal(false)
            setScrapeConnecting(false)
            setScrapeConnectError(null)
          }}
        />
      )}

      <div className="layout">
        {view === 'rentals' ? (
          // Rental sidebar — same shell (.sidebar / .suburb-list) so it
          // inherits the existing styles, but stripped down to a multi-
          // select list. Empty selection Set = "All suburbs" (one click
          // on the All row clears the set; one click on a suburb adds
          // /removes it). Header counter shows X / Y, where X reflects
          // the effective count (all when set is empty).
          <aside className="sidebar">
            <h2>
              Rental Suburbs
              {rentalSuburbs.length > 0 && (
                <span style={{
                  marginLeft: 8, fontSize: 12, fontWeight: 400,
                  color: '#6b7280',
                }}>
                  {rentalShownNames.length} / {rentalSuburbs.length}
                </span>
              )}
            </h2>
            {/* Select-all / Deselect-all — mirrors the sales sidebar
                .check-actions block at App.jsx:566-568. Explicit
                semantics: Set holds exactly the names shown. */}
            {rentalSuburbs.length > 0 && (
              <div className="check-actions">
                <button
                  className="btn-link"
                  onClick={() => setRentalSelected(new Set(rentalSuburbs.map(s => s.name)))}
                >
                  Select all
                </button>
                <button
                  className="btn-link"
                  onClick={() => setRentalSelected(new Set())}
                >
                  Deselect all
                </button>
              </div>
            )}
            <div className="suburb-list">
              {rentalSuburbs.length === 0 && (
                <div className="suburb-item suburb-loading">
                  <span className="suburb-name" style={{ color: '#888', fontStyle: 'italic', fontSize: 13 }}>
                    No rental suburbs assigned. Ask your admin.
                  </span>
                </div>
              )}
              {rentalSuburbs.map(s => {
                const checked = rentalSelected.has(s.name)
                return (
                  <div
                    key={s.id}
                    className={`suburb-item ${checked ? 'selected' : ''}`}
                    onClick={() => toggleRentalSelection(s.name)}
                  >
                    <input
                      type="checkbox"
                      className="suburb-check"
                      checked={checked}
                      onChange={() => toggleRentalSelection(s.name)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="suburb-info">
                      <span className="suburb-name">{s.name}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </aside>
        ) : (
        <aside className="sidebar">
          <h2>Suburbs</h2>
          {saleFallenCount > 0 && (
            <button
              type="button"
              onClick={() => setView('fallen')}
              title="Under-offer listings that returned to active in the last 14 days — motivated vendors. Click to open the full list."
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                margin: '0 0 12px', padding: '8px 12px', cursor: 'pointer',
                background: '#fff7ed', border: '1px solid #fdba74',
                borderRadius: 6, color: '#7c2d12', fontWeight: 600, fontSize: 13,
                textAlign: 'left',
              }}
            >
              🔔 {saleFallenCount} sale{saleFallenCount > 1 ? 's' : ''} fallen through
              <span style={{ marginLeft: 'auto', fontWeight: 400 }}>→</span>
            </button>
          )}
          {/* Add form only for admins + users granted can_add_suburbs.
              Everyone else sees just the suburbs an admin assigned them
              and can't self-expand coverage. */}
          {(me?.role === 'admin' || me?.can_add_suburbs) && (
          <form onSubmit={addSuburb} className="add-form" ref={suggestionsRef}>
            <div className="autocomplete-wrapper">
              <input
                type="text" value={newSuburb}
                onChange={e => handleSuburbInput(e.target.value)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Type suburb name..." autoComplete="off"
              />
              {showSuggestions && (
                <div className="suggestions-dropdown">
                  {suggestions.map(s => {
                    // Backend returns {name, postcode}; legacy plain
                    // string is handled by normalising at the source.
                    const name = s.name || s
                    const postcode = s.postcode || ''
                    return (
                      <div
                        key={name}
                        className="suggestion-item"
                        onClick={() => selectSuggestion(name)}
                      >
                        <span>{name}</span>
                        {postcode && (
                          <span style={{
                            marginLeft: 8, fontSize: 11, color: '#94a3b8',
                            fontFeatureSettings: '"tnum"',
                          }}>{postcode}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <button type="submit" className="btn btn-small">+</button>
          </form>
          )}

          {suburbs.length > 0 && (
            <div className="check-actions">
              <button className="btn-link" onClick={selectAllCheck}>Select all</button>
              <button className="btn-link" onClick={deselectAllCheck}>Deselect all</button>
            </div>
          )}

          <div className="suburb-list">
            {suburbsLoading && suburbs.length === 0 && (
              <div className="suburb-item suburb-loading">
                <span className="loading-spinner loading-spinner-sm" />
                <span className="suburb-name" style={{ color: '#888', fontStyle: 'italic', fontSize: 13 }}>
                  Loading your suburbs…
                </span>
              </div>
            )}
            {!suburbsLoading && suburbs.length === 0 && (
              <div className="suburb-item suburb-loading">
                <span className="suburb-name" style={{ color: '#b91c1c', fontStyle: 'italic', fontSize: 13 }}>
                  No suburbs assigned. Ask your admin.
                </span>
              </div>
            )}
            {suburbs.length > 0 && (
              <div
                className={`suburb-item suburb-item-all ${selectedSuburbs.size === 0 ? 'selected' : ''}`}
                onClick={() => setSelectedSuburbs(new Set())}
              >
                <span className="suburb-name">
                  All suburbs <span className="suburb-name-meta">({suburbs.length})</span>
                </span>
                <span className="suburb-count">
                  {suburbs.reduce((s, x) => s + (x.active_count || 0) + (x.under_offer_count || 0), 0)}
                  <span className="suburb-count-label"> listings</span>
                </span>
              </div>
            )}

            {suburbs.map(s => {
              const job = scrapeStatus[s.id]
              const isRunning = job?.status === 'running'
              const isViewing = selectedSuburbs.has(s.id)
              const isChecked = checkedSuburbs.has(s.id)

              return (
                <div key={s.id} className={`suburb-item ${isViewing ? 'selected' : ''}`}>
                  <input
                    type="checkbox" className="suburb-check"
                    checked={isChecked}
                    onChange={() => toggleCheckSuburb(s.id)}
                    title="Include in scrape"
                  />
                  <div className="suburb-info" onClick={() => toggleViewSuburb(s.id)}>
                    <span className="suburb-name" title={s.name}>{s.name}</span>
                    <div className="suburb-stats">
                      <span className="stat active">{s.active_count || 0}</span>
                      <span className="stat under-offer">{s.under_offer_count || 0}</span>
                      <span className="stat sold">{s.sold_count || 0}</span>
                      <span className="stat withdrawn">{s.withdrawn_count || 0}</span>
                    </div>
                    {isRunning && <div className="scrape-progress">{job.progress}</div>}
                    {job?.status === 'completed' && <div className="scrape-done">{job.progress}</div>}
                    {job?.status === 'error' && <div className="scrape-error">{job.progress}</div>}
                  </div>
                  <div className="suburb-actions">
                    <button className="btn btn-icon" onClick={() => scrapeSuburb(s.id)} disabled={isRunning} title="Scrape this suburb">
                      {isRunning ? '...' : '↻'}
                    </button>
                    <button className="btn btn-icon btn-danger" onClick={() => deleteSuburb(s.id, s.name)} title="Delete suburb">
                      ×
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </aside>
        )}

        <main className="content">
          {/* Persistent, background-warmed tabs. Each is mounted once —
              immediately for whichever tab is active, and ~1.5s after first
              paint for the rest (warmBackground) — then kept mounted and
              toggled with `display`. So the first visit fetches Listings +
              every other tab's data in parallel, and later switches are
              instant: no re-mount, no re-fetch, in-tab state preserved
              (a running Hot Vendors job keeps polling, scroll positions and
              filters survive). Report / Rental / Admin / History stay lazy
              in the ternary below — they hang off a selection or a role, so
              there is nothing useful to prefetch blindly. */}
          <div style={{ display: view === 'hot-vendors' ? 'block' : 'none', height: isDesk ? '100%' : undefined }}>
            <HotVendorScoring />
          </div>
          {(view === 'today' || warmBackground) && (
            <div style={{ display: view === 'today' ? 'block' : 'none' }}>
              <TodayView setView={setView} saleFallenCount={saleFallenCount} suburbs={suburbs} report={report} />
            </div>
          )}
          {(view === 'signals' || warmBackground) && (
            <div style={{ display: view === 'signals' ? 'block' : 'none', height: isDesk ? '100%' : undefined }}>
              <SignalsView />
            </div>
          )}
          {(view === 'fallen' || warmBackground) && (
            <div style={{ display: view === 'fallen' ? 'block' : 'none', height: isDesk ? '100%' : undefined }}>
              <FallenView bootApi={BOOT_API} />
            </div>
          )}
          {(view === 'appraisals' || warmBackground) && (
            <div style={{ display: view === 'appraisals' ? 'block' : 'none', height: isDesk ? '100%' : undefined }}>
              <AppraisalsView />
            </div>
          )}
          {(view === 'pipeline' || warmBackground) && (
            <div style={{ display: view === 'pipeline' ? 'block' : 'none', height: isDesk ? '100%' : undefined }}>
              <Pipeline
                autoGeneratedFor={pipelineAutoGenerated}
                setAutoGeneratedFor={setPipelineAutoGenerated}
              />
            </div>
          )}
          {/* Listings is the landing tab (default view) — always mounted so
              it's warm even when the user lands elsewhere via a #hash. */}
          <div style={{ display: view === 'listings' ? (isDesk ? 'flex' : 'block') : 'none', flexDirection: 'column', height: isDesk ? '100%' : undefined, minHeight: 0 }}>
            {soldLoadError && (
              <div style={{
                margin: '0 0 12px', padding: '8px 12px', borderRadius: 6,
                background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e',
                fontSize: 13,
              }}>
                Sold/withdrawn listings unavailable — refresh to retry.
              </div>
            )}
            <ListingsView
              selectedStatuses={selectedStatuses} toggleStatus={toggleStatus} statusColors={statusColors}
              selectedAgency={selectedAgency} setSelectedAgency={setSelectedAgency} uniqueAgencies={uniqueAgencies}
              selectedAgent={selectedAgent} setSelectedAgent={setSelectedAgent} uniqueAgents={uniqueAgents}
              filteredListings={filteredListings} suburbs={suburbs} checkedSuburbs={checkedSuburbs}
              toggleCheckSuburb={toggleCheckSuburb} selectAllCheck={selectAllCheck} deselectAllCheck={deselectAllCheck}
              sortField={sortField} sortDir={sortDir} toggleSort={toggleSort}
              calcDOM={calcDOM} formatIsoDate={formatIsoDate}
              deleteListing={deleteListing} updateListing={updateListing} mirrorListing={mirrorListing}
              bootLoading={listingsBootLoading}
              onNavigate={handleNavigate}
              hasRental={!!me && ((me.role || '').toLowerCase() === 'admin' || !!me.rental_access)}
            />
          </div>

          {/* Lazy tabs — mounted on demand (depend on a selection / role). */}
          {view === 'rentals' ? (
            <RentalView selectedNames={rentalShownNames} />
          ) : view === 'admin' ? (
            <AdminUsers />
          ) : view === 'report' && report ? (
            <Report
              report={report} suburbs={suburbs} reportSuburbs={reportSuburbs}
              setReportSuburbs={setReportSuburbs} fetchReport={fetchReport}
              reportLoading={reportLoading}
            />
          ) : view === 'report' && reportError && !reportLoading ? (
            <div style={{
              padding: '40px 24px', textAlign: 'center',
              color: '#7d6608', background: '#fef9e7',
              border: '1px solid #f0d264', borderRadius: 8,
              margin: '24px auto', maxWidth: 560,
            }}>
              <h3 style={{ margin: '0 0 8px', color: '#7d6608' }}>
                Could not load report
              </h3>
              <p style={{ margin: '0 0 16px', fontSize: 14, color: '#444' }}>
                The server may be waking up or temporarily unreachable.
              </p>
              <button
                onClick={() => fetchReport(reportSuburbs)}
                style={{
                  padding: '10px 24px', background: '#386351', color: '#fff',
                  border: 'none', borderRadius: 6, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >
                Retry
              </button>
            </div>
          ) : view === 'report' ? (
            <LoadingState
              title="Loading market report…"
              subtext="Crunching listings, agency share, price changes and snapshots. First load can take 15–30 seconds while the server warms up."
            />
          ) : view === 'logs' ? (
            <div className="logs-view">
              <h2>Scrape History</h2>
              <button className="btn btn-small" onClick={fetchLogs}>Refresh</button>
              <table className="logs-table">
                <thead>
                  <tr>
                    <th>Suburb</th><th>Started</th><th>Completed</th>
                    <th>For Sale</th><th>Sold</th><th>New</th>
                    <th>Updated</th><th>Withdrawn</th><th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id}>
                      <td>{log.suburb_name}</td>
                      <td>{log.started_at ? new Date(log.started_at).toLocaleString('en-AU') : '-'}</td>
                      <td>{log.completed_at ? new Date(log.completed_at).toLocaleString('en-AU') : 'Running...'}</td>
                      <td>{log.forsale_count}</td>
                      <td>{log.sold_count}</td>
                      <td className="new-count">{log.new_count}</td>
                      <td>{log.updated_count}</td>
                      <td className="withdrawn-count">{log.withdrawn_count}</td>
                      <td className="error-cell">{log.errors ? '⚠' : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </main>
      </div>
      <Footer />
      </div>
    </div>
  )
}

export default App

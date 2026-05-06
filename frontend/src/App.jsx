import { useState, useEffect, useCallback, useRef } from 'react'
import HotVendorScoring from './HotVendorScoring'
import Pipeline from './pages/Pipeline'
import Report from './pages/Report'
import ListingsView from './pages/ListingsView'
import LoadingState from './components/LoadingState'
import AdminUsers from './pages/AdminUsers'
import { ThemeModal, ScrapeModal } from './components/Modals'
import Header from './components/Header'
import { useListings, calcDOM, formatIsoDate } from './hooks/useListings'
import { PRESETS, DEFAULT_THEME, THEME_STORAGE_KEY } from './themes'
import { fetchWithRetry, BACKEND_DIRECT, readCache, writeCache } from './lib/api'
const API = '/api'
// Bootstrap fetches go direct to Render to bypass Vercel's 25s edge
// timeout — without this, a cold Render dyno (30-60s wake) returns
// 504 to the browser and the sidebar stays blank.
const BOOT_API = `${BACKEND_DIRECT}/api`
const SUBURBS_CACHE = 'suburbs'

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
  const [logs, setLogs] = useState([])
  const [view, setView] = useState('listings')
  const [report, setReport] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportSuburbs, setReportSuburbs] = useState(new Set())
  const [selectedAgent, setSelectedAgent] = useState('')
  const [selectedAgency, setSelectedAgency] = useState('')
  const [showThemeModal, setShowThemeModal] = useState(false)

  const {
    listings, fetchListings, filteredListings,
    sortField, sortDir, toggleSort,
    uniqueAgents, uniqueAgencies, deleteListing, updateListing, mirrorListing,
    bootLoading: listingsBootLoading,
  } = useListings({ checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency, view })

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
    const res = await fetch(`${API}/scrape/status`)
    if (res.ok) {
      const data = await res.json()
      setScrapeStatus(data)
      const anyRunning = Object.values(data).some(j => j.status === 'running')
      if (anyRunning) {
        setShowScrapeModal(true)
        if (!pollRef.current) {
          pollRef.current = setInterval(async () => {
            const r = await fetch(`${API}/scrape/status`)
            if (r.ok) {
              const d = await r.json()
              setScrapeStatus(d)
              if (!Object.values(d).some(j => j.status === 'running')) {
                clearInterval(pollRef.current)
                pollRef.current = null
                setSelectedStatuses(new Set(['active', 'under_offer']))
                fetchSuburbs()
                fetchListings()
              }
            }
          }, 2000)
        }
      }
    }
  }, [fetchSuburbs, fetchListings])

  const fetchLogs = useCallback(async () => {
    const res = await fetch(`${API}/scrape/logs`)
    if (res.ok) setLogs(await res.json())
  }, [])

  useEffect(() => {
    fetchSuburbs()
    fetchScrapeStatus()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  useEffect(() => { if (view === 'logs') fetchLogs() }, [view])

  const searchTimeoutRef = useRef(null)
  const suggestionsRef = useRef(null)

  const handleSuburbInput = (val) => {
    setNewSuburb(val)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    if (val.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    searchTimeoutRef.current = setTimeout(async () => {
      const res = await fetch(`${API}/suburbs/search?q=${encodeURIComponent(val.trim())}`)
      if (res.ok) {
        const data = await res.json()
        setSuggestions(data)
        setShowSuggestions(data.length > 0)
      }
    }, 150)
  }

  const selectSuggestion = async (name) => {
    setSuggestions([])
    setShowSuggestions(false)
    setNewSuburb('')
    const res = await fetch(`${API}/suburbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    })
    if (res.ok) {
      const data = await res.json()
      setCheckedSuburbs(prev => new Set([...prev, data.id]))
      fetchSuburbs()
    } else {
      const data = await res.json()
      if (data.error === 'Suburb already exists') fetchSuburbs()
      else alert(data.error || 'Error adding suburb')
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
    const res = await fetch(`${API}/suburbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newSuburb.trim() })
    })
    if (res.ok) {
      const data = await res.json()
      setNewSuburb('')
      setSuggestions([])
      setCheckedSuburbs(prev => new Set([...prev, data.id]))
      fetchSuburbs()
    } else {
      const data = await res.json()
      alert(data.error || 'Error adding suburb')
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
      const res = await fetch(`${API}/suburbs/${id}`, { method: 'DELETE' })
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
    scrapeStartRef.current = Date.now()
    await fetch(`${API}/scrape/${id}`, { method: 'POST' })
    setShowScrapeModal(true)
    fetchScrapeStatus()
  }

  const scrapeSelected = async () => {
    if (checkedSuburbs.size === 0) return
    scrapeStartRef.current = Date.now()
    await fetch(`${API}/scrape/selected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suburb_ids: Array.from(checkedSuburbs) })
    })
    setShowScrapeModal(true)
    fetchScrapeStatus()
  }

  const fetchReport = (suburbIds) => {
    const ids = suburbIds && suburbIds.size > 0 ? Array.from(suburbIds) : []
    const params = ids.length > 0 ? `?suburb_ids=${ids.join(',')}` : ''
    setReportLoading(true)
    // Direct to Render — Vercel's 25s edge proxy was killing the
    // report request during cold starts. The retry helper rides on
    // top so transient 5xx don't drop the user back to a blank tab.
    fetchWithRetry(`${BACKEND_DIRECT}/api/report${params}`, {}, 4)
      .then(r => r.json())
      .then(data => setReport(data))
      .catch(() => setReport(null))
      .finally(() => setReportLoading(false))
  }

  const cancelScrape = async () => {
    await fetch(`${API}/scrape/cancel`, { method: 'POST' })
    fetchScrapeStatus()
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

  const statusColors = {
    active: '#22c55e',
    under_offer: '#f59e0b',
    sold: '#3b82f6',
    withdrawn: '#ef4444',
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

  return (
    <div className="app">
      <Header
        view={view} setView={setView}
        checkedSuburbs={checkedSuburbs}
        selectedStatuses={selectedStatuses}
        selectedAgent={selectedAgent} selectedAgency={selectedAgency}
        filteredListingsCount={filteredListings.length}
        isAnyScraping={isAnyScraping}
        scrapeSelected={scrapeSelected}
        setShowScrapeModal={setShowScrapeModal}
        setReportSuburbs={setReportSuburbs} fetchReport={fetchReport}
        setShowThemeModal={setShowThemeModal}
      />

      {showThemeModal && (
        <ThemeModal
          theme={theme} setTheme={setTheme} defaultTheme={DEFAULT_THEME}
          presets={PRESETS} updateColor={updateColor}
          onClose={() => setShowThemeModal(false)}
        />
      )}

      {showScrapeModal && scrapeJobs.length > 0 && (
        <ScrapeModal
          scrapeJobs={scrapeJobs} isAnyScraping={isAnyScraping}
          completedCount={completedCount} totalJobs={totalJobs}
          elapsed={elapsed} estimatedRemaining={estimatedRemaining}
          formatTime={formatTime} cancelScrape={cancelScrape}
          onClose={() => setShowScrapeModal(false)}
        />
      )}

      <div className="layout">
        <aside className="sidebar">
          <h2>Suburbs</h2>
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
                  {suggestions.map(s => (
                    <div key={s} className="suggestion-item" onClick={() => selectSuggestion(s)}>
                      {s}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button type="submit" className="btn btn-small">+</button>
          </form>

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
                    <span className="suburb-name">{s.name}</span>
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

        <main className="content">
          {/* Hot Vendors stays mounted across navigation so a running
              CSV-scoring or Excel-build job (background polling) keeps
              going while the user works in Listings/Pipeline. When
              they come back the state is exactly as they left it —
              no reload, no progress lost. Other tabs are cheap to
              re-render so they stay in the ternary below. */}
          <div style={{ display: view === 'hot-vendors' ? 'block' : 'none' }}>
            <HotVendorScoring />
          </div>
          {view === 'pipeline' ? (
            <Pipeline />
          ) : view === 'hot-vendors' ? null : view === 'admin' ? (
            <AdminUsers />
          ) : view === 'report' && report ? (
            <Report
              report={report} suburbs={suburbs} reportSuburbs={reportSuburbs}
              setReportSuburbs={setReportSuburbs} fetchReport={fetchReport}
            />
          ) : view === 'report' ? (
            <LoadingState
              title="Loading market report…"
              subtext="Crunching listings, agency share, price changes and snapshots. First load can take 10–15 seconds while the server warms up."
            />
          ) : view === 'listings' ? (
            <ListingsView
              selectedStatuses={selectedStatuses} toggleStatus={toggleStatus} statusColors={statusColors}
              selectedAgency={selectedAgency} setSelectedAgency={setSelectedAgency} uniqueAgencies={uniqueAgencies}
              selectedAgent={selectedAgent} setSelectedAgent={setSelectedAgent} uniqueAgents={uniqueAgents}
              filteredListings={filteredListings} suburbs={suburbs} checkedSuburbs={checkedSuburbs}
              sortField={sortField} sortDir={sortDir} toggleSort={toggleSort}
              calcDOM={calcDOM} formatIsoDate={formatIsoDate}
              deleteListing={deleteListing} updateListing={updateListing} mirrorListing={mirrorListing}
              bootLoading={listingsBootLoading}
            />
          ) : (
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
                      <td>{log.started_at ? new Date(log.started_at).toLocaleString() : '-'}</td>
                      <td>{log.completed_at ? new Date(log.completed_at).toLocaleString() : 'Running...'}</td>
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
          )}
        </main>
      </div>
    </div>
  )
}

export default App

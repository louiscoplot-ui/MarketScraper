import { useState, useEffect, useCallback, useRef } from 'react'

const API = '/api'

function App() {
  const [suburbs, setSuburbs] = useState([])
  const [listings, setListings] = useState([])
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
  const [reportSuburbs, setReportSuburbs] = useState(new Set())
  // Empty sortField means "default sort" (by listing_date desc, newest first).
  // First click on a column header then explicitly selects that column.
  const [sortField, setSortField] = useState('')
  const [sortDir, setSortDir] = useState('desc')
  const [selectedAgent, setSelectedAgent] = useState('')
  const [selectedAgency, setSelectedAgency] = useState('')
  const [showThemeModal, setShowThemeModal] = useState(false)

  // Terracotta & Jade — warm paper with deep ocean-jade, terracotta accent (DEFAULT)
  const defaultTheme = {
    bg: '#EFE2C7', surface: '#F7ECD4', surfaceHover: '#E5D3B0', border: '#D4C09A',
    text: '#1B3842', textMuted: '#5C6F77', primary: '#D2775A',
  }

  const presets = {
    'Terracotta & Jade': {
      bg: '#EFE2C7', surface: '#F7ECD4', surfaceHover: '#E5D3B0', border: '#D4C09A',
      text: '#1B3842', textMuted: '#5C6F77', primary: '#D2775A',
    },
    'Burgundy & Rye': {
      bg: '#E8D8B8', surface: '#F1E4C6', surfaceHover: '#D8C69D', border: '#BFA97A',
      text: '#1E1B14', textMuted: '#6B5E45', primary: '#8A2420',
    },
    'Nocturnal': {
      bg: '#0E1A28', surface: '#172739', surfaceHover: '#22334A', border: '#3A4B62',
      text: '#E4EAF1', textMuted: '#8FA3B8', primary: '#D4AA4A',
    },
    'Tropical Vivid': {
      bg: '#0F2A4D', surface: '#173862', surfaceHover: '#224A82', border: '#2D5B95',
      text: '#F7E6D4', textMuted: '#B3C3D8', primary: '#E77D37',
    },
  }

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('ms_theme_v2')
      return saved ? JSON.parse(saved) : defaultTheme
    } catch { return defaultTheme }
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
    localStorage.setItem('ms_theme_v2', JSON.stringify(theme))
  }, [theme])

  const updateColor = (key, val) => setTheme(prev => ({ ...prev, [key]: val }))

  const pollRef = useRef(null)
  const scrapeStartRef = useRef(null)

  // --- Data fetching ---
  const fetchSuburbs = useCallback(async () => {
    const res = await fetch(`${API}/suburbs`)
    if (res.ok) {
      const data = await res.json()
      setSuburbs(data)
      setCheckedSuburbs(prev => {
        if (prev.size === 0 && data.length > 0) return new Set(data.map(s => s.id))
        return prev
      })
    }
  }, [])

  const fetchListings = useCallback(async () => {
    const ids = checkedSuburbs.size > 0 ? Array.from(checkedSuburbs) : []
    const suburbFilter = ids.length > 0 ? `suburb_ids=${ids.join(',')}` : ''
    let url = `${API}/listings?${suburbFilter}`
    if (selectedStatuses.size > 0) url += `&statuses=${Array.from(selectedStatuses).join(',')}`
    const res = await fetch(url)
    if (res.ok) setListings(await res.json())
  }, [checkedSuburbs, selectedStatuses])

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

  useEffect(() => { fetchListings() }, [checkedSuburbs, selectedStatuses])
  useEffect(() => { if (view === 'logs') fetchLogs() }, [view])

  // --- Autocomplete ---
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
      if (data.error === 'Suburb already exists') {
        // Already added, just refresh
        fetchSuburbs()
      } else {
        alert(data.error || 'Error adding suburb')
      }
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

  // --- Actions ---
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
    await fetch(`${API}/suburbs/${id}`, { method: 'DELETE' })
    setSelectedSuburbs(prev => { const n = new Set(prev); n.delete(id); return n })
    setCheckedSuburbs(prev => { const n = new Set(prev); n.delete(id); return n })
    fetchSuburbs()
    fetchListings()
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
    fetch(`${API}/report${params}`)
      .then(r => r.json())
      .then(data => setReport(data))
      .catch(() => setReport(null))
  }

  const cancelScrape = async () => {
    await fetch(`${API}/scrape/cancel`, { method: 'POST' })
    fetchScrapeStatus()
  }

  // Multi-status toggle
  const toggleStatus = (status) => {
    setSelectedStatuses(prev => {
      const n = new Set(prev)
      if (status === null) return new Set() // "ALL" clears the filter
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

  // --- Days on Market ---
  // DOM — only calculable when REIWA actually published a listing date.
  // We deliberately don't fall back to first_seen (the day our scraper first
  // saw the listing): that would invent a DOM. Better to show "-" than lie.
  const calcDOM = (listing) => {
    const dateStr = listing.listing_date
    if (!dateStr) return null
    let start
    // listing_date is dd/mm/yyyy format
    const ddmm = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (ddmm) {
      start = new Date(parseInt(ddmm[3]), parseInt(ddmm[2]) - 1, parseInt(ddmm[1]))
    } else {
      start = new Date(dateStr)
    }
    if (isNaN(start.getTime())) return null
    const end = listing.status === 'sold' && listing.sold_date ? new Date(listing.sold_date) : new Date()
    return Math.max(0, Math.floor((end - start) / (1000 * 60 * 60 * 24)))
  }

  // --- Sorting ---
  const parseDateToSortable = (dateStr) => {
    if (!dateStr) return ''
    // dd/mm/yyyy -> yyyy-mm-dd for proper sorting
    const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`
    return dateStr // ISO format already sortable
  }

  // withdrawn_date is stored as ISO ("2026-04-24T05:30:00"); display dd/mm/yyyy
  const formatIsoDate = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
  }

  const DESC_DEFAULT_FIELDS = new Set(['listing_date', 'dom', 'withdrawn_date'])
  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir(DESC_DEFAULT_FIELDS.has(field) ? 'desc' : 'asc') }
  }

  const deleteListing = async (listing) => {
    if (!listing?.id) return
    const label = listing.address || `#${listing.id}`
    if (!confirm(`Delete this ${listing.status || 'listing'}?\n\n${label}\n\nThis removes the row from the database. Cannot be undone (but a future scrape will re-add it if the URL reappears on REIWA).`)) return
    const res = await fetch(`${API}/listings/${listing.id}`, { method: 'DELETE' })
    if (res.ok) {
      fetchListings()
      fetchSuburbs()  // refresh per-suburb counts
    } else {
      alert('Delete failed')
    }
  }

  const sortedListings = [...listings].sort((a, b) => {
    // When no explicit sort, fall back to newest-first by listing_date
    const effectiveField = sortField || 'listing_date'
    const effectiveDir = sortField ? sortDir : 'desc'
    let va, vb
    if (effectiveField === 'dom') {
      va = calcDOM(a) ?? -1
      vb = calcDOM(b) ?? -1
    } else if (effectiveField === 'listing_date') {
      va = parseDateToSortable(a.listing_date)
      vb = parseDateToSortable(b.listing_date)
    } else {
      va = a[effectiveField]
      vb = b[effectiveField]
    }
    if (va == null) va = ''
    if (vb == null) vb = ''
    if (typeof va === 'number' && typeof vb === 'number')
      return effectiveDir === 'asc' ? va - vb : vb - va
    return effectiveDir === 'asc'
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va))
  })

  const filteredListings = sortedListings.filter(l => {
    if (selectedAgent && l.agent !== selectedAgent) return false
    if (selectedAgency && l.agency !== selectedAgency) return false
    return true
  })

  // Unique agents and agencies from current listings (after suburb/status filter)
  const uniqueAgents = [...new Set(listings.map(l => l.agent).filter(Boolean))].sort()
  const uniqueAgencies = [...new Set(listings.map(l => l.agency).filter(Boolean))].sort()

  const isAnyScraping = Object.values(scrapeStatus).some(j => j.status === 'running')

  const statusColors = {
    active: '#22c55e',
    under_offer: '#f59e0b',
    sold: '#3b82f6',
    withdrawn: '#ef4444',
  }

  // Scrape modal helpers
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
      <header>
        <h1>MarketScraper</h1>
        <div className="header-actions">
          <button
            className="btn btn-primary"
            onClick={scrapeSelected}
            disabled={isAnyScraping || checkedSuburbs.size === 0}
          >
            {isAnyScraping ? 'Scraping...' : `Scrape REIWA (${checkedSuburbs.size})`}
          </button>
          {isAnyScraping && (
            <button className="btn btn-secondary" onClick={() => setShowScrapeModal(true)}>
              View Progress
            </button>
          )}
          <button
            className="btn btn-export"
            onClick={() => {
              const params = new URLSearchParams()
              if (checkedSuburbs.size > 0) params.set('suburb_ids', Array.from(checkedSuburbs).join(','))
              if (selectedStatuses.size > 0) params.set('statuses', Array.from(selectedStatuses).join(','))
              if (selectedAgent) params.set('agent', selectedAgent)
              if (selectedAgency) params.set('agency', selectedAgency)
              window.open(`${API}/listings/export?${params.toString()}`, '_blank')
            }}
            disabled={filteredListings.length === 0}
          >
            Export Excel
          </button>
          <button
            className={`btn btn-report ${view === 'report' ? 'active' : ''}`}
            onClick={() => {
              if (view !== 'report') {
                setView('report')
                setReportSuburbs(new Set(checkedSuburbs))
                fetchReport(checkedSuburbs)
              } else {
                setView('listings')
              }
            }}
          >
            {view === 'report' ? 'View Listings' : 'Market Report'}
          </button>
          <button
            className={`btn btn-secondary ${view === 'logs' ? 'active' : ''}`}
            onClick={() => setView(v => v === 'logs' ? 'listings' : 'logs')}
          >
            {view === 'logs' ? 'View Listings' : 'View Logs'}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowThemeModal(true)}>
            Theme
          </button>
        </div>
      </header>

      {/* Theme Modal */}
      {showThemeModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowThemeModal(false) }}>
          <div className="modal theme-modal">
            <div className="modal-header">
              <h2>Customize Theme</h2>
              <button className="btn btn-icon" onClick={() => setShowThemeModal(false)}>x</button>
            </div>
            <div className="theme-presets">
              {Object.entries(presets).map(([name, colors]) => (
                <button
                  key={name}
                  className="theme-preset-btn"
                  style={{ background: colors.surface, color: colors.text, borderColor: colors.primary }}
                  onClick={() => setTheme(colors)}
                >
                  <span className="preset-dot" style={{ background: colors.primary }} />
                  {name}
                </button>
              ))}
            </div>
            <div className="theme-colors">
              {[
                ['bg', 'Background'],
                ['surface', 'Panels'],
                ['border', 'Borders'],
                ['text', 'Text'],
                ['textMuted', 'Text Secondary'],
                ['primary', 'Accent Color'],
              ].map(([key, label]) => (
                <div key={key} className="theme-color-row">
                  <label>{label}</label>
                  <div className="color-input-group">
                    <input
                      type="color"
                      value={theme[key]}
                      onChange={e => updateColor(key, e.target.value)}
                    />
                    <input
                      type="text"
                      value={theme[key]}
                      onChange={e => updateColor(key, e.target.value)}
                      className="color-hex"
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setTheme(defaultTheme)}>Reset</button>
              <button className="btn btn-primary" onClick={() => setShowThemeModal(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Scrape Progress Modal */}
      {showScrapeModal && scrapeJobs.length > 0 && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isAnyScraping) setShowScrapeModal(false) }}>
          <div className="modal">
            <div className="modal-header">
              <h2>Scraping Progress</h2>
              {!isAnyScraping && (
                <button className="btn btn-icon" onClick={() => setShowScrapeModal(false)}>×</button>
              )}
            </div>

            {/* Progress bar */}
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${totalJobs > 0 ? (completedCount / totalJobs) * 100 : 0}%` }}
              />
            </div>
            <div className="progress-stats">
              <span>{completedCount}/{totalJobs} suburbs done</span>
              <span>Elapsed: {formatTime(elapsed)}</span>
              {estimatedRemaining !== null && isAnyScraping && (
                <span>~{formatTime(estimatedRemaining)} remaining</span>
              )}
              {isAnyScraping && (
                <button className="btn btn-danger btn-small" onClick={cancelScrape}>
                  Cancel Scraping
                </button>
              )}
            </div>

            {/* Job list */}
            <div className="modal-jobs">
              {scrapeJobs.map(job => (
                <div key={job.id} className={`modal-job status-${job.status}`}>
                  <span className="job-name">{job.name}</span>
                  <span className={`job-status ${job.status}`}>
                    {job.status === 'running' && '⏳ '}
                    {job.status === 'completed' && '✓ '}
                    {job.status === 'cancelled' && '⊘ '}
                    {job.status === 'error' && '✗ '}
                    {job.progress || job.status}
                  </span>
                </div>
              ))}
            </div>

            {!isAnyScraping && (
              <div className="modal-footer">
                <button className="btn btn-primary" onClick={() => setShowScrapeModal(false)}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <h2>Suburbs</h2>
          <form onSubmit={addSuburb} className="add-form" ref={suggestionsRef}>
            <div className="autocomplete-wrapper">
              <input
                type="text"
                value={newSuburb}
                onChange={e => handleSuburbInput(e.target.value)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Type suburb name..."
                autoComplete="off"
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
            <div
              className={`suburb-item ${selectedSuburbs.size === 0 ? 'selected' : ''}`}
              onClick={() => setSelectedSuburbs(new Set())}
            >
              <span className="suburb-name">All Suburbs</span>
              <span className="suburb-count">
                {suburbs.reduce((s, x) => s + (x.active_count || 0) + (x.under_offer_count || 0), 0)}
              </span>
            </div>

            {suburbs.map(s => {
              const job = scrapeStatus[s.id]
              const isRunning = job?.status === 'running'
              const isViewing = selectedSuburbs.has(s.id)
              const isChecked = checkedSuburbs.has(s.id)

              return (
                <div key={s.id} className={`suburb-item ${isViewing ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    className="suburb-check"
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
          {view === 'report' && report ? (
            <div className="report-view">
              <h2>Market Report{reportSuburbs.size > 0 && reportSuburbs.size < suburbs.length
                ? ` — ${[...reportSuburbs].map(id => suburbs.find(s => s.id === id)?.name).filter(Boolean).join(', ')}`
                : ''}</h2>
              <div className="report-suburb-selector">
                <label className="report-check-item" onClick={() => {
                  if (reportSuburbs.size === suburbs.length) {
                    setReportSuburbs(new Set())
                  } else {
                    const all = new Set(suburbs.map(s => s.id))
                    setReportSuburbs(all)
                    fetchReport(all)
                  }
                }}>
                  <input type="checkbox" checked={reportSuburbs.size === suburbs.length} readOnly />
                  <span>All</span>
                </label>
                {suburbs.map(s => (
                  <label key={s.id} className="report-check-item" onClick={(e) => {
                    e.preventDefault()
                    const next = new Set(reportSuburbs)
                    if (next.has(s.id)) { next.delete(s.id) } else { next.add(s.id) }
                    setReportSuburbs(next)
                    if (next.size > 0) fetchReport(next)
                  }}>
                    <input type="checkbox" checked={reportSuburbs.has(s.id)} readOnly />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
              <div className="report-grid">
                <div className="report-card">
                  <h3>Overview</h3>
                  <div className="report-stats">
                    <div className="report-stat"><span className="stat-val">{report.summary?.active || 0}</span><span className="stat-label">Active</span></div>
                    <div className="report-stat"><span className="stat-val">{report.summary?.under_offer || 0}</span><span className="stat-label">Under Offer</span></div>
                    <div className="report-stat"><span className="stat-val">{report.summary?.sold || 0}</span><span className="stat-label">Sold</span></div>
                    <div className="report-stat"><span className="stat-val">{report.summary?.withdrawn || 0}</span><span className="stat-label">Withdrawn</span></div>
                  </div>
                </div>

                <div className="report-card">
                  <h3>Price Range (Active)</h3>
                  <div className="report-stats">
                    <div className="report-stat"><span className="stat-val">{report.price?.min ? `$${report.price.min.toLocaleString()}` : '-'}</span><span className="stat-label">Min</span></div>
                    <div className="report-stat"><span className="stat-val">{report.price?.median ? `$${report.price.median.toLocaleString()}` : '-'}</span><span className="stat-label">Median</span></div>
                    <div className="report-stat"><span className="stat-val">{report.price?.max ? `$${report.price.max.toLocaleString()}` : '-'}</span><span className="stat-label">Max</span></div>
                    <div className="report-stat"><span className="stat-val">{report.price?.count_with_price || 0}/{report.summary?.active || 0}</span><span className="stat-label">With Price</span></div>
                  </div>
                </div>

                <div className="report-card">
                  <h3>Days on Market (Active)</h3>
                  <div className="report-stats">
                    <div className="report-stat"><span className="stat-val">{report.dom?.avg ?? '-'}</span><span className="stat-label">Average</span></div>
                    <div className="report-stat"><span className="stat-val">{report.dom?.median ?? '-'}</span><span className="stat-label">Median</span></div>
                    <div className="report-stat"><span className="stat-val">{report.dom?.max ?? '-'}</span><span className="stat-label">Max</span></div>
                    <div className="report-stat stale"><span className="stat-val">{report.dom?.stale_count || 0}</span><span className="stat-label">Stale (60+)</span></div>
                  </div>
                </div>

                <div className="report-card">
                  <h3>Property Types</h3>
                  <div className="report-list">
                    {(report.property_types || []).map(([type, count]) => (
                      <div key={type} className="report-list-row">
                        <span>{type}</span><span className="report-count">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="report-tables">
                {/* Market Share */}
                {(report.market_share || []).length > 0 && (
                  <div className="report-table-section">
                    <h3>Market Share (Active Listings)</h3>
                    <div className="market-share-bars">
                      {report.market_share.slice(0, 10).map((ms, i) => (
                        <div key={ms.agency} className="share-row">
                          <span className="share-name">{ms.agency}</span>
                          <div className="share-bar-bg">
                            <div
                              className="share-bar-fill"
                              style={{ width: `${ms.pct}%`, opacity: 1 - (i * 0.06) }}
                            />
                          </div>
                          <span className="share-val">{ms.count} ({ms.pct}%)</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Market Share by Suburb */}
                {report.suburb_market_share && Object.keys(report.suburb_market_share).length > 1 && (
                  <div className="report-table-section">
                    <h3>Market Share by Suburb</h3>
                    {Object.entries(report.suburb_market_share).map(([suburb, agencies]) => (
                      <div key={suburb} className="suburb-share-block">
                        <h4>{suburb}</h4>
                        <div className="market-share-bars compact">
                          {agencies.slice(0, 5).map((ms, i) => (
                            <div key={ms.agency} className="share-row">
                              <span className="share-name">{ms.agency}</span>
                              <div className="share-bar-bg">
                                <div
                                  className="share-bar-fill"
                                  style={{ width: `${ms.pct}%`, opacity: 1 - (i * 0.08) }}
                                />
                              </div>
                              <span className="share-val">{ms.count} ({ms.pct}%)</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Price Drops */}
                {(report.price_drops || []).length > 0 && (
                  <div className="report-table-section">
                    <h3>Price Changes — Motivated Sellers</h3>
                    <table>
                      <thead><tr><th>Address</th><th>Suburb</th><th>Old Price</th><th>New Price</th><th>Drop</th><th>Agent</th><th>Agency</th><th>Link</th></tr></thead>
                      <tbody>
                        {report.price_drops.map((pd, i) => (
                          <tr key={i} className={pd.drop_amount ? 'price-drop-row' : ''}>
                            <td>{pd.address}</td>
                            <td>{pd.suburb}</td>
                            <td className="price-cell old-price">{pd.old_price || '-'}</td>
                            <td className="price-cell">{pd.new_price || '-'}</td>
                            <td className="num">
                              {pd.drop_amount
                                ? <span className="price-drop-badge">-${pd.drop_amount.toLocaleString()} ({pd.drop_pct}%)</span>
                                : <span className="price-change-badge">Changed</span>
                              }
                            </td>
                            <td>{pd.agent || '-'}</td>
                            <td>{pd.agency || '-'}</td>
                            <td className="link-cell">{pd.reiwa_url ? <a href={pd.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Historical Trends */}
                {(report.snapshots || []).length > 0 && (() => {
                  const dates = [...new Set(report.snapshots.map(s => s.snapshot_date))].sort()
                  const latestDate = dates[dates.length - 1]
                  const prevDate = dates.length > 1 ? dates[dates.length - 2] : null
                  const latest = report.snapshots.filter(s => s.snapshot_date === latestDate)
                  const prev = prevDate ? report.snapshots.filter(s => s.snapshot_date === prevDate) : []
                  const sumField = (arr, f) => arr.reduce((s, x) => s + (x[f] || 0), 0)
                  const latestActive = sumField(latest, 'active_count')
                  const prevActive = prev.length > 0 ? sumField(prev, 'active_count') : null
                  const latestUO = sumField(latest, 'under_offer_count')
                  const prevUO = prev.length > 0 ? sumField(prev, 'under_offer_count') : null
                  const medians = latest.map(s => s.median_price).filter(Boolean)
                  const latestMedian = medians.length > 0 ? Math.round(medians.reduce((a,b) => a+b, 0) / medians.length) : null
                  const prevMedians = prev.map(s => s.median_price).filter(Boolean)
                  const prevMedian = prevMedians.length > 0 ? Math.round(prevMedians.reduce((a,b) => a+b, 0) / prevMedians.length) : null
                  const delta = (cur, prv) => {
                    if (prv === null || prv === undefined) return null
                    const d = cur - prv
                    if (d === 0) return '='
                    return d > 0 ? `+${d}` : `${d}`
                  }
                  return (
                    <div className="report-table-section">
                      <h3>Market Trends</h3>
                      <p className="trend-subtitle">{dates.length} snapshot{dates.length > 1 ? 's' : ''} recorded (latest: {latestDate})</p>
                      <div className="trend-cards">
                        <div className="trend-card">
                          <span className="trend-val">{latestActive}</span>
                          <span className="trend-label">Active Listings</span>
                          {prevActive !== null && <span className={`trend-delta ${latestActive > prevActive ? 'up' : latestActive < prevActive ? 'down' : ''}`}>{delta(latestActive, prevActive)} vs prev</span>}
                        </div>
                        <div className="trend-card">
                          <span className="trend-val">{latestUO}</span>
                          <span className="trend-label">Under Offer</span>
                          {prevUO !== null && <span className={`trend-delta ${latestUO > prevUO ? 'up' : latestUO < prevUO ? 'down' : ''}`}>{delta(latestUO, prevUO)} vs prev</span>}
                        </div>
                        {latestMedian && (
                          <div className="trend-card">
                            <span className="trend-val">${latestMedian.toLocaleString()}</span>
                            <span className="trend-label">Median Price</span>
                            {prevMedian && <span className={`trend-delta ${latestMedian > prevMedian ? 'up' : latestMedian < prevMedian ? 'down' : ''}`}>{latestMedian > prevMedian ? '+' : ''}{((latestMedian - prevMedian) / prevMedian * 100).toFixed(1)}% vs prev</span>}
                          </div>
                        )}
                      </div>
                      {dates.length > 1 && (
                        <table className="snapshot-table">
                          <thead>
                            <tr><th>Date</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th><th>New</th><th>Median Price</th><th>Avg DOM</th></tr>
                          </thead>
                          <tbody>
                            {dates.slice().reverse().map(date => {
                              const snaps = report.snapshots.filter(s => s.snapshot_date === date)
                              return (
                                <tr key={date}>
                                  <td>{date}</td>
                                  <td className="num">{sumField(snaps, 'active_count')}</td>
                                  <td className="num">{sumField(snaps, 'under_offer_count')}</td>
                                  <td className="num">{sumField(snaps, 'sold_count')}</td>
                                  <td className="num">{sumField(snaps, 'withdrawn_count')}</td>
                                  <td className="num">{sumField(snaps, 'new_count')}</td>
                                  <td className="num">{(() => { const ps = snaps.map(s => s.median_price).filter(Boolean); return ps.length ? `$${Math.round(ps.reduce((a,b)=>a+b,0)/ps.length).toLocaleString()}` : '-' })()}</td>
                                  <td className="num">{(() => { const ds = snaps.map(s => s.avg_dom).filter(Boolean); return ds.length ? Math.round(ds.reduce((a,b)=>a+b,0)/ds.length) : '-' })()}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )
                })()}

                <div className="report-table-section">
                  <h3>Top Agencies</h3>
                  <table>
                    <thead><tr><th>Agency</th><th>Total</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th></tr></thead>
                    <tbody>
                      {(report.agencies || []).map(([name, stats]) => (
                        <tr key={name}>
                          <td>{name}</td><td className="num">{stats.total}</td>
                          <td className="num">{stats.active}</td><td className="num">{stats.under_offer}</td>
                          <td className="num">{stats.sold}</td><td className="num">{stats.withdrawn}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="report-table-section">
                  <h3>Top Agents</h3>
                  <table>
                    <thead><tr><th>Agent</th><th>Total</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th></tr></thead>
                    <tbody>
                      {(report.agents || []).map(([name, stats]) => (
                        <tr key={name}>
                          <td>{name}</td><td className="num">{stats.total}</td>
                          <td className="num">{stats.active}</td><td className="num">{stats.under_offer}</td>
                          <td className="num">{stats.sold}</td><td className="num">{stats.withdrawn}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {report.stale_listings?.length > 0 && (
                  <div className="report-table-section">
                    <h3>Stale Listings (60+ Days) — Potential Leads</h3>
                    <table>
                      <thead><tr><th>Address</th><th>Suburb</th><th>Price</th><th>Agent</th><th>Agency</th><th>DOM</th><th>Link</th></tr></thead>
                      <tbody>
                        {report.stale_listings.map((l, i) => (
                          <tr key={i} className="stale-row">
                            <td>{l.address}</td><td>{l.suburb}</td><td>{l.price || '-'}</td>
                            <td>{l.agent || '-'}</td><td>{l.agency || '-'}</td>
                            <td className="num stale">{l.dom}</td>
                            <td className="link-cell">{l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {report.withdrawn_listings?.length > 0 && (
                  <div className="report-table-section">
                    <h3>Withdrawn Listings — Prospection Targets</h3>
                    <table>
                      <thead><tr><th>Address</th><th>Suburb</th><th>Price</th><th>Agent</th><th>Agency</th><th>Link</th></tr></thead>
                      <tbody>
                        {report.withdrawn_listings.map((l, i) => (
                          <tr key={i} className="withdrawn-row">
                            <td>{l.address}</td><td>{l.suburb}</td><td>{l.price || '-'}</td>
                            <td>{l.agent || '-'}</td><td>{l.agency || '-'}</td>
                            <td className="link-cell">{l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {(report.suburbs || []).length > 1 && (
                  <div className="report-table-section">
                    <h3>Suburb Breakdown</h3>
                    <table>
                      <thead><tr><th>Suburb</th><th>Total</th><th>Active</th><th>Under Offer</th><th>Sold</th><th>Withdrawn</th></tr></thead>
                      <tbody>
                        {report.suburbs.map(([name, stats]) => (
                          <tr key={name}>
                            <td>{name}</td><td className="num">{stats.total}</td>
                            <td className="num">{stats.active}</td><td className="num">{stats.under_offer}</td>
                            <td className="num">{stats.sold}</td><td className="num">{stats.withdrawn}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : view === 'listings' ? (
            <>
              <div className="filters">
                <button
                  className={`filter-btn ${selectedStatuses.size === 0 ? 'active' : ''}`}
                  onClick={() => toggleStatus(null)}
                >
                  ALL
                </button>
                {['active', 'under_offer', 'sold', 'withdrawn'].map(s => (
                  <button
                    key={s}
                    className={`filter-btn ${selectedStatuses.has(s) ? 'active' : ''}`}
                    onClick={() => toggleStatus(s)}
                    style={selectedStatuses.has(s) ? { borderColor: statusColors[s], backgroundColor: statusColors[s] + '33', color: statusColors[s] } : { borderColor: statusColors[s] }}
                  >
                    {s.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
                <div className="filter-separator" />

                <select
                  className="filter-select"
                  value={selectedAgency}
                  onChange={e => setSelectedAgency(e.target.value)}
                >
                  <option value="">All Agencies</option>
                  {uniqueAgencies.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>

                <select
                  className="filter-select"
                  value={selectedAgent}
                  onChange={e => setSelectedAgent(e.target.value)}
                >
                  <option value="">All Agents</option>
                  {uniqueAgents.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>

                <span className="listing-count">
                  {filteredListings.length} listing{filteredListings.length !== 1 ? 's' : ''}
                  {checkedSuburbs.size > 0 && checkedSuburbs.size < suburbs.length && ` (${checkedSuburbs.size} suburb${checkedSuburbs.size > 1 ? 's' : ''})`}
                  {selectedAgency && ` · ${selectedAgency}`}
                  {selectedAgent && ` · ${selectedAgent}`}
                </span>
              </div>

              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      {[
                        ['address', 'Address'],
                        ['suburb_name', 'Suburb'],
                        ['price_text', 'Price'],
                        ['bedrooms', 'Bed'],
                        ['bathrooms', 'Bath'],
                        ['parking', 'Car'],
                        ['land_size', 'Land'],
                        ['internal_size', 'Internal'],
                        ['agency', 'Agency'],
                        ['agent', 'Agent'],
                        ['listing_date', 'Listed'],
                        ['dom', 'DOM'],
                        ['withdrawn_date', 'Withdrawn'],
                        ['status', 'Status'],
                        ['listing_type', 'Type'],
                      ].map(([field, label]) => (
                        <th key={field} onClick={() => toggleSort(field)} className="sortable">
                          {label}
                          {sortField === field && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                        </th>
                      ))}
                      <th>Link</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredListings.map((l, i) => (
                      <tr key={l.id || i} className={`status-${l.status}`}>
                        <td className="address-cell">
                          {l.reiwa_url ? (
                            <a href={l.reiwa_url} target="_blank" rel="noopener">{l.address}</a>
                          ) : l.address}
                        </td>
                        <td>{l.suburb_name}</td>
                        <td className="price-cell">{l.price_text || '-'}</td>
                        <td className="num">{l.bedrooms ?? '-'}</td>
                        <td className="num">{l.bathrooms ?? '-'}</td>
                        <td className="num">{l.parking ?? '-'}</td>
                        <td>{l.land_size || '-'}</td>
                        <td>{l.internal_size || '-'}</td>
                        <td className="agency-cell">{l.agency || '-'}</td>
                        <td>{l.agent || '-'}</td>
                        <td className="date-cell">{l.listing_date || '-'}</td>
                        <td className={`num ${(calcDOM(l) ?? 0) >= 60 ? 'stale' : ''}`}>
                          {calcDOM(l) != null ? calcDOM(l) : '-'}
                          {(calcDOM(l) ?? 0) >= 60 && <span className="stale-flag" title="60+ days on market — potential lead">!</span>}
                        </td>
                        <td className="date-cell">{formatIsoDate(l.withdrawn_date) || '-'}</td>
                        <td>
                          <span className="status-badge" style={{ backgroundColor: statusColors[l.status] || '#666' }}>
                            {l.status?.replace('_', ' ')}
                          </span>
                        </td>
                        <td>{l.listing_type || '-'}</td>
                        <td className="link-cell">
                          {l.reiwa_url ? (
                            <a href={l.reiwa_url} target="_blank" rel="noopener">View</a>
                          ) : '-'}
                        </td>
                        <td className="link-cell">
                          <button
                            className="btn-delete-row"
                            title={`Delete this ${l.status} listing`}
                            onClick={() => deleteListing(l)}
                          >×</button>
                        </td>
                      </tr>
                    ))}
                    {filteredListings.length === 0 && (
                      <tr>
                        <td colSpan="17" className="empty">
                          {suburbs.length === 0
                            ? 'Add a suburb to get started'
                            : 'No listings yet. Click "Scrape" to fetch data.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="logs-view">
              <h2>Scrape History</h2>
              <button className="btn btn-small" onClick={fetchLogs}>Refresh</button>
              <table className="logs-table">
                <thead>
                  <tr>
                    <th>Suburb</th>
                    <th>Started</th>
                    <th>Completed</th>
                    <th>For Sale</th>
                    <th>Sold</th>
                    <th>New</th>
                    <th>Updated</th>
                    <th>Withdrawn</th>
                    <th>Errors</th>
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

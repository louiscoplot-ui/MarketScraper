import { useState, useEffect, useCallback, useRef } from 'react'

const API = '/api'

function App() {
  const [suburbs, setSuburbs] = useState([])
  const [listings, setListings] = useState([])
  const [selectedSuburbs, setSelectedSuburbs] = useState(new Set())
  const [checkedSuburbs, setCheckedSuburbs] = useState(new Set())
  const [selectedStatuses, setSelectedStatuses] = useState(new Set())
  const [newSuburb, setNewSuburb] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [scrapeStatus, setScrapeStatus] = useState({})
  const [showScrapeModal, setShowScrapeModal] = useState(false)
  const [logs, setLogs] = useState([])
  const [view, setView] = useState('listings')
  const [sortField, setSortField] = useState('listing_date')
  const [sortDir, setSortDir] = useState('desc')
  const [selectedAgent, setSelectedAgent] = useState('')
  const [selectedAgency, setSelectedAgency] = useState('')
  const [showThemeModal, setShowThemeModal] = useState(false)

  const defaultTheme = {
    bg: '#0f172a', surface: '#1e293b', surfaceHover: '#334155', border: '#334155',
    text: '#e2e8f0', textMuted: '#94a3b8', primary: '#3b82f6',
  }

  const presets = {
    'Dark (Default)': { bg: '#0f172a', surface: '#1e293b', surfaceHover: '#334155', border: '#334155', text: '#e2e8f0', textMuted: '#94a3b8', primary: '#3b82f6' },
    'Belle Property': { bg: '#1a2e22', surface: '#243d2e', surfaceHover: '#2f5040', border: '#3a5f4a', text: '#f0f5f2', textMuted: '#a8c5b0', primary: '#c9a84c' },
    'Light': { bg: '#f8fafc', surface: '#ffffff', surfaceHover: '#f1f5f9', border: '#e2e8f0', text: '#1e293b', textMuted: '#64748b', primary: '#3b82f6' },
    'Green Agency': { bg: '#0f1f0f', surface: '#1a2e1a', surfaceHover: '#2d4a2d', border: '#2d4a2d', text: '#e2f0e2', textMuted: '#8fbc8f', primary: '#22c55e' },
    'Gold Luxury': { bg: '#1a1710', surface: '#2a2518', surfaceHover: '#3d3522', border: '#3d3522', text: '#f0e6d0', textMuted: '#c4a96a', primary: '#d4a843' },
  }

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('ms_theme')
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
    localStorage.setItem('ms_theme', JSON.stringify(theme))
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
  const calcDOM = (listing) => {
    const dateStr = listing.listing_date || listing.first_seen
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
  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const sortedListings = [...listings].sort((a, b) => {
    let va = sortField === 'dom' ? (calcDOM(a) ?? -1) : a[sortField]
    let vb = sortField === 'dom' ? (calcDOM(b) ?? -1) : b[sortField]
    if (va == null) va = ''
    if (vb == null) vb = ''
    if (typeof va === 'number' && typeof vb === 'number')
      return sortDir === 'asc' ? va - vb : vb - va
    return sortDir === 'asc'
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
    const suburb = suburbs.find(s => s.id === parseInt(id))
    return { id, name: suburb?.name || `Suburb ${id}`, ...job }
  }).filter(j => j.status === 'running' || j.status === 'completed' || j.status === 'error')

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
            {isAnyScraping ? 'Scraping...' : `Scrape Selected (${checkedSuburbs.size})`}
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
            </div>

            {/* Job list */}
            <div className="modal-jobs">
              {scrapeJobs.map(job => (
                <div key={job.id} className={`modal-job status-${job.status}`}>
                  <span className="job-name">{job.name}</span>
                  <span className={`job-status ${job.status}`}>
                    {job.status === 'running' && '⏳ '}
                    {job.status === 'completed' && '✓ '}
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
          {view === 'listings' ? (
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
                        ['status', 'Status'],
                        ['listing_type', 'Type'],
                      ].map(([field, label]) => (
                        <th key={field} onClick={() => toggleSort(field)} className="sortable">
                          {label}
                          {sortField === field && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                        </th>
                      ))}
                      <th>Link</th>
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
                      </tr>
                    ))}
                    {filteredListings.length === 0 && (
                      <tr>
                        <td colSpan="14" className="empty">
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

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
  const [sortField, setSortField] = useState('address')
  const [sortDir, setSortDir] = useState('asc')
  const [selectedAgent, setSelectedAgent] = useState('')
  const [selectedAgency, setSelectedAgency] = useState('')
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

  const selectSuggestion = (name) => {
    setNewSuburb(name)
    setSuggestions([])
    setShowSuggestions(false)
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

  // --- Sorting ---
  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const sortedListings = [...listings].sort((a, b) => {
    let va = a[sortField], vb = b[sortField]
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
            className={`btn btn-secondary ${view === 'logs' ? 'active' : ''}`}
            onClick={() => setView(v => v === 'logs' ? 'listings' : 'logs')}
          >
            {view === 'logs' ? 'View Listings' : 'View Logs'}
          </button>
        </div>
      </header>

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
                    style={{ borderColor: statusColors[s] }}
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
                        ['status', 'Status'],
                        ['listing_type', 'Type'],
                        ['first_seen', 'First Seen'],
                        ['last_seen', 'Last Seen'],
                      ].map(([field, label]) => (
                        <th key={field} onClick={() => toggleSort(field)} className="sortable">
                          {label}
                          {sortField === field && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                        </th>
                      ))}
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
                        <td>
                          <span className="status-badge" style={{ backgroundColor: statusColors[l.status] || '#666' }}>
                            {l.status?.replace('_', ' ')}
                          </span>
                        </td>
                        <td>{l.listing_type || '-'}</td>
                        <td className="date-cell">{l.first_seen ? new Date(l.first_seen).toLocaleDateString() : '-'}</td>
                        <td className="date-cell">{l.last_seen ? new Date(l.last_seen).toLocaleDateString() : '-'}</td>
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

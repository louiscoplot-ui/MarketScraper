// Top navigation — tab-based, neutral palette, logo slot reserved.
// Replaces the button row that lived inline in App.jsx.
//
// All state lives in App.jsx; this is a presentational component that
// receives view + handlers via props.

const TABS = [
  { id: 'listings', label: 'Listings' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'report', label: 'Market Report' },
  { id: 'hot-vendors', label: 'Hot Vendors' },
  { id: 'logs', label: 'History' },
  { id: 'admin', label: 'Admin' },
]


export default function Header({
  view, setView,
  checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency,
  filteredListingsCount,
  isAnyScraping, scrapeSelected, setShowScrapeModal,
  setReportSuburbs, fetchReport,
  setShowThemeModal,
}) {
  const handleTabClick = (id) => {
    if (id === 'report') {
      setView('report')
      setReportSuburbs(new Set(checkedSuburbs))
      fetchReport(checkedSuburbs)
    } else {
      setView(id)
    }
  }

  const handleExport = () => {
    const params = new URLSearchParams()
    if (checkedSuburbs.size > 0) params.set('suburb_ids', Array.from(checkedSuburbs).join(','))
    if (selectedStatuses.size > 0) params.set('statuses', Array.from(selectedStatuses).join(','))
    if (selectedAgent) params.set('agent', selectedAgent)
    if (selectedAgency) params.set('agency', selectedAgency)
    window.open(`/api/listings/export?${params.toString()}`, '_blank')
  }

  return (
    <header className="app-header">
      <div className="brand">
        {/* Logo slot — left empty intentionally. When you have an
            approved logo asset, drop an <img src=... /> in here. */}
        <div className="logo-slot" aria-label="Logo" />
        <span className="brand-text">AgentDeck</span>
      </div>

      <nav className="tabs" aria-label="Primary">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab${view === t.id ? ' active' : ''}`}
            onClick={() => handleTabClick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={scrapeSelected}
          disabled={isAnyScraping || checkedSuburbs.size === 0}
        >
          {isAnyScraping ? 'Scraping…' : `Scrape (${checkedSuburbs.size})`}
        </button>
        {isAnyScraping && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowScrapeModal(true)}>
            Progress
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleExport}
          disabled={filteredListingsCount === 0}
        >
          Export
        </button>
        <button
          className="btn btn-ghost btn-icon-sm"
          onClick={() => setShowThemeModal(true)}
          aria-label="Theme settings"
          title="Theme"
        >
          ⚙
        </button>
      </div>
    </header>
  )
}

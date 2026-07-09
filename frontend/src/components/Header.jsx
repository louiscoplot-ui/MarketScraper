// Top navigation — tab-based, neutral palette, logo slot reserved.
// Replaces the button row that lived inline in App.jsx.
//
// All state lives in App.jsx; this is a presentational component that
// receives view + handlers via props.

import { useState } from 'react'
import { getTheme, toggleTheme } from '../lib/themeFlag'

// 4-block grid mark — same source as brand/logo.svg, inlined so the
// header doesn't need a network round-trip to render.
function LogoMark({ size = 22 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="9" height="9" rx="2" />
      <rect x="13" y="2" width="9" height="9" rx="2" />
      <rect x="2" y="13" width="9" height="9" rx="2" />
      <rect x="13" y="13" width="9" height="9" rx="2" />
    </svg>
  )
}

function ThemeToggle() {
  // Local state purely for re-render on toggle — the source of truth
  // is the data-theme attribute that themeFlag.applyTheme() sets.
  const [, force] = useState(0)
  const t = getTheme()
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => { toggleTheme(); force(n => n + 1) }}
      title="Toggle SuburbDesk visual identity (instant rollback if you don't like the new look)"
    >
      <span className="dot" />
      {t === 'v2' ? 'v2' : 'classic'}
    </button>
  )
}

// Listings first — it's the tab operators open most, and it loads fast
// (cached listings) so a returning visit paints immediately instead of
// waiting on the slower /api/brief/today call. Today sits right after.
const TABS = [
  { id: 'listings', label: 'Listings' },
  { id: 'today', label: 'Today' },
  { id: 'signals', label: 'Signals' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'appraisals', label: 'Appraisals' },
  { id: 'report', label: 'Market Report' },
  { id: 'hot-vendors', label: 'Hot Vendors' },
  // The 'rentals' tab is appended dynamically based on me.rental_access
  // / role inside the component — keeps the constant array static
  // while still gating the new module behind a per-user flag.
  { id: 'logs', label: 'History' },
  { id: 'admin', label: 'Admin' },
]


export default function Header({
  view, setView,
  checkedSuburbs, selectedStatuses, selectedAgent, selectedAgency,
  filteredListingsCount,
  isAnyScraping, scrapeSelected, setShowScrapeModal,
  setReportSuburbs, fetchReport, reportSuburbs, hasReport,
  setShowThemeModal,
  setShowAccountModal,
  me,
  // Desk redesign: in railMode the vertical Rail owns navigation, so the
  // header collapses to just its action cluster (Scrape / Export /
  // Account) as a slim top strip. onEnterDesk opens the redesign from the
  // classic header.
  railMode = false,
  onEnterDesk,
}) {
  // Insert "Rental" between Hot Vendors and History when the caller has
  // access. Admin (role) implicitly has access. rental_access is a 0/1
  // INTEGER from SQLite / bool from psycopg2 — `!!` coerces both.
  // Admin tab is filtered out entirely for non-admins — without this
  // guard regular users saw the tab and got a permission error when
  // they clicked it.
  const visibleTabs = (() => {
    const isAdmin = !!me && (me.role || '').toLowerCase() === 'admin'
    const hasRental = isAdmin || !!(me && me.rental_access)
    const base = TABS.filter(t => t.id !== 'admin' || isAdmin)
    if (!hasRental) return base
    const out = []
    for (const t of base) {
      out.push(t)
      if (t.id === 'hot-vendors') out.push({ id: 'rentals', label: 'Rental' })
    }
    return out
  })()
  const handleTabClick = (id) => {
    if (id === 'report') {
      setView('report')
      // Keep the previous Market Report selection across tab visits.
      // Resetting to checkedSuburbs every click changed the cache key
      // → cold-start refetch every return → user saw 2min spinner
      // every time. Only seed from the sidebar checkboxes the FIRST
      // time the user visits the report (no existing report or
      // selection yet). After that, the report's own checkboxes
      // own the selection.
      if (!hasReport && (!reportSuburbs || reportSuburbs.size === 0)) {
        const seed = new Set(checkedSuburbs)
        setReportSuburbs(seed)
        fetchReport(seed)
      } else {
        // Re-fetch in background only if needed; cache hit makes it
        // instant for the same selection.
        fetchReport(reportSuburbs)
      }
    } else {
      setView(id)
    }
  }

  const [isExporting, setIsExporting] = useState(false)
  const handleExport = async () => {
    const params = new URLSearchParams()
    if (checkedSuburbs.size > 0) params.set('suburb_ids', Array.from(checkedSuburbs).join(','))
    if (selectedStatuses.size > 0) params.set('statuses', Array.from(selectedStatuses).join(','))
    if (selectedAgent) params.set('agent', selectedAgent)
    if (selectedAgency) params.set('agency', selectedAgency)
    setIsExporting(true)
    try {
      const resp = await fetch(`/api/listings/export?${params.toString()}`)
      if (!resp.ok) throw new Error(await resp.text())
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      let filename = 'SuburbDesk_export.xlsx'
      const cd = resp.headers.get('Content-Disposition') || ''
      const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)
      if (m) filename = decodeURIComponent(m[1])
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
      alert('Could not export — please refresh and try again.')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <header className="app-header">
      {!railMode && (
        <a href="/" className="brand brand-logo-mark">
          <LogoMark size={22} />
          <span className="brand-text">SuburbDesk</span>
        </a>
      )}

      {!railMode && (
        <nav className="tabs" aria-label="Primary">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              className={`tab header-tab${view === t.id ? ' active' : ''}`}
              onClick={() => handleTabClick(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}

      <div className="actions">
        {!railMode && onEnterDesk && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onEnterDesk}
            title="Aperçu de la nouvelle interface « The Morning Desk » (réversible en un clic)"
          >
            ✦ Nouveau design
          </button>
        )}
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
          disabled={filteredListingsCount === 0 || isExporting}
        >
          {isExporting ? 'Exporting…' : 'Export'}
        </button>
        <ThemeToggle />
        {setShowAccountModal && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAccountModal(true)}
            title={me && me.password_set ? 'Change your password' : 'Set a password'}
          >
            Account
          </button>
        )}
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

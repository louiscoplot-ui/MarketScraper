// Market Report view — extracted from App.jsx to keep modules under
// the MCP push size limit. All state still lives in App.jsx; this
// component is purely presentational.

const PERTH_TZ = 'Australia/Perth'

// Backend stores changed_at as naive UTC (datetime('now') / utcnow().
// isoformat()). Force-interpret as UTC so JS doesn't read it as local.
function _toUtcDate(s) {
  if (!s) return null
  let iso = String(s).includes('T') ? String(s) : String(s).replace(' ', 'T')
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

function fmtPerthFull(s) {
  const d = _toUtcDate(s)
  if (!d) return ''
  return d.toLocaleString('en-AU', {
    timeZone: PERTH_TZ,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Compact "when" cell — relative for recent events, absolute date
// after a week so the agent can scan the table at a glance.
//
// If the date is missing or unparseable, return '—' (em dash) so the
// cell is never visually blank — that ambiguity used to read as 'no
// data' rather than 'unknown'.
function fmtRelative(s) {
  const d = _toUtcDate(s)
  if (!d) return s ? String(s) : '—'
  const ms = Date.now() - d.getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-AU', {
    timeZone: PERTH_TZ, day: '2-digit', month: 'short',
  })
}

export default function Report({ report, suburbs, reportSuburbs, setReportSuburbs, fetchReport, reportLoading }) {
  // Render the header + suburb selector even while loading so the
  // checkboxes update instantly when the user toggles them. The data
  // area below swaps to a loading indicator until the new fetch lands.
  return (
    <div className="report-view">
      <h2>Market Report{reportSuburbs.size > 0 && reportSuburbs.size < suburbs.length
        ? ` — ${[...reportSuburbs].map(id => suburbs.find(s => s.id === id)?.name).filter(Boolean).join(', ')}`
        : ''}</h2>
      <div className="report-suburb-selector">
        {/* Native onChange instead of label-onClick + readOnly so the
            browser ticks the box instantly on click — the React state
            update + report refetch run after, asynchronously, and don't
            block the visual feedback. */}
        <label className="report-check-item">
          <input
            type="checkbox"
            checked={reportSuburbs.size === suburbs.length && suburbs.length > 0}
            onChange={(e) => {
              if (e.target.checked) {
                const all = new Set(suburbs.map(s => s.id))
                setReportSuburbs(all)
                fetchReport(all)
              } else {
                setReportSuburbs(new Set())
              }
            }}
          />
          <span>All</span>
        </label>
        {suburbs.map(s => (
          <label key={s.id} className="report-check-item">
            <input
              type="checkbox"
              checked={reportSuburbs.has(s.id)}
              onChange={(e) => {
                const next = new Set(reportSuburbs)
                if (e.target.checked) next.add(s.id)
                else next.delete(s.id)
                setReportSuburbs(next)
                if (next.size > 0) fetchReport(next)
              }}
            />
            <span>{s.name}</span>
          </label>
        ))}
      </div>
      {(!report || reportLoading) ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 12, padding: '48px 24px', textAlign: 'center',
        }}>
          <div className="loading-spinner" />
          <div style={{ fontWeight: 600, fontSize: 14, color: '#1C1D22' }}>
            Loading market report…
          </div>
          <div style={{ fontSize: 12, color: '#6B6C75', maxWidth: 380, lineHeight: 1.5 }}>
            Crunching listings, agency share, price changes and snapshots.
            First load can take 15–30 seconds while the server warms up.
          </div>
        </div>
      ) : (
      <>
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
        {(report.market_share || []).length > 0 && (
          <div className="report-table-section">
            <h3>Market Share (Active Listings)</h3>
            <div className="market-share-bars">
              {report.market_share.slice(0, 10).map((ms, i) => (
                <div key={ms.agency} className="share-row">
                  <span className="share-name">{ms.agency}</span>
                  <div className="share-bar-bg">
                    <div className="share-bar-fill" style={{ width: `${ms.pct}%`, opacity: 1 - (i * 0.06) }} />
                  </div>
                  <span className="share-val">{ms.count} ({ms.pct}%)</span>
                </div>
              ))}
            </div>
          </div>
        )}

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
                        <div className="share-bar-fill" style={{ width: `${ms.pct}%`, opacity: 1 - (i * 0.08) }} />
                      </div>
                      <span className="share-val">{ms.count} ({ms.pct}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {(report.price_drops || []).length > 0 && (
          <div className="report-table-section">
            <h3>Price Changes — Motivated Sellers <span className="muted-count">(latest 15)</span></h3>
            <table>
              <thead><tr><th>Address</th><th>Suburb</th><th>Old Price</th><th>New Price</th><th>Drop</th><th>When</th><th>Agent</th><th>Agency</th><th>Link</th></tr></thead>
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
                    <td className="when-cell" title={fmtPerthFull(pd.changed_at)}>
                      {fmtRelative(pd.changed_at)}
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
      </>
      )}
    </div>
  )
}

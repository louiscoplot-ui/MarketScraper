// Listings table + filter bar — extracted from App.jsx to keep modules
// under the MCP push size limit. State stays in App.jsx; this is a
// presentational component that takes everything via props.

import EditableDateCell from '../components/EditableDateCell'


// HTML5 date input emits YYYY-MM-DD. listing_date in the DB is
// DD/MM/YYYY, the rest are stored as ISO. Convert at the boundary.
function isoToDmy(iso) {
  if (!iso) return null
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
}


export default function ListingsView({
  selectedStatuses, toggleStatus, statusColors,
  selectedAgency, setSelectedAgency, uniqueAgencies,
  selectedAgent, setSelectedAgent, uniqueAgents,
  filteredListings, suburbs, checkedSuburbs,
  sortField, sortDir, toggleSort,
  calcDOM, formatIsoDate, deleteListing, updateListing,
}) {
  return (
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
            style={selectedStatuses.has(s)
              ? { borderColor: statusColors[s], backgroundColor: statusColors[s] + '33', color: statusColors[s] }
              : { borderColor: statusColors[s] }}
          >
            {s.replace('_', ' ').toUpperCase()}
          </button>
        ))}
        <div className="filter-separator" />

        <select className="filter-select" value={selectedAgency} onChange={e => setSelectedAgency(e.target.value)}>
          <option value="">All Agencies</option>
          {uniqueAgencies.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        <select className="filter-select" value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)}>
          <option value="">All Agents</option>
          {uniqueAgents.map(a => <option key={a} value={a}>{a}</option>)}
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
                ['sold_date', 'Sold'],
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
                  {l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">{l.address}</a> : l.address}
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
                <td className="date-cell">
                  <EditableDateCell
                    value={l.listing_date}
                    onSave={(iso) => updateListing(l.id, { listing_date: isoToDmy(iso) })}
                  />
                </td>
                <td className={`num ${(calcDOM(l) ?? 0) >= 60 ? 'stale' : ''}`}>
                  {calcDOM(l) != null ? calcDOM(l) : '-'}
                  {(calcDOM(l) ?? 0) >= 60 && <span className="stale-flag" title="60+ days on market — potential lead">!</span>}
                </td>
                <td className="date-cell">
                  <EditableDateCell
                    value={l.withdrawn_date}
                    onSave={(iso) => updateListing(l.id, { withdrawn_date: iso })}
                  />
                </td>
                <td className="date-cell">
                  <EditableDateCell
                    value={l.sold_date}
                    onSave={(iso) => updateListing(l.id, { sold_date: iso })}
                  />
                </td>
                <td>
                  <span className="status-badge" style={{ backgroundColor: statusColors[l.status] || '#666' }}>
                    {l.status?.replace('_', ' ')}
                  </span>
                </td>
                <td>{l.listing_type || '-'}</td>
                <td className="link-cell">
                  {l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}
                </td>
                <td className="link-cell">
                  <button className="btn-delete-row" title={`Delete this ${l.status} listing`} onClick={() => deleteListing(l)}>×</button>
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
  )
}

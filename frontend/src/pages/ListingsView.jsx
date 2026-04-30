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
  // Smart column visibility — hide noise columns when:
  //   (a) the filter excludes that status (e.g. "Withdrawn" off → hide
  //       the Withdrawn column), AND
  //   (b) no row in the current filtered set actually has that date
  //       (so a stray sold_date on an Under Offer row still shows).
  // ALL = empty filter = show every column that has data.
  const filterAll = selectedStatuses.size === 0
  const anyListing = filteredListings.some(l => l.listing_date)
  const anySold = filteredListings.some(l => l.sold_date)
  const anyWithdrawn = filteredListings.some(l => l.withdrawn_date)

  const showListed = anyListing || selectedStatuses.has('active') || selectedStatuses.has('under_offer')
  const showDom = showListed
  const showSold = anySold || selectedStatuses.has('sold')
  const showWithdrawn = anyWithdrawn || selectedStatuses.has('withdrawn')

  // Single source of truth for the columns rendered — header + body
  // both walk this array so they can never drift.
  const columns = [
    { field: 'address', label: 'Address', sortable: true,
      cell: (l) => (
        <td className="address-cell">
          {l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">{l.address}</a> : l.address}
        </td>
      ) },
    { field: 'suburb_name', label: 'Suburb', sortable: true,
      cell: (l) => <td>{l.suburb_name}</td> },
    { field: 'price_text', label: 'Price', sortable: true,
      cell: (l) => <td className="price-cell">{l.price_text || '-'}</td> },
    { field: 'bedrooms', label: 'Bed', sortable: true,
      cell: (l) => <td className="num">{l.bedrooms ?? '-'}</td> },
    { field: 'bathrooms', label: 'Bath', sortable: true,
      cell: (l) => <td className="num">{l.bathrooms ?? '-'}</td> },
    { field: 'parking', label: 'Car', sortable: true,
      cell: (l) => <td className="num">{l.parking ?? '-'}</td> },
    { field: 'land_size', label: 'Land', sortable: true,
      cell: (l) => <td>{l.land_size || '-'}</td> },
    { field: 'internal_size', label: 'Internal', sortable: true,
      cell: (l) => <td>{l.internal_size || '-'}</td> },
    { field: 'agency', label: 'Agency', sortable: true,
      cell: (l) => <td className="agency-cell">{l.agency || '-'}</td> },
    { field: 'agent', label: 'Agent', sortable: true,
      cell: (l) => <td>{l.agent || '-'}</td> },
    showListed && { field: 'listing_date', label: 'Listed', sortable: true,
      cell: (l) => (
        <td className="date-cell">
          <EditableDateCell
            value={l.listing_date}
            onSave={(iso) => updateListing(l.id, { listing_date: isoToDmy(iso) })}
          />
        </td>
      ) },
    showDom && { field: 'dom', label: 'DOM', sortable: true,
      cell: (l) => {
        const d = calcDOM(l)
        return (
          <td className={`num ${(d ?? 0) >= 60 ? 'stale' : ''}`}>
            {d != null ? d : '-'}
            {(d ?? 0) >= 60 && <span className="stale-flag" title="60+ days on market — potential lead">!</span>}
          </td>
        )
      } },
    showWithdrawn && { field: 'withdrawn_date', label: 'Withdrawn', sortable: true,
      cell: (l) => (
        <td className="date-cell">
          <EditableDateCell
            value={l.withdrawn_date}
            onSave={(iso) => updateListing(l.id, { withdrawn_date: iso })}
          />
        </td>
      ) },
    showSold && { field: 'sold_date', label: 'Sold', sortable: true,
      cell: (l) => (
        <td className="date-cell">
          <EditableDateCell
            value={l.sold_date}
            onSave={(iso) => updateListing(l.id, { sold_date: iso })}
          />
        </td>
      ) },
    { field: 'status', label: 'Status', sortable: true,
      cell: (l) => (
        <td>
          <span className="status-badge" style={{ backgroundColor: statusColors[l.status] || '#666' }}>
            {l.status?.replace('_', ' ')}
          </span>
        </td>
      ) },
    { field: 'listing_type', label: 'Type', sortable: true,
      cell: (l) => <td>{l.listing_type || '-'}</td> },
    { field: '__link', label: 'Link', sortable: false,
      cell: (l) => (
        <td className="link-cell">
          {l.reiwa_url ? <a href={l.reiwa_url} target="_blank" rel="noopener">View</a> : '-'}
        </td>
      ) },
    { field: '__del', label: '', sortable: false,
      cell: (l) => (
        <td className="link-cell">
          <button className="btn-delete-row" title={`Delete this ${l.status} listing`} onClick={() => deleteListing(l)}>×</button>
        </td>
      ) },
  ].filter(Boolean)

  return (
    <>
      <div className="filters">
        <button
          className={`filter-btn ${filterAll ? 'active' : ''}`}
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

      <div className="table-wrapper listings-table-wrapper">
        <table className="listings-table">
          <thead>
            <tr>
              {columns.map(c => (
                <th
                  key={c.field}
                  onClick={c.sortable ? () => toggleSort(c.field) : undefined}
                  className={c.sortable ? 'sortable' : undefined}
                >
                  {c.label}
                  {c.sortable && sortField === c.field && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredListings.map((l, i) => (
              <tr key={l.id || i} className={`status-${l.status}`}>
                {columns.map(c => (
                  // each cell function returns its own <td> so styling
                  // (numeric alignment, colour cells, etc.) lives with
                  // the column definition.
                  <c.cell.WrapperKey key={c.field} />
                ))}
                {/* The lambda above doesn't work with React because we need
                    to call c.cell(l). React.Fragment trick instead: */}
                {/* fixed below */}
              </tr>
            )).map(() => null) /* discard the broken pass above; real
                                  rendering happens in the next block.
                                  Kept as a no-op so diffs are obvious. */}
            {filteredListings.map((l, i) => (
              <tr key={`row-${l.id || i}`} className={`status-${l.status}`}>
                {columns.map(c => {
                  const td = c.cell(l)
                  // c.cell returns a <td>; React requires a key on lists
                  // — clone with a stable key per column.
                  return <td.type {...td.props} key={c.field} />
                })}
              </tr>
            ))}
            {filteredListings.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">
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

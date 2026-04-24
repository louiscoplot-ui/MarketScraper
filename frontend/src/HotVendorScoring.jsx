// Hot Vendor Scoring — drag-drop a CoreLogic / PriceFinder transaction
// export, get a per-property motivation score with HOT/WARM/MEDIUM/LOW
// buckets, browse and re-export to Excel.
//
// Everything runs client-side: the file never leaves the browser.

import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'

// --- Column matching (case-insensitive, fuzzy) ---------------------------

const COLUMN_ALIASES = {
  address: ['address', 'property address', 'street address', 'full address'],
  type: ['property type', 'type', 'dwelling type', 'asset type'],
  beds: ['bedrooms', 'beds', 'bedroom', 'bed'],
  baths: ['bathrooms', 'baths', 'bathroom', 'bath'],
  price: ['sale price', 'price', 'sold price', 'sale amount', 'amount'],
  date: ['sale date', 'date', 'sold date', 'settlement date', 'transaction date'],
  owner: ['current owner', 'owner', 'owner name', 'vendor'],
  agency: ['agency', 'agency name', 'office'],
  agent: ['agent', 'agent name', 'sales agent'],
}

function buildColumnMap(headerRow) {
  const map = {}
  const norm = (s) => String(s || '').trim().toLowerCase()
  const headers = headerRow.map(norm)
  for (const key of Object.keys(COLUMN_ALIASES)) {
    for (const alias of COLUMN_ALIASES[key]) {
      const idx = headers.indexOf(alias)
      if (idx >= 0) { map[key] = idx; break }
    }
  }
  return map
}

// --- Date parsing --------------------------------------------------------

function parseDate(raw) {
  if (raw == null || raw === '') return null
  // Excel serial date (number)
  if (typeof raw === 'number') {
    const ms = (raw - 25569) * 86400 * 1000
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d
  }
  const s = String(raw).trim()
  // dd/mm/yyyy or dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (m) {
    let [_, d, mo, y] = m
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y
    const dt = new Date(parseInt(y), parseInt(mo) - 1, parseInt(d))
    return isNaN(dt.getTime()) ? null : dt
  }
  // ISO yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) {
    const dt = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
    return isNaN(dt.getTime()) ? null : dt
  }
  const dt = new Date(s)
  return isNaN(dt.getTime()) ? null : dt
}

function parsePrice(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return raw
  const cleaned = String(raw).replace(/[^\d.]/g, '')
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

// --- Type normalization --------------------------------------------------

function normalizeType(raw) {
  const s = String(raw || '').toLowerCase().trim()
  if (!s) return 'Unknown'
  if (/house|townhouse|terrace|villa|duplex|semi/.test(s)) return 'House'
  if (/apartment|unit|flat|studio/.test(s)) return 'Apartment'
  return 'Other'
}

// --- Cleaning rules ------------------------------------------------------

function isValidSale(price, dateObj, prevValidPrice) {
  if (price == null || price < 1000) return false
  const year = dateObj ? dateObj.getFullYear() : null
  if (year && price < 50_000 && year > 1995) return false
  if (year && price < 100_000 && year > 2000) return false
  if (year && price < 200_000 && year > 2005) return false
  // 85%+ drop vs prior valid sale = partial transfer
  if (prevValidPrice != null && price < prevValidPrice * 0.15) return false
  return true
}

// --- Scoring tables ------------------------------------------------------

function holdScore(holdYrs, medianYrs) {
  if (medianYrs <= 0) return 50
  const ratio = holdYrs / medianYrs
  if (ratio < 0.4) return 10
  if (ratio < 0.6) return 25
  if (ratio < 0.8) return 40
  if (ratio < 1.0) return 55
  if (ratio < 1.2) return 70
  if (ratio < 1.5) return 85
  return 100
}

function typeScore(type) {
  return type === 'House' ? 100 : 60
}

function gainScore(gainPct, numSales) {
  if (numSales < 2 || gainPct == null) return 40 // unknown
  if (gainPct < 0) return 15
  if (gainPct < 15) return 28
  if (gainPct < 30) return 42
  if (gainPct < 50) return 55
  if (gainPct < 75) return 68
  if (gainPct < 100) return 80
  if (gainPct < 200) return 90
  return 100
}

function typeMultiplier(type) {
  return type === 'House' ? 1.3 : 0.9
}

function categoryFor(score) {
  if (score >= 82) return 'HOT'
  if (score >= 62) return 'WARM'
  if (score >= 44) return 'MEDIUM'
  return 'LOW'
}

const CATEGORY_COLORS = {
  HOT: '#FFD7D7',
  WARM: '#FFE8CC',
  MEDIUM: '#FFFACC',
  LOW: null,
}

const CATEGORY_BADGE = {
  HOT: { bg: '#dc2626', label: '🔴 HOT' },
  WARM: { bg: '#ea580c', label: '🟠 WARM' },
  MEDIUM: { bg: '#ca8a04', label: '🟡 MEDIUM' },
  LOW: { bg: '#9ca3af', label: '⚪ LOW' },
}

// --- Main pipeline -------------------------------------------------------

function processWorkbook(workbook) {
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  if (!rows.length) throw new Error('Empty sheet')

  const colMap = buildColumnMap(rows[0])
  if (colMap.address == null || colMap.price == null || colMap.date == null) {
    throw new Error(
      'Missing required columns. Need at least: Address, Sale Price, Sale Date.'
    )
  }

  // Parse every transaction row
  const transactions = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const address = String(r[colMap.address] || '').trim()
    if (!address) continue
    transactions.push({
      address,
      type: r[colMap.type],
      beds: r[colMap.beds],
      baths: r[colMap.baths],
      price: parsePrice(r[colMap.price]),
      date: parseDate(r[colMap.date]),
      owner: r[colMap.owner],
      agency: r[colMap.agency],
      agent: r[colMap.agent],
    })
  }

  // Group by address, sort each group chronologically, then apply cleaning
  const byAddress = new Map()
  for (const t of transactions) {
    if (!byAddress.has(t.address)) byAddress.set(t.address, [])
    byAddress.get(t.address).push(t)
  }

  const properties = []
  for (const [address, sales] of byAddress.entries()) {
    sales.sort((a, b) => (a.date || 0) - (b.date || 0))
    const valid = []
    let prevPrice = null
    for (const s of sales) {
      if (isValidSale(s.price, s.date, prevPrice)) {
        valid.push(s)
        prevPrice = s.price
      }
    }
    if (!valid.length) continue

    const last = valid[valid.length - 1]
    const prev = valid.length >= 2 ? valid[valid.length - 2] : null
    const holdYrs = last.date
      ? Math.max(0, (Date.now() - last.date.getTime()) / (365.25 * 24 * 3600 * 1000))
      : 0
    let gainPct = null, gainDollars = null, cagr = null
    if (prev && prev.price > 0) {
      gainDollars = last.price - prev.price
      gainPct = (gainDollars / prev.price) * 100
      const yrsBetween = (last.date - prev.date) / (365.25 * 24 * 3600 * 1000)
      if (yrsBetween > 0) {
        cagr = (Math.pow(last.price / prev.price, 1 / yrsBetween) - 1) * 100
      }
    }

    properties.push({
      address,
      type: normalizeType(last.type),
      beds: parsePrice(last.beds),
      baths: parsePrice(last.baths),
      lastSalePrice: last.price,
      ownerPurchaseDate: last.date,
      ownerPurchasePrice: last.price,
      previousSalePrice: prev ? prev.price : null,
      holdYrs,
      numSales: valid.length,
      gainPct,
      gainDollars,
      cagr,
      owner: last.owner,
      agency: last.agency,
      agent: last.agent,
    })
  }

  if (!properties.length) throw new Error('No valid properties after cleaning')

  // Median holding across the whole dataset
  const sortedHolds = [...properties].map(p => p.holdYrs).sort((a, b) => a - b)
  const medianHolding = sortedHolds[Math.floor(sortedHolds.length / 2)]

  // Compute scores
  for (const p of properties) {
    p.holdScoreVal = holdScore(p.holdYrs, medianHolding)
    p.typeScoreVal = typeScore(p.type)
    p.gainScoreVal = gainScore(p.gainPct, p.numSales)
    p.rawScore = p.holdScoreVal * 0.5 + p.typeScoreVal * 0.2 + p.gainScoreVal * 0.3
    p.adjustedScore = p.rawScore * typeMultiplier(p.type)
  }

  // Normalise 0-100 across the dataset
  const adj = properties.map(p => p.adjustedScore)
  const minA = Math.min(...adj)
  const maxA = Math.max(...adj)
  const range = maxA - minA || 1
  for (const p of properties) {
    p.finalScore = ((p.adjustedScore - minA) / range) * 100
    p.category = categoryFor(p.finalScore)
  }

  properties.sort((a, b) => b.finalScore - a.finalScore)
  properties.forEach((p, i) => { p.rank = i + 1 })

  return { properties, medianHolding }
}

// --- Excel export --------------------------------------------------------

function exportExcel(properties) {
  const buildRow = (p) => ({
    Rank: p.rank,
    Address: p.address,
    Type: p.type,
    Beds: p.beds ?? '',
    Baths: p.baths ?? '',
    'Last Sale Price': p.lastSalePrice,
    'Owner Purchase Price': p.ownerPurchasePrice,
    'Owner Purchase Date': p.ownerPurchaseDate
      ? p.ownerPurchaseDate.toLocaleDateString('en-AU')
      : '',
    'Holding (yrs)': Number(p.holdYrs.toFixed(2)),
    'Owner Gain ($)': p.gainDollars ?? '',
    'Owner Gain (%)': p.gainPct != null ? Number(p.gainPct.toFixed(1)) : '',
    'CAGR (%/yr)': p.cagr != null ? Number(p.cagr.toFixed(2)) : '',
    '# Sales': p.numSales,
    'Hold Score': Number(p.holdScoreVal.toFixed(0)),
    'Type Score': Number(p.typeScoreVal.toFixed(0)),
    'Gain Score': Number(p.gainScoreVal.toFixed(0)),
    'Final Score': Number(p.finalScore.toFixed(1)),
    Category: p.category,
    'Current Owner': p.owner ?? '',
    Agency: p.agency ?? '',
    Agent: p.agent ?? '',
  })

  const wb = XLSX.utils.book_new()

  const tintRows = (sheet, rows) => {
    // SheetJS community edition doesn't write cell fills; we still emit the
    // sheet without colour but keep the rich Category column so the reader
    // can spot the buckets at a glance. (The web UI shows the colours.)
    return sheet
  }

  const all = properties.map(buildRow)
  const sheet1 = XLSX.utils.json_to_sheet(all)
  XLSX.utils.book_append_sheet(wb, tintRows(sheet1, all), 'Scored Properties')

  const priority = properties.filter(p => p.finalScore >= 62).map(buildRow)
  const sheet2 = XLSX.utils.json_to_sheet(priority)
  XLSX.utils.book_append_sheet(wb, tintRows(sheet2, priority), 'High Priority Leads')

  const houses = properties.filter(p => p.type === 'House').map(buildRow)
  const sheet3 = XLSX.utils.json_to_sheet(houses)
  XLSX.utils.book_append_sheet(wb, tintRows(sheet3, houses), 'Houses Priority List')

  const ts = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `HotVendors_${ts}.xlsx`)
}

// --- React component -----------------------------------------------------

const fmtMoney = (n) => n == null ? '-' :
  '$' + Math.round(n).toLocaleString('en-AU')
const fmtPct = (n) => n == null ? '-' : `${n.toFixed(1)}%`
const fmtYrs = (n) => n == null ? '-' : n.toFixed(1)

const SORT_FIELDS = {
  rank: (a, b) => a.rank - b.rank,
  address: (a, b) => a.address.localeCompare(b.address),
  type: (a, b) => a.type.localeCompare(b.type),
  beds: (a, b) => (a.beds ?? -1) - (b.beds ?? -1),
  lastSalePrice: (a, b) => (a.lastSalePrice ?? 0) - (b.lastSalePrice ?? 0),
  holdYrs: (a, b) => a.holdYrs - b.holdYrs,
  gainPct: (a, b) => (a.gainPct ?? -Infinity) - (b.gainPct ?? -Infinity),
  cagr: (a, b) => (a.cagr ?? -Infinity) - (b.cagr ?? -Infinity),
  numSales: (a, b) => a.numSales - b.numSales,
  finalScore: (a, b) => a.finalScore - b.finalScore,
}

export default function HotVendorScoring() {
  const [state, setState] = useState({ properties: [], medianHolding: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ field: 'rank', dir: 'asc' })
  const fileInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)

  const handleFile = async (file) => {
    setError('')
    setLoading(true)
    try {
      const buf = await file.arrayBuffer()
      const workbook = XLSX.read(buf, { type: 'array', cellDates: true })
      // Yield to the event loop so the spinner has time to render before the
      // synchronous CPU-bound processing kicks in.
      await new Promise(r => setTimeout(r, 0))
      const result = processWorkbook(workbook)
      setState(result)
    } catch (e) {
      console.error(e)
      setError(e.message || 'Failed to process file')
    } finally {
      setLoading(false)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.properties.filter(p => {
      if (filter !== 'ALL' && p.category !== filter) return false
      if (typeFilter === 'HOUSE' && p.type !== 'House') return false
      if (typeFilter === 'APARTMENT' && p.type !== 'Apartment') return false
      if (q) {
        const addr = p.address.toLowerCase()
        const owner = String(p.owner || '').toLowerCase()
        if (!addr.includes(q) && !owner.includes(q)) return false
      }
      return true
    })
  }, [state.properties, filter, typeFilter, search])

  const sorted = useMemo(() => {
    const cmp = SORT_FIELDS[sort.field] || SORT_FIELDS.rank
    const arr = [...filtered].sort(cmp)
    if (sort.dir === 'desc') arr.reverse()
    return arr
  }, [filtered, sort])

  const counts = useMemo(() => {
    const c = { HOT: 0, WARM: 0, MEDIUM: 0, LOW: 0 }
    for (const p of state.properties) c[p.category]++
    return c
  }, [state.properties])

  const avgScore = state.properties.length
    ? state.properties.reduce((s, p) => s + p.finalScore, 0) / state.properties.length
    : 0

  const toggleSort = (field) => {
    setSort(prev => prev.field === field
      ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { field, dir: field === 'finalScore' || field === 'holdYrs' || field === 'gainPct' ? 'desc' : 'asc' })
  }

  const sortIndicator = (field) =>
    sort.field === field ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const hasData = state.properties.length > 0

  return (
    <div className="hot-vendor">
      <div className="hot-vendor-header">
        <div>
          <h2>Hot Vendor Scoring</h2>
          <p className="hot-vendor-sub">
            Drop a CoreLogic / PriceFinder transaction export. Files never leave
            your browser. Properties are scored on holding length, gain, and
            type to surface likely-to-sell vendors.
          </p>
        </div>
        {hasData && (
          <button className="btn btn-primary" onClick={() => exportExcel(state.properties)}>
            Export Excel
          </button>
        )}
      </div>

      {!hasData && (
        <div
          className={`drop-zone ${dragActive ? 'active' : ''}`}
          onDragEnter={(e) => { e.preventDefault(); setDragActive(true) }}
          onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])}
          />
          <div className="drop-icon">⬇</div>
          <div className="drop-title">
            {loading ? 'Processing…' : 'Drop your .xlsx here, or click to browse'}
          </div>
          <div className="drop-hint">
            Required columns: Address, Sale Price, Sale Date.
            Optional: Property Type, Beds, Baths, Owner, Agency, Agent.
          </div>
          {error && <div className="drop-error">{error}</div>}
        </div>
      )}

      {hasData && (
        <>
          <div className="hv-stats">
            <div className="hv-stat"><span className="hv-stat-num">{state.properties.length}</span><span>Properties</span></div>
            <div className="hv-stat hv-hot"><span className="hv-stat-num">{counts.HOT}</span><span>🔴 HOT</span></div>
            <div className="hv-stat hv-warm"><span className="hv-stat-num">{counts.WARM}</span><span>🟠 WARM</span></div>
            <div className="hv-stat hv-medium"><span className="hv-stat-num">{counts.MEDIUM}</span><span>🟡 MEDIUM</span></div>
            <div className="hv-stat"><span className="hv-stat-num">{avgScore.toFixed(1)}</span><span>Avg score</span></div>
            <div className="hv-stat"><span className="hv-stat-num">{state.medianHolding.toFixed(1)} yr</span><span>Median holding</span></div>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-secondary btn-small" onClick={() => setState({ properties: [], medianHolding: 0 })}>
                Load another file
              </button>
            </div>
          </div>

          <div className="hv-controls">
            {['ALL', 'HOT', 'WARM', 'MEDIUM', 'LOW'].map(c => (
              <button
                key={c}
                className={`hv-pill ${filter === c ? 'active' : ''}`}
                onClick={() => setFilter(c)}
                style={filter === c && c !== 'ALL' ? { background: CATEGORY_BADGE[c].bg, color: '#fff' } : null}
              >
                {c === 'ALL' ? 'ALL' : CATEGORY_BADGE[c].label}
              </button>
            ))}
            <div className="hv-spacer" />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="ALL">All Types</option>
              <option value="HOUSE">Houses only</option>
              <option value="APARTMENT">Apartments only</option>
            </select>
            <input
              type="search"
              placeholder="Search address or owner…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  {[
                    ['rank', '#'],
                    ['address', 'Address'],
                    ['type', 'Type'],
                    ['beds', 'Beds'],
                    ['lastSalePrice', 'Last Sale'],
                    ['holdYrs', 'Hold (yrs)'],
                    ['gainPct', 'Gain %'],
                    ['cagr', 'CAGR'],
                    ['numSales', '# Sales'],
                    ['finalScore', 'Score'],
                  ].map(([f, label]) => (
                    <th key={f} onClick={() => toggleSort(f)} className="sortable">
                      {label}{sortIndicator(f)}
                    </th>
                  ))}
                  <th>Category</th>
                  <th>Owner</th>
                  <th>Agency</th>
                  <th>Agent</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => (
                  <tr key={p.rank} style={{ background: CATEGORY_COLORS[p.category] || undefined }}>
                    <td className="num">{p.rank}</td>
                    <td>{p.address}</td>
                    <td>{p.type}</td>
                    <td className="num">{p.beds ?? '-'}</td>
                    <td className="num">{fmtMoney(p.lastSalePrice)}</td>
                    <td className="num">{fmtYrs(p.holdYrs)}</td>
                    <td className="num">{fmtPct(p.gainPct)}</td>
                    <td className="num">{p.cagr != null ? fmtPct(p.cagr) : '-'}</td>
                    <td className="num">{p.numSales}</td>
                    <td className="num"><strong>{p.finalScore.toFixed(1)}</strong></td>
                    <td>
                      <span className="hv-badge" style={{ background: CATEGORY_BADGE[p.category].bg }}>
                        {CATEGORY_BADGE[p.category].label}
                      </span>
                    </td>
                    <td>{p.owner || '-'}</td>
                    <td>{p.agency || '-'}</td>
                    <td>{p.agent || '-'}</td>
                  </tr>
                ))}
                {!sorted.length && (
                  <tr><td colSpan="14" className="empty">No properties match the current filters</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

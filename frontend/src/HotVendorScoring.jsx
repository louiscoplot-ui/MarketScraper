// Hot Vendor Scoring — drop a CSV / xlsx, the backend's v4 pipeline does
// the heavy lifting (auto-calibrated weights per suburb, latent profit,
// quantile-based segmentation) and returns the full scored list. The
// .xlsx report is regenerated on demand from the persisted data.

import { useMemo, useRef, useState } from 'react'

const API = ''

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


function fmtMoney(n) {
  if (n == null || n === '') return '-'
  return '$' + Math.round(n).toLocaleString('en-AU')
}

function fmtPct(n, d = 1) {
  if (n == null || n === '' || isNaN(n)) return '-'
  return `${Number(n).toFixed(d)}%`
}

function fmtNum(n, d = 1) {
  if (n == null || n === '' || isNaN(n)) return '-'
  return Number(n).toFixed(d)
}


const SORT_FIELDS = {
  rank: (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
  address: (a, b) => (a.address || '').localeCompare(b.address || ''),
  type: (a, b) => (a.type || '').localeCompare(b.type || ''),
  bedrooms: (a, b) => (a.bedrooms ?? -1) - (b.bedrooms ?? -1),
  last_sale_price: (a, b) => (a.last_sale_price ?? 0) - (b.last_sale_price ?? 0),
  holding_years: (a, b) => (a.holding_years ?? 0) - (b.holding_years ?? 0),
  owner_gain_pct: (a, b) => (a.owner_gain_pct ?? -Infinity) - (b.owner_gain_pct ?? -Infinity),
  cagr: (a, b) => (a.cagr ?? -Infinity) - (b.cagr ?? -Infinity),
  potential_profit: (a, b) => (a.potential_profit ?? -Infinity) - (b.potential_profit ?? -Infinity),
  sales_count: (a, b) => (a.sales_count ?? 0) - (b.sales_count ?? 0),
  final_score: (a, b) => (a.final_score ?? 0) - (b.final_score ?? 0),
}


export default function HotVendorScoring() {
  const [data, setData] = useState(null)
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
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API}/api/hot-vendors/score-csv`, {
        method: 'POST',
        body: fd,
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || `Upload failed (${res.status})`)
      setData(result)
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

  const downloadExcel = () => {
    if (!data?.upload_id) return
    window.open(`${API}/api/hot-vendors/uploads/${data.upload_id}/excel`, '_blank')
  }

  const properties = data?.properties || []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return properties.filter(p => {
      if (filter !== 'ALL' && p.category !== filter) return false
      if (typeFilter === 'HOUSE' && p.type !== 'House') return false
      if (typeFilter === 'APARTMENT' && p.type !== 'Apartment') return false
      if (q) {
        const addr = (p.address || '').toLowerCase()
        const owner = String(p.current_owner || '').toLowerCase()
        if (!addr.includes(q) && !owner.includes(q)) return false
      }
      return true
    })
  }, [properties, filter, typeFilter, search])

  const sorted = useMemo(() => {
    const cmp = SORT_FIELDS[sort.field] || SORT_FIELDS.rank
    const arr = [...filtered].sort(cmp)
    if (sort.dir === 'desc') arr.reverse()
    return arr
  }, [filtered, sort])

  const counts = useMemo(() => {
    const c = { HOT: 0, WARM: 0, MEDIUM: 0, LOW: 0 }
    for (const p of properties) {
      if (c[p.category] !== undefined) c[p.category]++
    }
    return c
  }, [properties])

  const avgScore = properties.length
    ? properties.reduce((s, p) => s + (p.final_score || 0), 0) / properties.length
    : 0

  const toggleSort = (field) => {
    setSort(prev => prev.field === field
      ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { field, dir: ['final_score', 'holding_years', 'owner_gain_pct', 'cagr', 'potential_profit'].includes(field) ? 'desc' : 'asc' })
  }

  const sortIndicator = (field) =>
    sort.field === field ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const hasData = properties.length > 0
  const profile = data?.profile || {}
  const weights = data?.weights || {}

  return (
    <div className="hot-vendor">
      <div className="hot-vendor-header">
        <div>
          <h2>Hot Vendor Scoring</h2>
          <p className="hot-vendor-sub">
            Drop an RP Data / CoreLogic / Landgate CSV (or xlsx). The backend
            v4 pipeline auto-calibrates scoring weights against the suburb's
            profile (mature/dynamic, premium/standard, high-gain) and returns
            HOT / WARM / MEDIUM / LOW leads.
          </p>
        </div>
        {hasData && (
          <button className="btn btn-primary" onClick={downloadExcel}>
            ⬇ Download Excel report
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
          onClick={() => !loading && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])}
          />
          <div className="drop-icon">⬇</div>
          <div className="drop-title">
            {loading ? 'Scoring on backend… (this can take 5-30s for big suburbs)' :
             'Drop your CSV or xlsx here, or click to browse'}
          </div>
          <div className="drop-hint">
            RP Data exports detected automatically (20 / 21 / 22-column
            layouts). Backend handles cleaning, latent profit, and
            quantile-based segmentation.
          </div>
          {error && <div className="drop-error">{error}</div>}
        </div>
      )}

      {hasData && (
        <>
          {/* Suburb profile + auto-calibrated weights banner */}
          <div style={{
            background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px',
            padding: '14px 18px', marginBottom: '14px', fontSize: '13px',
          }}>
            <div style={{ fontWeight: '700', marginBottom: '6px', color: '#0c4a6e' }}>
              {data.suburb} — {profile.is_mature ? 'Mature' : 'Dynamic'} ·{' '}
              {profile.is_premium ? 'Premium' : 'Standard'} ·{' '}
              {profile.is_high_gain ? 'High-gain' : 'Moderate-gain'}
            </div>
            <div style={{ color: '#075985' }}>
              <strong>Auto-calibrated weights:</strong>{' '}
              Hold {Math.round((weights.hold || 0) * 100)}% ·{' '}
              Type {Math.round((weights.type || 0) * 100)}% ·{' '}
              Gain% {((weights.gain || 0) * 100).toFixed(1)}% ·{' '}
              CAGR {((weights.cagr || 0) * 100).toFixed(1)}% ·{' '}
              Freq {Math.round((weights.freq || 0) * 100)}% ·{' '}
              Profit {Math.round((weights.profit || 0) * 100)}%
            </div>
            {data.rationale?.length > 0 && (
              <div style={{ color: '#0369a1', marginTop: '4px', fontSize: '12px' }}>
                Why: {data.rationale.join(', ')}
              </div>
            )}
          </div>

          <div className="hv-stats">
            <div className="hv-stat"><span className="hv-stat-num">{properties.length}</span><span>Properties</span></div>
            <div className="hv-stat hv-hot"><span className="hv-stat-num">{counts.HOT}</span><span>🔴 HOT</span></div>
            <div className="hv-stat hv-warm"><span className="hv-stat-num">{counts.WARM}</span><span>🟠 WARM</span></div>
            <div className="hv-stat hv-medium"><span className="hv-stat-num">{counts.MEDIUM}</span><span>🟡 MEDIUM</span></div>
            <div className="hv-stat"><span className="hv-stat-num">{avgScore.toFixed(1)}</span><span>Avg score</span></div>
            <div className="hv-stat"><span className="hv-stat-num">{(profile.median_hold ?? 0).toFixed(1)} yr</span><span>Median holding</span></div>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-secondary btn-small" onClick={() => setData(null)}>
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
                    ['bedrooms', 'Beds'],
                    ['last_sale_price', 'Last Sale'],
                    ['holding_years', 'Hold (yrs)'],
                    ['owner_gain_pct', 'Gain %'],
                    ['cagr', 'CAGR'],
                    ['potential_profit', 'Latent Profit'],
                    ['sales_count', '# Sales'],
                    ['final_score', 'Score'],
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
                    <td className="num">{p.bedrooms ?? '-'}</td>
                    <td className="num">{fmtMoney(p.last_sale_price)}</td>
                    <td className="num">{fmtNum(p.holding_years)}</td>
                    <td className="num">{fmtPct(p.owner_gain_pct)}</td>
                    <td className="num">{fmtPct(p.cagr, 2)}</td>
                    <td className="num">{fmtMoney(p.potential_profit)}</td>
                    <td className="num">{p.sales_count}</td>
                    <td className="num"><strong>{fmtNum(p.final_score)}</strong></td>
                    <td>
                      <span className="hv-badge" style={{ background: CATEGORY_BADGE[p.category]?.bg }}>
                        {CATEGORY_BADGE[p.category]?.label || p.category}
                      </span>
                    </td>
                    <td>{p.current_owner || '-'}</td>
                    <td>{p.agency || '-'}</td>
                    <td>{p.agent || '-'}</td>
                  </tr>
                ))}
                {!sorted.length && (
                  <tr><td colSpan="15" className="empty">No properties match the current filters</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

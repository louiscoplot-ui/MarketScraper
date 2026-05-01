// Hot Vendor Scoring — drop a CSV / xlsx, the backend's v4 pipeline does
// the heavy lifting (auto-calibrated weights per suburb, latent profit,
// quantile-based segmentation) and returns the full scored list. The
// .xlsx report is regenerated on demand from the persisted data.

import { useEffect, useMemo, useRef, useState } from 'react'
import StickyHScroll from './components/StickyHScroll'

// Vercel proxy has a ~25s edge timeout that includes upload buffering.
// For big suburbs (Ellenbrook, Mandurah — 50-200 MB CSVs) we bypass
// Vercel and POST directly to Render. CORS is wide-open on the backend
// (`CORS(app)` in app.py) so cross-origin POST works. Polling stays on
// the proxy because each poll is tiny + low-latency.
const API = ''
const BACKEND_DIRECT = 'https://marketscraper-backend.onrender.com'
const ACTIVE_JOB_KEY = 'agentdeck_hv_active_job'
// Bumped at every push that touches the upload flow — visible in the
// header so we can tell at a glance which frontend bundle is live.
const BUILD_TAG = 'upload-direct-v3'

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

// User-controlled per-row flags. Tints override the category colour.
const STATUS_OPTIONS = [
  { value: '', label: '—' },
  { value: 'listed', label: '✓ Listed / Appraised' },
  { value: 'pending', label: '… Considering / Pending' },
  { value: 'declined', label: '✗ Not interested' },
]

const STATUS_TINT = {
  listed: '#bbf7d0',
  pending: '#fde68a',
  declined: '#fecaca',
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

function getSuburb(p) {
  if (p.suburb) return String(p.suburb).trim()
  const m = (p.address || '').match(/,\s*([A-Za-z][A-Za-z\s'-]+?)(?:\s+\d{4})?$/)
  return m ? m[1].trim() : null
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
  const [selectedSuburbs, setSelectedSuburbs] = useState(new Set())
  const [compact, setCompact] = useState(false)
  const [statuses, setStatuses] = useState({})
  const [suburbDropdownOpen, setSuburbDropdownOpen] = useState(false)
  const fileInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)
  const wrapperRef = useRef(null)
  const suburbDropdownRef = useRef(null)
  const [savedUploads, setSavedUploads] = useState([])
  const [savedLoading, setSavedLoading] = useState(true)

  // Load past uploads on mount so a returning user lands on a list of
  // previously-scored suburbs (latest per suburb) instead of a blank
  // dropzone. UPSERT keeps re-uploads from duplicating rows.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API}/api/hot-vendors/uploads`)
        if (!res.ok) throw new Error('list failed')
        const j = await res.json()
        if (!cancelled) setSavedUploads(j.uploads || [])
      } catch (e) {
        console.warn('Could not load past uploads:', e)
      } finally {
        if (!cancelled) setSavedLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const loadSavedUpload = async (uploadId) => {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/hot-vendors/uploads/${uploadId}`)
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || `Load failed (${res.status})`)
      setData(result)
    } catch (e) {
      console.error(e)
      setError(e.message || 'Failed to load saved upload')
    } finally {
      setLoading(false)
    }
  }

  const refreshSavedUploads = async () => {
    try {
      const res = await fetch(`${API}/api/hot-vendors/uploads`)
      if (res.ok) {
        const j = await res.json()
        setSavedUploads(j.uploads || [])
      }
    } catch {}
  }

  const [loadingStage, setLoadingStage] = useState('')

  // Polls a backend job until it's done / errored / timed out.
  // Extracted so we can resume polling on mount when localStorage has
  // an active job (user navigated away and came back).
  const pollJob = async (jobId, opts = {}) => {
    const { onResult, signal } = opts
    const POLL_MS = 2500
    const MAX_MS = 30 * 60 * 1000  // 30 min hard cap.
    const start = Date.now()
    while (true) {
      if (signal?.aborted) return
      await new Promise(r => setTimeout(r, POLL_MS))
      let sJson = {}
      let sRes
      try {
        sRes = await fetch(`${API}/api/hot-vendors/score-csv/job/${jobId}`)
        sJson = await sRes.json().catch(() => ({}))
      } catch (netErr) {
        // Transient network blip — keep polling, the job is still on
        // the server. Log so we see it in DevTools.
        console.warn('[poll] network blip, retrying:', netErr.message)
        continue
      }
      console.log(`[poll ${jobId}] status=${sJson.status} stage=${sJson.stage}`)
      if (sJson.stage) setLoadingStage(sJson.stage)
      if (sJson.status === 'done' && sJson.result) {
        onResult?.(sJson.result)
        return sJson.result
      }
      if (sJson.status === 'error' || sJson.status === 'lost' || !sRes.ok) {
        throw new Error(sJson.error || `Job failed (${sRes?.status})`)
      }
      if (Date.now() - start > MAX_MS) {
        throw new Error('Job exceeded 30 minutes — server likely stuck')
      }
    }
  }

  const handleFile = async (file) => {
    setError('')
    setLoading(true)
    setLoadingStage(`Uploading ${(file.size / (1024 * 1024)).toFixed(1)} MB…`)
    console.log(`[upload] ${file.name} — ${(file.size / (1024 * 1024)).toFixed(2)} MB`)
    const t0 = Date.now()
    try {
      const fd = new FormData()
      fd.append('file', file)
      // Direct to Render — Vercel proxy edge timeout (~25s) would kill
      // big uploads while it's still buffering the multipart body.
      const startRes = await fetch(`${BACKEND_DIRECT}/api/hot-vendors/score-csv`, {
        method: 'POST',
        body: fd,
      })
      console.log(`[upload] POST took ${Date.now() - t0} ms, status=${startRes.status}`)
      const startJson = await startRes.json()
      if (!startRes.ok || !startJson.job_id) {
        throw new Error(startJson.error || `Upload rejected (${startRes.status})`)
      }
      const jobId = startJson.job_id
      // Persist so we can resume polling after a page change / reload.
      try {
        localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({
          job_id: jobId, filename: file.name, started_at: Date.now(),
        }))
      } catch {}
      console.log(`[upload] queued job ${jobId} — polling every 2.5s`)

      const result = await pollJob(jobId)
      console.log(`[upload] job ${jobId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      setData(result)
      refreshSavedUploads()
      try { localStorage.removeItem(ACTIVE_JOB_KEY) } catch {}
    } catch (e) {
      console.error('[upload] failed:', e)
      setError(e.message || 'Failed to process file')
      try { localStorage.removeItem(ACTIVE_JOB_KEY) } catch {}
    } finally {
      setLoading(false)
      setLoadingStage('')
    }
  }

  // Resume polling on mount if a job was in-flight when the user
  // navigated away. The backend thread keeps running independently of
  // the frontend, so the result is already (or about to be) in DB.
  useEffect(() => {
    let cancelled = false
    let stored
    try { stored = JSON.parse(localStorage.getItem(ACTIVE_JOB_KEY) || 'null') } catch { stored = null }
    if (!stored?.job_id) return
    console.log(`[resume] picking up job ${stored.job_id} from localStorage`)
    setLoading(true)
    setLoadingStage('Resuming…')
    ;(async () => {
      try {
        const result = await pollJob(stored.job_id, { signal: { get aborted() { return cancelled } } })
        if (cancelled) return
        setData(result)
        refreshSavedUploads()
      } catch (e) {
        if (cancelled) return
        console.warn('[resume] job lost or failed:', e.message)
        setError(`Previous upload (${stored.filename}) — ${e.message}`)
      } finally {
        if (!cancelled) {
          setLoading(false)
          setLoadingStage('')
          try { localStorage.removeItem(ACTIVE_JOB_KEY) } catch {}
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  const onDrop = (e) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const [excelLoading, setExcelLoading] = useState(false)
  const [excelFallbackUrl, setExcelFallbackUrl] = useState(null)
  const [excelFallbackName, setExcelFallbackName] = useState('')

  const downloadExcel = async () => {
    const id = data?.upload_id ?? data?.id ?? data?.uploadId
    console.log('[Excel] Download clicked. data keys =', data && Object.keys(data),
                ' upload_id =', id, ' suburb =', data?.suburb)
    if (!id) {
      setError(
        'No upload_id on this report. The backend may not have finished ' +
        'persisting yet, or the saved upload predates this version. ' +
        'Try re-uploading the CSV (UPSERT — won\'t duplicate rows).'
      )
      return
    }
    setError('')
    setExcelLoading(true)
    setExcelFallbackUrl(null)
    const t0 = Date.now()
    try {
      // Direct to Render — Vercel proxy edge timeout (~25s) was killing
      // the fetch while build_workbook was still serialising big suburbs.
      const url = `${BACKEND_DIRECT}/api/hot-vendors/uploads/${id}/excel`
      console.log('[Excel] Fetching', url)
      const res = await fetch(url)
      const elapsed = Date.now() - t0
      console.log(`[Excel] Response in ${elapsed} ms — status ${res.status}, type ${res.headers.get('content-type')}`)
      if (!res.ok) {
        let msg = `Download failed (${res.status})`
        try {
          const j = await res.json()
          if (j.error) msg = j.error
        } catch {}
        throw new Error(msg)
      }
      const blob = await res.blob()
      console.log(`[Excel] Blob size ${blob.size} bytes, type "${blob.type}"`)
      if (!blob.size) throw new Error('Empty file returned by backend')
      const dlUrl = URL.createObjectURL(blob)
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/filename="?([^";]+)"?/i)
      const fname = m ? m[1] : `hot-vendors-${data.suburb || 'report'}.xlsx`

      // Auto-download via a transient anchor. Most browsers honour this
      // even outside the user-gesture context after a fetch, but Safari
      // and some Chrome configs silently block it. Always also surface
      // a manual fallback link so the user is never stuck.
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = fname
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      console.log('[Excel] Triggered programmatic download:', fname)
      // Don't revoke immediately — the click handler may still be reading.
      setTimeout(() => { a.remove() }, 1000)
      setExcelFallbackUrl(dlUrl)
      setExcelFallbackName(fname)
    } catch (e) {
      console.error('[Excel] Failed:', e)
      setError(e.message || 'Excel download failed')
    } finally {
      setExcelLoading(false)
    }
  }

  const properties = data?.properties || []

  // Hydrate per-row status flags from the score-csv payload (server-side
  // join against hot_vendor_property_status). Re-runs only on new uploads.
  useEffect(() => {
    if (!data) { setStatuses({}); setSelectedSuburbs(new Set()); return }
    const next = {}
    for (const p of data.properties || []) {
      if (p.user_status) next[p.address] = p.user_status
    }
    setStatuses(next)
    setSelectedSuburbs(new Set())
  }, [data])

  const uniqueSuburbs = useMemo(() => {
    const set = new Set()
    for (const p of properties) {
      const s = getSuburb(p)
      if (s) set.add(s)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [properties])

  // Close the suburb dropdown when clicking outside it.
  useEffect(() => {
    if (!suburbDropdownOpen) return
    const onDocClick = (e) => {
      if (!suburbDropdownRef.current?.contains(e.target)) setSuburbDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [suburbDropdownOpen])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const subFilter = selectedSuburbs.size > 0
    return properties.filter(p => {
      if (filter !== 'ALL' && p.category !== filter) return false
      if (typeFilter === 'HOUSE' && p.type !== 'House') return false
      if (typeFilter === 'APARTMENT' && p.type !== 'Apartment') return false
      if (subFilter) {
        const s = getSuburb(p)
        if (!s || !selectedSuburbs.has(s)) return false
      }
      if (q) {
        const addr = (p.address || '').toLowerCase()
        const owner = String(p.current_owner || '').toLowerCase()
        if (!addr.includes(q) && !owner.includes(q)) return false
      }
      return true
    })
  }, [properties, filter, typeFilter, search, selectedSuburbs])

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

  const toggleSuburb = (s) => {
    setSelectedSuburbs(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s); else next.add(s)
      return next
    })
  }

  const setStatus = async (address, status) => {
    setStatuses(prev => {
      const next = { ...prev }
      if (status) next[address] = status; else delete next[address]
      return next
    })
    try {
      await fetch(`${API}/api/hot-vendors/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, status }),
      })
    } catch (e) {
      console.error('Failed to save status', e)
    }
  }

  // Drag the table sideways with the mouse — REIWA scraper has the same
  // affordance via overflow scroll. Skip when the drag starts on an
  // interactive element so click/select still work.
  const onTableMouseDown = (e) => {
    if (e.target.closest('select, button, input, a, th')) return
    const w = wrapperRef.current
    if (!w) return
    const startX = e.pageX - w.offsetLeft
    const startScroll = w.scrollLeft
    let moved = false
    const onMove = (ev) => {
      const dx = ev.pageX - w.offsetLeft - startX
      if (Math.abs(dx) > 3) {
        moved = true
        w.classList.add('dragging')
      }
      w.scrollLeft = startScroll - dx
      if (moved) ev.preventDefault()
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      w.classList.remove('dragging')
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const hasData = properties.length > 0
  const profile = data?.profile || {}
  const weights = data?.weights || {}
  const suburbBtnLabel = selectedSuburbs.size === 0
    ? `All suburbs${uniqueSuburbs.length > 1 ? ` (${uniqueSuburbs.length})` : ''}`
    : selectedSuburbs.size === 1
      ? Array.from(selectedSuburbs)[0]
      : `${selectedSuburbs.size} suburbs`

  return (
    <div className={`hot-vendor ${compact ? 'compact' : ''}`}>
      <div className="hot-vendor-header">
        <div>
          <h2>Hot Vendor Scoring <span style={{
            fontSize: '11px', fontWeight: 400, color: 'var(--text-muted)',
            marginLeft: 8, padding: '2px 6px', border: '1px solid var(--border)',
            borderRadius: 4, fontFamily: 'monospace',
          }}>{BUILD_TAG}</span></h2>
          <p className="hot-vendor-sub">
            Drop an RP Data / CoreLogic / Landgate CSV (or xlsx). The backend
            v4 pipeline auto-calibrates scoring weights against the suburb's
            profile (mature/dynamic, premium/standard, high-gain) and returns
            HOT / WARM / MEDIUM / LOW leads.
          </p>
        </div>
        {hasData && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={downloadExcel}
              disabled={excelLoading}
            >
              {excelLoading ? '⏳ Generating…' : '⬇ Download Excel report'}
            </button>
            {excelFallbackUrl && (
              <a
                href={excelFallbackUrl}
                download={excelFallbackName}
                className="btn btn-ghost btn-sm"
                style={{ textDecoration: 'none' }}
              >
                ⬇ Click here if it didn't download
              </a>
            )}
          </div>
        )}
      </div>

      {!hasData && (
        <>
          {!savedLoading && savedUploads.length > 0 && (
            <div className="hv-saved">
              <div className="hv-saved-title">Recent reports</div>
              <div className="hv-saved-grid">
                {savedUploads.map(u => (
                  <button
                    key={u.id}
                    className="hv-saved-card"
                    onClick={() => loadSavedUpload(u.id)}
                    disabled={loading}
                  >
                    <div className="hv-saved-suburb">{u.suburb}</div>
                    <div className="hv-saved-meta">
                      {u.row_count} properties
                      {u.uploaded_at && ` · ${(u.uploaded_at || '').slice(0, 10)}`}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

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
              {loading
                ? (loadingStage || 'Working on it…')
                : savedUploads.length > 0
                  ? 'Or drop a new CSV / xlsx here to score another suburb'
                  : 'Drop your CSV or xlsx here, or click to browse'}
            </div>
            {loading && (
              <div className="drop-hint">
                Big suburbs (Ellenbrook, Mandurah) can take 1-5 min.
                You can leave this page open in another tab.
              </div>
            )}
            <div className="drop-hint">
              RP Data exports detected automatically (20 / 21 / 22-column
              layouts). Backend handles cleaning, latent profit, and
              quantile-based segmentation.
            </div>
            {error && <div className="drop-error">{error}</div>}
          </div>
        </>
      )}

      {hasData && (
        <>
          {error && (
            <div className="hv-error-banner">
              ⚠ {error}
              <button className="btn-link" onClick={() => setError('')}>dismiss</button>
            </div>
          )}
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

            {uniqueSuburbs.length > 1 && (
              <div className="hv-suburb-filter" ref={suburbDropdownRef}>
                <button
                  className={`hv-pill ${selectedSuburbs.size > 0 ? 'active' : ''}`}
                  onClick={() => setSuburbDropdownOpen(o => !o)}
                >
                  📍 {suburbBtnLabel} ▾
                </button>
                {suburbDropdownOpen && (
                  <div className="hv-suburb-menu">
                    <div className="hv-suburb-menu-actions">
                      <button className="btn-link" onClick={() => setSelectedSuburbs(new Set())}>Clear</button>
                      <button className="btn-link" onClick={() => setSelectedSuburbs(new Set(uniqueSuburbs))}>All</button>
                    </div>
                    {uniqueSuburbs.map(s => (
                      <label key={s} className="hv-suburb-item">
                        <input
                          type="checkbox"
                          checked={selectedSuburbs.has(s)}
                          onChange={() => toggleSuburb(s)}
                        />
                        {s}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              className={`hv-pill ${compact ? 'active' : ''}`}
              onClick={() => setCompact(c => !c)}
              title="Toggle compact column widths"
            >
              {compact ? '⊟ Compact' : '⊞ Compact'}
            </button>

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

          <div
            className="table-wrapper hv-table-wrapper"
            ref={wrapperRef}
            onMouseDown={onTableMouseDown}
          >
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
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => {
                  const userStatus = statuses[p.address] || ''
                  const tint = userStatus ? STATUS_TINT[userStatus] : CATEGORY_COLORS[p.category]
                  return (
                    <tr key={p.rank} style={{ background: tint || undefined }}>
                      <td className="num">{p.rank}</td>
                      <td className="hv-cell-address" title={p.address}>{p.address}</td>
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
                      <td className="hv-cell-owner" title={p.current_owner || ''}>{p.current_owner || '-'}</td>
                      <td className="hv-cell-agency" title={p.agency || ''}>{p.agency || '-'}</td>
                      <td className="hv-cell-agent" title={p.agent || ''}>{p.agent || '-'}</td>
                      <td>
                        <select
                          className="hv-status-select"
                          value={userStatus}
                          onChange={(e) => setStatus(p.address, e.target.value)}
                        >
                          {STATUS_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
                {!sorted.length && (
                  <tr><td colSpan="16" className="empty">No properties match the current filters</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <StickyHScroll targetRef={wrapperRef} />
        </>
      )}
    </div>
  )
}

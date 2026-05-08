import { useState, useEffect } from 'react'
import { BACKEND_DIRECT, fetchWithRetry } from '../lib/api'
import LoadingState from '../components/LoadingState'

const API = ''
// Pipeline tracking + generate go direct to Render to bypass Vercel's
// 25s edge timeout, same as the listings/suburbs bootstrap. Switching
// suburbs reads pre-generated rows from pipeline_tracking, which is a
// fast indexed lookup — but on a cold dyno even that response is
// blocked by the proxy timeout, so we go direct.
const PIPELINE_API = `${BACKEND_DIRECT}/api/pipeline`

// Per-suburb 5s snapshot cache. Survives unmount/remount within the
// same JS session so Pipeline → Listings → back-to-Pipeline doesn't
// re-fetch when the user is navigating quickly. Cache key is the
// suburb name (or '__all__' for unfiltered). Entries auto-expire on
// next access via the 5000ms TTL check inside loadTracking.
const _pipelineCache = new Map()

const STATUS_LABELS = {
  sent: { label: 'Sent', color: '#3b82f6' },
  responded: { label: 'Responded', color: '#f59e0b' },
  appraisal_booked: { label: 'Appraisal Booked', color: '#10b981' },
  listing_signed: { label: 'Listing Signed ✓', color: '#059669' },
  no_response: { label: 'No Response', color: '#6b7280' },
}

function formatPrice(p) {
  if (p == null || p === '') return '—'
  const n = typeof p === 'number' ? p : parseInt(String(p).replace(/[^\d]/g, ''))
  return isNaN(n) ? '—' : `$${n.toLocaleString()}`
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}


// Cluster consecutive groups (already sorted by primary source on the
// backend) that share the same primary source address. Each cluster
// renders the source cell ONCE with rowSpan covering all its targets.
function clusterByPrimarySource(groups) {
  const clusters = []
  for (const g of groups) {
    const primary = (g.sources[0]?.source_address || '').toLowerCase().trim()
    const last = clusters[clusters.length - 1]
    if (last && last.primaryKey === primary && primary !== '') {
      last.groups.push(g)
      // Merge any secondary sources unique to this group into the cluster
      for (const s of g.sources) {
        const k = (s.source_address || '').toLowerCase().trim()
        if (!last.sources.some(ls => (ls.source_address || '').toLowerCase().trim() === k)) {
          last.sources.push(s)
        }
      }
    } else {
      clusters.push({
        primaryKey: primary,
        sources: [...g.sources],
        groups: [g],
      })
    }
  }
  return clusters
}


export default function Pipeline() {
  // `allowedSuburbs` is fetched from /api/suburbs which is already
  // filtered server-side to the calling user's assignments. We default
  // `suburb` to the first allowed entry so a user who's only assigned
  // Ellenbrook doesn't see Cottesloe pre-selected.
  const [allowedSuburbs, setAllowedSuburbs] = useState([])
  const [suburbsLoaded, setSuburbsLoaded] = useState(false)
  const [suburb, setSuburb] = useState('')
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [groups, setGroups] = useState([])
  const [generateMsg, setGenerateMsg] = useState(null)
  const [editingName, setEditingName] = useState(null)
  const [editingNote, setEditingNote] = useState(null)
  const [actionModal, setActionModal] = useState(null)
  const [showManualForm, setShowManualForm] = useState(false)
  // Per-row in-flight letter downloads so multiple buttons can be
  // clicked without the spinner state stomping on itself.
  const [downloadingIds, setDownloadingIds] = useState(new Set())

  useEffect(() => {
    fetch(`${API}/api/suburbs`)
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        const names = (Array.isArray(rows) ? rows : [])
          .map(r => r.name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        setAllowedSuburbs(names)
        setSuburb(prev => (prev && names.includes(prev)) ? prev : (names[0] || ''))
        setSuburbsLoaded(true)
      })
      .catch(() => { setSuburbsLoaded(true) })
  }, [])

  // Reload the tracking table whenever the active suburb changes.
  // Single source of truth — the generator dropdown is also the
  // filter, so swapping suburbs immediately surfaces that suburb's
  // already-generated pipeline entries (no Generate click required).
  useEffect(() => {
    if (!suburbsLoaded || !suburb) return
    loadTracking()
  }, [suburb, suburbsLoaded])

  // OSM cache state for the active suburb. The backend warms in a
  // background thread; we poll every 3s while warming so the user sees
  // a progress banner instead of waiting on a 30s blocking request.
  // 'ready' | 'warming' | 'empty' | 'slow' (>60s of warming).
  const [osmStatus, setOsmStatus] = useState('ready')

  useEffect(() => {
    if (!suburbsLoaded || !suburb) return
    let cancelled = false
    let timer = null
    const startedAt = Date.now()

    async function tick() {
      if (cancelled) return
      try {
        const res = await fetch(
          `${PIPELINE_API}/osm-status/${encodeURIComponent(suburb)}`
        )
        if (!res.ok) {
          // 403 (suburb not allowed) or 5xx — stop polling, don't block UI.
          if (!cancelled) setOsmStatus('ready')
          return
        }
        const data = await res.json()
        if (cancelled) return
        if (data.status === 'ready') {
          setOsmStatus('ready')
          // If we were warming, the data is now available — refresh
          // the pipeline view so the just-warmed streets show up.
          if (Date.now() - startedAt > 1500) loadTracking()
          return
        }
        // Still warming — show banner. After 60s, downgrade message.
        const elapsed = Date.now() - startedAt
        // Warming is silent (no banner) up to 30s — most prefetches
        // finish well within that and the user shouldn't see a
        // "Loading..." indicator for a quick background task. Past 30s
        // we surface the "slow" banner so they know something's stuck.
        setOsmStatus(elapsed > 30_000 ? 'slow' : 'warming')
        timer = setTimeout(tick, 3000)
      } catch {
        if (!cancelled) setOsmStatus('ready')
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [suburb, suburbsLoaded])

  // Auto-generate when the active suburb has zero entries and OSM is
  // ready. Saves the user a click — read-only operation, no
  // confirmation needed. 2s delay so a quick suburb-flip doesn't
  // accidentally fire generation against the wrong suburb.
  const [autoGenerating, setAutoGenerating] = useState(false)
  const [autoGeneratedFor, setAutoGeneratedFor] = useState(new Set())
  useEffect(() => {
    if (loading || generating || autoGenerating) return
    if (!suburb || osmStatus !== 'ready') return
    if (groups.length > 0) return
    if (autoGeneratedFor.has(suburb)) return
    const t = setTimeout(async () => {
      setAutoGenerating(true)
      setAutoGeneratedFor(prev => new Set(prev).add(suburb))
      try { await handleGenerate() } finally { setAutoGenerating(false) }
    }, 2000)
    return () => clearTimeout(t)
  }, [suburb, osmStatus, groups.length, loading, generating])

  // Module-level snapshot cache so navigating Pipeline → Listings →
  // back-to-Pipeline within 5s doesn't re-fetch. The component unmounts
  // when the user switches tabs (App.jsx renders Pipeline conditionally),
  // so React state is lost — but this Map survives across mounts within
  // the same JS session. Per-suburb keys, 5s TTL.
  async function loadTracking({ force = false } = {}) {
    const cacheKey = suburb || '__all__'
    const cached = _pipelineCache.get(cacheKey)
    if (!force && cached && (Date.now() - cached.t) < 5000) {
      setGroups(cached.groups)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const url = suburb
        ? `${PIPELINE_API}/tracking/grouped?suburb=${encodeURIComponent(suburb)}&limit=500`
        : `${PIPELINE_API}/tracking/grouped?limit=500`
      const res = await fetchWithRetry(url, {}, 4)
      const data = await res.json()
      const groupsResult = data.groups || []
      setGroups(groupsResult)
      _pipelineCache.set(cacheKey, { groups: groupsResult, t: Date.now() })
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenerateMsg(null)
    // First attempt: try silently. If it throws (network error / Render
    // cold-start race), wait 35s and retry once before showing the
    // user any error — by then the dyno is almost certainly warm.
    const attempt = async () => {
      const res = await fetch(
        `${API}/api/pipeline/generate?suburb=${encodeURIComponent(suburb)}&days=${days}`
      )
      return res.json()
    }
    let data
    try {
      data = await attempt()
    } catch (firstErr) {
      try {
        await new Promise(r => setTimeout(r, 35_000))
        data = await attempt()
      } catch (secondErr) {
        setGenerateMsg({
          type: 'error',
          text: 'Connecting to server… please wait a moment and try again.',
          retryable: true,
        })
        setGenerating(false)
        return
      }
    }
    if (data.error) {
      setGenerateMsg({ type: 'error', text: data.error })
    } else if (data.sold_count === 0) {
      // No sales in the window — coach the user toward a wider one
      // instead of saying "0 entries from 0 sales".
      setGenerateMsg({
        type: 'info',
        text: `No sales found in ${suburb} in the last ${days} days. Try extending to 14 or 30 days.`,
      })
    } else if (data.generated === 0) {
      // Sales exist but every neighbour was already in pipeline_tracking
      // (likely from a previous run or auto-gen after the daily scrape).
      setGenerateMsg({
        type: 'info',
        text: `Found ${data.sold_count} sales but all neighbours are already in your pipeline.`,
      })
      setFilterSuburb(suburb)
      loadTracking({ force: true })
    } else {
      const cap = data.cap_applied ? ' (cap reached — try a wider days window for more)' : ''
      setGenerateMsg({
        type: 'success',
        text: `Added ${data.generated} new targets from ${data.sold_count} sales in ${suburb}${cap}.`,
      })
      setFilterSuburb(suburb)
      loadTracking({ force: true })
    }
    setGenerating(false)
  }

  async function patchEntry(id, fields) {
    await fetch(`${API}/api/pipeline/tracking/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    loadTracking({ force: true })
  }

  async function downloadLetter(representativeId, targetAddress) {
    // Explicit X-Access-Key header instead of relying on the global
    // window.fetch interceptor — survives any future refactor of the
    // interceptor and makes the auth contract visible at the call site.
    // (Storage key matches lib/api.js: ACCESS_KEY_STORAGE = 'agentdeck_access_key'.)
    setDownloadingIds(prev => {
      const next = new Set(prev); next.add(representativeId); return next
    })
    try {
      const accessKey = localStorage.getItem('agentdeck_access_key') || ''
      const resp = await fetch(
        `${API}/api/pipeline/letter/${representativeId}/download`,
        { headers: { 'X-Access-Key': accessKey } }
      )
      if (!resp.ok) throw new Error(await resp.text())
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const safe = (targetAddress || 'letter').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || `letter_${representativeId}`
      const a = document.createElement('a')
      a.href = url
      a.download = `letter_${safe}.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Letter download failed:', err)
      alert('Could not download letter — please refresh and try again.')
    } finally {
      setDownloadingIds(prev => {
        const next = new Set(prev); next.delete(representativeId); return next
      })
    }
  }

  function handleExportCSV() {
    const headers = ['Source Sales', 'Target Address', 'Owner Name',
                     'Total Source Sales', 'Status', 'Sent Date', 'Notes']
    const rows = groups.map(g => {
      const sourcesText = g.sources
        .map(s => {
          const price = s.source_price ? ` ($${s.source_price.toLocaleString()})` : ''
          const dt = s.source_sold_date ? ` — sold ${s.source_sold_date}` : ''
          return `${s.source_address}${price}${dt}`
        })
        .join('; ')
      return [
        sourcesText, g.target_address, g.target_owner_name || '',
        g.sources.length, g.status, g.sent_date, g.notes || '',
      ]
    })
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pipeline_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  // Stats
  const sent = groups.filter(g => g.status === 'sent').length
  const responded = groups.filter(g => g.status === 'responded').length
  const appraisals = groups.filter(g => g.status === 'appraisal_booked').length
  const listed = groups.filter(g => g.status === 'listing_signed').length
  const respRate = groups.length ? Math.round((responded / groups.length) * 100) : 0

  const clusters = clusterByPrimarySource(groups)

  return (
    <div style={{ padding: '24px', maxWidth: '1280px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>
        Appraisal Pipeline
      </h1>

      {/* Generator */}
      <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '20px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={suburb}
            onChange={e => setSuburb(e.target.value)}
            disabled={allowedSuburbs.length === 0}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px' }}>
            {!suburbsLoaded
              ? <option value="">Loading suburbs…</option>
              : allowedSuburbs.length === 0
                ? <option value="">No suburbs assigned — ask your admin</option>
                : allowedSuburbs.map(s => <option key={s}>{s}</option>)}
          </select>

          <div style={{ display: 'flex', gap: '6px' }}>
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => {
                setDays(d)
                // Reset any in-flight Generate state so the button isn't
                // stuck on "Generating…" if the user changes the window
                // mid-request. The previous request's response will be
                // ignored because the new period invalidates it.
                setGenerating(false)
                setGenerateMsg(null)
              }}
                style={{
                  padding: '8px 14px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
                  background: days === d ? '#1d4ed8' : 'white',
                  color: days === d ? 'white' : '#374151',
                  border: `1px solid ${days === d ? '#1d4ed8' : '#d1d5db'}`,
                }}>
                {d} days
              </button>
            ))}
          </div>

          <button
            onClick={handleGenerate}
            disabled={generating}
            style={{
              padding: '8px 20px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
              background: generating ? '#93c5fd' : '#1d4ed8', color: 'white', border: 'none', fontWeight: '600',
            }}>
            {generating ? 'Generating...' : 'Generate Letters'}
          </button>

          <button
            onClick={() => setShowManualForm(s => !s)}
            style={{
              padding: '8px 16px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
              background: showManualForm ? '#374151' : 'white',
              color: showManualForm ? 'white' : '#374151',
              border: '1px solid #d1d5db',
            }}>
            {showManualForm ? '× Cancel' : '+ Add Manual Sale'}
          </button>
        </div>

        {generateMsg && (() => {
          // Three palettes: success (green), info (neutral blue —
          // "0 sales" / "all already in pipeline" cases), error (red).
          const palette = generateMsg.type === 'success'
            ? { bg: '#d1fae5', fg: '#065f46', border: 'transparent' }
            : generateMsg.type === 'info'
              ? { bg: '#EFF6FF', fg: '#1E40AF', border: '#BFDBFE' }
              : { bg: '#fee2e2', fg: '#991b1b', border: 'transparent' }
          return (
            <div style={{
              marginTop: '12px', padding: '10px 14px', borderRadius: '6px', fontSize: '14px',
              background: palette.bg, color: palette.fg,
              border: `1px solid ${palette.border}`,
              display: 'flex', alignItems: 'center', gap: '12px',
            }}>
              <span>{generateMsg.text}</span>
              {generateMsg.retryable && (
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  style={{
                    padding: '4px 12px', borderRadius: '4px',
                    border: `1px solid ${palette.fg}`, background: 'white',
                    color: palette.fg, cursor: 'pointer', fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  {generating ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </div>
          )
        })()}

        {osmStatus === 'slow' && (
          <div style={{
            marginTop: '12px', padding: '10px 14px', borderRadius: '6px', fontSize: '14px',
            background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1E40AF',
            display: 'flex', alignItems: 'center', gap: '10px',
          }}>
            <span
              aria-hidden="true"
              style={{
                width: '14px', height: '14px', borderRadius: '50%',
                border: '2px solid rgba(30, 64, 175, 0.25)',
                borderTopColor: '#1E40AF',
                animation: 'sd-spin 0.8s linear infinite',
                flexShrink: 0,
              }}
            />
            <span>
              {osmStatus === 'slow'
                ? 'Loading street data is taking longer than expected — try refreshing in a moment.'
                : `Preparing street data for ${suburb} — this takes about 20 seconds the first time, then it's instant.`}
            </span>
            <style>{`@keyframes sd-spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}
      </div>

      {showManualForm && (
        <ManualAddForm
          defaultSuburb={suburb}
          allowedSuburbs={allowedSuburbs}
          onSuccess={(msg) => {
            setGenerateMsg({ type: 'success', text: msg })
            setShowManualForm(false)
            loadTracking({ force: true })
          }}
          onError={(msg) => setGenerateMsg({ type: 'error', text: msg })}
        />
      )}

      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px' }}>
          <span style={{ fontSize: '13px', color: '#6b7280' }}>
            Showing <strong style={{ color: '#1C1D22' }}>{suburb}</strong>
          </span>
          <span style={{ fontSize: '13px', color: '#6b7280', marginLeft: 'auto' }}>
            {clusters.length} source{clusters.length !== 1 ? 's' : ''} · {groups.length} target{groups.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
          <button
            onClick={() => window.open('/pipeline/print', '_blank')}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '14px' }}>
            🖨 Print All Letters
          </button>
          <button
            onClick={handleExportCSV}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '14px' }}>
            ⬇ Export CSV
          </button>
        </div>
      )}

      {groups.length > 0 && (
        <div style={{
          display: 'flex', gap: '24px', marginBottom: '20px',
          padding: '14px 20px', background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px',
          fontSize: '14px', color: '#374151',
        }}>
          <span><strong>{sent}</strong> sent</span>
          <span><strong>{responded}</strong> responded ({respRate}%)</span>
          <span><strong>{appraisals}</strong> appraisals booked</span>
          <span><strong>{listed}</strong> listings signed</span>
        </div>
      )}

      {loading || !suburbsLoaded ? (
        <LoadingState
          title="Loading pipeline…"
          subtext="First load can take 15–30 seconds while the server warms up. Subsequent suburb switches are near-instant."
        />
      ) : groups.length === 0 ? (
        // Empty state: only suppress when OSM is "slow" (>30s) — at
        // that point a banner is already telling the user. While
        // warming silently in the background, show the empty-state
        // CTA so the user can read what to do next instead of
        // staring at a blank page.
        osmStatus === 'slow' ? null : (
          <div style={{
            background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px',
            padding: '20px 24px', maxWidth: '640px', margin: '20px 0',
          }}>
            <div style={{ color: '#1f2937', fontSize: '14px', lineHeight: '1.55' }}>
              <strong>No prospecting targets yet for {suburb || 'this suburb'}.</strong>
              <br />
              Click 'Generate Letters' to scan recent sales and find neighbouring properties to contact.
              <br />
              This takes about 30 seconds and only needs to be done once per week per suburb.
            </div>
            <div style={{ color: '#6b7280', fontSize: '12px', marginTop: '8px' }}>
              Tip: after your daily scrape runs at 5am, targets are generated automatically.
            </div>
            {autoGenerating && (
              <div style={{ color: '#1d4ed8', fontSize: '12px', marginTop: '10px', fontWeight: 500 }}>
                Generating targets…
              </div>
            )}
          </div>
        )
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Source Sale', 'Target Address', 'Owner Name', 'Status', 'Sent', 'Notes', 'Letter', 'Action'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '600', color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clusters.flatMap(cluster => cluster.groups.map((g, idx) => {
                const isFirst = idx === 0
                const isLast = idx === cluster.groups.length - 1
                const rowBorder = isLast ? '2px solid #e5e7eb' : '1px solid #f3f4f6'
                return (
                  <tr key={g.representative_id} style={{ borderBottom: rowBorder }}>
                    {/* Source cell — rowSpan covers every target in this cluster */}
                    {isFirst && (
                      <td
                        rowSpan={cluster.groups.length}
                        style={{
                          padding: '12px 14px',
                          color: '#374151',
                          maxWidth: '320px',
                          verticalAlign: 'top',
                          background: '#fafafa',
                          borderRight: '1px solid #e5e7eb',
                        }}>
                        {cluster.sources.map((s, i) => (
                          <div key={s.row_id || i} style={{ fontSize: '12px', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <div style={{ fontWeight: '700', color: '#111827', fontSize: '13px' }}>
                              {s.source_address}
                            </div>
                            <div style={{ color: '#6b7280', fontSize: '11px', marginTop: '1px' }}>
                              {formatPrice(s.source_price)}
                              {s.source_sold_date && (
                                <span style={{ color: '#9ca3af', marginLeft: '6px' }}>
                                  · sold {formatDate(s.source_sold_date)}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                        <div style={{ fontSize: '11px', color: '#059669', fontWeight: '600', marginTop: '6px' }}>
                          {cluster.groups.length} target{cluster.groups.length !== 1 ? 's' : ''}
                        </div>
                      </td>
                    )}

                    {/* Target address */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <strong>{g.target_address}</strong>
                      {g.source_suburb && (
                        <div style={{ fontSize: '11px', color: '#9ca3af' }}>{g.source_suburb}</div>
                      )}
                    </td>

                    <td style={{ padding: '10px 12px' }}>
                      {editingName === g.representative_id ? (
                        <input
                          autoFocus
                          defaultValue={g.target_owner_name || ''}
                          onBlur={ev => {
                            patchEntry(g.representative_id, { target_owner_name: ev.target.value })
                            setEditingName(null)
                          }}
                          onKeyDown={ev => { if (ev.key === 'Enter') ev.target.blur() }}
                          style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px', width: '140px' }}
                        />
                      ) : (
                        <span
                          onClick={() => setEditingName(g.representative_id)}
                          style={{ cursor: 'pointer', color: g.target_owner_name ? '#111827' : '#9ca3af', borderBottom: '1px dashed #d1d5db' }}>
                          {g.target_owner_name || '+ add name'}
                        </span>
                      )}
                    </td>

                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: '500',
                        background: STATUS_LABELS[g.status]?.color + '20',
                        color: STATUS_LABELS[g.status]?.color,
                      }}>
                        {STATUS_LABELS[g.status]?.label || g.status}
                      </span>
                    </td>

                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#6b7280' }}>
                      {formatDate(g.sent_date)}
                    </td>

                    <td style={{ padding: '10px 12px', maxWidth: '180px' }}>
                      {editingNote === g.representative_id ? (
                        <input
                          autoFocus
                          defaultValue={g.notes || ''}
                          onBlur={ev => {
                            patchEntry(g.representative_id, { notes: ev.target.value })
                            setEditingNote(null)
                          }}
                          onKeyDown={ev => { if (ev.key === 'Enter') ev.target.blur() }}
                          style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px', width: '160px' }}
                        />
                      ) : (
                        <span
                          onClick={() => setEditingNote(g.representative_id)}
                          style={{ cursor: 'pointer', color: g.notes ? '#111827' : '#9ca3af', borderBottom: '1px dashed #d1d5db' }}>
                          {g.notes || '+ add note'}
                        </span>
                      )}
                    </td>

                    <td style={{ padding: '10px 12px' }}>
                      <button
                        onClick={() => downloadLetter(g.representative_id, g.target_address)}
                        disabled={downloadingIds.has(g.representative_id)}
                        title="Download a Word doc with all nearby sales mentioned"
                        style={{
                          padding: '4px 10px', borderRadius: '4px', border: '1px solid #d1d5db',
                          background: 'white',
                          cursor: downloadingIds.has(g.representative_id) ? 'wait' : 'pointer',
                          fontSize: '12px',
                          opacity: downloadingIds.has(g.representative_id) ? 0.6 : 1,
                        }}>
                        {downloadingIds.has(g.representative_id) ? 'Downloading…' : '📄 Word'}
                      </button>
                    </td>

                    <td style={{ padding: '10px 12px' }}>
                      <select
                        value=""
                        onChange={ev => {
                          if (!ev.target.value) return
                          setActionModal({ id: g.representative_id, status: ev.target.value })
                          ev.target.value = ""
                        }}
                        style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '12px', cursor: 'pointer' }}>
                        <option value="">Update...</option>
                        <option value="responded">Responded</option>
                        <option value="appraisal_booked">Appraisal Booked</option>
                        <option value="listing_signed">Listing Signed</option>
                        <option value="no_response">No Response</option>
                      </select>
                    </td>
                  </tr>
                )
              }))}
            </tbody>
          </table>
        </div>
      )}

      {actionModal && (
        <ActionModal
          status={actionModal.status}
          onConfirm={(notes, date) => {
            patchEntry(actionModal.id, {
              status: actionModal.status,
              notes: notes || undefined,
              response_date: date || undefined,
            })
            setActionModal(null)
          }}
          onClose={() => setActionModal(null)}
        />
      )}
    </div>
  )
}

function ManualAddForm({ defaultSuburb, allowedSuburbs, onSuccess, onError }) {
  const [sourceAddress, setSourceAddress] = useState('')
  const [sourceSuburb, setSourceSuburb] = useState(defaultSuburb || '')
  const [sourcePrice, setSourcePrice] = useState('')
  const [soldDate, setSoldDate] = useState(new Date().toISOString().slice(0, 10))
  const [explicitTargets, setExplicitTargets] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!sourceAddress.trim()) {
      onError && onError('Source address required')
      return
    }
    setSubmitting(true)
    try {
      const body = {
        source_address: sourceAddress.trim(),
        source_suburb: sourceSuburb.trim(),
        source_sold_date: soldDate || undefined,
        source_price: sourcePrice ? parseInt(sourcePrice.replace(/[^\d]/g, '')) : undefined,
      }
      const targets = explicitTargets
        .split(/[\n,;]/)
        .map(t => t.trim())
        .filter(Boolean)
      if (targets.length > 0) body.target_addresses = targets

      const res = await fetch(`${API}/api/pipeline/manual-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.error) {
        onError && onError(data.error)
      } else {
        onSuccess && onSuccess(`Added ${data.generated} entries from ${sourceAddress}`)
        setSourceAddress('')
        setSourcePrice('')
        setExplicitTargets('')
      }
    } catch (e) {
      onError && onError('Failed to connect to backend')
    }
    setSubmitting(false)
  }

  return (
    <form
      onSubmit={submit}
      style={{
        background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px',
        padding: '16px 20px', marginBottom: '16px',
      }}>
      <div style={{ marginBottom: '10px', fontSize: '13px', color: '#78350f' }}>
        Add a sale the scraper missed (off-market, broker network, missing date in REIWA, etc).
        Auto-generates ±1 / ±2 neighbours unless you specify explicit targets.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <input
          required
          placeholder="Source address (e.g. 28 Lillian Street)"
          value={sourceAddress}
          onChange={e => setSourceAddress(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
        <select
          required
          value={sourceSuburb}
          onChange={e => setSourceSuburb(e.target.value)}
          disabled={!allowedSuburbs || allowedSuburbs.length === 0}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px', background: '#fff' }}
        >
          {(!allowedSuburbs || allowedSuburbs.length === 0) ? (
            <option value="">No suburbs assigned</option>
          ) : (
            <>
              <option value="" disabled>Select a suburb…</option>
              {allowedSuburbs.map(s => <option key={s} value={s}>{s}</option>)}
            </>
          )}
        </select>
        <input
          placeholder="Price (optional)"
          value={sourcePrice}
          onChange={e => setSourcePrice(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
        <input
          type="date"
          value={soldDate}
          onChange={e => setSoldDate(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
      </div>
      <div style={{ marginBottom: '10px' }}>
        <input
          placeholder="Optional: explicit target addresses, comma-separated (else auto ±1/±2)"
          value={explicitTargets}
          onChange={e => setExplicitTargets(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px', boxSizing: 'border-box' }}
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        style={{
          padding: '8px 18px', borderRadius: '6px', border: 'none',
          background: submitting ? '#fcd34d' : '#d97706', color: 'white',
          cursor: 'pointer', fontWeight: '600',
        }}>
        {submitting ? 'Adding...' : 'Add Sale'}
      </button>
    </form>
  )
}

function ActionModal({ status, onConfirm, onClose }) {
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState('')
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{ background: 'white', borderRadius: '10px', padding: '24px', width: '360px' }}>
        <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: '600' }}>
          Mark as {status.replace(/_/g, ' ')}
        </h3>
        <input
          placeholder="Notes (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px', marginBottom: '10px', boxSizing: 'border-box' }}
        />
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px', marginBottom: '16px', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(notes, date)}
            style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#1d4ed8', color: 'white', cursor: 'pointer', fontWeight: '600' }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

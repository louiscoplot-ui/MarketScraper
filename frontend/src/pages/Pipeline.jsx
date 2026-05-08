import { useState, useEffect } from 'react'
import { BACKEND_DIRECT, fetchWithRetry, readCache, writeCache } from '../lib/api'
import LoadingState from '../components/LoadingState'

const API = ''
// Pipeline tracking + generate go direct to Render to bypass Vercel's
// 25s edge timeout, same as the listings/suburbs bootstrap. Switching
// suburbs reads pre-generated rows from pipeline_tracking, which is a
// fast indexed lookup — but on a cold dyno even that response is
// blocked by the proxy timeout, so we go direct.
const PIPELINE_API = `${BACKEND_DIRECT}/api/pipeline`

// localStorage cache keys (scoped by access_key prefix via readCache /
// writeCache from lib/api). Stale-while-revalidate — render the cached
// snapshot synchronously on mount + reload, refresh in the background.
const PIPELINE_CACHE_KEY = (suburb) => `pipeline_groups_${(suburb || '__all__').toLowerCase()}`
const RECENT_SALES_CACHE_KEY = (suburb, days) => `pipeline_recent_${(suburb || '__all__').toLowerCase()}_${days}`

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

// Strict dd/mm/yyyy for the recent-sales panel — operators in WA
// expect Australian-style dates, not the ISO yyyy-mm-dd that Postgres
// returns or the localised "8 May 2026" version above.
function formatDateAU(value) {
  if (!value) return '—'
  const s = String(value).trim()
  // Accept ISO yyyy-mm-dd or dd/mm/yyyy. Anything else passes through.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`
  return s
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
  // Hydrate groups synchronously from localStorage on first mount —
  // suburb starts empty until /api/suburbs lands, so we read the
  // generic "__all__" cache here and the suburb-scoped cache kicks in
  // once the suburb effect fires. Either way, first paint shows real
  // rows instead of a spinner after reload.
  const [groups, setGroups] = useState(() => readCache(PIPELINE_CACHE_KEY('')) || [])
  const [generateMsg, setGenerateMsg] = useState(null)
  const [editingName, setEditingName] = useState(null)
  const [editingNote, setEditingNote] = useState(null)
  const [actionModal, setActionModal] = useState(null)
  const [showManualForm, setShowManualForm] = useState(false)
  // Per-row in-flight letter downloads so multiple buttons can be
  // clicked without the spinner state stomping on itself.
  const [downloadingIds, setDownloadingIds] = useState(new Set())
  // Raw sales returned by /api/pipeline/generate — surfaced when
  // generated=0 so the user can SEE the sales found even if no
  // targets were auto-created. Populated by handleGenerate's
  // "Found N sales but..." branch and cleared on success.
  const [recentSales, setRecentSales] = useState([])

  useEffect(() => {
    let cancelled = false
    // Hydrate from App.jsx's localStorage suburb cache so Pipeline
    // doesn't show "No suburbs assigned" while its own fetch is in
    // flight — the shared cache key is the same one App.jsx uses
    // (sd_cache_v2_<key prefix>_suburbs).
    const cached = readCache('suburbs')
    if (Array.isArray(cached) && cached.length > 0) {
      const names = cached.map(r => r.name).filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
      setAllowedSuburbs(names)
      setSuburb(prev => (prev && names.includes(prev)) ? prev : (names[0] || ''))
      setSuburbsLoaded(true)
    }
    // Always fetch fresh too (cache may be stale or first visit).
    // Retry with backoff so a transient 401 / cold start doesn't leave
    // the dropdown empty for the rest of the session.
    fetchWithRetry(`${API}/api/suburbs`, {}, 4)
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        if (cancelled) return
        const names = (Array.isArray(rows) ? rows : [])
          .map(r => r.name).filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        if (names.length > 0) {
          setAllowedSuburbs(names)
          setSuburb(prev => (prev && names.includes(prev)) ? prev : (names[0] || ''))
        }
        setSuburbsLoaded(true)
      })
      .catch(() => { if (!cancelled) setSuburbsLoaded(true) })
    return () => { cancelled = true }
  }, [])

  // Reload the tracking table whenever the active suburb changes.
  // Clear groups + recentSales SYNCHRONOUSLY first so the user
  // doesn't see stale rows from the previous suburb while the new
  // fetch is in flight (was showing Floreat pipeline rows after
  // switching to Mt Claremont because groups state lagged the fetch).
  useEffect(() => {
    if (!suburbsLoaded || !suburb) return
    setGroups([])
    setRecentSales([])
    loadTracking()
  }, [suburb, suburbsLoaded])

  // Auto-fetch the raw sales for the active suburb + day window
  // whenever either changes. This drives the "show me sales in the
  // last N days" view — independent of pipeline generation.
  // Stale-while-revalidate: render cached sales instantly on
  // suburb/days change (or reload), then refresh in background.
  useEffect(() => {
    if (!suburbsLoaded || !suburb) return
    const cached = readCache(RECENT_SALES_CACHE_KEY(suburb, days))
    if (Array.isArray(cached)) setRecentSales(cached)
    let cancelled = false
    fetch(`${PIPELINE_API}/recent-sales?suburb=${encodeURIComponent(suburb)}&days=${days}`)
      .then(r => r.ok ? r.json() : { sales: [] })
      .then(data => {
        if (cancelled) return
        const sales = data.sales || []
        setRecentSales(sales)
        writeCache(RECENT_SALES_CACHE_KEY(suburb, days), sales)
      })
      .catch(() => { if (!cancelled && !cached) setRecentSales([]) })
    return () => { cancelled = true }
  }, [suburb, days, suburbsLoaded])

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
  // Auto-generate as soon as we know there are recent sales and no
  // pipeline targets yet. No OSM gate — the backend handles cold OSM
  // cache internally (slower but works). User shouldn't have to click
  // anything: pick suburb + days → sales appear (via recent-sales
  // panel) AND targets generate silently in the background.
  useEffect(() => {
    if (loading || generating || autoGenerating) return
    if (!suburb) return
    if (groups.length > 0) return
    // Re-trigger when days changes too — a new window means a different
    // sales set, which may unlock generation that previously had nothing.
    const key = `${suburb}|${days}`
    if (autoGeneratedFor.has(key)) return
    if (recentSales.length === 0) return  // no sales to generate from
    const t = setTimeout(async () => {
      setAutoGenerating(true)
      setAutoGeneratedFor(prev => new Set(prev).add(key))
      try { await handleGenerate() } finally { setAutoGenerating(false) }
    }, 1500)
    return () => clearTimeout(t)
  }, [suburb, days, groups.length, loading, generating, recentSales.length])

  // Stale-while-revalidate: hydrate from localStorage instantly on
  // mount/reload (suburb-scoped), then refresh in background. The
  // user sees pipeline rows on first paint instead of a spinner —
  // even after a hard reload. `force` skips the cache hit and forces
  // a fresh fetch (used after PATCH/Generate when we know data
  // changed).
  async function loadTracking({ force = false } = {}) {
    const cached = !force ? readCache(PIPELINE_CACHE_KEY(suburb)) : null
    if (cached && Array.isArray(cached)) {
      setGroups(cached)
      setLoading(false)
      // Continue to fetch fresh in background
    } else {
      setLoading(true)
    }
    try {
      const url = suburb
        ? `${PIPELINE_API}/tracking/grouped?suburb=${encodeURIComponent(suburb)}&limit=500`
        : `${PIPELINE_API}/tracking/grouped?limit=500`
      const res = await fetchWithRetry(url, {}, 4)
      const data = await res.json()
      const groupsResult = data.groups || []
      setGroups(groupsResult)
      writeCache(PIPELINE_CACHE_KEY(suburb), groupsResult)
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
      // OR no neighbours could be auto-found. Either way: surface the
      // raw sales (recent_sales) so the user can SEE what's available
      // and manually add targets if needed.
      const reason = (data.skipped_no_neighbour && data.skipped_no_neighbour > 0)
        ? `couldn't auto-find neighbour addresses for those sales`
        : `all neighbours are already in your pipeline`
      setGenerateMsg({
        type: 'info',
        text: `Found ${data.sold_count} sales — ${reason}.`,
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
    // Optimistic local mirror — apply the change to the row instantly
    // so the user sees the toggle / status / note flip immediately.
    // No loadTracking refetch (which was eating 1+ second per click
    // and resetting scroll position). The PATCH lands server-side in
    // the background. On error we revert by reloading once.
    const localPatch = { ...fields }
    if ('contacted' in fields) {
      localPatch.contacted = !!fields.contacted
      localPatch.contacted_at = fields.contacted ? new Date().toISOString() : null
    }
    setGroups(prev => {
      const next = prev.map(g => g.representative_id === id ? { ...g, ...localPatch } : g)
      writeCache(PIPELINE_CACHE_KEY(suburb), next)
      return next
    })
    try {
      const res = await fetch(`${API}/api/pipeline/tracking/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      // Don't revert the optimistic state on failure — the user sees
      // their toggle/edit persist, and a server-side error gets logged
      // for debugging. Reverting was causing the "click → tick → flip
      // back" symptom whenever the backend hadn't yet had its
      // pipeline_tracking.contacted column added (migration timing
      // race on first deploy).
      console.error('patchEntry failed (kept optimistic state):', e)
    }
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
          const dt = s.source_sold_date ? ` — sold ${formatDateAU(s.source_sold_date)}` : ''
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

          {/* Discrete Add Manual Sale only — Generate Letters runs
              automatically on suburb/days change. The user no longer
              needs to click anything to see sales + targets. */}
          <button
            onClick={() => setShowManualForm(s => !s)}
            style={{
              padding: '8px 12px', borderRadius: '6px', fontSize: '13px', cursor: 'pointer',
              background: showManualForm ? '#374151' : 'white',
              color: showManualForm ? 'white' : '#6b7280',
              border: '1px solid #d1d5db',
            }}>
            {showManualForm ? '× Cancel' : '+ Add sale'}
          </button>

          {generating && (
            <span style={{ fontSize: '12px', color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                width: '12px', height: '12px', borderRadius: '50%',
                border: '2px solid rgba(107,114,128,0.25)',
                borderTopColor: '#6b7280',
                animation: 'sd-spin 0.8s linear infinite',
                display: 'inline-block',
              }} />
              Building targets…
            </span>
          )}
          <style>{`@keyframes sd-spin { to { transform: rotate(360deg) } }`}</style>
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

      {/* Compact utility row — single line, shows context + tiny
          stats + secondary actions. Replaces the previous 3 separate
          blocks (showing-badge / print-export / 4-stat panel) which
          were eating vertical space and adding visual noise. */}
      {groups.length > 0 && (
        <div style={{
          display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '16px',
          fontSize: '13px', color: '#6b7280',
        }}>
          <span>
            <strong style={{ color: '#1C1D22' }}>{groups.length}</strong> targets
            {' · '}
            <strong style={{ color: '#1C1D22' }}>{sent}</strong> sent
            {responded > 0 && (
              <> · <strong style={{ color: '#1C1D22' }}>{responded}</strong> responded ({respRate}%)</>
            )}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button
              onClick={() => window.open('/pipeline/print', '_blank')}
              style={{ padding: '4px 10px', borderRadius: '4px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '12px', color: '#6b7280' }}>
              Print all
            </button>
            <button
              onClick={handleExportCSV}
              style={{ padding: '4px 10px', borderRadius: '4px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '12px', color: '#6b7280' }}>
              Export CSV
            </button>
          </span>
        </div>
      )}

      {/* Always-visible "sales in last N days" panel — driven by the
          7/14/30 day toggle. Independent of pipeline generation:
          shows what's there even when no targets have been auto-built
          yet. */}
      {recentSales.length > 0 && (
        <div style={{
          background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px',
          padding: '14px 18px', marginBottom: '16px',
        }}>
          <div style={{
            fontSize: '13px', fontWeight: 600, color: '#111827',
            marginBottom: '10px', display: 'flex', justifyContent: 'space-between',
          }}>
            <span>Recent sales in {suburb} — last {days} days</span>
            <span style={{ color: '#6b7280', fontWeight: 400 }}>
              {recentSales.length} {recentSales.length === 1 ? 'sale' : 'sales'}
            </span>
          </div>
          <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
            {recentSales.map((s, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '8px 0', borderTop: i ? '1px solid #f3f4f6' : 'none',
                fontSize: '13px',
              }}>
                <span style={{ flex: 1, fontWeight: 500, color: '#111827' }}>
                  {s.source_address}
                </span>
                <span style={{ color: '#374151', minWidth: '110px', textAlign: 'right' }}>
                  {s.source_price ? `$${s.source_price.toLocaleString()}` : '—'}
                </span>
                <span style={{ color: '#6b7280', minWidth: '90px', textAlign: 'right' }}>
                  {formatDateAU(s.source_sold_date)}
                </span>
                {s.reiwa_url && (
                  <a href={s.reiwa_url} target="_blank" rel="noopener noreferrer"
                     style={{ color: '#1d4ed8', fontSize: '12px' }}>
                    View
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {loading || !suburbsLoaded ? (
        <LoadingState
          title="Loading pipeline…"
          subtext="First load can take 15–30 seconds while the server warms up. Subsequent suburb switches are near-instant."
        />
      ) : groups.length === 0 ? (
        // No pipeline targets yet — but the recent-sales panel above
        // already shows what's there. Show a tiny status hint instead
        // of a big CTA box telling the user to click something. If a
        // background generation is running, surface that.
        recentSales.length === 0 ? (
          <div style={{
            color: '#6b7280', fontSize: '13px', padding: '20px 0',
          }}>
            No sales found for {suburb || 'this suburb'} in the last {days} days.
            Try a wider window — or pick a different suburb.
          </div>
        ) : (
          <div style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>
            {autoGenerating
              ? `Building neighbour targets for ${suburb}…`
              : `Sales above. Targets will appear shortly.`}
          </div>
        )
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Source Sale', 'Target Address', 'Owner Name', 'Contacted', 'Status', 'Sent', 'Notes', 'Letter', 'Action'].map(h => (
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
                                  · sold {formatDateAU(s.source_sold_date)}
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
                      {/* One-click contacted toggle. Lets the agent
                          mark a row as called/letter-sent without
                          digging into the Status dropdown. Backed by
                          pipeline_tracking.contacted (INTEGER 0/1)
                          + contacted_at timestamp set server-side. */}
                      <button
                        type="button"
                        onClick={() => patchEntry(g.representative_id, { contacted: !g.contacted })}
                        title={g.contacted_at ? `Marked contacted ${formatDateAU(g.contacted_at)}` : 'Click to mark contacted'}
                        style={{
                          padding: '4px 10px', borderRadius: '999px',
                          border: `1px solid ${g.contacted ? '#16a34a' : '#d1d5db'}`,
                          background: g.contacted ? '#dcfce7' : 'white',
                          color: g.contacted ? '#15803d' : '#6b7280',
                          cursor: 'pointer', fontSize: '12px', fontWeight: 500,
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                        }}
                      >
                        {g.contacted ? '✓ Contacted' : 'Mark contacted'}
                      </button>
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
                      {formatDateAU(g.sent_date)}
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

// Hot Vendor Scoring — drop a CSV / xlsx, the backend's v4 pipeline does
// the heavy lifting (auto-calibrated weights per suburb, latent profit,
// quantile-based segmentation) and returns the full scored list. The
// .xlsx report is regenerated on demand from the persisted data.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, MapPin, ChevronDown, StickyNote, Plus, Upload, Search, Check, Star, Clock } from 'lucide-react'
import StickyHScroll from './components/StickyHScroll'
import DeskMap from './components/DeskMap'
import { formatIsoDate } from './hooks/useListings'
import { Button, ScoreBadge, Checkbox, Select } from './components/ui'
import { getDeskMode } from './lib/deskFlag'
import { readCache, writeCache, writeCacheEvicting, BACKEND_DIRECT, fetchWithRetry, getAccessKey } from './lib/api'

// Vercel proxy has a ~25s edge timeout that includes upload buffering.
// For big suburbs (Ellenbrook, Mandurah — 50-200 MB CSVs) we bypass
// Vercel and POST directly to Render. CORS is wide-open on the backend
// (`CORS(app)` in app.py) so cross-origin POST works. Polling stays on
// the proxy because each poll is tiny + low-latency.
const API = ''
// BACKEND_DIRECT comes from lib/api — the hardcoded local copy skipped
// the preview-host fallback (previews sit outside the backend's CORS
// allow-list, so direct calls silently died there).
// The active-job key is scoped per user (access-key prefix): on a
// shared browser, user B must not resume/clear user A's scoring job.
const ACTIVE_JOB_KEY = `agentdeck_hv_active_job_${(getAccessKey() || 'anon').slice(0, 16)}`

// Category filter chips — a coloured dot (score-badge palette) + a
// plain label. No emoji, no full-pill fill: the row stays neutral and
// the only place category colour lives is the ScoreBadge column.
const CAT_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'HOT', label: 'Hot', dot: 'var(--score-hot)' },
  { key: 'WARM', label: 'Warm', dot: 'var(--score-warm)' },
  { key: 'MEDIUM', label: 'Medium', dot: 'var(--score-medium)' },
  { key: 'LOW', label: 'Low', dot: 'var(--score-low)' },
]

// User-controlled per-row workflow flags. Plain labels — no emoji, and
// no row tint any more (rows are neutral; the flag lives in the select).
const STATUS_OPTIONS = [
  { value: '', label: '—' },
  { value: 'contacted', label: 'Called / Contacted' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'listed', label: 'Listed / Appraised' },
  { value: 'pending', label: 'Considering / Pending' },
  { value: 'declined', label: 'Not interested' },
]

// Local (Perth) YYYY-MM-DD — toISOString alone is UTC and would flip the
// date around 8am Perth time.
function localIsoDate(base, plusDays = 0) {
  const d = base ? new Date(base) : new Date()
  d.setDate(d.getDate() + plusDays)
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return t.toISOString().slice(0, 10)
}

// Snooze state for a row: 'due' (callback date reached), 'snoozed'
// (future date), or null.
function callbackState(dateStr) {
  if (!dateStr) return null
  return dateStr <= localIsoDate() ? 'due' : 'snoozed'
}

// Display-only: RP Data ships addresses in ALL CAPS. Title-case them
// for the UI without ever touching the stored value.
function titleCase(s) {
  if (!s) return s
  return String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

// Whole months since an ISO/date string, or null if unparseable.
function monthsSince(value) {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime())) return null
  return Math.max(0, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.4)))
}

// Soft, non-blocking freshness note. Nothing before 3 months; after
// that a neutral grey line — never "expired", never red. Access to the
// data / scoring / export is NEVER gated on age.
const STALE_AFTER_MONTHS = 3
function stalenessLabel(uploadedAt) {
  const n = monthsSince(uploadedAt)
  if (n == null || n < STALE_AFTER_MONTHS) return null
  return `~${n} month${n === 1 ? '' : 's'} old`
}


// Small, neutral freshness note on each saved-upload card. Nothing
// before 3 months; after that a discreet grey pill — never red, never
// "expired". A 6-month-old RP Data export on properties held 10+ years
// is still perfectly usable, so we suggest, we don't alarm.
function renderExpiryBadge(u) {
  const label = stalenessLabel(u && u.uploaded_at)
  if (!label) return null
  return (
    <div style={{
      marginTop: 6, fontSize: 11, padding: '2px 7px',
      borderRadius: 'var(--radius-sm)', display: 'inline-block',
      background: 'var(--status-off-bg)', color: 'var(--text-muted)',
    }}>{label}</div>
  )
}

// Page-wide freshness line above the table — same neutral logic as the
// card badge. Non-blocking: it never disables data, scoring or export.
function renderExpiryBanner(data) {
  if (!data) return null
  const label = stalenessLabel(data.uploaded_at)
  if (!label) return null
  const when = data.uploaded_at ? formatIsoDate(data.uploaded_at) : ''
  return (
    <div style={{
      margin: '0 0 12px', padding: '9px 14px',
      borderRadius: 'var(--radius)', fontSize: 13,
      background: 'var(--status-off-bg)',
      border: '1px solid var(--border)',
      color: 'var(--text-muted)',
    }}>
      Last updated{when ? ` ${when}` : ''} · {label}. Re-import your RP Data
      for the freshest scores whenever you like.
    </div>
  )
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
  current_owner: (a, b) => String(a.current_owner || '').localeCompare(String(b.current_owner || '')),
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
  // Stale-while-revalidate: hydrate the last-scored report from localStorage
  // so the table is on screen instantly on every visit/reload — no "Working
  // on it…" flash. Only a new upload/score replaces it (see writeCache below).
  const [data, setData] = useState(() => readCache('hv_last_report'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ field: 'rank', dir: 'asc' })
  const [selectedSuburbs, setSelectedSuburbs] = useState(new Set())
  // Compact mode defaults ON for first-time visitors. Toggle persists.
  const [compact, setCompact] = useState(() => {
    try {
      const v = localStorage.getItem('hv_compact')
      return v === null ? true : v === '1'
    } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('hv_compact', compact ? '1' : '0') } catch {}
  }, [compact])
  const [statuses, setStatuses] = useState({})
  const [notes, setNotes] = useState({})
  // Call-back dates (snooze) — keyed by raw address like statuses/phones.
  const [callbacks, setCallbacks] = useState({})
  // Property dossier popup (desk) — opens when the operator clicks an
  // address; shows every field the score is built from + contact.
  const [propDetail, setPropDetail] = useState(null)
  const [noteEditing, setNoteEditing] = useState(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [suburbDropdownOpen, setSuburbDropdownOpen] = useState(false)
  const fileInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)
  const wrapperRef = useRef(null)
  const suburbDropdownRef = useRef(null)
  const [savedUploads, setSavedUploads] = useState(() => readCache('hv_uploads') || [])
  // Only show the "Loading…" hint when we have nothing cached to show yet.
  const [savedLoading, setSavedLoading] = useState(() => (readCache('hv_uploads') || []).length === 0)
  // Visible feedback when the operator switches between saved reports
  // (separate from `loading`, which doubles as the upload-in-progress
  // flag). Drives the small "Loading…" hint next to "Recent reports".
  const [isLoadingReport, setIsLoadingReport] = useState(false)
  // In-memory cache of report payloads keyed by upload_id. Switching
  // back to a report already loaded this session is instant — no
  // network round-trip. Cleared on hard reload (ref, not localStorage).
  const reportCache = useRef(new Map())

  // Load past uploads on mount so a returning user lands on a list of
  // previously-scored suburbs (latest per suburb) instead of a blank
  // dropzone. UPSERT keeps re-uploads from duplicating rows.
  //
  // Auto-load the most recent upload as soon as the list arrives so
  // the operator never has to re-upload an Excel that's already in the
  // database — they pick up exactly where they left off, including
  // status flags / notes the side-tables persist.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // BACKEND_DIRECT + retry: through the Vercel proxy a cold Render
        // dyno died at the 25s edge timeout with a single attempt, and
        // "Recent reports" stayed empty for the first morning visit.
        const res = await fetchWithRetry(`${BACKEND_DIRECT}/api/hot-vendors/uploads`, {}, 4)
        if (!res.ok) throw new Error('list failed')
        const j = await res.json()
        if (cancelled) return
        const uploads = j.uploads || []
        setSavedUploads(uploads)
        writeCache('hv_uploads', uploads)
        // Auto-load the latest report only if nothing is on screen yet — a
        // cache-hydrated `data` means we keep it (no refetch) until the user
        // clicks another suburb or uploads anew.
        if (uploads.length > 0 && !data) {
          loadSavedUpload(uploads[0].id)
        }
      } catch (e) {
        console.warn('Could not load past uploads:', e)
      } finally {
        if (!cancelled) setSavedLoading(false)
      }
    })()
    return () => { cancelled = true }
    // Intentionally only on mount — `data` is checked inside so the
    // auto-load is skipped if the user has already loaded something.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sequence counter so the latest click always wins. If the user
  // clicks Cottesloe while Ellenbrook is mid-load, we don't want
  // Ellenbrook's response to clobber Cottesloe's after they switched.
  const loadSeqRef = useRef(0)
  const loadSavedUpload = async (uploadId) => {
    const seq = ++loadSeqRef.current
    setError('')
    // Cache hit (in-memory this session, or localStorage from a past visit)
    // → swap data instantly, skip the fetch entirely.
    if (reportCache.current.has(uploadId)) {
      const hit = reportCache.current.get(uploadId)
      setData(hit)
      writeCacheEvicting('hv_last_report', hit, 'hv_report_')
      return
    }
    const persisted = readCache(`hv_report_${uploadId}`)
    if (persisted) {
      reportCache.current.set(uploadId, persisted)
      setData(persisted)
      writeCacheEvicting('hv_last_report', persisted, 'hv_report_')
      return
    }
    setLoading(true)
    setIsLoadingReport(true)
    try {
      // Direct + retry — a multi-MB report through a cold Vercel proxy
      // hit the 25s edge timeout on the first morning load.
      const res = await fetchWithRetry(`${BACKEND_DIRECT}/api/hot-vendors/uploads/${uploadId}`, {}, 4)
      const result = await res.json()
      if (seq !== loadSeqRef.current) return  // a newer click is in flight
      if (!res.ok) throw new Error(result.error || `Load failed (${res.status})`)
      reportCache.current.set(uploadId, result)
      setData(result)
      // Persist so this report is instant next visit. writeCache silently
      // no-ops if the payload blows the quota (big suburbs) — the network
      // stays the fallback, so correctness is unaffected.
      writeCacheEvicting(`hv_report_${uploadId}`, result, 'hv_report_')
      writeCacheEvicting('hv_last_report', result, 'hv_report_')
    } catch (e) {
      if (seq !== loadSeqRef.current) return
      console.error(e)
      setError(e.message || 'Failed to load saved upload')
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false)
        setIsLoadingReport(false)
      }
    }
  }

  const refreshSavedUploads = async () => {
    try {
      const res = await fetch(`${API}/api/hot-vendors/uploads`)
      if (res.ok) {
        const j = await res.json()
        setSavedUploads(j.uploads || [])
        writeCache('hv_uploads', j.uploads || [])
      }
    } catch {}
  }

  // A freshly-scored report replaces the cached one (the "except on new
  // upload" case) so the next visit hydrates to the latest, not the old.
  const persistScored = (result) => {
    if (!result || result.error) return
    const id = result.upload_id ?? result.id ?? result.uploadId
    if (id != null) reportCache.current.set(id, result)
    if (id != null) writeCacheEvicting(`hv_report_${id}`, result, 'hv_report_')
    writeCacheEvicting('hv_last_report', result, 'hv_report_')
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
        // Per-attempt deadline: a TCP-stalled poll never resolved, so
        // the MAX_MS guard below was never reached and the upload froze
        // "in progress" forever. AbortError lands in the catch and the
        // loop keeps polling.
        sRes = await fetch(`${API}/api/hot-vendors/score-csv/job/${jobId}`,
          { signal: AbortSignal.timeout(12000) })
        sJson = await sRes.json().catch(() => ({}))
      } catch (netErr) {
        // Transient network blip — keep polling, the job is still on
        // the server. Log so we see it in DevTools.
        console.warn('[poll] network blip, retrying:', netErr.message)
        continue
      }
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
      const startJson = await startRes.json().catch(() => ({}))
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

      const result = await pollJob(jobId)
      setData(result)
      persistScored(result)
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
    setLoading(true)
    setLoadingStage('Resuming…')
    ;(async () => {
      try {
        const result = await pollJob(stored.job_id, { signal: { get aborted() { return cancelled } } })
        if (cancelled) return
        setData(result)
        persistScored(result)
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
  const [excelStage, setExcelStage] = useState('')
  const [excelFallbackUrl, setExcelFallbackUrl] = useState(null)
  const [excelFallbackName, setExcelFallbackName] = useState('')

  // The "click here if it didn't download" fallback belongs to ONE report:
  // clear it (and release the blob) when the report on screen changes, so
  // it can't hand out the previous suburb's file under a stale name.
  useEffect(() => {
    setExcelFallbackUrl(prev => {
      if (prev) { try { URL.revokeObjectURL(prev) } catch { /* ignore */ } }
      return null
    })
    setExcelFallbackName('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const downloadExcel = async () => {
    const id = data?.upload_id ?? data?.id ?? data?.uploadId
    if (!id) {
      setError(
        'No upload_id on this report. The backend may not have finished ' +
        'persisting yet, or the saved upload predates this version. ' +
        'Try re-uploading the CSV (UPSERT — won\'t duplicate rows).'
      )
      return
    }
    setError('')
    setExcelFallbackUrl(prev => {
      if (prev) { try { URL.revokeObjectURL(prev) } catch { /* ignore */ } }
      return null
    })
    setExcelLoading(true)
    setExcelStage('Starting…')
    const t0 = Date.now()
    // Per-fetch timeouts so a TCP stall on Render can't hang the
    // polling loop indefinitely. Without these, fetch() has no
    // built-in deadline and a borked dyno would keep the button
    // disabled forever — the outer try/finally never fires because
    // we're still suspended inside the await.
    const POST_TIMEOUT_MS = 30000
    const POLL_TIMEOUT_MS = 12000
    const FILE_TIMEOUT_MS = 120000
    let consecutivePollErrors = 0
    try {
      // Async pattern: POST starts a background build job, we poll the
      // status, then fetch the file once ready. Avoids 502s on big
      // suburbs that take >2 min to serialise.
      const startRes = await fetch(
        `${BACKEND_DIRECT}/api/hot-vendors/uploads/${id}/excel-job`,
        { method: 'POST', signal: AbortSignal.timeout(POST_TIMEOUT_MS) }
      )
      const startJson = await startRes.json().catch(() => ({}))
      if (!startRes.ok || !startJson.job_id) {
        throw new Error(startJson.error || `Could not start Excel job (${startRes.status})`)
      }
      const jobId = startJson.job_id

      const POLL_MS = 1500
      const MAX_MS = 10 * 60 * 1000
      while (true) {
        await new Promise(r => setTimeout(r, POLL_MS))
        if (Date.now() - t0 > MAX_MS) throw new Error('Excel job took >10 min')
        let sRes
        try {
          sRes = await fetch(
            `${BACKEND_DIRECT}/api/hot-vendors/excel-job/${jobId}`,
            { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }
          )
        } catch (e) {
          // Network throw / abort — count it. After 5 in a row,
          // bail out so the button stops being stuck.
          consecutivePollErrors += 1
          console.warn(`[Excel poll ${jobId}] fetch error ${consecutivePollErrors}/5:`, e.message)
          if (consecutivePollErrors >= 5) {
            throw new Error('Lost connection to the server while polling Excel job')
          }
          continue
        }
        consecutivePollErrors = 0
        const sJson = await sRes.json().catch(() => ({}))
        if (sJson.stage) setExcelStage(sJson.stage)
        if (sJson.status === 'done' && sJson.has_file) {
          const fileRes = await fetch(
            `${BACKEND_DIRECT}/api/hot-vendors/excel-job/${jobId}/file`,
            { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) }
          )
          if (!fileRes.ok) throw new Error(`File fetch failed (${fileRes.status})`)
          const blob = await fileRes.blob()
          if (!blob.size) throw new Error('Empty file from backend')
          const dlUrl = URL.createObjectURL(blob)
          const fname = sJson.filename || `hot-vendors-${data.suburb || 'report'}.xlsx`
          const a = document.createElement('a')
          a.href = dlUrl
          a.download = fname
          a.style.display = 'none'
          document.body.appendChild(a)
          a.click()
          setTimeout(() => { a.remove() }, 1000)
          setExcelFallbackUrl(dlUrl)
          setExcelFallbackName(fname)
          return
        }
        if (sJson.status === 'error') throw new Error(sJson.error || 'Excel build failed')
        if (sJson.status === 'lost' || !sRes.ok) throw new Error(sJson.error || 'Job lost')
      }
    } catch (e) {
      console.error('[Excel] Failed:', e)
      setError(e.message || 'Excel download failed')
    } finally {
      // Always restore the button — every code path (success return,
      // throw inside loop, AbortSignal timeout, post-deploy reload)
      // converges here. The previous failure mode was a stalled fetch
      // with no signal: AbortSignal.timeout — we'd suspend inside the
      // await and the finally would never fire.
      setExcelLoading(false)
      setExcelStage('')
    }
  }

  const properties = data?.properties || []

  // Hydrate per-row status + note from the score-csv payload (server-
  // side join against hot_vendor_property_status). Re-runs on new
  // uploads; notes survive across re-uploads keyed on normalized address.
  useEffect(() => {
    if (!data) { setStatuses({}); setNotes({}); setPhones({}); setCallbacks({}); setSelectedSuburbs(new Set()); return }
    const nextS = {}
    const nextN = {}
    const nextP = {}
    const nextC = {}
    for (const p of data.properties || []) {
      if (p.user_status) nextS[p.address] = p.user_status
      if (p.user_note) nextN[p.address] = p.user_note
      // Hydrate the backend-saved phone too — and RESET on report switch:
      // phones is keyed by raw address, so a stale map showed suburb A's
      // hand-typed number on a same-named address in suburb B.
      if (p.phone) nextP[p.address] = p.phone
      if (p.callback_date) nextC[p.address] = p.callback_date
    }
    setStatuses(nextS)
    setNotes(nextN)
    setPhones(nextP)
    setCallbacks(nextC)
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

  // Manual phone numbers keyed by address — hydrated from the property's
  // `phone` field (backend) and overridden locally on save.
  const [phones, setPhones] = useState({})
  const [phoneSaving, setPhoneSaving] = useState(false)
  const [phoneDraft, setPhoneDraft] = useState('')
  // Contacts import — same model as the official RP-Data upload: drop a
  // csv/xlsx with names/addresses/phones, the backend auto-detects the
  // columns and merges by address into the scored list.
  const contactsInputRef = useRef(null)
  const [importingContacts, setImportingContacts] = useState(false)
  const importContacts = async (file) => {
    if (!file) return
    setImportingContacts(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${BACKEND_DIRECT}/api/hot-vendors/import-contacts`, {
        method: 'POST',
        body: fd,
        headers: { 'X-Access-Key': localStorage.getItem('agentdeck_access_key') || '' },
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `Import failed (${res.status})`)
      let msg = `Contacts imported — ${j.phones_saved} phone number${j.phones_saved === 1 ? '' : 's'} saved`
        + (j.owners_filled ? `, ${j.owners_filled} owner name${j.owners_filled === 1 ? '' : 's'} filled` : '')
        + ` (${j.matched} address${j.matched === 1 ? '' : 'es'} matched).`
      if (j.unmatched) msg += `\n${j.unmatched} address${j.unmatched === 1 ? '' : 'es'} not in your scored list${j.unmatched_sample?.length ? `, e.g. ${j.unmatched_sample.slice(0, 3).join('; ')}` : ''}.`
      alert(msg)
      // Refresh the on-screen report so the new phones hydrate.
      const id = data?.upload_id ?? data?.id ?? data?.uploadId
      if (id) {
        const res2 = await fetch(`${API}/api/hot-vendors/uploads/${id}`)
        const result = await res2.json().catch(() => null)
        if (res2.ok && result && !result.error) {
          reportCache.current.set(id, result)
          setData(result)
          persistScored(result)
        }
      }
    } catch (e) {
      alert(`Contacts import failed: ${e.message}`)
    } finally {
      setImportingContacts(false)
      if (contactsInputRef.current) contactsInputRef.current.value = ''
    }
  }
  const openDetail = (p) => {
    setPropDetail(p)
    setPhoneDraft(phones[p.address] ?? p.phone ?? '')
  }
  // Optimistic with REVERT + alert on failure (same contract as saveNote):
  // a hand-typed owner phone number silently vanishing on the next reload
  // because a cold-start PATCH failed is the worst kind of data loss.
  const savePhone = async (address, phone) => {
    const trimmed = (phone || '').trim()
    let previous
    setPhoneSaving(true)
    setPhones(prev => { previous = prev[address]; return { ...prev, [address]: trimmed } })
    try {
      const res = await fetch(`${API}/api/hot-vendors/phone`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, phone: trimmed }),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
    } catch (e) {
      setPhones(prev => {
        const next = { ...prev }
        if (previous === undefined) delete next[address]; else next[address] = previous
        return next
      })
      alert(`Could not save the phone number: ${e.message}. Please try again.`)
    } finally {
      setPhoneSaving(false)
    }
  }

  // callbackDate: undefined = leave the snooze untouched (plain status
  // change) · '' = clear it · 'YYYY-MM-DD' = snooze until that date.
  const setStatus = async (address, status, callbackDate) => {
    let previous
    let prevCb
    setStatuses(prev => {
      previous = prev[address]
      const next = { ...prev }
      if (status) next[address] = status; else delete next[address]
      return next
    })
    if (callbackDate !== undefined) {
      setCallbacks(prev => {
        prevCb = prev[address]
        const next = { ...prev }
        if (callbackDate) next[address] = callbackDate; else delete next[address]
        return next
      })
    }
    try {
      const body = { address, status }
      if (callbackDate !== undefined) body.callback_date = callbackDate || null
      const res = await fetch(`${API}/api/hot-vendors/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
    } catch (e) {
      setStatuses(prev => {
        const next = { ...prev }
        if (previous === undefined) delete next[address]; else next[address] = previous
        return next
      })
      if (callbackDate !== undefined) {
        setCallbacks(prev => {
          const next = { ...prev }
          if (prevCb === undefined) delete next[address]; else next[address] = prevCb
          return next
        })
      }
      alert(`Could not save the status: ${e.message}. Please try again.`)
    }
  }

  const openNote = (p) => {
    setNoteEditing(p)
    setNoteDraft(notes[p.address] || '')
  }
  const closeNote = () => {
    setNoteEditing(null)
    setNoteDraft('')
    setNoteSaving(false)
  }
  const saveNote = async () => {
    if (!noteEditing) return
    setNoteSaving(true)
    try {
      const res = await fetch(`${API}/api/hot-vendors/note`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: noteEditing.address, note: noteDraft }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || 'Save failed')
      }
      const trimmed = noteDraft.trim()
      setNotes(prev => {
        const next = { ...prev }
        if (trimmed) next[noteEditing.address] = trimmed
        else delete next[noteEditing.address]
        return next
      })
      closeNote()
    } catch (e) {
      alert(`Could not save note: ${e.message}`)
      setNoteSaving(false)
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
  const expiryBanner = renderExpiryBanner(data)
  const suburbBtnLabel = selectedSuburbs.size === 0
    ? `All suburbs${uniqueSuburbs.length > 1 ? ` (${uniqueSuburbs.length})` : ''}`
    : selectedSuburbs.size === 1
      ? Array.from(selectedSuburbs)[0]
      : `${selectedSuburbs.size} suburbs`

  // ── Desk redesign — full render of mock #hotvendors (scored state only;
  // the upload/empty flow keeps its classic UI below). ──
  if (getDeskMode() === 'desk' && properties.length > 0) {
    // Highest final_score across the whole dataset — independent of the
    // current sort/filter so the banner never promotes the wrong lead.
    const top = properties.reduce((a, b) => ((b.final_score || 0) > (a.final_score || 0) ? b : a), properties[0])
    const currentUploadId = String(data?.upload_id ?? data?.id ?? data?.uploadId ?? '')
    const kpis = [
      { l: 'Hot', v: counts.HOT, c: 'var(--score-hot)' },
      { l: 'Warm', v: counts.WARM, c: 'var(--score-warm)' },
      { l: 'Medium', v: counts.MEDIUM, c: 'var(--score-medium)' },
      { l: 'Total scored', v: properties.length, c: 'var(--status-off)' },
    ]
    const sigChips = (p) => {
      const out = []
      if (p.holding_years != null) out.push(`${Math.round(p.holding_years)}y hold`)
      if (p.owner_gain_pct != null) out.push(`${p.owner_gain_pct >= 0 ? '+' : ''}${Math.round(p.owner_gain_pct)}% gain`)
      if (p.sales_count) out.push(`${p.sales_count} street sale${p.sales_count === 1 ? '' : 's'}`)
      return out.slice(0, 2)
    }
    const CHIPS = CAT_FILTERS.map(c => ({ key: c.key, label: c.label, dot: c.dot, n: c.key === 'ALL' ? properties.length : (counts[c.key] || 0) }))
    // Status column 170px — the native <select> sizes to its longest
    // option (~165px at 12px + padding) and overflowed the previous 132px.
    const GRID = '46px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.15fr) 170px 140px'
    const noteFor = (a) => (notes[a] || '').trim()
    const catBadge = (cat) => cat === 'HOT' ? { bg: 'var(--score-hot-bg)', fg: 'var(--score-hot-text)' }
      : cat === 'WARM' ? { bg: 'var(--status-watch-bg)', fg: 'var(--status-watch-text)' }
      : cat === 'MEDIUM' ? { bg: 'var(--status-good-bg)', fg: 'var(--status-good-text)' }
      : { bg: 'var(--status-off-bg)', fg: 'var(--status-off-text)' }
    const HV_HEAD = [
      { l: 'Score', f: 'final_score' }, { l: 'Address', f: 'address' }, { l: 'Owner', f: 'current_owner' },
      { l: 'Signals' }, { l: 'Status' }, { l: 'Note' },
    ]
    return (
      <div style={{ padding: '24px 30px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Hot Vendors</h2>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>{properties.length} owners scored · avg {Math.round(avgScore)}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {/* Excel export — same background job + polling flow as classic. */}
            <button onClick={downloadExcel} disabled={excelLoading}
              title="Download the scored .xlsx report"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--accent-fg)', background: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 10, padding: '9px 14px', cursor: excelLoading ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              <Download size={13} strokeWidth={2} aria-hidden="true" />
              {excelLoading ? (excelStage || 'Generating…') : 'Export Excel'}
            </button>
            {excelFallbackUrl && (
              <a href={excelFallbackUrl} download={excelFallbackName}
                style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                Click here if it didn't download
              </a>
            )}
            {/* Switch between saved reports — same loader as the classic
                "Recent reports" cards. */}
            {savedUploads.length > 1 && (
              <Select
                size="sm"
                title="Switch report"
                value={savedUploads.some(u => String(u.id) === currentUploadId) ? currentUploadId : ''}
                onChange={(e) => { const u = savedUploads.find(x => String(x.id) === e.target.value); if (u) loadSavedUpload(u.id) }}
                options={[
                  ...(savedUploads.some(u => String(u.id) === currentUploadId) ? [] : [{ value: '', label: 'Recent reports…' }]),
                  ...savedUploads.map(u => ({ value: String(u.id), label: `${u.suburb || 'Report'}${u.uploaded_at ? ` · ${formatIsoDate(u.uploaded_at)}` : ''}` })),
                ]}
              />
            )}
            {/* Load another file — same scoring flow as the classic dropzone. */}
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }}
              onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
            <button onClick={() => !loading && fileInputRef.current?.click()} disabled={loading}
              title="Upload a new RP Data CSV / xlsx to score"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', cursor: loading ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              <Upload size={13} strokeWidth={2} aria-hidden="true" />
              {loading ? (loadingStage || 'Working…') : 'Upload CSV'}
            </button>
            {/* Contacts import — csv/xlsx with names/addresses/phones,
                merged by address into this list (same flow as the
                official RP-Data upload). */}
            <input ref={contactsInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }}
              onChange={(e) => importContacts(e.target.files && e.target.files[0])} />
            <button onClick={() => contactsInputRef.current && contactsInputRef.current.click()} disabled={importingContacts}
              title="Import a spreadsheet of names, addresses and phone numbers — matched to this list by address"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', cursor: importingContacts ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              {importingContacts ? 'Importing…' : <><Upload size={13} strokeWidth={2} aria-hidden="true" /> Import contacts</>}
            </button>
            {/* Suburb picker — desk has no sidebar, so surface suburb
                selection here. Empty selection = all. */}
            {uniqueSuburbs.length > 1 && (
              /* ref shared with the doc-level mousedown closer — without it
                 (desk has its own markup) every mousedown inside the menu
                 unmounted the dropdown before the click could land. */
              <div ref={suburbDropdownRef} style={{ position: 'relative' }}>
                <button onClick={() => setSuburbDropdownOpen(o => !o)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: selectedSuburbs.size ? 'var(--accent)' : 'var(--text-muted)', background: 'var(--surface)', border: `1px solid ${selectedSuburbs.size ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, padding: '9px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {suburbBtnLabel} <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
                </button>
                {suburbDropdownOpen && (
                  <>
                    <div onClick={() => setSuburbDropdownOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
                    <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 21, width: 230, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 40px -8px rgba(15,23,42,.3)', padding: '10px 12px', maxHeight: 340, overflowY: 'auto' }}>
                      <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                        <button className="btn-link" onClick={() => setSelectedSuburbs(new Set())} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>All</button>
                        <button className="btn-link" onClick={() => setSelectedSuburbs(new Set(uniqueSuburbs))} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>Select all</button>
                      </div>
                      {uniqueSuburbs.map(s => (
                        <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 2px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text)' }}>
                          <input type="checkbox" checked={selectedSuburbs.has(s)} onChange={() => setSelectedSuburbs(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })} style={{ accentColor: 'var(--accent)', width: 15, height: 15 }} />
                          {s}
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {top && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, background: 'linear-gradient(100deg,rgba(219,39,119,.10),rgba(219,39,119,.02))', border: '1px solid rgba(219,39,119,.22)', borderRadius: 16, padding: '16px 22px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, width: 56, height: 56, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', color: 'var(--score-hot-text)', boxShadow: '0 2px 10px rgba(219,39,119,.22)', flexShrink: 0 }}>{Math.round(top.final_score)}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--score-hot-text)', marginBottom: 5 }}>Hottest lead today · act first</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, letterSpacing: '-0.01em', color: 'var(--text)' }}>{titleCase(top.address)}{getSuburb(top) ? `, ${getSuburb(top)}` : ''}</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{top.current_owner || '—'}{noteFor(top.address) ? ` · ${noteFor(top.address)}` : ''}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button onClick={() => setStatus(top.address, 'contacted', '')} style={{ background: 'var(--score-hot)', border: 'none', color: '#fff', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, padding: '10px 16px', borderRadius: 9, cursor: 'pointer' }}>Log a call</button>
              <button onClick={() => openNote(top)} style={{ background: 'var(--surface)', border: '1px solid rgba(219,39,119,.3)', color: 'var(--score-hot-text)', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, padding: '10px 16px', borderRadius: 9, cursor: 'pointer' }}>Add note</button>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
          {kpis.map(k => (
            <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 13, padding: '15px 17px', boxShadow: 'var(--shadow-card)' }}>
              <span style={{ width: 9, height: 38, borderRadius: 5, background: k.c, flexShrink: 0 }} />
              <div><div style={{ fontFamily: 'var(--font-display)', fontSize: 28, lineHeight: 0.9, letterSpacing: '-0.02em', color: 'var(--text)' }}>{k.v}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 6 }}>{k.l}</div></div>
            </div>
          ))}
        </div>

        {/* Filter pills + search on ONE row, directly above the table so
            the search sits right where it acts. Search pushed to the far
            right (marginLeft:auto). */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {CHIPS.map(c => {
            const on = filter === c.key
            return (
              /* Real <button> — keyboard focusable + default focus outline. */
              <button key={c.key} type="button" onClick={() => setFilter(c.key)} style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, borderRadius: 999, padding: '6px 12px', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'transparent', color: on ? 'var(--accent)' : 'var(--text-muted)' }}>
                {c.dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.dot }} />}{c.label}<span style={{ fontFamily: 'var(--font-mono)', opacity: 0.7 }}>{c.n}</span>
              </button>
            )
          })}
          {/* Search — filters by address OR owner as you type. */}
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address or owner…"
              style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: search ? '8px 34px' : '8px 14px 8px 34px', width: 260, outline: 'none' }}
            />
            <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)', pointerEvents: 'none', display: 'flex' }}><Search size={13} strokeWidth={2} aria-hidden="true" /></span>
            {search && <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>{sorted.length}</div>}
          </div>
        </div>

        <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-card)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 14, padding: '8px 16px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
            {HV_HEAD.map(h => h.f ? (
              /* Real <button> — keyboard sortable, keeps the default focus outline. */
              <button key={h.l} type="button" onClick={() => toggleSort(h.f)} style={{ cursor: 'pointer', userSelect: 'none', background: 'none', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', color: 'inherit' }}>{h.l}{sortIndicator(h.f)}</button>
            ) : (
              <span key={h.l}>{h.l}</span>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {sorted.map(p => {
              const cb = catBadge(p.category)
              const note = noteFor(p.address)
              // Snooze: future call-back dims the row; a due one flags it.
              const cbState = callbackState(callbacks[p.address])
              return (
              <div key={p.rank ?? `${p.address}-${getSuburb(p) || ''}`} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 14, alignItems: 'center', padding: '6px 16px', borderBottom: '1px solid var(--border)', opacity: cbState === 'snoozed' ? 0.55 : 1 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '3px 0', borderRadius: 7, background: cb.bg, color: cb.fg }}>{Math.round(p.final_score)}</span>
                <div style={{ minWidth: 0 }}>
                  <button type="button" onClick={() => openDetail(p)} title="Open details"
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleCase(p.address)}</button>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {getSuburb(p) || ''}
                    {cbState === 'due' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, background: 'var(--status-watch-bg)', color: 'var(--status-watch-text)', border: '1px solid var(--status-watch)', borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap' }}>call-back due</span>}
                    {cbState === 'snoozed' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, background: 'var(--status-off-bg)', color: 'var(--status-off-text)', borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap' }}>snoozed → {formatIsoDate(callbacks[p.address])}</span>}
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleCase(p.current_owner) || '—'}</div>
                  {(() => {
                    // Show the phone inline so the agent sees who's reachable
                    // without opening each dossier. Clickable tel: link.
                    const ph = (phones[p.address] ?? p.phone ?? '').trim()
                    return ph
                      ? <a href={`tel:${ph}`} onClick={(e) => e.stopPropagation()} style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>{ph}</a>
                      : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>no phone</span>
                  })()}
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'nowrap', overflow: 'hidden' }}>
                  {sigChips(p).map((s, i) => <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px', whiteSpace: 'nowrap', flexShrink: 0 }}>{s}</span>)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <Select value={statuses[p.address] || ''} onChange={(e) => setStatus(p.address, e.target.value)} size="sm" options={STATUS_OPTIONS} />
                </div>
                <button onClick={() => openNote(p)} title={note || 'Add a note'}
                  style={{ minWidth: 0, textAlign: 'left', background: note ? 'var(--status-watch-bg)' : 'transparent', border: note ? '1px solid var(--status-watch)' : '1px dashed var(--border)', borderRadius: 6, padding: '4px 7px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 11, color: note ? 'var(--status-watch-text)' : 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {note ? note : '+ note'}
                </button>
              </div>
              )
            })}
            {!sorted.length && <div style={{ padding: 24, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>No properties match the current filters.</div>}
          </div>
        </div>

        {noteEditing && (
          <div className="note-modal-overlay" onClick={closeNote}>
            <div className="note-modal" onClick={(e) => e.stopPropagation()}>
              <div className="note-modal-header">
                <div><div className="note-modal-title">Note</div><div className="note-modal-sub">{noteEditing.address}</div></div>
                <button className="btn-icon" onClick={closeNote} title="Close">×</button>
              </div>
              <textarea className="note-textarea" autoFocus value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Spoke with the owner…" rows={6}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote(); if (e.key === 'Escape') closeNote() }} />
              <div className="note-modal-footer">
                <span className="note-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>
                <div className="note-modal-actions">
                  <button className="btn btn-ghost btn-sm" onClick={closeNote}>Cancel</button>
                  <button className="btn btn-primary btn-sm" onClick={saveNote} disabled={noteSaving}>{noteSaving ? 'Saving…' : 'Save note'}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Property dossier — validated design 10/07/2026. Wide overlay:
            header band (score + address + signal chips + Log a call),
            narrative line, then three columns — owner & outcomes ·
            story + why-score · map + facts. One dossier, every entry
            point (row click, future map pins, Contact today). */}
        {propDetail && (() => {
          const p = propDetail
          const money = (v) => (v || v === 0) && !Number.isNaN(Number(v)) ? `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString('en-AU')}` : '—'
          const cb = catBadge(p.category)
          const savedPhone = phones[p.address] ?? p.phone ?? ''
          const dirty = (phoneDraft || '').trim() !== (savedPhone || '').trim()
          const cbSt = callbackState(callbacks[p.address])
          const lblStyle = { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 }
          const valStyle = { fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.25 }
          const cardS = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-card)' }
          const facts = [
            ['Type', [p.type, p.bedrooms ? `${p.bedrooms} bd` : null, p.bathrooms ? `${p.bathrooms} ba` : null].filter(Boolean).join(' · ') || '—'],
            ['CAGR', p.cagr != null ? `${p.cagr}%` : '—'],
            ['Sales in street', p.sales_count != null ? String(p.sales_count) : '—'],
            ['Last sale', money(p.last_sale_price)],
            ['Agency', p.agency || '—'],
            ['Agent', p.agent || '—'],
          ]
          const comps = [
            ['Hold length', p.hold_score], ['Property type', p.type_score],
            ['Owner gain', p.gain_score], ['Yearly growth', p.cagr_score],
            ['Street activity', p.freq_score], ['Untapped value', p.prof_score],
          ].filter(([, v]) => v != null && !Number.isNaN(Number(v)))
          const narrative = (() => {
            if (cbSt === 'due') return { tone: 'watch', text: `Call-back due — you set a reminder for ${formatIsoDate(callbacks[p.address])}.` }
            const bits = []
            if (p.holding_years != null) bits.push(`${Math.round(p.holding_years)}-year hold`)
            if (p.owner_gain_pct != null) bits.push(`an estimated ${p.owner_gain_pct >= 0 ? '+' : ''}${Math.round(p.owner_gain_pct)}% untapped gain`)
            if (!bits.length) return null
            const street = p.sales_count ? ` ${p.sales_count} recent sale${p.sales_count !== 1 ? 's' : ''} in the street strengthen${p.sales_count === 1 ? 's' : ''} the conversation.` : ''
            return { tone: 'accent', text: `${bits.join(' with ')} — owners in this bracket are the suburb's most likely listers.${street}` }
          })()
          return (
            <div className="note-modal-overlay" onClick={() => setPropDetail(null)}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1180px, 97vw)', maxHeight: '92vh', overflowY: 'auto', background: 'var(--bg)', borderRadius: 18, boxShadow: 'var(--shadow-pop)' }}>

                {/* ── header band ── */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 22px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  <div style={{ flexShrink: 0, width: 58, height: 58, borderRadius: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: cb.bg }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 24, lineHeight: 1, color: cb.fg }}>{Math.round(p.final_score)}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: '.1em', color: cb.fg, opacity: 0.75 }}>VENDOR</span>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, letterSpacing: '-0.01em', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleCase(p.address)}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{getSuburb(p) || ''}{p.category ? ` · ${p.category}` : ''}</span>
                      {sigChips(p).map((s, i) => <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>{s}</span>)}
                      {cbSt === 'snoozed' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--status-off-bg)', color: 'var(--status-off-text)', borderRadius: 999, padding: '2px 8px' }}>snoozed → {formatIsoDate(callbacks[p.address])}</span>}
                    </div>
                  </div>
                  <button onClick={() => { setStatus(p.address, 'contacted', ''); setPropDetail(null) }}
                    style={{ flexShrink: 0, background: 'var(--score-hot)', border: 'none', color: '#fff', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, padding: '9px 16px', borderRadius: 9, cursor: 'pointer' }}>Log a call</button>
                  <button className="btn-icon" onClick={() => setPropDetail(null)} title="Close" style={{ flexShrink: 0 }}>×</button>
                </div>

                {/* ── narrative — why call now ── */}
                {narrative && (
                  <div style={{ padding: '10px 22px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, background: narrative.tone === 'watch' ? 'var(--status-watch-bg)' : 'var(--accent-soft)', color: narrative.tone === 'watch' ? 'var(--status-watch-text)' : 'var(--accent)' }}>
                    {narrative.text}
                  </div>
                )}

                {/* ── body: 3 columns ── */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14, padding: '16px 22px 20px' }}>

                  {/* col 1 · owner & action */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                    <div style={{ ...cardS, padding: '13px 15px' }}>
                      <div style={lblStyle}>Owner</div>
                      <div style={{ ...valStyle, fontSize: 14.5, marginBottom: 11 }}>{titleCase(p.current_owner) || '—'}</div>
                      <div style={lblStyle}>Phone</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="tel"
                          value={phoneDraft}
                          onChange={(e) => setPhoneDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && dirty) savePhone(p.address, phoneDraft) }}
                          placeholder="Add a phone number…"
                          style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', outline: 'none' }}
                        />
                        {savedPhone && !dirty && <a href={`tel:${savedPhone}`} className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>Call</a>}
                        {dirty && <button className="btn btn-primary btn-sm" disabled={phoneSaving} onClick={() => savePhone(p.address, phoneDraft)}>{phoneSaving ? 'Saving…' : 'Save'}</button>}
                      </div>
                      {statuses[p.address] && (
                        <div style={{ marginTop: 11 }}>
                          <div style={lblStyle}>Last outcome</div>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 999, padding: '3px 10px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                            {(STATUS_OPTIONS.find(o => o.value === statuses[p.address]) || {}).label || statuses[p.address]}
                          </span>
                        </div>
                      )}
                    </div>
                    <div style={{ ...cardS, padding: '13px 15px' }}>
                      <div style={{ ...lblStyle, marginBottom: 9 }}>Log call outcome</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <button className="btn btn-primary btn-sm" style={{ textAlign: 'left' }} onClick={() => { setStatus(p.address, 'contacted', ''); setPropDetail(null) }}><Check size={13} strokeWidth={2} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Spoke to owner</button>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={() => { setStatus(p.address, 'no_answer', ''); setPropDetail(null) }}>No answer</button>
                          <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={() => { setStatus(p.address, 'declined', ''); setPropDetail(null) }}>Not interested</button>
                        </div>
                        <button className="btn btn-ghost btn-sm" style={{ textAlign: 'left' }} onClick={() => { setStatus(p.address, 'listed', ''); setPropDetail(null) }}><Star size={13} strokeWidth={2} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Appraisal booked</button>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                          <Clock size={13} strokeWidth={2} aria-hidden="true" /> Call back on
                          <input type="date" min={localIsoDate(null, 1)} value={callbacks[p.address] || ''}
                            onChange={(e) => { if (e.target.value) { setStatus(p.address, 'pending', e.target.value); setPropDetail(null) } }}
                            style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 7px', background: 'var(--surface)', color: 'var(--text)' }} />
                        </label>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Select value={statuses[p.address] || ''} onChange={(e) => setStatus(p.address, e.target.value)} size="sm" options={STATUS_OPTIONS} />
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => { openNote(p); setPropDetail(null) }}>{noteFor(p.address) ? 'Edit note' : 'Add note'}</button>
                    </div>
                  </div>

                  {/* col 2 · story + why this score */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                    <div style={{ ...cardS, padding: '13px 15px' }}>
                      <div style={{ ...lblStyle, marginBottom: 10 }}>Property story</div>
                      <div style={{ position: 'relative', paddingLeft: 19 }}>
                        <div style={{ position: 'absolute', left: 5, top: 5, bottom: 5, width: 2, background: 'var(--border)' }} />
                        <div style={{ position: 'relative', paddingBottom: 13 }}>
                          <span style={{ position: 'absolute', left: -19, top: 3, width: 12, height: 12, borderRadius: '50%', background: 'var(--status-off)', border: '2.5px solid var(--surface)' }} />
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{p.owner_purchase_date || 'PURCHASE'}</div>
                          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)' }}><strong>Purchased</strong>{p.owner_purchase_price ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}> — {money(p.owner_purchase_price)}</span> : null}</div>
                          {p.holding_years != null && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>{p.holding_years}-yr hold{p.owner_gain_pct != null ? ` · est. gain ${p.owner_gain_pct >= 0 ? '+' : ''}${Math.round(p.owner_gain_pct)}%` : ''}</div>}
                        </div>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: -19, top: 3, width: 12, height: 12, borderRadius: '50%', background: 'var(--accent)', border: '2.5px solid var(--surface)' }} />
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>TODAY</div>
                          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)' }}><strong>Scored {Math.round(p.final_score)}</strong> — {p.category === 'HOT' ? 'top bracket for this suburb' : `${(p.category || '').toLowerCase()} bracket`}</div>
                          {p.sales_count ? <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>{p.sales_count} recent sale{p.sales_count !== 1 ? 's' : ''} in the street</div> : null}
                        </div>
                      </div>
                    </div>
                    {comps.length > 0 && (
                      <div style={{ ...cardS, padding: '13px 15px', flex: 1 }}>
                        <div style={{ ...lblStyle, marginBottom: 10 }}>Why this score</div>
                        <div style={{ display: 'grid', gap: 7 }}>
                          {comps.map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-muted)', width: 92, flexShrink: 0 }}>{k}</span>
                              <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 999, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, Number(v)))}%`, background: 'var(--accent)', borderRadius: 999 }} />
                              </div>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, color: 'var(--text)', width: 24, textAlign: 'right' }}>{Math.round(Number(v))}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* col 3 · map + facts */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                    <div style={{ ...cardS, overflow: 'hidden', height: 150, flex: 'none' }}>
                      <DeskMap items={[{ address: p.address, suburb: getSuburb(p) }]} minHeight={150}
                        colorOf={() => '#386350'} popupOf={(x) => x.address} label={getSuburb(p) || undefined} />
                    </div>
                    <div style={{ ...cardS, padding: '13px 15px', flex: 1 }}>
                      <div style={{ ...lblStyle, marginBottom: 9 }}>Property facts</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 14px' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={lblStyle}>Bought</div>
                          <div style={{ ...valStyle, overflowWrap: 'anywhere' }}>{money(p.owner_purchase_price)}{p.owner_purchase_date ? ` · ${p.owner_purchase_date}` : ''}</div>
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={lblStyle}>Est. gain</div>
                          <div style={{ ...valStyle, overflowWrap: 'anywhere' }}>{money(p.owner_gain_dollars)}{p.owner_gain_pct != null ? ` · ${Math.round(p.owner_gain_pct)}%` : ''}</div>
                        </div>
                        {facts.map(([k, v]) => (
                          <div key={k} style={{ minWidth: 0, gridColumn: (k === 'Agency' || k === 'Agent') ? '1 / -1' : 'auto' }}>
                            <div style={lblStyle}>{k}</div>
                            <div style={{ ...valStyle, overflowWrap: 'anywhere' }} title={String(v)}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── footer: note ── */}
                {noteFor(p.address) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 22px 15px', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <span style={{ ...lblStyle, marginBottom: 0, flexShrink: 0 }}>Note</span>
                    <div style={{ flex: 1, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--status-watch-text)', background: 'var(--status-watch-bg)', border: '1px solid var(--status-watch)', borderRadius: 8, padding: '7px 11px' }}>{noteFor(p.address)}</div>
                    <button className="btn btn-ghost btn-sm" onClick={() => { openNote(p); setPropDetail(null) }}>Edit</button>
                  </div>
                )}
              </div>
            </div>
          )
        })()}
      </div>
    )
  }

  return (
    <div className={`hot-vendor ${compact ? 'compact' : ''}`}>
      {expiryBanner}
      <div className="hot-vendor-header">
        <div>
          <h2>Hot Vendor Scoring</h2>
          <p className="hot-vendor-sub">
            Drop an RP Data / CoreLogic / Landgate CSV (or xlsx). SuburbDesk
            tunes the scoring to this suburb's profile (how long owners hold,
            price level, typical gains) and returns HOT / WARM / MEDIUM / LOW
            leads, ranked.
          </p>
        </div>
        {hasData && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              variant="primary"
              onClick={downloadExcel}
              loading={excelLoading}
              icon={excelLoading ? undefined : Download}
            >
              {excelLoading
                ? (excelStage || 'Generating…')
                : 'Download Excel report'}
            </Button>
            {excelFallbackUrl && (
              <a
                href={excelFallbackUrl}
                download={excelFallbackName}
                className="btn btn-ghost btn-sm"
                style={{ textDecoration: 'none' }}
              >
                Click here if it didn't download
              </a>
            )}
          </div>
        )}
      </div>

      {/* Recent reports — always visible (not gated on !hasData) so the
          user can switch between suburb sheets in one click. The
          currently-loaded suburb gets the .active class. Clicking any
          card while another is mid-load is allowed (race-handled via
          loadSeqRef inside loadSavedUpload). */}
      {!savedLoading && savedUploads.length > 0 && (
        <div className="hv-saved">
          <div className="hv-saved-title">
            Recent reports
            {isLoadingReport && (
              <span style={{
                marginLeft: 10, fontSize: 12, fontWeight: 400,
                color: 'var(--status-info-text)', display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{
                  width: 11, height: 11, borderRadius: '50%',
                  border: '2px solid rgba(30, 64, 175, 0.25)',
                  borderTopColor: 'var(--status-info-text)',
                  animation: 'hv-spin 0.8s linear infinite',
                  display: 'inline-block',
                }} />
                Loading…
                <style>{`@keyframes hv-spin { to { transform: rotate(360deg) } }`}</style>
              </span>
            )}
          </div>
          <div className="hv-saved-grid">
            {savedUploads.map(u => {
              const isActive = data && (
                (data.upload_id && data.upload_id === u.id) ||
                (data.suburb && data.suburb.toLowerCase() === (u.suburb || '').toLowerCase())
              )
              const expiryBadge = renderExpiryBadge(u)
              return (
                <button
                  key={u.id}
                  className={`hv-saved-card${isActive ? ' active' : ''}`}
                  onClick={() => loadSavedUpload(u.id)}
                >
                  <div className="hv-saved-suburb">{u.suburb}</div>
                  <div className="hv-saved-meta">
                    {u.row_count} properties
                    {u.uploaded_at && ` · ${formatIsoDate(u.uploaded_at)}`}
                  </div>
                  {expiryBadge}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {!hasData && (
        <>
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
              RP Data exports are detected automatically (20 / 21 / 22-column
              layouts) — no formatting needed on your side.
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
            background: 'var(--status-info-bg)', border: '1px solid var(--status-info)', borderRadius: '10px',
            padding: '14px 18px', marginBottom: '14px', fontSize: '13px',
          }}>
            <div style={{ fontWeight: '700', marginBottom: '6px', color: 'var(--status-info-text)' }}>
              {data.suburb} — {profile.is_mature ? 'Mature' : 'Dynamic'} ·{' '}
              {profile.is_premium ? 'Premium' : 'Standard'} ·{' '}
              {profile.is_high_gain ? 'High-gain' : 'Moderate-gain'}
            </div>
            <div style={{ color: 'var(--status-info-text)' }}>
              <strong>What drives the score in this suburb:</strong>{' '}
              Hold length {Math.round((weights.hold || 0) * 100)}% ·{' '}
              Property type {Math.round((weights.type || 0) * 100)}% ·{' '}
              Owner gain {((weights.gain || 0) * 100).toFixed(1)}% ·{' '}
              Yearly growth {((weights.cagr || 0) * 100).toFixed(1)}% ·{' '}
              Sales history {Math.round((weights.freq || 0) * 100)}% ·{' '}
              Untapped value {Math.round((weights.profit || 0) * 100)}%
            </div>
            {data.rationale?.length > 0 && (
              <div style={{ color: 'var(--status-info-text)', marginTop: '4px', fontSize: '12px' }}>
                Why: {data.rationale.join(', ')}
              </div>
            )}
          </div>

          <div className="hv-stats">
            <div className="hv-stat"><span className="hv-stat-num">{properties.length}</span><span>Properties</span></div>
            <div className="hv-stat hv-hot"><span className="hv-stat-num">{counts.HOT}</span><span>Hot</span></div>
            <div className="hv-stat hv-warm"><span className="hv-stat-num">{counts.WARM}</span><span>Warm</span></div>
            <div className="hv-stat hv-medium"><span className="hv-stat-num">{counts.MEDIUM}</span><span>Medium</span></div>
            <div className="hv-stat"><span className="hv-stat-num">{avgScore.toFixed(1)}</span><span>Avg score</span></div>
            <div className="hv-stat"><span className="hv-stat-num">{(profile.median_hold ?? 0).toFixed(1)} yr</span><span>Median holding</span></div>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-secondary btn-small" onClick={() => setData(null)}>
                Load another file
              </button>
            </div>
          </div>

          <div className="hv-controls">
            {CAT_FILTERS.map(({ key, label, dot }) => (
              <button
                key={key}
                className={`hv-pill ${filter === key ? 'active' : ''}`}
                onClick={() => setFilter(key)}
              >
                {dot && <span className="hv-cat-dot" style={{ background: dot }} />}
                {label}
              </button>
            ))}

            {uniqueSuburbs.length > 1 && (
              <div className="hv-suburb-filter" ref={suburbDropdownRef}>
                <button
                  className={`hv-pill hv-pill-icon ${selectedSuburbs.size > 0 ? 'active' : ''}`}
                  onClick={() => setSuburbDropdownOpen(o => !o)}
                >
                  <MapPin size={14} strokeWidth={2} aria-hidden="true" />
                  {suburbBtnLabel}
                  <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                {suburbDropdownOpen && (
                  <div className="hv-suburb-menu">
                    <div className="hv-suburb-menu-actions">
                      <button className="btn-link" onClick={() => setSelectedSuburbs(new Set())}>Clear</button>
                      <button className="btn-link" onClick={() => setSelectedSuburbs(new Set(uniqueSuburbs))}>All</button>
                    </div>
                    {uniqueSuburbs.map(s => (
                      <div key={s} className="hv-suburb-item">
                        <Checkbox
                          checked={selectedSuburbs.has(s)}
                          onChange={() => toggleSuburb(s)}
                          label={s}
                          size="sm"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              className={`hv-pill ${compact ? 'active' : ''}`}
              onClick={() => setCompact(c => !c)}
              title="Toggle row density — compact fits more leads on screen"
            >
              {compact ? 'Compact' : 'Comfortable'}
            </button>

            <div className="hv-spacer" />
            <Select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              size="sm"
              options={[
                { value: 'ALL', label: 'All types' },
                { value: 'HOUSE', label: 'Houses only' },
                { value: 'APARTMENT', label: 'Apartments only' },
              ]}
            />
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
                    ['last_sale_price', 'Last sale'],
                    ['holding_years', 'Hold (yrs)'],
                    ['owner_gain_pct', 'Gain %'],
                    ['cagr', 'Growth %/yr'],
                    ['potential_profit', 'Untapped value'],
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
                  const addr = titleCase(p.address)
                  const noteText = (notes[p.address] || '').trim()
                  const hasNote = !!noteText
                  return (
                    <tr key={p.rank}>
                      <td className="num">{p.rank}</td>
                      <td className="hv-cell-address">
                        <div className="hv-addr-main" title={addr}>{addr}</div>
                        {/* Note lives here now (was a separate right-hand
                            column that forced horizontal scroll). Same
                            openNote() editor + save path — only moved. */}
                        {hasNote ? (
                          <div className="hv-note-inline has-note" title={noteText}
                               onClick={() => openNote(p)}>
                            <StickyNote size={11} strokeWidth={2} aria-hidden="true" />
                            <span>{noteText}</span>
                          </div>
                        ) : (
                          <button type="button" className="hv-note-inline empty-note"
                                  onClick={() => openNote(p)}>
                            <Plus size={11} strokeWidth={2} aria-hidden="true" />
                            Add a note
                          </button>
                        )}
                      </td>
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
                        <ScoreBadge category={p.category} score={p.final_score} />
                      </td>
                      <td className="hv-cell-owner" title={p.current_owner || ''}>{p.current_owner || '-'}</td>
                      <td className="hv-cell-agency" title={p.agency || ''}>{p.agency || '-'}</td>
                      <td className="hv-cell-agent" title={p.agent || ''}>{p.agent || '-'}</td>
                      <td>
                        <Select
                          value={userStatus}
                          onChange={(e) => setStatus(p.address, e.target.value)}
                          size="sm"
                          options={STATUS_OPTIONS}
                        />
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

      {noteEditing && (
        <div className="note-modal-overlay" onClick={closeNote}>
          <div className="note-modal" onClick={(e) => e.stopPropagation()}>
            <div className="note-modal-header">
              <div>
                <div className="note-modal-title">Note</div>
                <div className="note-modal-sub">{noteEditing.address}</div>
              </div>
              <button className="btn-icon" onClick={closeNote} title="Close">×</button>
            </div>
            <textarea
              className="note-textarea"
              autoFocus
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Spoke with the owner, considering selling next quarter…"
              rows={6}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote()
                if (e.key === 'Escape') closeNote()
              }}
            />
            <div className="note-modal-footer">
              <span className="note-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>
              <div className="note-modal-actions">
                <button className="btn btn-ghost btn-sm" onClick={closeNote} disabled={noteSaving}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveNote}
                  disabled={noteSaving}
                >
                  {noteSaving ? 'Saving…' : 'Save note'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

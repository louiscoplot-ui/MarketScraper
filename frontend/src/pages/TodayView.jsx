// SENTINEL S4 — the "Today" view: the morning brief in-app. Default view
// at login. Top 5 signals with a "Why this owner" breakdown built from the
// signal engine's real reason_codes + one-click actions (Generate letter /
// Log call / Dismiss) and the "→ appraisal? / → listing?" attribution.
// Letter download is fetch+blob via the api() wrapper (BACKEND_DIRECT) —
// window.open would bypass the X-Access-Key interceptor.
import { useState, useEffect, useCallback } from 'react'
import { FileText, Phone, X } from 'lucide-react'
import { api, apiJson, readCache, writeCache } from '../lib/api'
import { formatIsoDate } from '../hooks/useListings'
import { Button, Chip, Checkbox, Spinner } from '../components/ui'
import { getDeskMode } from '../lib/deskFlag'

// Score → colour on the status grammar. A high score is a hot lead: red
// (alert) ≥ 60, amber (watch) ≥ 35, muted below.
function scoreColor(score) {
  if (score >= 0.6) return 'var(--status-alert-text)'
  if (score >= 0.35) return 'var(--status-watch-text)'
  return 'var(--text-muted)'
}

// Classify ONE real reason_code string (produced verbatim by the signal
// engine, signal_engine.py:157-208) into the status grammar, purely by
// the words the engine itself wrote — no invented meaning. Only the three
// signal types named in the colour legend get a colour; every other real
// reason (long-hold gain, relisted-other-agency) stays neutral grey so a
// coloured dot never implies a legend entry that isn't there.
//   "…price drops…"                 → alert  (red)
//   "Withdrawn … without selling"   → watch  (amber)
//   "… sales in the street …"       → good   (green)  [neighbour sold]
function reasonStatus(text) {
  const t = String(text || '').toLowerCase()
  if (t.includes('price drop')) return 'alert'
  if (t.includes('withdrawn')) return 'watch'
  if (t.includes('sales in the street') || t.includes('sold')) return 'good'
  return 'off'
}

// The colour key shown at the top. Exactly the three actionable signal
// types the engine surfaces most; matches reasonStatus() above.
const SIGNAL_LEGEND = [
  { label: 'Price drop', status: 'alert' },
  { label: 'Withdrawn', status: 'watch' },
  { label: 'Neighbour sold', status: 'good' },
]

// Interactive market-pulse chart — real metro median-asking series from the
// nightly market_snapshots, with hover (crosshair + point + value/date),
// a $ axis on the left, and a plain-language subtitle.
const MP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MP_RANGES = [[1, '1M'], [3, '3M'], [6, '6M'], [12, '12M']]
function MarketPulse({ report, suburbCount, scope }) {
  const [hi, setHi] = useState(null)
  // Time window (months) — the operator narrows the trend to the last
  // 1/3/6/12 months. Persisted so the choice sticks across sessions.
  const [months, setMonths] = useState(() => {
    try { const v = parseInt(localStorage.getItem('mp_months') || '12', 10); return [1, 3, 6, 12].includes(v) ? v : 12 } catch { return 12 }
  })
  const pickMonths = (m) => { setMonths(m); try { localStorage.setItem('mp_months', String(m)) } catch {} }
  // Scope-aware: the Dashboard's suburb selector drives this chart too.
  // One suburb selected → that suburb's own median series; All → the
  // portfolio average (previous behaviour).
  const scopeAll = !scope || scope === 'all'
  const snaps = ((report && report.snapshots) || []).filter(s =>
    scopeAll || (s.suburb_name || '').toLowerCase() === scope.toLowerCase()
  )
  const dates = [...new Set(snaps.map(s => s.snapshot_date))].sort()
  const fullSeries = dates.map(dt => {
    const ps = snaps.filter(s => s.snapshot_date === dt).map(s => s.median_price).filter(Boolean)
    return ps.length ? { dt, v: ps.reduce((a, b) => a + b, 0) / ps.length } : null
  }).filter(Boolean)
  // Window to the last N months. The cutoff is derived from the newest
  // snapshot date (not "today") so a stale feed still shows its tail
  // instead of an empty window.
  const newest = fullSeries.length ? fullSeries[fullSeries.length - 1].dt : null
  let cutoff = null
  if (newest) {
    const d = new Date(newest); d.setMonth(d.getMonth() - months)
    cutoff = d.toISOString().slice(0, 10)
  }
  const series = cutoff ? fullSeries.filter(p => p.dt >= cutoff) : fullSeries

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '13px 16px', boxShadow: 'var(--shadow-card)' }
  const fmtM = (v) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1e3)}k`
  const monthOf = (iso) => MP_MONTHS[(+String(iso).slice(5, 7) || 1) - 1]
  const dmy = (iso) => { const p = String(iso).slice(0, 10).split('-'); return `${p[2]}/${p[1]}/${p[0]}` }

  const RangeToggle = (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
      {MP_RANGES.map(([m, lab]) => {
        const on = months === m
        return (
          <button key={m} onClick={() => pickMonths(m)}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = on ? 'var(--accent-soft)' : 'var(--surface)' }}
            style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, fontWeight: 600, padding: '3px 9px', border: 'none', cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent)' : 'var(--text-muted)' }}>{lab}</button>
        )
      })}
    </div>
  )

  const Head = (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Market pulse</div>
        {RangeToggle}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
        {scopeAll
          ? `All suburbs · median asking price · last ${months} month${months > 1 ? 's' : ''}`
          : `${scope} · median asking price · last ${months} month${months > 1 ? 's' : ''}`}
      </div>
    </div>
  )

  if (series.length < 2) {
    return <div style={card}>{Head}<div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', padding: '26px 0' }}>{fullSeries.length >= 2 ? 'No snapshots in this window — try a longer range.' : 'The trend builds as nightly snapshots accumulate (need ≥ 2 days of data).'}</div></div>
  }

  const vals = series.map(p => p.v)
  const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1
  const n = series.length
  const X = (i) => (i / (n - 1)) * 640
  const Y = (v) => 138 - ((v - min) / rng) * 122
  const line = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')
  const area = `M0,150 ${series.map((p, i) => `L${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')} L640,150 Z`
  // Clamp the hover index — `series` can shrink under the cursor (report
  // refresh in the background, scope change) leaving `hi` past the end.
  const hIdx = hi == null ? null : Math.min(hi, n - 1)
  const cur = hIdx != null ? series[hIdx] : series[n - 1]
  const first = series[0].v
  const deltaPct = first ? ((cur.v - first) / first) * 100 : 0
  const up = deltaPct >= 0
  const labelIdx = n <= 6 ? series.map((_, i) => i) : [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1]
  const hx = hIdx != null ? (X(hIdx) / 640) * 100 : null
  const hy = hIdx != null ? (Y(series[hIdx].v) / 150) * 100 : null
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (!r.width) return
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    setHi(Math.round(f * (n - 1)))
  }

  return (
    <div style={card}>
      {Head}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '-0.02em', color: 'var(--text)' }}>{fmtM(cur.v)}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: up ? 'var(--status-good-text)' : 'var(--status-alert-text)' }}>{up ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(1)}% since {monthOf(series[0].dt)}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)' }}>· {dmy(cur.dt)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {/* $ axis */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: 104, width: 46, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)', textAlign: 'right' }}>
          <span>{fmtM(max)}</span><span>{fmtM((max + min) / 2)}</span><span>{fmtM(min)}</span>
        </div>
        {/* chart */}
        <div style={{ position: 'relative', flex: 1, height: 104, cursor: 'crosshair' }} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
          <svg viewBox="0 0 640 150" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
            <defs><linearGradient id="mp-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".18" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
            <line x1="0" y1="40" x2="640" y2="40" stroke="var(--border)" strokeWidth="1" /><line x1="0" y1="90" x2="640" y2="90" stroke="var(--border)" strokeWidth="1" />
            <path d={area} fill="url(#mp-fill)" />
            <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          {hIdx != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${hx}%`, width: 1, background: 'var(--accent)', opacity: 0.45 }} />}
          {hIdx != null && <div style={{ position: 'absolute', left: `${hx}%`, top: `${hy}%`, width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: '50%', background: 'var(--accent)', border: '2px solid var(--surface)', boxShadow: '0 0 0 1px var(--accent)' }} />}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 6, marginLeft: 54 }}>
        {labelIdx.map(i => <span key={i}>{monthOf(series[i].dt)}</span>)}
      </div>
    </div>
  )
}

// ── Customizable desk dashboard ────────────────────────────────────────
// Each widget can be toggled on/off in the "Customize" panel; the choice
// persists in localStorage. Grouped by the four families the operator picked.
const DASH_WIDGETS = [
  { id: 'leads',      label: 'Contact today',         group: 'Leads' },
  { id: 'fallen',     label: 'Sales fallen through',  group: 'Leads' },
  // Both fed by brief.items (the nightly top-5), NOT the full signal set —
  // labels say "brief" so the numbers don't contradict the Signals page.
  { id: 'bySuburb',   label: 'Brief signals by suburb', group: 'Leads' },
  { id: 'hot',        label: "Today's brief",         group: 'Leads' },
  { id: 'market',     label: 'Market state',          group: 'Market' },
  { id: 'movers',     label: 'Price movements',       group: 'Market' },
  { id: 'pulse',      label: 'Market pulse',          group: 'Trends' },
  { id: 'dom',        label: 'Days on market',        group: 'Trends' },
  { id: 'agencies',   label: 'Agency market share',   group: 'Trends' },
  { id: 'appraisals', label: 'Appraisal follow-ups',  group: 'Pipeline' },
]
const DASH_PREF_KEY = 'desk_dash_widgets_v1'
const WIDE = new Set(['leads', 'pulse', 'market'])   // full-width widgets

const TONE_TEXT = { alert: 'var(--status-alert-text)', watch: 'var(--status-watch-text)', good: 'var(--status-good-text)', off: 'var(--status-off-text)' }
const TONE_BG = { alert: 'var(--status-alert-bg)', watch: 'var(--status-watch-bg)', good: 'var(--status-good-bg)', off: 'var(--status-off-bg)' }

// The morning call-list: merge every "reason to phone an owner" from the
// real datasets into one prioritised list (address + why + where to act).
// `suburb` (or null) scopes report-derived rows to one suburb.
function buildLeads(report, items, fallenList, suburb) {
  const r = report || {}
  const inScope = (s) => !suburb || (s || '').toLowerCase() === suburb.toLowerCase()
  const out = []
  const add = (address, sub, reason, tone, view, weight, detail) => {
    if (!address || !inScope(sub)) return
    out.push({ address, suburb: sub || '', reason, tone, view, weight, detail: detail || {} })
  }
  ;(fallenList || []).forEach(f => add(f.address, f.suburb, 'Sale fell through', 'watch', 'fallen', 100,
    { kind: 'Sale fell through', price: f.original_price, date: f.detected_at, dateLabel: 'Back on market', reiwa_url: f.reiwa_url }))
  ;(r.price_drops || []).filter(m => (m.delta_amount ?? 0) < 0).forEach(m => {
    const pct = m.delta_pct != null ? Math.abs(Math.round(m.delta_pct)) : null
    add(m.address, m.suburb, `Price cut${pct != null && pct <= 200 ? ` ${pct}%` : ''}`, 'alert', 'report', 80,
      { kind: 'Price cut', old_price: m.old_price, new_price: m.new_price, delta_pct: m.delta_pct })
  })
  ;(items || []).filter(s => (s.score || 0) >= 0.35).forEach(s =>
    // Multi-trigger leads are the strongest evidence — show "+N" instead
    // of silently dropping every reason after the first.
    add(s.address, s.suburb,
      ((s.reasons || [])[0] || 'Vendor signal') + ((s.reasons || []).length > 1 ? ` +${s.reasons.length - 1}` : ''),
      (s.score || 0) >= 0.6 ? 'alert' : 'watch', 'signals', 60 + (s.score || 0) * 20,
      { kind: 'Vendor signal', score: s.score, reasons: s.reasons, narrative: s.narrative }))
  // Freshness bound: the report carries every withdrawn row ever scraped
  // but no withdrawn_date, so listing_date is the only proxy — a withdrawn
  // listing that went up >180 days ago is history, not a call for today.
  // Rows with no date at all are kept (can't judge them).
  const wCut = new Date(); wCut.setDate(wCut.getDate() - 180)
  const wCutIso = wCut.toISOString().slice(0, 10)
  ;(r.withdrawn_listings || [])
    .filter(w => !w.listing_date || String(w.listing_date).slice(0, 10) >= wCutIso)
    .forEach(w => add(w.address, w.suburb, 'Withdrawn', 'watch', 'report', 50,
    { kind: 'Withdrawn', price: w.price, agent: w.agent, agency: w.agency, dom: w.dom, listing_date: w.listing_date, reiwa_url: w.reiwa_url }))
  ;(r.stale_listings || []).forEach(s => add(s.address, s.suburb, `${s.dom || '60+'} days on market`, 'off', 'report', 40,
    { kind: 'Stale listing', price: s.price, agent: s.agent, agency: s.agency, dom: s.dom, listing_date: s.listing_date, reiwa_url: s.reiwa_url }))
  const seen = new Map()
  for (const o of out) {
    // Suburb is part of the key — REIWA addresses don't include it, so the
    // same street address can exist in two tracked suburbs (two owners).
    const k = `${o.address || ''}|${o.suburb || ''}`.toLowerCase()
    if (!seen.has(k) || seen.get(k).weight < o.weight) seen.set(k, o)
  }
  return [...seen.values()].sort((a, b) => b.weight - a.weight)
}

export default function TodayView({ setView, saleFallenCount = 0, suburbs = [], report }) {
  const [scope, setScope] = useState('all')   // desk dashboard scope selector
  const [brief, setBrief] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)          // signal_id in flight
  const [acted, setActed] = useState({})          // signal_id -> {action_id, action}
  // Count of signals currently suppressed (dismissed). Fetched from the
  // existing scoped /api/signals endpoint — read-only, no new backend.
  const [cooldownCount, setCooldownCount] = useState(0)

  // Dashboard customization — enabled widgets (persisted) + the Customize panel.
  const [enabled, setEnabled] = useState(() => {
    try { const raw = localStorage.getItem(DASH_PREF_KEY); if (raw) return new Set(JSON.parse(raw)) } catch { /* ignore */ }
    // 'hot' (Today's brief) is OFF by default: on a small portfolio it
    // lists the same addresses as "Contact today" right next to it —
    // pure duplication. Still one click away in ⚙ Customize.
    return new Set(DASH_WIDGETS.map(w => w.id).filter(id => id !== 'hot'))
  })
  const [customOpen, setCustomOpen] = useState(false)
  const [leadDetail, setLeadDetail] = useState(null)   // clicked lead → popup
  // Market-state comparison window: 'week' (7d) or 'month' (30d). Persisted.
  const [statePeriod, setStatePeriod] = useState(() => {
    try { return localStorage.getItem('dash_market_period') === 'month' ? 'month' : 'week' } catch { return 'week' }
  })
  const setPeriod = (p) => { setStatePeriod(p); try { localStorage.setItem('dash_market_period', p) } catch { /* ignore */ } }
  const toggleWidget = (id) => setEnabled(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id)
    try { localStorage.setItem(DASH_PREF_KEY, JSON.stringify([...n])) } catch { /* ignore */ }
    return n
  })
  // Lazy datasets for the actionable widgets — cached, fetched only when
  // the relevant widget is on (keeps the "load once" ethos).
  const [fallenList, setFallenList] = useState(() => readCache('dash_fallen') || [])
  const [appraisalsList, setAppraisalsList] = useState(() => readCache('dash_appraisals') || [])

  const fetchBrief = useCallback(async () => {
    // Stale-while-revalidate: the brief is computed live server-side
    // (heavy, worse on a cold Render dyno), so a fresh fetch every visit
    // felt slow. Paint the last cached brief instantly, then refresh in
    // the background. Cache is access-key-scoped (readCache/writeCache).
    const cached = readCache('brief_today')
    if (cached) { setBrief(cached); setLoading(false) }
    else { setLoading(true) }
    setError('')
    try {
      // Deadline so a stalled cold-start socket can't hang the spinner
      // forever — the finally below only runs if the promise settles.
      const d = await apiJson('/api/brief/today', { signal: AbortSignal.timeout(30000) })
      setBrief(d)
      if (d && !d.error) writeCache('brief_today', d)
    } catch (e) {
      if (!cached) setError(e.message || 'Could not load your brief')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchBrief() }, [fetchBrief])

  // Dismissed signals are hidden from Today but still tracked — surface a
  // count so they never vanish without a trace. Best-effort; a failure
  // just hides the line.
  useEffect(() => {
    apiJson('/api/signals?status=dismissed&limit=200')
      .then(d => {
        // Only signals still inside the engine's 30-day dismissed cooldown
        // (signal_engine.py DISMISSED_COOLDOWN_DAYS) are actually snoozed;
        // older dismissed rows stay in the table forever and would inflate
        // the count indefinitely.
        const cutoff = Date.now() - 30 * 86400000
        setCooldownCount((d.signals || []).filter(s => {
          const t = Date.parse(s.created_at)
          return !isNaN(t) && t >= cutoff
        }).length)
      })
      .catch(() => setCooldownCount(0))
  }, [])

  // Reactive desk flag: getDeskMode() read once inside an effect never
  // re-fires when the operator clicks "Enter desk" mid-session, so the
  // fallen/appraisals widgets stayed empty until a full reload. The
  // <html data-desk> attribute (set by deskFlag.applyDesk) is the
  // observable source of truth.
  const [deskOn, setDeskOn] = useState(() => getDeskMode() === 'desk')
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() =>
      setDeskOn(el.getAttribute('data-desk') === 'on'))
    obs.observe(el, { attributes: true, attributeFilter: ['data-desk'] })
    return () => obs.disconnect()
  }, [])

  // Sales fallen through — for the leads / fallen widgets.
  useEffect(() => {
    if (!deskOn) return
    if (!(enabled.has('leads') || enabled.has('fallen'))) return
    apiJson('/api/signals/sale-fallen')
      .then(d => { const a = Array.isArray(d) ? d : []; setFallenList(a); writeCache('dash_fallen', a) })
      .catch(() => {})
  }, [enabled, deskOn])

  // Appraisal follow-ups — for the personal follow-up widget.
  useEffect(() => {
    if (!deskOn) return
    if (!enabled.has('appraisals')) return
    apiJson('/api/appraisals')
      .then(d => { const a = Array.isArray(d) ? d : (d && d.appraisals) || []; setAppraisalsList(a); writeCache('dash_appraisals', a) })
      .catch(() => {})
  }, [enabled, deskOn])

  async function recordAction(item, actionType) {
    setBusy(item.signal_id)
    try {
      const res = await apiJson('/api/brief/action', {
        method: 'POST',
        body: JSON.stringify({
          signal_id: item.signal_id,
          brief_id: brief?.brief_id ?? null,
          action_type: actionType,
        }),
      })
      setActed(prev => ({
        ...prev,
        [item.signal_id]: { action_id: res.action_id, action: actionType },
      }))
    } catch (e) {
      alert(`Could not record action: ${e.message}`)
    } finally {
      setBusy(null)
    }
  }

  async function downloadLetter(item) {
    setBusy(item.signal_id)
    try {
      const res = await api(`/api/brief/letter/${item.signal_id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `letter_${(item.address || 'brief').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60)}.docx`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
      await recordAction(item, 'letter')
    } catch (e) {
      alert(`Letter download failed: ${e.message}`)
      setBusy(null)
    }
  }

  async function setConversion(item, field, value) {
    const info = acted[item.signal_id]
    if (!info?.action_id) return
    try {
      await apiJson(`/api/brief/action/${info.action_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value }),
      })
      setActed(prev => ({
        ...prev,
        [item.signal_id]: { ...info, [field]: value },
      }))
    } catch (e) {
      alert(`Could not save: ${e.message}`)
    }
  }

  const items = brief?.items || []

  // ── Desk redesign — single-page customizable dashboard. The page never
  // scrolls: three full-height columns scroll internally. Leads-first,
  // scope-aware, real data. English only. ──
  if (getDeskMode() === 'desk') {
    const trackedNames = suburbs.length ? suburbs.map(s => s.name).filter(Boolean).sort()
      : [...new Set(items.map(i => i.suburb).filter(Boolean))].sort()
    const suburbsList = trackedNames
    const scopeAll = scope === 'all'
    const eq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase()
    const scoped = scopeAll ? items : items.filter(i => eq(i.suburb, scope))
    const has = (id) => enabled.has(id)
    const r = report || {}

    // ── derived datasets (scope-aware) ──
    const leads = has('leads') ? buildLeads(report, scoped, fallenList, scopeAll ? null : scope) : []
    const bars = suburbsList.map(name => ({ name, count: items.filter(i => eq(i.suburb, name)).length }))
      .sort((a, b) => b.count - a.count).slice(0, 12)
    const maxBar = Math.max(1, ...bars.map(b => b.count))
    // Market counters: whole portfolio, or one suburb from report.suburbs.
    // If the scoped suburb has no row in the report (no listings yet, or
    // report still warming), show ZEROS with an honest tag — never the
    // whole-portfolio totals under a single-suburb header.
    // While the report hasn't landed yet, show "—" skeletons — a
    // confident "0 ACTIVE" during load is a lie.
    const reportReady = !!(report && !report.error)
    let counts = r.summary || {}
    let countsScopeLabel = scopeAll ? `${suburbsList.length} suburbs` : scope
    if (!reportReady) {
      counts = { active: '—', under_offer: '—', sold: '—', withdrawn: '—' }
      countsScopeLabel = 'loading…'
    } else if (!scopeAll) {
      const entry = (r.suburbs || []).find(x => Array.isArray(x) && eq(x[0], scope))
      if (entry && entry[1]) {
        counts = entry[1]
      } else {
        counts = { active: 0, under_offer: 0, sold: 0, withdrawn: 0 }
        countsScopeLabel = `${scope} · no report data yet`
      }
    }
    // Deltas from the nightly market_snapshots already in the report
    // payload — per suburb: newest row vs the newest row ≥N days older,
    // summed across the scope. `days` = 7 (week) or 30 (month). No extra
    // fetch. Sold is intentionally excluded from the tiles: the scrape
    // keeps a rolling ~200 recent sales per suburb, so its count is a
    // fixed backlog, not a market movement — a delta there is meaningless.
    const computeDelta = (days) => {
      if (!reportReady) return {}
      const snaps = (r.snapshots || []).filter(s => scopeAll || eq(s.suburb_name, scope))
      if (snaps.length === 0) return {}
      const bySub = {}
      snaps.forEach(s => { (bySub[s.suburb_id] = bySub[s.suburb_id] || []).push(s) })
      const sum = { active: 0, under_offer: 0, withdrawn: 0 }
      let havePast = false
      Object.values(bySub).forEach(rows => {
        rows.sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)))
        const cur = rows[rows.length - 1]
        const target = new Date(cur.snapshot_date)
        target.setDate(target.getDate() - days)
        const targetIso = target.toISOString().slice(0, 10)
        let base = null
        rows.forEach(row => { if (String(row.snapshot_date) <= targetIso) base = row })
        if (!base || base === cur) return
        havePast = true
        sum.active += (cur.active_count || 0) - (base.active_count || 0)
        sum.under_offer += (cur.under_offer_count || 0) - (base.under_offer_count || 0)
        sum.withdrawn += (cur.withdrawn_count || 0) - (base.withdrawn_count || 0)
      })
      return havePast ? sum : {}
    }
    const delta = computeDelta(statePeriod === 'month' ? 30 : 7)
    const periodWord = statePeriod === 'month' ? 'vs last month' : 'vs last week'
    const marketTiles = [
      { l: 'Active', v: counts.active || 0, c: 'var(--status-good)', ct: 'var(--status-good-text)', d: delta.active },
      { l: 'Under offer', v: counts.under_offer || 0, c: 'var(--status-watch)', ct: 'var(--status-watch-text)', d: delta.under_offer },
      { l: 'Sold', v: counts.sold || 0, c: 'var(--status-info)', ct: 'var(--status-info-text)', skip: true },
      { l: 'Withdrawn', v: counts.withdrawn || 0, c: 'var(--status-alert)', ct: 'var(--status-alert-text)', d: delta.withdrawn },
    ]
    const moversAll = r.price_drops || []
    const movers = (scopeAll ? moversAll : moversAll.filter(m => eq(m.suburb, scope))).slice(0, 12)
    const dm = r.dom || {}
    // 'Unknown' agency is scrape noise, not a competitor — drop it.
    const share = (r.market_share || []).filter(a => (a.agency || '').toLowerCase() !== 'unknown').slice(0, 10)
    const maxShare = Math.max(1, ...share.map(a => a.pct || 0))
    const apDue = (appraisalsList || []).filter(a => (a.status || 'active') === 'active')
      .sort((a, b) => String(a.next_followup || '~').localeCompare(String(b.next_followup || '~'))).slice(0, 20)
    const metroTag = scopeAll ? '' : ' · metro'

    const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '13px 16px', boxShadow: 'var(--shadow-card)', minWidth: 0 }
    const panelTitle = { fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }
    const titleRow = (t, n) => (
      <div style={{ ...panelTitle, marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        {t}{n != null && <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: 11, color: 'var(--text-faint)' }}>· {n}</span>}
      </div>
    )
    const emptyLine = (t) => <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>{t}</div>
    const go = (v) => setView && setView(v)
    // The desk widgets are styled inline, which can't express :hover /
    // :focus-visible (and desk.css is shared shell CSS): hover is applied
    // by hand, keyboard focus relies on the browser's default outline —
    // native <button> or tabIndex element, never outline:none.
    const hoverFx = (enter, leave) => ({
      onMouseEnter: (e) => Object.assign(e.currentTarget.style, enter),
      onMouseLeave: (e) => Object.assign(e.currentTarget.style, leave),
    })
    const asButton = (fn) => ({
      role: 'button', tabIndex: 0,
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } },
    })
    const W = (id, node) => has(id) ? node : null
    // Each column scrolls on its own so the PAGE never scrolls.
    const colStyle = { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto', paddingRight: 4 }
    const groupsOrder = ['Leads', 'Market', 'Trends', 'Pipeline']

    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '16px 30px 16px', minHeight: 0 }}>
        {/* header (fixed) */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', flexShrink: 0, marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 }}>
              {[formatIsoDate(brief?.brief_date), `${suburbsList.length} suburbs tracked`].filter(Boolean).join(' · ')}
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: 26, letterSpacing: '-0.02em', margin: 0, color: 'var(--text)' }}>Good morning</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
            <select value={scope} onChange={e => setScope(e.target.value)}
              style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', cursor: 'pointer' }}>
              <option value="all">All suburbs</option>
              {suburbsList.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={() => setCustomOpen(o => !o)} title="Choose widgets"
              onMouseEnter={(e) => { if (!customOpen) e.currentTarget.style.background = 'var(--surface-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
              style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: customOpen ? 'var(--accent)' : 'var(--text-muted)', background: 'var(--surface)', border: `1px solid ${customOpen ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, padding: '9px 14px', cursor: 'pointer' }}>
              ⚙ Customize
            </button>
            {customOpen && (
              <>
                <div onClick={() => setCustomOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
                <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 21, width: 250, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 40px -8px rgba(15,23,42,.3)', padding: '12px 14px', maxHeight: 420, overflowY: 'auto' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 10 }}>Dashboard widgets</div>
                  {groupsOrder.map(g => (
                    <div key={g} style={{ marginBottom: 10 }}>
                      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 5 }}>{g}</div>
                      {DASH_WIDGETS.filter(w => w.group === g).map(w => (
                        <label key={w.id} {...hoverFx({ background: 'var(--surface-hover)' }, { background: 'transparent' })}
                          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 4px', borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text)' }}>
                          <input type="checkbox" checked={has(w.id)} onChange={() => toggleWidget(w.id)} style={{ accentColor: 'var(--accent)', width: 15, height: 15 }} />
                          {w.label}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div style={{ color: 'var(--text-muted)', padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}><Spinner size={16} muted inline /> Loading your brief…</div>
        ) : error ? (
          <div style={{ color: 'var(--status-alert-text)', padding: 24 }}>{error}</div>
        ) : enabled.size === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: 24, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>No widgets enabled — click ⚙ Customize to add some.</div>
        ) : (
          // Full-height column grid — columns scroll internally. auto-fit
          // (a) drops the track of any column whose widgets are all off, so
          // no permanent blank third of the screen, and (b) wraps columns on
          // narrow viewports — the grid then scrolls vertically instead of
          // clipping (overflowY auto is a no-op while everything fits).
          <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, overflowY: 'auto', overflowX: 'hidden' }}>

            {/* ── Column 1 — the call list (+ price movements below) ── */}
            {(has('leads') || has('hot') || has('movers')) && (
            <div style={colStyle}>
              {W('leads', (
                // flex-grow proportional to fullness (capped at 6): when
                // both Contact today and Price movements are full they split
                // the column 50/50; when one is sparse the fuller one takes
                // the freed space — neither is ever removed.
                <div style={{ ...card, flex: `${Math.max(1, Math.min(leads.length, 6))} 1 0`, minHeight: 120, display: 'flex', flexDirection: 'column' }}>
                  {titleRow('Contact today', leads.length)}
                  {leads.length === 0 ? emptyLine('Nothing to action — the feed fills as the nightly scrapes run.') : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto', minHeight: 0, paddingBottom: 12, WebkitMaskImage: 'linear-gradient(180deg, #000 calc(100% - 18px), transparent)', maskImage: 'linear-gradient(180deg, #000 calc(100% - 18px), transparent)' }}>
                      {leads.map((l, i) => (
                        <button key={`${l.view}-${l.address}-${i}`} onClick={() => setLeadDetail(l)}
                          {...hoverFx({ background: 'var(--surface-hover)' }, { background: 'var(--bg)' })}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 9, padding: '6px 11px', cursor: 'pointer', minWidth: 0 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: TONE_TEXT[l.tone], flexShrink: 0 }} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.address}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.suburb}</div>
                          </div>
                          {/* Capped so a long multi-signal reason can't squeeze the
                              address out — the popup shows the full detail. */}
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0, padding: '3px 8px', borderRadius: 999, background: TONE_BG[l.tone], color: TONE_TEXT[l.tone] }}>{l.reason}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {W('hot', (
                // Accent-toned (NOT rose): the grammar reserves rose for the
                // Hot Vendor score surface only — this is a signals feed.
                <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                  <div onClick={() => go('signals')} {...asButton(() => go('signals'))}
                    {...hoverFx({ background: 'color-mix(in srgb, var(--accent) 14%, var(--surface))' }, { background: 'var(--accent-soft)' })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--accent)' }}>Today's brief · {scoped.length}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--accent-fg)', background: 'var(--accent)', borderRadius: 8, padding: '5px 11px' }}>Open →</span>
                  </div>
                  <div style={{ padding: '2px 16px 6px', maxHeight: 260, overflowY: 'auto' }}>
                    {scoped.length === 0 ? emptyLine('No signals for this scope.') : scoped.slice(0, 10).map(s => {
                      const st = (s.score || 0) >= 0.6 ? 'alert' : (s.score || 0) >= 0.35 ? 'watch' : 'off'
                      const reason = ((s.reasons || [])[0] || '') + ((s.reasons || []).length > 1 ? ` +${s.reasons.length - 1} more` : '')
                      return (
                        <div key={s.signal_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: `var(--status-${st}-bg)`, color: `var(--status-${st}-text)` }}>{Math.round((s.score || 0) * 100)}</span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.suburb}{reason ? ` · ${reason}` : ''}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {W('movers', (
                // Shares the column with Contact today — flex-grow tracks
                // its own fullness (capped 6) so a full movers list claims
                // its half but a 1-row list stays compact.
                <div style={{ ...card, flex: `${Math.max(1, Math.min(movers.length, 6))} 1 0`, minHeight: movers.length ? 110 : 0, display: 'flex', flexDirection: 'column' }}>
                  {titleRow('Price movements', movers.length || null)}
                  {movers.length === 0 ? emptyLine('No recent price changes.') : (
                    <div style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0 }}>
                      {movers.map((m, i) => {
                        const cut = (m.delta_amount ?? 0) < 0
                        const pct = m.delta_pct != null && Math.abs(m.delta_pct) <= 200 ? Math.abs(Math.round(m.delta_pct)) : null
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.address}</div>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>{m.suburb} · {m.old_price || '—'} → {m.new_price || '—'}</div>
                            </div>
                            {pct != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: cut ? 'var(--status-alert-bg)' : 'var(--status-info-bg)', color: cut ? 'var(--status-alert-text)' : 'var(--status-info-text)' }}>{cut ? '▼' : '▲'} {pct}%</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            )}

            {/* ── Column 2 — market ── */}
            {(has('market') || has('pulse')) && (
            <div style={colStyle}>
              {W('market', (
                <div style={card}>
                  {/* header with a Week / Month segmented toggle */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                    <div style={{ ...panelTitle, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      Market state <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: 11, color: 'var(--text-faint)' }}>· {countsScopeLabel}</span>
                    </div>
                    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
                      {[['week', 'Week'], ['month', 'Month']].map(([k, lab]) => {
                        const on = statePeriod === k
                        return (
                          <button key={k} onClick={() => setPeriod(k)}
                            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-hover)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = on ? 'var(--accent-soft)' : 'var(--surface)' }}
                            style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, padding: '4px 11px', border: 'none', cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent)' : 'var(--text-muted)' }}>{lab}</button>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 9 }}>
                    {marketTiles.map(t => {
                      const hasD = typeof t.d === 'number'
                      const up = (t.d || 0) > 0
                      return (
                      <div key={t.l} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, padding: '10px 12px' }}>
                        {/* label + status dot on top — reads before the number */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.c, flexShrink: 0 }} />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{t.l}</span>
                        </div>
                        {/* the count */}
                        <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '-0.02em', lineHeight: 1.05, color: 'var(--text)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{t.v}</div>
                        {/* change vs the selected window — arrow + count + plain words */}
                        {t.skip ? (
                          reportReady && <div style={{ marginTop: 5, fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-faint)' }}>latest sales on file</div>
                        ) : hasD ? (
                          t.d === 0 ? (
                            <div style={{ marginTop: 5, fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-faint)' }}>No change {periodWord.replace('vs ', '')}</div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 5, fontFamily: 'var(--font-ui)', fontSize: 11.5 }}>
                              <span aria-hidden style={{ color: t.ct, fontWeight: 700, fontSize: 12, lineHeight: 1 }}>{up ? '↑' : '↓'}</span>
                              <span style={{ color: t.ct, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{Math.abs(t.d)}</span>
                              <span style={{ color: 'var(--text-faint)' }}>{periodWord}</span>
                            </div>
                          )
                        ) : (
                          reportReady && <div style={{ marginTop: 5, fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-faint)' }}>Trend building…</div>
                        )}
                      </div>
                    )})}
                  </div>
                </div>
              ))}
              {W('pulse', <MarketPulse report={report} suburbCount={suburbs.length} scope={scope} />)}
            </div>
            )}

            {/* ── Column 3 — intel + follow-ups ── */}
            {(has('fallen') || has('bySuburb') || has('appraisals') || has('dom') || has('agencies')) && (
            <div style={colStyle}>
              {W('fallen', (
                <div onClick={() => go('fallen')} {...asButton(() => go('fallen'))}
                  {...hoverFx({ boxShadow: 'var(--shadow-pop)' }, { boxShadow: 'var(--shadow-card)' })}
                  style={{ ...card, cursor: 'pointer', background: saleFallenCount > 0 ? 'var(--status-watch-bg)' : 'var(--surface)', border: saleFallenCount > 0 ? '1px solid var(--status-watch)' : '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--status-watch)', boxShadow: '0 0 0 3px rgba(217,119,6,.16)' }} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--status-watch-text)' }}>Motivated vendors · 14 days</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 30, color: saleFallenCount > 0 ? 'var(--status-watch-text)' : 'var(--text-muted)' }}>{saleFallenCount}</span>
                    <span style={{ fontSize: 13, color: 'var(--status-watch-text)', fontWeight: 500 }}>sales fallen through</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--status-watch-text)' }}>Open →</span>
                  </div>
                </div>
              ))}
              {W('bySuburb', (
                <div style={card}>
                  {titleRow('Brief signals by suburb')}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {bars.length === 0 ? emptyLine('No signals yet.') : bars.map(b => (
                      <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text)', width: 104, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
                        <div style={{ flex: 1, height: 8, background: 'var(--bg)', borderRadius: 999, overflow: 'hidden' }}><div style={{ height: '100%', width: `${(b.count / maxBar) * 100}%`, background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 75%, white), var(--accent))', borderRadius: 999 }} /></div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', width: 30, textAlign: 'right' }}>{b.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {W('appraisals', (
                <div onClick={() => go('appraisals')} {...asButton(() => go('appraisals'))}
                  {...hoverFx({ boxShadow: 'var(--shadow-pop)' }, { boxShadow: 'var(--shadow-card)' })}
                  style={{ ...card, cursor: 'pointer' }}>
                  {titleRow('Appraisal follow-ups', apDue.length || null)}
                  {apDue.length === 0 ? emptyLine('No follow-ups due.') : (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      {apDue.slice(0, 8).map((a, i) => (
                        <div key={a.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.address}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>{a.owner_name || a.vendor_name || ''}</div>
                          </div>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatIsoDate(a.next_followup) || '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {W('dom', (
                <div style={card}>
                  {titleRow(`Days on market${metroTag}`)}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                    {[{ l: 'Average', v: dm.avg ?? '—' }, { l: 'Median', v: dm.median ?? '—' }, { l: 'Stale (60+ days)', v: dm.stale_count ?? 0, alert: true }].map(t => (
                      <div key={t.l} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, padding: '12px 13px' }}>
                        <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '-0.02em', color: t.alert && Number(t.v) > 0 ? 'var(--status-alert-text)' : 'var(--text)' }}>{t.v}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 6 }}>{t.l}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {W('agencies', (
                <div style={card}>
                  {titleRow(`Agency market share${metroTag}`)}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {share.length === 0 ? emptyLine('No data.') : share.map(a => (
                      <div key={a.agency} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text)', width: 120, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.agency}</span>
                        <div style={{ flex: 1, height: 8, background: 'var(--bg)', borderRadius: 999, overflow: 'hidden' }}><div style={{ height: '100%', width: `${((a.pct || 0) / maxShare) * 100}%`, background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 75%, white), var(--accent))', borderRadius: 999 }} /></div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', width: 40, textAlign: 'right' }}>{a.pct != null ? `${Math.round(a.pct)}%` : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            )}

          </div>
        )}

        {/* Lead detail popup — clicking a "Contact today" row opens the
            listing's info here instead of jumping to another screen. */}
        {leadDetail && (() => {
          const l = leadDetail
          const d = l.detail || {}
          const viewLabel = l.view === 'report' ? 'Market Report' : l.view === 'fallen' ? 'Fallen sales' : l.view === 'signals' ? 'Signals' : l.view
          const rows = []
          if (d.old_price || d.new_price) rows.push(['Price', `${d.old_price || '—'} → ${d.new_price || '—'}`])
          if (d.price) rows.push([d.kind === 'Sale fell through' ? 'Was listed at' : 'Price', d.price])
          if (d.delta_pct != null && Math.abs(d.delta_pct) <= 200) rows.push(['Change', `${Math.round(d.delta_pct)}%`])
          if (d.dom != null) rows.push(['Days on market', String(d.dom)])
          if (d.listing_date) rows.push(['Listed', formatIsoDate(d.listing_date) || d.listing_date])
          if (d.date) rows.push([d.dateLabel || 'Date', formatIsoDate(d.date) || d.date])
          if (d.agency) rows.push(['Agency', d.agency])
          if (d.agent) rows.push(['Agent', d.agent])
          if (d.score != null) rows.push(['Signal score', `${Math.round((d.score || 0) * 100)}/100`])
          return (
            <div className="note-modal-overlay" onClick={() => setLeadDetail(null)}>
              <div className="note-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: '92vw' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingBottom: 14, borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, letterSpacing: '-0.01em', color: 'var(--text)' }}>{l.address}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{l.suburb}</div>
                  </div>
                  <button className="btn-icon" onClick={() => setLeadDetail(null)} title="Close">×</button>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, background: TONE_BG[l.tone], color: TONE_TEXT[l.tone] }}>{l.reason}</span>
                </div>

                {rows.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 9, marginBottom: 14 }}>
                    {rows.flatMap(([k, v]) => [
                      <span key={k + '-k'} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', alignSelf: 'center' }}>{k}</span>,
                      <span key={k + '-v'} style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{v}</span>,
                    ])}
                  </div>
                )}

                {Array.isArray(d.reasons) && d.reasons.length > 0 && (
                  <ul style={{ margin: '0 0 14px', paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {d.reasons.map((rr, i) => (
                      <li key={i} style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)', display: 'flex', gap: 8 }}>
                        <span style={{ color: 'var(--text-faint)' }}>•</span>{rr}
                      </li>
                    ))}
                  </ul>
                )}
                {d.narrative && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14 }}>{d.narrative}</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  {d.reiwa_url && <a href={d.reiwa_url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>Open on REIWA ↗</a>}
                  <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => { setLeadDetail(null); go(l.view) }}>View in {viewLabel} →</button>
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 24px', maxWidth: 760, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 2, color: 'var(--text)' }}>Dashboard</h2>
      <div style={{ color: 'var(--text-muted)', marginBottom: 14, fontSize: 14 }}>
        {formatIsoDate(brief?.brief_date) || ''}{brief?.live ? ' · built live (tonight’s brief will be emailed)' : ''}
      </div>


      {/* Signal colour key — explains the dot next to each "why" reason. */}
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
          {SIGNAL_LEGEND.map(l => (
            <Chip key={l.label} status={l.status} size="sm">{l.label}</Chip>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spinner size={16} muted inline /> Loading your brief…
        </div>
      ) : error ? (
        <div style={{ color: 'var(--status-alert-text)', padding: 24 }}>{error}</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>
          No vendor signals for your suburbs yet — the ledger fills as the
          nightly scrapes accumulate market events.
        </div>
      ) : items.map(item => {
        const info = acted[item.signal_id]
        const reasons = item.reasons || []
        return (
          <div key={item.signal_id} style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius-card)',
            padding: '14px 16px', marginBottom: 14, background: 'var(--surface)',
            opacity: info?.action === 'dismissed' ? 0.5 : 1,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>
                {item.address}
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {item.suburb}</span>
              </div>
              <div style={{ fontWeight: 700, color: scoreColor(item.score), fontVariantNumeric: 'tabular-nums' }}
                   title="Signal score (0–100)">
                {Math.round((item.score || 0) * 100)}
              </div>
            </div>

            {item.narrative && (
              <div style={{ margin: '8px 0', color: 'var(--text)' }}>{item.narrative}</div>
            )}

            {/* Why this owner — ALWAYS visible, built ONLY from the signal
                engine's real reason_codes (item.reasons). No invented
                justification: if the engine produced no reasons (it never
                should — a score without reasons can't exist), we say so
                plainly rather than fabricate one. */}
            <div style={{
              margin: '10px 0', padding: '10px 12px',
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 6,
              }}>
                Why this owner
              </div>
              {reasons.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {reasons.map((r, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--text)' }}>
                      <span aria-hidden="true" style={{
                        width: 7, height: 7, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                        background: `var(--status-${reasonStatus(r)})`,
                      }} />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  No detailed signal breakdown recorded for this address.
                </div>
              )}
            </div>

            {!info ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="sm" icon={FileText}
                        disabled={busy === item.signal_id}
                        onClick={() => downloadLetter(item)}>
                  Generate letter
                </Button>
                <Button variant="ghost" size="sm" icon={Phone}
                        disabled={busy === item.signal_id}
                        onClick={() => recordAction(item, 'call_logged')}>
                  Log call
                </Button>
                <Button variant="ghost" size="sm" icon={X}
                        disabled={busy === item.signal_id}
                        onClick={() => recordAction(item, 'dismissed')}>
                  Dismiss
                </Button>
              </div>
            ) : info.action === 'dismissed' ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Dismissed</div>
            ) : (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--status-good-text)', fontWeight: 600 }}>
                  {info.action === 'letter' ? 'Letter generated' : 'Call logged'}
                </span>
                <Checkbox
                  checked={!!info.converted_to_appraisal}
                  onChange={e => setConversion(item, 'converted_to_appraisal', e.target.checked)}
                  label="→ appraisal?"
                  size="sm"
                />
                <Checkbox
                  checked={!!info.converted_to_listing}
                  onChange={e => setConversion(item, 'converted_to_listing', e.target.checked)}
                  label="→ listing?"
                  size="sm"
                />
              </div>
            )}
          </div>
        )
      })}

      {/* Dismissed signals don't vanish without a trace. */}
      {!loading && !error && cooldownCount > 0 && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
          {cooldownCount} dismissed signal{cooldownCount === 1 ? '' : 's'} snoozed
          (hidden from this page, still tracked — they come back if the
          opportunity is still live later).
        </div>
      )}
    </div>
  )
}

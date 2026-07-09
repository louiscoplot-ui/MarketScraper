// SENTINEL S4 — the "Today" view: the morning brief in-app. Default view
// at login. Top 5 signals with a "Why this owner" breakdown built from the
// signal engine's real reason_codes + one-click actions (Generate letter /
// Log call / Dismiss) and the "→ appraisal? / → listing?" attribution.
// Letter download is fetch+blob via the api() wrapper (BACKEND_DIRECT) —
// window.open would bypass the X-Access-Key interceptor.
import { useState, useEffect, useCallback } from 'react'
import { FileText, Phone, X } from 'lucide-react'
import { api, apiJson } from '../lib/api'
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

export default function TodayView({ setView, saleFallenCount = 0, suburbs = [] }) {
  const [scope, setScope] = useState('all')   // desk dashboard scope selector
  const [brief, setBrief] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)          // signal_id in flight
  const [acted, setActed] = useState({})          // signal_id -> {action_id, action}
  // Count of signals currently suppressed (dismissed). Fetched from the
  // existing scoped /api/signals endpoint — read-only, no new backend.
  const [cooldownCount, setCooldownCount] = useState(0)

  const fetchBrief = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setBrief(await apiJson('/api/brief/today'))
    } catch (e) {
      setError(e.message || 'Could not load your brief')
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
      .then(d => setCooldownCount((d.signals || []).length))
      .catch(() => setCooldownCount(0))
  }, [])

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

  // ── Desk redesign — full render of mock #dashboard. Separate from
  // classic; wires real brief data + a local scope selector. ──
  if (getDeskMode() === 'desk') {
    // All tracked suburbs (from the full list App passes) drive the scope
    // menu + the "tracked" count — not just the ones that happen to have a
    // signal in today's brief. KPIs/bars stay signal-based.
    const trackedNames = suburbs.length ? suburbs.map(s => s.name).filter(Boolean).sort()
      : [...new Set(items.map(i => i.suburb).filter(Boolean))].sort()
    const suburbsList = trackedNames
    const scoped = scope === 'all' ? items : items.filter(i => i.suburb === scope)
    const hot = scoped.filter(i => (i.score || 0) >= 0.6).length
    const watch = scoped.filter(i => (i.score || 0) >= 0.35 && (i.score || 0) < 0.6).length
    const kpis = [
      { label: 'Fresh signals', value: scoped.length, c: 'var(--score-hot)' },
      { label: 'Hot ≥ 60', value: hot, c: 'var(--status-alert)' },
      { label: 'Watch 35–60', value: watch, c: 'var(--status-watch)' },
      { label: 'Suburbs', value: scope === 'all' ? suburbsList.length : 1, c: 'var(--status-info)' },
    ]
    const bars = suburbsList.map(name => ({ name, count: items.filter(i => i.suburb === name).length }))
      .sort((a, b) => b.count - a.count).slice(0, 7)
    const maxBar = Math.max(1, ...bars.map(b => b.count))
    const top = scoped[0]
    const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', boxShadow: 'var(--shadow-card)' }
    const panelTitle = { fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--text)' }

    return (
      <div style={{ padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>
              {formatIsoDate(brief?.brief_date) || ''} · {suburbsList.length} suburbs tracked
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: 34, letterSpacing: '-0.02em', margin: 0, color: 'var(--text)' }}>Good morning</h2>
          </div>
          <select value={scope} onChange={e => setScope(e.target.value)}
            style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', cursor: 'pointer' }}>
            <option value="all">All suburbs</option>
            {suburbsList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {loading ? (
          <div style={{ color: 'var(--text-muted)', padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}><Spinner size={16} muted inline /> Loading your brief…</div>
        ) : error ? (
          <div style={{ color: 'var(--status-alert-text)', padding: 24 }}>{error}</div>
        ) : (
          <>
            {/* KPI marquee */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
              {kpis.map(k => (
                <div key={k.label} style={{ ...card, padding: '18px 18px 16px' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 12 }}>{k.label}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 0.9, color: 'var(--text)' }}>{k.value}</span>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: k.c }} />
                  </div>
                </div>
              ))}
            </div>

            {/* main grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16 }}>
              {/* left */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={panelTitle}>Market pulse — median asking, metro</div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>indicative</span>
                  </div>
                  <svg viewBox="0 0 640 150" preserveAspectRatio="none" style={{ width: '100%', height: 130 }}>
                    <defs><linearGradient id="tv-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#386350" stopOpacity=".18" /><stop offset="1" stopColor="#386350" stopOpacity="0" /></linearGradient></defs>
                    <line x1="0" y1="38" x2="640" y2="38" stroke="var(--border)" strokeWidth="1" /><line x1="0" y1="75" x2="640" y2="75" stroke="var(--border)" strokeWidth="1" /><line x1="0" y1="112" x2="640" y2="112" stroke="var(--border)" strokeWidth="1" />
                    <path d="M0,124 L91,114 L182,118 L274,100 L365,90 L457,72 L548,58 L640,44 L640,150 L0,150 Z" fill="url(#tv-fill)" />
                    <polyline points="0,124 91,114 182,118 274,100 365,90 457,72 548,58 640,44" fill="none" stroke="#386350" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                    <circle cx="640" cy="44" r="4" fill="#386350" />
                  </svg>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 6 }}>Live series builds from nightly snapshots.</div>
                </div>
                <div style={card}>
                  <div style={{ ...panelTitle, marginBottom: 16 }}>Signals by suburb</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                    {bars.length === 0 ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>No signals yet.</div> : bars.map(b => (
                      <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)', width: 118, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
                        <div style={{ flex: 1, height: 8, background: 'var(--bg)', borderRadius: 999, overflow: 'hidden' }}><div style={{ height: '100%', width: `${(b.count / maxBar) * 100}%`, background: 'linear-gradient(90deg,#4f8067,#386350)', borderRadius: 999 }} /></div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', width: 34, textAlign: 'right' }}>{b.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* right */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {saleFallenCount > 0 && (
                  <div onClick={() => setView && setView('fallen')} style={{ background: 'var(--status-watch-bg)', border: '1px solid #F5C88A', borderRadius: 14, padding: '16px 18px', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--status-watch)', boxShadow: '0 0 0 3px rgba(217,119,6,.16)' }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#92400E' }}>Motivated vendors · 14 days</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, color: '#7c2d12' }}>{saleFallenCount}</span>
                      <span style={{ fontSize: 13, color: '#92400E', fontWeight: 500 }}>sales fallen through</span>
                      <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: '#B45309' }}>Open list →</span>
                    </div>
                  </div>
                )}
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 4px 20px -6px rgba(219,39,119,.18),0 0 0 1px rgba(219,39,119,.14)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div onClick={() => setView && setView('hot-vendors')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px 13px', background: 'linear-gradient(180deg,rgba(219,39,119,.06),transparent)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--score-hot)', boxShadow: '0 0 0 3px rgba(219,39,119,.15)' }} />
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--score-hot-text)' }}>Hot vendors · live</span>
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, letterSpacing: '-0.01em', marginTop: 5, color: 'var(--text)' }}>{scoped.length} fresh signals this morning</div>
                    </div>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: '#fff', background: 'var(--score-hot)', borderRadius: 8, padding: '7px 12px', whiteSpace: 'nowrap' }}>Open →</span>
                  </div>
                  <div style={{ padding: '2px 20px 8px', maxHeight: 360, overflowY: 'auto' }}>
                    {scoped.length === 0 ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', padding: '14px 0' }}>No signals for this scope.</div> : scoped.slice(0, 8).map(s => {
                      const st = (s.score || 0) >= 0.6 ? 'alert' : (s.score || 0) >= 0.35 ? 'watch' : 'off'
                      const reason = (s.reasons || [])[0] || ''
                      return (
                        <div key={s.signal_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, width: 38, height: 38, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: `var(--status-${st}-bg)`, color: `var(--status-${st}-text)` }}>{Math.round((s.score || 0) * 100)}</span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.suburb}{reason ? ` · ${reason}` : ''}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 24px', maxWidth: 760, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 2, color: 'var(--text)' }}>Today</h2>
      <div style={{ color: 'var(--text-muted)', marginBottom: 14, fontSize: 14 }}>
        {formatIsoDate(brief?.brief_date) || ''}{brief?.live ? ' · built live (tonight’s brief will be emailed)' : ''}
      </div>

      {/* Desk-mode KPI marquee (mock 01). Hidden in classic via CSS. */}
      {!loading && !error && (
        <div className="desk-kpis">
          <div className="desk-kpi" data-c="rose">
            <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{items.length}</div><div className="desk-kpi-l">Fresh signals</div></div>
          </div>
          <div className="desk-kpi" data-c="alert">
            <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{items.filter(i => (i.score || 0) >= 0.6).length}</div><div className="desk-kpi-l">Hot ≥ 60</div></div>
          </div>
          <div className="desk-kpi" data-c="watch">
            <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{items.filter(i => (i.score || 0) >= 0.35 && (i.score || 0) < 0.6).length}</div><div className="desk-kpi-l">Watch 35–60</div></div>
          </div>
          <div className="desk-kpi" data-c="info">
            <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{new Set(items.map(i => i.suburb).filter(Boolean)).size}</div><div className="desk-kpi-l">Suburbs</div></div>
          </div>
        </div>
      )}

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
          {cooldownCount} signal{cooldownCount === 1 ? '' : 's'} on cooldown
          (dismissed — hidden from Today, still tracked; they resurface if
          still active after the cooldown).
        </div>
      )}
    </div>
  )
}

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

export default function TodayView() {
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

  return (
    <div style={{ padding: '16px 24px', maxWidth: 760, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 2, color: 'var(--text)' }}>Today</h2>
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
          {cooldownCount} signal{cooldownCount === 1 ? '' : 's'} on cooldown
          (dismissed — hidden from Today, still tracked; they resurface if
          still active after the cooldown).
        </div>
      )}
    </div>
  )
}

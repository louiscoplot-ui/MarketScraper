// SENTINEL S2 — Signals view. Deliberately minimal (the morning brief is
// the product, this is the working list): score + plain-language reasons +
// Dismiss / Mark actioned. Reads /api/signals (scoped server-side),
// status changes via PATCH /api/signals/<id>.
import { useState, useEffect, useCallback } from 'react'
import { Check, X } from 'lucide-react'
import { apiJson } from '../lib/api'
import { Button, Chip, Select, Spinner } from '../components/ui'

const STATUS_LABELS = { new: 'New', actioned: 'Actioned', dismissed: 'Dismissed' }

// Score → status grammar. A high score is a hot lead: alert (red) ≥ 60,
// watch (amber) ≥ 35, off (grey) below. Rendered as a Chip.
function scoreStatus(score) {
  if (score >= 0.6) return 'alert'
  if (score >= 0.35) return 'watch'
  return 'off'
}

// Classify ONE real reason_code (produced verbatim by the signal engine,
// signal_engine.py) into the status grammar by the words the engine wrote
// — no invented meaning. Mirrors TodayView so the two screens read alike.
//   "…price drops…"               → alert  (red)
//   "Withdrawn … without selling" → watch  (amber)
//   "… sales in the street …"     → good   (green)
// Everything else (long-hold gain, relisted) stays neutral grey.
function reasonStatus(text) {
  const t = String(text || '').toLowerCase()
  if (t.includes('price drop')) return 'alert'
  if (t.includes('withdrawn')) return 'watch'
  if (t.includes('sales in the street') || t.includes('sold')) return 'good'
  return 'off'
}

function PrecisionCard() {
  // S3 — the self-labeling ledger's track record. Honest by design: shows
  // pending separately; hit rate only over RESOLVED predictions.
  const [stats, setStats] = useState(null)
  useEffect(() => {
    apiJson('/api/precision').then(setStats).catch(() => setStats(null))
  }, [])
  if (!stats || !stats.totals || !stats.totals.predictions) return null
  const t = stats.totals
  return (
    <div style={{
      display: 'flex', gap: 24, alignItems: 'baseline', padding: '10px 14px',
      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      marginBottom: 14, fontSize: 14, color: 'var(--text)', flexWrap: 'wrap',
    }}>
      <strong>Prediction ledger</strong>
      <span>{t.predictions} prediction{t.predictions > 1 ? 's' : ''}</span>
      <span style={{ color: 'var(--status-good-text)' }}>{t.listed} listed</span>
      <span style={{ color: 'var(--text-muted)' }}>{t.not_listed} expired</span>
      <span style={{ color: 'var(--text-muted)' }}>{t.pending} pending</span>
      <span style={{ fontWeight: 700 }}>
        {t.hit_rate == null ? 'hit rate: —'
          : `hit rate: ${(t.hit_rate * 100).toFixed(0)}%`}
      </span>
    </div>
  )
}

// Score thresholds. long_hold_gain alone = 20; anything ≥ 35 means the
// address triggered a SECOND signal (withdrawn, price drops, street
// momentum…) — those are the leads worth doorknocking first.
const SCORE_FILTERS = [
  { value: '0', label: 'All scores' },
  { value: '0.35', label: 'Multi-signal (35+)' },
  { value: '0.5', label: 'Hot only (50+)' },
]

export default function SignalsView() {
  const [signals, setSignals] = useState([])
  const [status, setStatus] = useState('new')
  const [suburb, setSuburb] = useState('')        // '' = all my suburbs
  const [minScore, setMinScore] = useState(0)
  const [suburbs, setSuburbs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  // Populate the suburb picker from the caller's own scoped suburbs.
  useEffect(() => {
    apiJson('/api/suburbs')
      .then(d => setSuburbs(Array.isArray(d) ? d : (d.suburbs || [])))
      .catch(() => setSuburbs([]))
  }, [])

  const fetchSignals = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ status, limit: '200' })
      if (suburb) params.set('suburb', suburb)
      if (minScore > 0) params.set('min_score', String(minScore))
      const data = await apiJson(`/api/signals?${params.toString()}`)
      setSignals(data.signals || [])
    } catch (e) {
      setError(e.message || 'Could not load signals')
    } finally {
      setLoading(false)
    }
  }, [status, suburb, minScore])

  useEffect(() => { fetchSignals() }, [fetchSignals])

  async function setSignalStatus(id, newStatus) {
    setBusyId(id)
    try {
      await apiJson(`/api/signals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      setSignals(prev => prev.filter(s => s.id !== id))
    } catch (e) {
      alert(`Could not update signal: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div style={{ padding: '16px 24px', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: 'var(--text)' }}>Vendor Signals</h2>
        <Select value={suburb} onChange={e => setSuburb(e.target.value)}
                size="sm" title="Filter by suburb">
          <option value="">All my suburbs</option>
          {suburbs.map(s => (
            <option key={s.id || s.name} value={s.name}>{s.name}</option>
          ))}
        </Select>
        <Select value={String(minScore)} onChange={e => setMinScore(Number(e.target.value))}
                size="sm" title="Minimum score" options={SCORE_FILTERS} />
        <Select value={status} onChange={e => setStatus(e.target.value)}
                size="sm"
                options={Object.entries(STATUS_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
        <Button variant="ghost" size="sm" onClick={fetchSignals}>Refresh</Button>
        {!loading && (
          <span style={{ color: 'var(--text-muted)', fontSize: 13, marginLeft: 'auto' }}>
            {signals.length} shown
          </span>
        )}
      </div>

      <PrecisionCard />

      {loading ? (
        <div style={{ color: 'var(--text-muted)', padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spinner size={16} muted inline /> Loading signals…
        </div>
      ) : error ? (
        <div style={{ color: 'var(--status-alert-text)', padding: 24 }}>{error}</div>
      ) : signals.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>
          No {STATUS_LABELS[status].toLowerCase()} signals. Signals are
          rebuilt after every nightly scrape from the market-events ledger.
        </div>
      ) : (
        <table className="desk-signals" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '6px 8px', width: 70, color: 'var(--text-muted)' }}>Score</th>
              <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Address</th>
              <th style={{ padding: '6px 8px', width: 130, color: 'var(--text-muted)' }}>Suburb</th>
              <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Why</th>
              {status === 'new' &&
                <th style={{ padding: '6px 8px', width: 190 }}></th>}
            </tr>
          </thead>
          <tbody>
            {signals.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                <td style={{ padding: '8px' }}>
                  <Chip status={scoreStatus(s.score)} dot={false}>
                    {(s.score * 100).toFixed(0)}
                  </Chip>
                </td>
                <td style={{ padding: '8px', fontWeight: 600, color: 'var(--text)' }}>{s.address}</td>
                <td style={{ padding: '8px', color: 'var(--text)' }}>{s.suburb || ''}</td>
                <td style={{ padding: '8px' }}>
                  {/* Real reason_codes from the signal engine, each dot
                      coloured by the type the engine itself named. */}
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(s.reason_codes || []).map((r, i) => (
                      <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--text)' }}>
                        <span aria-hidden="true" style={{
                          width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0,
                          background: `var(--status-${reasonStatus(r)})`,
                        }} />
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                {status === 'new' && (
                  <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="secondary" size="sm" icon={Check}
                              onClick={() => setSignalStatus(s.id, 'actioned')}
                              loading={busyId === s.id}>
                        Actioned
                      </Button>
                      <Button variant="ghost" size="sm" icon={X}
                              onClick={() => setSignalStatus(s.id, 'dismissed')}
                              disabled={busyId === s.id}>
                        Dismiss
                      </Button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

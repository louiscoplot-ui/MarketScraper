// SENTINEL S2 — Signals view. Deliberately minimal (the morning brief is
// the product, this is the working list): score + plain-language reasons +
// Dismiss / Mark actioned. Reads /api/signals (scoped server-side),
// status changes via PATCH /api/signals/<id>.
import { useState, useEffect, useCallback, useRef } from 'react'
import { Check, X } from 'lucide-react'
import { apiJson, readCache, writeCache } from '../lib/api'
import { Button, Chip, Select, Spinner } from '../components/ui'
import { getDeskMode } from '../lib/deskFlag'
import DeskMap, { STATUS_COLOR } from '../components/DeskMap'

// Per-filter cache key so switching suburb/score/status repaints instantly
// from the last good rows while the network revalidates in the background.
const sigKey = (status, suburb, minScore) => `signals_${status}_${suburb || 'all'}_${minScore}`

// Pin colours come from DeskMap's STATUS_COLOR — one place to retune.
const SIGNAL_HEX = { alert: STATUS_COLOR.withdrawn, watch: STATUS_COLOR.under_offer, off: STATUS_COLOR.Leased }

// Deterministic pin position from a string — no Math.random so pins are
// stable across renders. Keeps the placeholder map (mock 06) tidy.
function pinPos(seed, i) {
  const s = String(seed || i)
  let h = 0
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 0xffff
  const top = 18 + (h % 64)
  const left = 14 + ((h >> 4) % 70)
  return { top: `${top}%`, left: `${left}%` }
}

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
      <strong title="Every strong signal is logged as a prediction that the owner will list within 6 months — this is how often we've been right so far.">Track record</strong>
      <span>{t.predictions} prediction{t.predictions > 1 ? 's' : ''}</span>
      <span style={{ color: 'var(--status-good-text)' }} title="Owner went on to list — prediction correct">{t.listed} listed</span>
      <span style={{ color: 'var(--text-muted)' }} title="6 months passed without a listing — prediction wrong">{t.not_listed} didn't list</span>
      <span style={{ color: 'var(--text-muted)' }} title="Still inside the 6-month window">{t.pending} pending</span>
      <span style={{ fontWeight: 700 }} title="Correct predictions ÷ resolved predictions (pending excluded)">
        {t.hit_rate == null ? 'accuracy: —'
          : `accuracy: ${(t.hit_rate * 100).toFixed(0)}%`}
      </span>
    </div>
  )
}

// Score thresholds. long_hold_gain is graduated by hold length × gain
// (a 30y+/300% owner alone can reach ~60); 35+/50+ are simple strength
// cut-offs, whatever the mix of triggers.
const SCORE_FILTERS = [
  { value: '0', label: 'All scores' },
  { value: '0.35', label: 'Score 35+' },
  { value: '0.5', label: 'Score 50+' },
]

export default function SignalsView() {
  // Seed from the cached default query so the first paint shows real rows
  // instead of a spinner (and never the bare "signal timed out" screen).
  const [signals, setSignals] = useState(() => readCache(sigKey('new', '', 0)) || [])
  const [status, setStatus] = useState('new')
  const [suburb, setSuburb] = useState('')        // '' = all my suburbs
  const [minScore, setMinScore] = useState(0)
  const [suburbs, setSuburbs] = useState([])
  const [loading, setLoading] = useState(() => (readCache(sigKey('new', '', 0)) || []).length === 0)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  // Populate the suburb picker from the caller's own scoped suburbs.
  useEffect(() => {
    apiJson('/api/suburbs')
      .then(d => setSuburbs(Array.isArray(d) ? d : (d.suburbs || [])))
      .catch(() => setSuburbs([]))
  }, [])

  const fetchSeqRef = useRef(0)
  const fetchSignals = useCallback(async () => {
    // Stale-while-revalidate on filter changes: repaint instantly from the
    // per-filter cache, keep those rows on screen while revalidating. The
    // full-pane spinner only shows when there is genuinely nothing cached.
    const seq = ++fetchSeqRef.current
    const key = sigKey(status, suburb, minScore)
    const cached = readCache(key)
    if (cached && cached.length) { setSignals(cached); setLoading(false) }
    else setSignals(prev => { if (prev.length === 0) setLoading(true); return prev })
    setError('')
    const params = new URLSearchParams({ status, limit: '200' })
    if (suburb) params.set('suburb', suburb)
    if (minScore > 0) params.set('min_score', String(minScore))
    // Render free-tier cold starts can take 30–60s. Escalate the deadline
    // instead of surfacing "signal timed out" on the first slow attempt.
    for (const timeout of [20000, 45000]) {
      try {
        const data = await apiJson(`/api/signals?${params.toString()}`,
          { signal: AbortSignal.timeout(timeout) })
        if (seq !== fetchSeqRef.current) return   // a newer filter won
        const rows = data.signals || []
        setSignals(rows)
        writeCache(key, rows)
        setError('')
        setLoading(false)
        return
      } catch (e) {
        if (seq !== fetchSeqRef.current) return
        if (timeout === 45000) {
          const timedOut = e && /timed out|abort/i.test(String(e.message || e.name || ''))
          // Only surface an error when there's nothing cached to show.
          setSignals(prev => {
            if (prev.length === 0) {
              setError(timedOut
                ? 'The server is still waking up — this can take a minute after a quiet spell.'
                : (e.message || 'Could not load signals.'))
            }
            return prev
          })
          setLoading(false)
        }
      }
    }
  }, [status, suburb, minScore])

  useEffect(() => { fetchSignals() }, [fetchSignals])

  async function setSignalStatus(id, newStatus) {
    // Optimistic: the row leaves the list instantly; it's restored (in
    // place) if the PATCH fails. No more full round-trip wait per click.
    setBusyId(id)
    let removed = null, removedIdx = -1
    setSignals(prev => {
      removedIdx = prev.findIndex(s => s.id === id)
      removed = removedIdx >= 0 ? prev[removedIdx] : null
      return prev.filter(s => s.id !== id)
    })
    try {
      await apiJson(`/api/signals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
    } catch (e) {
      if (removed) {
        setSignals(prev => {
          const next = prev.slice()
          next.splice(Math.min(removedIdx, next.length), 0, removed)
          return next
        })
      }
      alert(`Could not update signal: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  // ── Desk redesign (mock 06 · event stream + map). Separate render so
  // classic stays byte-identical; all state/handlers above are shared. ──
  if (getDeskMode() === 'desk') {
    const MONO = "var(--font-mono)"
    const scoreColorVar = (st) => `var(--status-${st})`
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {/* header + filters */}
        <div style={{ padding: '20px 30px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14, gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Signals</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--status-good)', boxShadow: '0 0 0 3px var(--status-good-bg)' }} />
                {/* "shown", not a total: the fetch is capped at 200 and rows
                    can come from the stale-while-revalidate cache. */}
                {signals.length} {STATUS_LABELS[status].toLowerCase()} signal{signals.length === 1 ? '' : 's'} shown
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select value={suburb} onChange={e => setSuburb(e.target.value)} size="sm" title="Filter by suburb">
                <option value="">All my suburbs</option>
                {suburbs.map(s => <option key={s.id || s.name} value={s.name}>{s.name}</option>)}
              </Select>
              <Select value={String(minScore)} onChange={e => setMinScore(Number(e.target.value))} size="sm" options={SCORE_FILTERS} />
              <Button variant="ghost" size="sm" onClick={fetchSignals}>Refresh</Button>
            </div>
          </div>
          {/* status filter chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(STATUS_LABELS).map(([v, l]) => {
              const on = status === v
              return (
                <span key={v} onClick={() => setStatus(v)}
                  style={{
                    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7,
                    fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, letterSpacing: '.04em',
                    textTransform: 'uppercase', borderRadius: 999, padding: '6px 13px',
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    color: on ? 'var(--accent)' : 'var(--text-muted)',
                    border: `1px solid ${on ? 'var(--accent-soft)' : 'var(--border)'}`,
                  }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? 'var(--accent)' : 'var(--text-faint)' }} />
                  {l}
                </span>
              )
            })}
          </div>
        </div>

        {/* split: feed | map */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: '58%', overflowY: 'auto', borderRight: '1px solid var(--border)' }}>
            {loading ? (
              <div style={{ color: 'var(--text-muted)', padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}><Spinner size={16} muted inline /> Loading signals…</div>
            ) : error ? (
              <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>{error}</span>
                <Button variant="secondary" size="sm" onClick={fetchSignals}>Retry</Button>
              </div>
            ) : signals.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', padding: 24 }}>No {STATUS_LABELS[status].toLowerCase()} signals yet.</div>
            ) : signals.map(s => {
              const st = scoreStatus(s.score)
              const reason = ((s.reason_codes || [])[0] || '') + ((s.reason_codes || []).length > 1 ? ` +${s.reason_codes.length - 1} more` : '')
              return (
                <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '46px 1fr auto', gap: 12, alignItems: 'center', padding: '11px 20px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, width: 40, height: 40, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `var(--status-${st}-bg)`, color: `var(--status-${st}-text)` }}>
                    {(s.score * 100).toFixed(0)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address}</div>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.suburb || ''}{reason ? ` · ${reason}` : ''}
                    </div>
                  </div>
                  {status === 'new' && (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="secondary" size="sm" icon={Check} onClick={() => setSignalStatus(s.id, 'actioned')} loading={busyId === s.id}>Actioned</Button>
                      <Button variant="ghost" size="sm" icon={X} onClick={() => setSignalStatus(s.id, 'dismissed')} disabled={busyId === s.id}>Dismiss</Button>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {/* map */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <DeskMap
              items={signals}
              label={`Signal locations · ${signals.length}`}
              addressOf={(s) => s.address}
              suburbOf={(s) => s.suburb}
              colorOf={(s) => SIGNAL_HEX[scoreStatus(s.score)] || '#9CA3AF'}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 24px', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: 'var(--text)' }}>Signals</h2>
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
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ color: 'var(--text-muted)' }}>{error}</span>
          <Button variant="secondary" size="sm" onClick={fetchSignals}>Retry</Button>
        </div>
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

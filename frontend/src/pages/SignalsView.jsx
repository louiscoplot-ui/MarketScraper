// SENTINEL S2 — Signals view. Deliberately minimal (the morning brief is
// the product, this is the working list): score + plain-language reasons +
// Dismiss / Mark actioned. Reads /api/signals (scoped server-side),
// status changes via PATCH /api/signals/<id>.
import { useState, useEffect, useCallback } from 'react'
import { apiJson } from '../lib/api'

const STATUS_LABELS = { new: 'New', actioned: 'Actioned', dismissed: 'Dismissed' }

function scoreColor(score) {
  if (score >= 0.6) return '#c0392b'
  if (score >= 0.35) return '#d68910'
  return '#7f8c8d'
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
      background: '#f4f6f7', border: '1px solid #dfe4e8', borderRadius: 8,
      marginBottom: 14, fontSize: 14,
    }}>
      <strong>Prediction ledger</strong>
      <span>{t.predictions} prediction{t.predictions > 1 ? 's' : ''}</span>
      <span style={{ color: '#1e8449' }}>{t.listed} listed</span>
      <span style={{ color: '#7f8c8d' }}>{t.not_listed} expired</span>
      <span style={{ color: '#7f8c8d' }}>{t.pending} pending</span>
      <span style={{ fontWeight: 700 }}>
        {t.hit_rate == null ? 'hit rate: —'
          : `hit rate: ${(t.hit_rate * 100).toFixed(0)}%`}
      </span>
    </div>
  )
}

export default function SignalsView() {
  const [signals, setSignals] = useState([])
  const [status, setStatus] = useState('new')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  const fetchSignals = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await apiJson(`/api/signals?status=${status}&limit=200`)
      setSignals(data.signals || [])
    } catch (e) {
      setError(e.message || 'Could not load signals')
    } finally {
      setLoading(false)
    }
  }, [status])

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Vendor Signals</h2>
        <select value={status} onChange={e => setStatus(e.target.value)}
                style={{ padding: '4px 8px' }}>
          {Object.entries(STATUS_LABELS).map(([v, l]) =>
            <option key={v} value={v}>{l}</option>)}
        </select>
        <button onClick={fetchSignals} style={{ padding: '4px 10px' }}>Refresh</button>
      </div>

      <PrecisionCard />

      {loading ? (
        <div style={{ color: '#7f8c8d', padding: 24 }}>Loading signals…</div>
      ) : error ? (
        <div style={{ color: '#c0392b', padding: 24 }}>{error}</div>
      ) : signals.length === 0 ? (
        <div style={{ color: '#7f8c8d', padding: 24 }}>
          No {STATUS_LABELS[status].toLowerCase()} signals. Signals are
          rebuilt after every nightly scrape from the market-events ledger.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #dfe4e8' }}>
              <th style={{ padding: '6px 8px', width: 70 }}>Score</th>
              <th style={{ padding: '6px 8px' }}>Address</th>
              <th style={{ padding: '6px 8px', width: 130 }}>Suburb</th>
              <th style={{ padding: '6px 8px' }}>Why</th>
              {status === 'new' &&
                <th style={{ padding: '6px 8px', width: 170 }}></th>}
            </tr>
          </thead>
          <tbody>
            {signals.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid #eef1f3', verticalAlign: 'top' }}>
                <td style={{ padding: '8px', fontWeight: 700, color: scoreColor(s.score) }}>
                  {(s.score * 100).toFixed(0)}
                </td>
                <td style={{ padding: '8px', fontWeight: 600 }}>{s.address}</td>
                <td style={{ padding: '8px' }}>{s.suburb || ''}</td>
                <td style={{ padding: '8px' }}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(s.reason_codes || []).map((r, i) =>
                      <li key={i} style={{ marginBottom: 2 }}>{r}</li>)}
                  </ul>
                </td>
                {status === 'new' && (
                  <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => setSignalStatus(s.id, 'actioned')}
                      disabled={busyId === s.id}
                      style={{ marginRight: 6, padding: '3px 8px', cursor: 'pointer' }}>
                      ✓ Actioned
                    </button>
                    <button
                      onClick={() => setSignalStatus(s.id, 'dismissed')}
                      disabled={busyId === s.id}
                      style={{ padding: '3px 8px', cursor: 'pointer' }}>
                      ✕ Dismiss
                    </button>
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

// SENTINEL S4 — the "Today" view: the morning brief in-app. Default view
// at login. Top 5 signals with narrative + one-click actions (Generate
// letter / Log call / Dismiss) and the single manual input we ask of the
// agent: the "→ appraisal? / → listing?" attribution checkboxes.
// Letter download is fetch+blob via the api() wrapper (BACKEND_DIRECT) —
// window.open would bypass the X-Access-Key interceptor.
import { useState, useEffect, useCallback } from 'react'
import { api, apiJson } from '../lib/api'

function scoreColor(score) {
  if (score >= 0.6) return '#c0392b'
  if (score >= 0.35) return '#d68910'
  return '#7f8c8d'
}

export default function TodayView() {
  const [brief, setBrief] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)          // signal_id in flight
  const [acted, setActed] = useState({})          // signal_id -> {action_id, action}

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
      <h2 style={{ marginBottom: 2 }}>Today</h2>
      <div style={{ color: '#7f8c8d', marginBottom: 16, fontSize: 14 }}>
        {brief?.brief_date || ''}{brief?.live ? ' · built live (tonight’s brief will be emailed)' : ''}
      </div>

      {loading ? (
        <div style={{ color: '#7f8c8d', padding: 24 }}>Loading your brief…</div>
      ) : error ? (
        <div style={{ color: '#c0392b', padding: 24 }}>{error}</div>
      ) : items.length === 0 ? (
        <div style={{ color: '#7f8c8d', padding: 24 }}>
          No vendor signals for your suburbs yet — the ledger fills as the
          nightly scrapes accumulate market events.
        </div>
      ) : items.map(item => {
        const info = acted[item.signal_id]
        return (
          <div key={item.signal_id} style={{
            border: '1px solid #e3e7ea', borderRadius: 10,
            padding: '14px 16px', marginBottom: 14,
            opacity: info?.action === 'dismissed' ? 0.5 : 1,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                {item.address}
                <span style={{ color: '#7f8c8d', fontWeight: 400 }}> — {item.suburb}</span>
              </div>
              <div style={{ fontWeight: 700, color: scoreColor(item.score) }}>
                {Math.round((item.score || 0) * 100)}
              </div>
            </div>
            <div style={{ margin: '8px 0', color: '#2c3e50' }}>{item.narrative}</div>
            <ul style={{ margin: '0 0 10px', paddingLeft: 18, color: '#566573', fontSize: 13 }}>
              {(item.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
            </ul>

            {!info ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={busy === item.signal_id}
                        onClick={() => downloadLetter(item)}
                        style={{ padding: '5px 12px', cursor: 'pointer' }}>
                  📄 Generate letter
                </button>
                <button disabled={busy === item.signal_id}
                        onClick={() => recordAction(item, 'call_logged')}
                        style={{ padding: '5px 12px', cursor: 'pointer' }}>
                  📞 Log call
                </button>
                <button disabled={busy === item.signal_id}
                        onClick={() => recordAction(item, 'dismissed')}
                        style={{ padding: '5px 12px', cursor: 'pointer' }}>
                  ✕ Dismiss
                </button>
              </div>
            ) : info.action === 'dismissed' ? (
              <div style={{ color: '#7f8c8d', fontSize: 13 }}>Dismissed</div>
            ) : (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13 }}>
                <span style={{ color: '#1e8449' }}>
                  {info.action === 'letter' ? '📄 Letter generated' : '📞 Call logged'}
                </span>
                <label style={{ cursor: 'pointer' }}>
                  <input type="checkbox"
                         checked={!!info.converted_to_appraisal}
                         onChange={e => setConversion(item, 'converted_to_appraisal', e.target.checked)}
                  /> → appraisal?
                </label>
                <label style={{ cursor: 'pointer' }}>
                  <input type="checkbox"
                         checked={!!info.converted_to_listing}
                         onChange={e => setConversion(item, 'converted_to_listing', e.target.checked)}
                  /> → listing?
                </label>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// LOOP-5 — Appraisals tab. Log an appraisal (auto-schedules J+30/60/90
// follow-ups server-side), see the list with next-relance date, and tag
// won/lost. Calls go through BACKEND_DIRECT (Render) with X-Access-Key so a
// cold start doesn't hit Vercel's 25s edge timeout. Mirrors the Pipeline
// view's plain-table styling.
import { useState, useEffect, useCallback } from 'react'
import { BACKEND_DIRECT } from '../lib/api'

const API = `${BACKEND_DIRECT}/api`

function authFetch(url, options = {}) {
  const key = localStorage.getItem('agentdeck_access_key') || ''
  return fetch(url, {
    ...options,
    headers: {
      'X-Access-Key': key,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
}

const EMPTY = {
  address: '', suburb: '', vendor_name: '', vendor_email: '',
  vendor_phone: '', appraisal_date: '', estimated_price: '', notes: '',
}

export default function AppraisalsView() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch(`${API}/appraisals`)
      const data = res.ok ? await res.json() : []
      setItems(Array.isArray(data) ? data : [])
    } catch {
      setItems([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const submit = async (e) => {
    e.preventDefault()
    if (saving) return
    setError(null)
    if (!form.address.trim() || !form.appraisal_date) {
      setError('Address and appraisal date are required.')
      return
    }
    setSaving(true)
    try {
      const payload = { ...form }
      payload.estimated_price = form.estimated_price
        ? parseInt(String(form.estimated_price).replace(/[^\d]/g, ''), 10)
        : null
      const res = await authFetch(`${API}/appraisals`, {
        method: 'POST', body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Save failed (${res.status})`)
      }
      setForm(EMPTY)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (id, status) => {
    try {
      const res = await authFetch(`${API}/appraisals/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      })
      if (res.ok) load()
    } catch { /* ignore — list reload will reflect server state */ }
  }

  const wonCount = items.filter(a => a.status === 'won').length
  const activeCount = items.filter(a => a.status === 'active').length

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  return (
    <div style={{ padding: '8px 4px' }}>
      <h2>Appraisals</h2>
      <div style={{ display: 'flex', gap: 12, margin: '0 0 16px', flexWrap: 'wrap' }}>
        <span style={{ background: '#dcfce7', color: '#166534', padding: '4px 10px',
          borderRadius: 6, fontWeight: 600, fontSize: 13 }}>
          {wonCount} won
        </span>
        <span style={{ background: '#eff6ff', color: '#1e40af', padding: '4px 10px',
          borderRadius: 6, fontWeight: 600, fontSize: 13 }}>
          {activeCount} active
        </span>
      </div>

      <form onSubmit={submit} style={{ display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8,
        margin: '0 0 20px', padding: 12, background: '#fafafa',
        border: '1px solid #eee', borderRadius: 8 }}>
        <input placeholder="Address *" value={form.address} onChange={f('address')} />
        <input placeholder="Suburb" value={form.suburb} onChange={f('suburb')} />
        <input placeholder="Vendor name" value={form.vendor_name} onChange={f('vendor_name')} />
        <input placeholder="Vendor email" value={form.vendor_email} onChange={f('vendor_email')} />
        <input placeholder="Vendor phone" value={form.vendor_phone} onChange={f('vendor_phone')} />
        <input type="date" value={form.appraisal_date} onChange={f('appraisal_date')} />
        <input placeholder="Estimated price" value={form.estimated_price} onChange={f('estimated_price')} />
        <input placeholder="Notes" value={form.notes} onChange={f('notes')} />
        <button type="submit" disabled={saving}
          style={{ gridColumn: '1 / -1', padding: '8px 16px', background: '#386350',
            color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600,
            cursor: 'pointer' }}>
          {saving ? 'Saving…' : 'Log appraisal (+ schedule J+30/60/90)'}
        </button>
        {error && <div style={{ gridColumn: '1 / -1', color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      </form>

      {loading ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#666' }}>No appraisals logged yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #eee' }}>
              <th style={{ padding: 6 }}>Address</th>
              <th style={{ padding: 6 }}>Suburb</th>
              <th style={{ padding: 6 }}>Date</th>
              <th style={{ padding: 6 }}>Est. price</th>
              <th style={{ padding: 6 }}>Next follow-up</th>
              <th style={{ padding: 6 }}>Status</th>
              <th style={{ padding: 6 }}></th>
            </tr>
          </thead>
          <tbody>
            {items.map(a => (
              <tr key={a.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: 6 }}>{a.address}</td>
                <td style={{ padding: 6 }}>{a.suburb || '—'}</td>
                <td style={{ padding: 6 }}>{a.appraisal_date}</td>
                <td style={{ padding: 6 }}>
                  {a.estimated_price ? `$${Number(a.estimated_price).toLocaleString()}` : '—'}
                </td>
                <td style={{ padding: 6 }}>{a.next_followup || '—'}</td>
                <td style={{ padding: 6, fontWeight: 600,
                  color: a.status === 'won' ? '#166534'
                    : a.status === 'lost' ? '#b91c1c' : '#1e40af' }}>
                  {a.status}
                </td>
                <td style={{ padding: 6 }}>
                  {a.status === 'active' && (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => setStatus(a.id, 'won')}
                        style={{ cursor: 'pointer', fontSize: 12 }}>Won</button>
                      <button onClick={() => setStatus(a.id, 'lost')}
                        style={{ cursor: 'pointer', fontSize: 12 }}>Lost</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

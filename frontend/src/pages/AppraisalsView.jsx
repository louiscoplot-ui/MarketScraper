// LOOP-5 — Appraisals tab. Log an appraisal (auto-schedules J+30/60/90
// follow-ups server-side), see the list with next-relance date, and tag
// won/lost. Calls go through BACKEND_DIRECT (Render) with X-Access-Key so a
// cold start doesn't hit Vercel's 25s edge timeout. Mirrors the Pipeline
// view's plain-table styling.
import { useState, useEffect, useCallback } from 'react'
import { BACKEND_DIRECT } from '../lib/api'
import { formatIsoDate } from '../hooks/useListings'
import { Button, Chip, Spinner } from '../components/ui'
import { getDeskMode } from '../lib/deskFlag'

function apPin(seed, i) {
  const s = String(seed || i); let h = 0
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 0xffff
  return { top: `${18 + (h % 62)}%`, left: `${14 + ((h >> 4) % 70)}%` }
}

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
  const [roi, setRoi] = useState(null)  // PERF-2 ROI summary
  const [deskForm, setDeskForm] = useState(false)  // desk: collapsible log form

  const loadRoi = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/roi/summary`)
      if (res.ok) setRoi(await res.json())
    } catch { /* non-critical */ }
  }, [])

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
    loadRoi()
  }, [loadRoi])

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

  // PERF-2 — mark won and capture commission for the ROI tracker.
  const markWon = async (id) => {
    const raw = window.prompt('Commission value (AUD)?', '')
    if (raw === null) return
    const commission = parseInt(String(raw).replace(/[^\d]/g, ''), 10) || 0
    try {
      const res = await authFetch(`${API}/appraisals/${id}/won`, {
        method: 'PATCH',
        body: JSON.stringify({ commission_value: commission, mandate_source: 'manual' }),
      })
      if (res.ok) load()
    } catch { /* list reload reflects server state */ }
  }

  const wonCount = items.filter(a => a.status === 'won').length
  const activeCount = items.filter(a => a.status === 'active').length

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  // ── Desk redesign — full render of mock #appraisals. ──
  if (getDeskMode() === 'desk') {
    const lostCount = items.filter(a => a.status === 'lost').length
    const kpis = [
      { v: activeCount, l: 'Open', c: 'var(--status-info)' },
      { v: wonCount, l: 'Won', c: 'var(--status-good)' },
      { v: lostCount, l: 'Lost', c: 'var(--status-alert)' },
      { v: items.length, l: 'Total', c: 'var(--status-off)' },
    ]
    const stColor = (s) => s === 'won' ? 'var(--status-good)' : s === 'lost' ? 'var(--status-alert)' : 'var(--status-info)'
    const GRID = '1.6fr 1.1fr 92px 108px 110px 92px'
    return (
      <div style={{ padding: '24px 30px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Appraisals</h2>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>{activeCount} open · {wonCount} won{roi ? ` · $${Number(roi.total_commission_aud || 0).toLocaleString()} commissions` : ''}</div>
          </div>
          <Button variant="primary" size="sm" onClick={() => setDeskForm(v => !v)}>{deskForm ? 'Close' : '+ Log request'}</Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
          {kpis.map(k => (
            <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 13, padding: '15px 17px', boxShadow: 'var(--shadow-card)' }}>
              <span style={{ width: 9, height: 38, borderRadius: 5, background: k.c, flexShrink: 0 }} />
              <div><div style={{ fontFamily: 'var(--font-display)', fontSize: 28, lineHeight: 0.9, letterSpacing: '-0.02em', color: 'var(--text)' }}>{k.v}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 6 }}>{k.l}</div></div>
            </div>
          ))}
        </div>

        {deskForm && (
          <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, padding: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
            <input placeholder="Address *" value={form.address} onChange={f('address')} style={inputStyle} />
            <input placeholder="Suburb" value={form.suburb} onChange={f('suburb')} style={inputStyle} />
            <input placeholder="Vendor name" value={form.vendor_name} onChange={f('vendor_name')} style={inputStyle} />
            <input type="date" value={form.appraisal_date} onChange={f('appraisal_date')} style={inputStyle} />
            <input placeholder="Estimated price" value={form.estimated_price} onChange={f('estimated_price')} style={inputStyle} />
            <div style={{ gridColumn: '1 / -1' }}><Button type="submit" variant="primary" loading={saving}>{saving ? 'Saving…' : 'Log appraisal'}</Button></div>
            {error && <div style={{ gridColumn: '1 / -1', color: 'var(--status-alert-text)', fontSize: 13 }}>{error}</div>}
          </form>
        )}

        <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
          <div style={{ width: '64%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-card)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              <span>Address</span><span>Owner</span><span>Date</span><span>Est. value</span><span>Follow-up</span><span>Status</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading ? <div style={{ padding: 24, color: 'var(--text-muted)', display: 'flex', gap: 10, alignItems: 'center' }}><Spinner size={16} muted inline /> Loading…</div>
                : items.length === 0 ? <div style={{ padding: 24, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>No appraisals logged yet.</div>
                : items.map(a => (
                  <div key={a.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center', padding: '11px 18px', borderBottom: '1px solid var(--border)', borderLeft: `3px solid ${stColor(a.status)}` }}>
                    <div style={{ minWidth: 0 }}><div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.address}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>{a.suburb || ''}</div></div>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.vendor_name || '—'}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{formatIsoDate(a.appraisal_date) || a.appraisal_date}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{a.estimated_price ? `$${Number(a.estimated_price).toLocaleString()}` : '—'}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{formatIsoDate(a.next_followup) || '—'}</span>
                    <span>
                      {a.status === 'active'
                        ? <span style={{ display: 'inline-flex', gap: 5 }}><Button variant="secondary" size="sm" onClick={() => markWon(a.id)}>Won</Button><Button variant="ghost" size="sm" onClick={() => setStatus(a.id, 'lost')}>Lost</Button></span>
                        : <Chip status={a.status === 'won' ? 'good' : a.status === 'lost' ? 'alert' : 'info'} size="sm">{a.status}</Chip>}
                    </span>
                  </div>
                ))}
            </div>
          </div>
          <div className="desk-map" style={{ flex: 1, minHeight: 0 }}>
            <div className="desk-map-label">Appraisal runs · batch nearby</div>
            {items.slice(0, 24).map((a, i) => { const p = apPin(a.address, i); return <span key={a.id ?? i} style={{ position: 'absolute', top: p.top, left: p.left, width: 13, height: 13, borderRadius: '50%', background: stColor(a.status), border: '2px solid #fff', boxShadow: '0 1px 5px rgba(0,0,0,.22)' }} /> })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '8px 4px' }}>
      <h2 style={{ color: 'var(--text)' }}>Appraisals</h2>
      <div style={{ display: 'flex', gap: 10, margin: '0 0 16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip status="good">{wonCount} won</Chip>
        <Chip status="info">{activeCount} active</Chip>
        {roi && (
          <span style={{ background: 'var(--accent)', color: 'var(--accent-fg)', padding: '3px 10px',
            borderRadius: 'var(--radius-pill)', fontWeight: 700, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
            title={`${roi.total_mandates_won} mandates · this quarter $${(roi.this_quarter?.commission || 0).toLocaleString()}`}>
            ${Number(roi.total_commission_aud || 0).toLocaleString()} commissions
          </span>
        )}
      </div>

      {/* Desk-mode KPI marquee (mock 08). Hidden in classic via CSS. */}
      <div className="desk-kpis">
        <div className="desk-kpi" data-c="info">
          <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{activeCount}</div><div className="desk-kpi-l">Open</div></div>
        </div>
        <div className="desk-kpi" data-c="good">
          <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{wonCount}</div><div className="desk-kpi-l">Won</div></div>
        </div>
        <div className="desk-kpi" data-c="alert">
          <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{items.filter(a => a.status === 'lost').length}</div><div className="desk-kpi-l">Lost</div></div>
        </div>
        <div className="desk-kpi" data-c="off">
          <span className="desk-kpi-bar" /><div><div className="desk-kpi-n">{items.length}</div><div className="desk-kpi-l">Total</div></div>
        </div>
      </div>

      <form onSubmit={submit} style={{ display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8,
        margin: '0 0 20px', padding: 12, background: 'var(--bg)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <input placeholder="Address *" value={form.address} onChange={f('address')} style={inputStyle} />
        <input placeholder="Suburb" value={form.suburb} onChange={f('suburb')} style={inputStyle} />
        <input placeholder="Vendor name" value={form.vendor_name} onChange={f('vendor_name')} style={inputStyle} />
        <input placeholder="Vendor email" value={form.vendor_email} onChange={f('vendor_email')} style={inputStyle} />
        <input placeholder="Vendor phone" value={form.vendor_phone} onChange={f('vendor_phone')} style={inputStyle} />
        <input type="date" value={form.appraisal_date} onChange={f('appraisal_date')} style={inputStyle} />
        <input placeholder="Estimated price" value={form.estimated_price} onChange={f('estimated_price')} style={inputStyle} />
        <input placeholder="Notes" value={form.notes} onChange={f('notes')} style={inputStyle} />
        <div style={{ gridColumn: '1 / -1' }}>
          <Button type="submit" variant="primary" loading={saving}>
            {saving ? 'Saving…' : 'Log appraisal (+ schedule J+30/60/90)'}
          </Button>
        </div>
        {error && <div style={{ gridColumn: '1 / -1', color: 'var(--status-alert-text)', fontSize: 13 }}>{error}</div>}
      </form>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spinner size={16} muted inline /> Loading…
        </div>
      ) : items.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No appraisals logged yet.</p>
      ) : (
        <div className="desk-split-side">
        <table className="desk-appraisals" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
              {['Address', 'Suburb', 'Date', 'Est. price', 'Next follow-up', 'Status', ''].map((h, i) => (
                <th key={i} style={{ padding: 6, color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map(a => (
              <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 6, color: 'var(--text)' }}>{a.address}</td>
                <td style={{ padding: 6, color: 'var(--text)' }}>{a.suburb || '—'}</td>
                <td style={{ padding: 6, color: 'var(--text)' }}>{formatIsoDate(a.appraisal_date) || a.appraisal_date}</td>
                <td style={{ padding: 6, color: 'var(--text)' }}>
                  {a.estimated_price ? `$${Number(a.estimated_price).toLocaleString()}` : '—'}
                </td>
                <td style={{ padding: 6, color: 'var(--text)' }}>{formatIsoDate(a.next_followup) || '—'}</td>
                <td style={{ padding: 6 }}>
                  <Chip status={a.status === 'won' ? 'good' : a.status === 'lost' ? 'alert' : 'info'} size="sm">
                    {a.status}
                  </Chip>
                </td>
                <td style={{ padding: 6 }}>
                  {a.status === 'active' && (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <Button variant="secondary" size="sm" onClick={() => markWon(a.id)}>Won</Button>
                      <Button variant="ghost" size="sm" onClick={() => setStatus(a.id, 'lost')}>Lost</Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Desk-mode lateral map (mock 08). Hidden in classic via CSS. */}
        <div className="desk-map desk-side-map">
          <div className="desk-map-label">Appraisal runs · batch nearby</div>
          {items.slice(0, 24).map((a, i) => {
            const st = a.status === 'won' ? 'good' : a.status === 'lost' ? 'alert' : 'info'
            const s = String(a.address || i)
            let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 0xffff
            return <span key={a.id ?? i} style={{ position: 'absolute', top: `${18 + (h % 62)}%`, left: `${14 + ((h >> 4) % 70)}%`, width: 13, height: 13, borderRadius: '50%', background: `var(--status-${st})`, border: '2px solid #fff', boxShadow: '0 1px 5px rgba(0,0,0,.22)' }} />
          })}
        </div>
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  padding: '8px 10px', fontSize: 13, borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
}

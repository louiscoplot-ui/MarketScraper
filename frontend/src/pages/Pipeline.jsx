import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL || 'https://marketscraper-backend.onrender.com'

const SUBURBS = [
  'Cottesloe', 'Nedlands', 'Claremont', 'Dalkeith', 'Swanbourne',
  'Peppermint Grove', 'Mosman Park', 'Subiaco', 'Mount Claremont',
  'City Beach', 'Floreat', 'Crawley', 'Mount Lawley', 'Highgate',
  'North Perth', 'Leederville'
]

const STATUS_LABELS = {
  sent: { label: 'Sent', color: '#3b82f6' },
  responded: { label: 'Responded', color: '#f59e0b' },
  appraisal_booked: { label: 'Appraisal Booked', color: '#10b981' },
  listing_signed: { label: 'Listing Signed ✓', color: '#059669' },
  no_response: { label: 'No Response', color: '#6b7280' }
}

export default function Pipeline() {
  const [suburb, setSuburb] = useState('Cottesloe')
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [entries, setEntries] = useState([])
  const [generateMsg, setGenerateMsg] = useState(null)
  const [editingName, setEditingName] = useState(null)
  const [editingNote, setEditingNote] = useState(null)
  const [actionModal, setActionModal] = useState(null)

  useEffect(() => { loadTracking() }, [])

  async function loadTracking() {
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/pipeline/tracking?limit=200`)
      const data = await res.json()
      setEntries(data.entries || [])
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenerateMsg(null)
    try {
      const res = await fetch(
        `${API}/api/pipeline/generate?suburb=${encodeURIComponent(suburb)}&days=${days}`
      )
      const data = await res.json()
      if (data.error) {
        setGenerateMsg({ type: 'error', text: data.error })
      } else {
        setGenerateMsg({
          type: 'success',
          text: `Generated ${data.generated} letters from ${data.sold_count} sales in ${suburb}`
        })
        loadTracking()
      }
    } catch (e) {
      setGenerateMsg({ type: 'error', text: 'Failed to connect to backend' })
    }
    setGenerating(false)
  }

  async function patchEntry(id, fields) {
    await fetch(`${API}/api/pipeline/tracking/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    })
    loadTracking()
  }

  function handleExportCSV() {
    const headers = ['Target Address','Owner Name','Source Sale','Sold Price','Score','Status','Sent Date','Notes']
    const rows = entries.map(e => [
      e.target_address, e.target_owner_name || '',
      e.source_address, e.source_price ? `$${e.source_price.toLocaleString()}` : '',
      e.hot_vendor_score || '', e.status, e.sent_date, e.notes || ''
    ])
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pipeline_${new Date().toISOString().slice(0,10)}.csv`
    a.click()
  }

  // Stats
  const sent = entries.filter(e => e.status === 'sent').length
  const responded = entries.filter(e => e.status === 'responded').length
  const appraisals = entries.filter(e => e.status === 'appraisal_booked').length
  const listed = entries.filter(e => e.status === 'listing_signed').length
  const respRate = entries.length ? Math.round((responded / entries.length) * 100) : 0

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>
        Appraisal Pipeline
      </h1>

      {/* Generator */}
      <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={suburb}
            onChange={e => setSuburb(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px' }}
          >
            {SUBURBS.map(s => <option key={s}>{s}</option>)}
          </select>

          <div style={{ display: 'flex', gap: '6px' }}>
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => setDays(d)}
                style={{
                  padding: '8px 14px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
                  background: days === d ? '#1d4ed8' : 'white',
                  color: days === d ? 'white' : '#374151',
                  border: `1px solid ${days === d ? '#1d4ed8' : '#d1d5db'}`
                }}>
                {d} days
              </button>
            ))}
          </div>

          <button
            onClick={handleGenerate}
            disabled={generating}
            style={{
              padding: '8px 20px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
              background: generating ? '#93c5fd' : '#1d4ed8', color: 'white', border: 'none', fontWeight: '600'
            }}>
            {generating ? 'Generating...' : 'Generate Letters'}
          </button>
        </div>

        {generateMsg && (
          <div style={{
            marginTop: '12px', padding: '10px 14px', borderRadius: '6px', fontSize: '14px',
            background: generateMsg.type === 'success' ? '#d1fae5' : '#fee2e2',
            color: generateMsg.type === 'success' ? '#065f46' : '#991b1b'
          }}>
            {generateMsg.text}
          </div>
        )}
      </div>

      {/* Actions */}
      {entries.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
          <button
            onClick={() => window.open('/pipeline/print', '_blank')}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '14px' }}>
            🖨 Print Letters
          </button>
          <button
            onClick={handleExportCSV}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '14px' }}>
            ⬇ Export CSV
          </button>
        </div>
      )}

      {/* Stats */}
      {entries.length > 0 && (
        <div style={{
          display: 'flex', gap: '24px', marginBottom: '20px',
          padding: '14px 20px', background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px',
          fontSize: '14px', color: '#374151'
        }}>
          <span><strong>{sent}</strong> sent</span>
          <span><strong>{responded}</strong> responded ({respRate}%)</span>
          <span><strong>{appraisals}</strong> appraisals booked</span>
          <span><strong>{listed}</strong> listings signed</span>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading...</p>
      ) : entries.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No entries yet. Generate letters to get started.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Target Address','Owner Name','Source Sale','Price','Score','Status','Sent','Notes','Action'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '600', color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px' }}>{e.target_address}</td>

                  {/* Owner Name — inline edit */}
                  <td style={{ padding: '10px 12px' }}>
                    {editingName === e.id ? (
                      <input
                        autoFocus
                        defaultValue={e.target_owner_name || ''}
                        onBlur={ev => { patchEntry(e.id, { target_owner_name: ev.target.value }); setEditingName(null) }}
                        onKeyDown={ev => { if (ev.key === 'Enter') ev.target.blur() }}
                        style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px', width: '140px' }}
                      />
                    ) : (
                      <span
                        onClick={() => setEditingName(e.id)}
                        style={{ cursor: 'pointer', color: e.target_owner_name ? '#111827' : '#9ca3af', borderBottom: '1px dashed #d1d5db' }}>
                        {e.target_owner_name || '+ add name'}
                      </span>
                    )}
                  </td>

                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{e.source_address}</td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    {e.source_price ? `$${e.source_price.toLocaleString()}` : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                    {e.hot_vendor_score || '—'}
                  </td>

                  {/* Status badge */}
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: '500',
                      background: STATUS_LABELS[e.status]?.color + '20',
                      color: STATUS_LABELS[e.status]?.color
                    }}>
                      {STATUS_LABELS[e.status]?.label || e.status}
                    </span>
                  </td>

                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#6b7280' }}>
                    {e.sent_date ? new Date(e.sent_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                  </td>

                  {/* Notes — inline edit */}
                  <td style={{ padding: '10px 12px', maxWidth: '180px' }}>
                    {editingNote === e.id ? (
                      <input
                        autoFocus
                        defaultValue={e.notes || ''}
                        onBlur={ev => { patchEntry(e.id, { notes: ev.target.value }); setEditingNote(null) }}
                        onKeyDown={ev => { if (ev.key === 'Enter') ev.target.blur() }}
                        style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px', width: '160px' }}
                      />
                    ) : (
                      <span
                        onClick={() => setEditingNote(e.id)}
                        style={{ cursor: 'pointer', color: e.notes ? '#111827' : '#9ca3af', borderBottom: '1px dashed #d1d5db' }}>
                        {e.notes || '+ add note'}
                      </span>
                    )}
                  </td>

                  {/* Action */}
                  <td style={{ padding: '10px 12px' }}>
                    <select
                      value=""
                      onChange={ev => {
                        if (!ev.target.value) return
                        setActionModal({ id: e.id, status: ev.target.value })
                        ev.target.value = ""
                      }}
                      style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '12px', cursor: 'pointer' }}>
                      <option value="">Update...</option>
                      <option value="responded">Responded</option>
                      <option value="appraisal_booked">Appraisal Booked</option>
                      <option value="listing_signed">Listing Signed</option>
                      <option value="no_response">No Response</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Action modal */}
      {actionModal && (
        <ActionModal
          status={actionModal.status}
          onConfirm={(notes, date) => {
            patchEntry(actionModal.id, {
              status: actionModal.status,
              notes: notes || undefined,
              response_date: date || undefined
            })
            setActionModal(null)
          }}
          onClose={() => setActionModal(null)}
        />
      )}
    </div>
  )
}

function ActionModal({ status, onConfirm, onClose }) {
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState('')
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{ background: 'white', borderRadius: '10px', padding: '24px', width: '360px' }}>
        <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: '600' }}>
          Mark as {status.replace(/_/g, ' ')}
        </h3>
        <input
          placeholder="Notes (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px', marginBottom: '10px', boxSizing: 'border-box' }}
        />
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px', marginBottom: '16px', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(notes, date)}
            style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#1d4ed8', color: 'white', cursor: 'pointer', fontWeight: '600' }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

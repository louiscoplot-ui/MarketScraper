import { useState, useEffect } from 'react'

const API = ''

const SUBURBS = [
  'Cottesloe', 'Nedlands', 'Claremont', 'Dalkeith', 'Swanbourne',
  'Peppermint Grove', 'Mosman Park', 'Subiaco', 'Mount Claremont',
  'City Beach', 'Floreat', 'Crawley', 'Mount Lawley', 'Highgate',
  'North Perth', 'Leederville', 'North Fremantle', 'Wembley',
  'West Leederville', 'Ellenbrook',
]

const STATUS_LABELS = {
  sent: { label: 'Sent', color: '#3b82f6' },
  responded: { label: 'Responded', color: '#f59e0b' },
  appraisal_booked: { label: 'Appraisal Booked', color: '#10b981' },
  listing_signed: { label: 'Listing Signed ✓', color: '#059669' },
  no_response: { label: 'No Response', color: '#6b7280' },
}

function formatPrice(p) {
  if (p == null || p === '') return '—'
  const n = typeof p === 'number' ? p : parseInt(String(p).replace(/[^\d]/g, ''))
  return isNaN(n) ? '—' : `$${n.toLocaleString()}`
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Pipeline() {
  const [suburb, setSuburb] = useState('Cottesloe')
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [groups, setGroups] = useState([])
  const [generateMsg, setGenerateMsg] = useState(null)
  const [editingName, setEditingName] = useState(null)
  const [editingNote, setEditingNote] = useState(null)
  const [actionModal, setActionModal] = useState(null)
  const [showManualForm, setShowManualForm] = useState(false)
  const [filterSuburb, setFilterSuburb] = useState('')

  useEffect(() => { loadTracking() }, [filterSuburb])

  async function loadTracking() {
    setLoading(true)
    try {
      const url = filterSuburb
        ? `${API}/api/pipeline/tracking/grouped?suburb=${encodeURIComponent(filterSuburb)}&limit=500`
        : `${API}/api/pipeline/tracking/grouped?limit=500`
      const res = await fetch(url)
      const data = await res.json()
      setGroups(data.groups || [])
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
        const cap = data.cap_applied ? ' (cap reached — try a wider days window for more)' : ''
        setGenerateMsg({
          type: 'success',
          text: `Generated ${data.generated} new entries from ${data.sold_count} sales in ${suburb}${cap}`,
        })
        setFilterSuburb(suburb)
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
      body: JSON.stringify(fields),
    })
    loadTracking()
  }

  function downloadLetter(representativeId) {
    // Hits the backend endpoint that aggregates ALL sources for the
    // target, generates a single Word doc, returns it as attachment.
    window.open(`${API}/api/pipeline/letter/${representativeId}/download`, '_blank')
  }

  function handleExportCSV() {
    const headers = ['Target Address', 'Owner Name', 'Source Sales', 'Total Source Sales',
                     'Score', 'Status', 'Sent Date', 'Notes']
    const rows = groups.map(g => {
      const sourcesText = g.sources
        .map(s => `${s.source_address} ${s.source_price ? `($${s.source_price.toLocaleString()})` : ''}`)
        .join('; ')
      return [
        g.target_address, g.target_owner_name || '',
        sourcesText, g.sources.length,
        g.hot_vendor_score || '', g.status, g.sent_date, g.notes || '',
      ]
    })
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pipeline_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  // Stats
  const sent = groups.filter(g => g.status === 'sent').length
  const responded = groups.filter(g => g.status === 'responded').length
  const appraisals = groups.filter(g => g.status === 'appraisal_booked').length
  const listed = groups.filter(g => g.status === 'listing_signed').length
  const respRate = groups.length ? Math.round((responded / groups.length) * 100) : 0

  return (
    <div style={{ padding: '24px', maxWidth: '1280px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>
        Appraisal Pipeline
      </h1>

      {/* Generator */}
      <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '20px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={suburb}
            onChange={e => setSuburb(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px' }}>
            {SUBURBS.map(s => <option key={s}>{s}</option>)}
          </select>

          <div style={{ display: 'flex', gap: '6px' }}>
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => setDays(d)}
                style={{
                  padding: '8px 14px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
                  background: days === d ? '#1d4ed8' : 'white',
                  color: days === d ? 'white' : '#374151',
                  border: `1px solid ${days === d ? '#1d4ed8' : '#d1d5db'}`,
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
              background: generating ? '#93c5fd' : '#1d4ed8', color: 'white', border: 'none', fontWeight: '600',
            }}>
            {generating ? 'Generating...' : 'Generate Letters'}
          </button>

          <button
            onClick={() => setShowManualForm(s => !s)}
            style={{
              padding: '8px 16px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
              background: showManualForm ? '#374151' : 'white',
              color: showManualForm ? 'white' : '#374151',
              border: '1px solid #d1d5db',
            }}>
            {showManualForm ? '× Cancel' : '+ Add Manual Sale'}
          </button>
        </div>

        {generateMsg && (
          <div style={{
            marginTop: '12px', padding: '10px 14px', borderRadius: '6px', fontSize: '14px',
            background: generateMsg.type === 'success' ? '#d1fae5' : '#fee2e2',
            color: generateMsg.type === 'success' ? '#065f46' : '#991b1b',
          }}>
            {generateMsg.text}
          </div>
        )}
      </div>

      {/* Manual add form — fallback for sales the scraper hasn't dated correctly */}
      {showManualForm && (
        <ManualAddForm
          defaultSuburb={suburb}
          onSuccess={(msg) => {
            setGenerateMsg({ type: 'success', text: msg })
            setShowManualForm(false)
            loadTracking()
          }}
          onError={(msg) => setGenerateMsg({ type: 'error', text: msg })}
        />
      )}

      {/* Filter */}
      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px' }}>
          <span style={{ fontSize: '13px', color: '#6b7280' }}>Filter by suburb:</span>
          <select
            value={filterSuburb}
            onChange={e => setFilterSuburb(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}>
            <option value="">All suburbs</option>
            {SUBURBS.map(s => <option key={s}>{s}</option>)}
          </select>
          <span style={{ fontSize: '13px', color: '#6b7280', marginLeft: 'auto' }}>
            {groups.length} envelope{groups.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Actions */}
      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
          <button
            onClick={() => window.open('/pipeline/print', '_blank')}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '14px' }}>
            🖨 Print All Letters
          </button>
          <button
            onClick={handleExportCSV}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '14px' }}>
            ⬇ Export CSV
          </button>
        </div>
      )}

      {/* Stats */}
      {groups.length > 0 && (
        <div style={{
          display: 'flex', gap: '24px', marginBottom: '20px',
          padding: '14px 20px', background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px',
          fontSize: '14px', color: '#374151',
        }}>
          <span><strong>{sent}</strong> sent</span>
          <span><strong>{responded}</strong> responded ({respRate}%)</span>
          <span><strong>{appraisals}</strong> appraisals booked</span>
          <span><strong>{listed}</strong> listings signed</span>
        </div>
      )}

      {/* Table — one row per target neighbour, sources collapsed inline */}
      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading...</p>
      ) : groups.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No entries yet. Generate letters to get started.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Target Address', 'Owner Name', 'Source Sale(s)', 'Score', 'Status', 'Sent', 'Notes', 'Letter', 'Action'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '600', color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <tr key={g.representative_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <strong>{g.target_address}</strong>
                    {g.source_suburb && (
                      <div style={{ fontSize: '11px', color: '#9ca3af' }}>{g.source_suburb}</div>
                    )}
                  </td>

                  {/* Owner Name — propagates to all rows for the same target */}
                  <td style={{ padding: '10px 12px' }}>
                    {editingName === g.representative_id ? (
                      <input
                        autoFocus
                        defaultValue={g.target_owner_name || ''}
                        onBlur={ev => {
                          patchEntry(g.representative_id, { target_owner_name: ev.target.value })
                          setEditingName(null)
                        }}
                        onKeyDown={ev => { if (ev.key === 'Enter') ev.target.blur() }}
                        style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px', width: '140px' }}
                      />
                    ) : (
                      <span
                        onClick={() => setEditingName(g.representative_id)}
                        style={{ cursor: 'pointer', color: g.target_owner_name ? '#111827' : '#9ca3af', borderBottom: '1px dashed #d1d5db' }}>
                        {g.target_owner_name || '+ add name'}
                      </span>
                    )}
                  </td>

                  {/* Source sales — listed inline */}
                  <td style={{ padding: '10px 12px', color: '#374151', maxWidth: '320px' }}>
                    {g.sources.map((s, i) => (
                      <div key={s.row_id || i} style={{ fontSize: '12px', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span>{s.source_address}</span>
                        <span style={{ color: '#9ca3af', marginLeft: '6px' }}>
                          {formatPrice(s.source_price)}
                        </span>
                      </div>
                    ))}
                    {g.sources.length > 1 && (
                      <div style={{ fontSize: '11px', color: '#059669', fontWeight: '600', marginTop: '2px' }}>
                        {g.sources.length} nearby sales
                      </div>
                    )}
                  </td>

                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                    {g.hot_vendor_score || '—'}
                  </td>

                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: '500',
                      background: STATUS_LABELS[g.status]?.color + '20',
                      color: STATUS_LABELS[g.status]?.color,
                    }}>
                      {STATUS_LABELS[g.status]?.label || g.status}
                    </span>
                  </td>

                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#6b7280' }}>
                    {formatDate(g.sent_date)}
                  </td>

                  {/* Notes */}
                  <td style={{ padding: '10px 12px', maxWidth: '180px' }}>
                    {editingNote === g.representative_id ? (
                      <input
                        autoFocus
                        defaultValue={g.notes || ''}
                        onBlur={ev => {
                          patchEntry(g.representative_id, { notes: ev.target.value })
                          setEditingNote(null)
                        }}
                        onKeyDown={ev => { if (ev.key === 'Enter') ev.target.blur() }}
                        style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px', width: '160px' }}
                      />
                    ) : (
                      <span
                        onClick={() => setEditingNote(g.representative_id)}
                        style={{ cursor: 'pointer', color: g.notes ? '#111827' : '#9ca3af', borderBottom: '1px dashed #d1d5db' }}>
                        {g.notes || '+ add note'}
                      </span>
                    )}
                  </td>

                  {/* Letter download */}
                  <td style={{ padding: '10px 12px' }}>
                    <button
                      onClick={() => downloadLetter(g.representative_id)}
                      title="Download a Word doc with all nearby sales mentioned"
                      style={{
                        padding: '4px 10px', borderRadius: '4px', border: '1px solid #d1d5db',
                        background: 'white', cursor: 'pointer', fontSize: '12px',
                      }}>
                      📄 Word
                    </button>
                  </td>

                  {/* Action */}
                  <td style={{ padding: '10px 12px' }}>
                    <select
                      value=""
                      onChange={ev => {
                        if (!ev.target.value) return
                        setActionModal({ id: g.representative_id, status: ev.target.value })
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
              response_date: date || undefined,
            })
            setActionModal(null)
          }}
          onClose={() => setActionModal(null)}
        />
      )}
    </div>
  )
}

function ManualAddForm({ defaultSuburb, onSuccess, onError }) {
  const [sourceAddress, setSourceAddress] = useState('')
  const [sourceSuburb, setSourceSuburb] = useState(defaultSuburb || 'Cottesloe')
  const [sourcePrice, setSourcePrice] = useState('')
  const [soldDate, setSoldDate] = useState(new Date().toISOString().slice(0, 10))
  const [explicitTargets, setExplicitTargets] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!sourceAddress.trim()) {
      onError && onError('Source address required')
      return
    }
    setSubmitting(true)
    try {
      const body = {
        source_address: sourceAddress.trim(),
        source_suburb: sourceSuburb.trim(),
        source_sold_date: soldDate || undefined,
        source_price: sourcePrice ? parseInt(sourcePrice.replace(/[^\d]/g, '')) : undefined,
      }
      const targets = explicitTargets
        .split(/[\n,;]/)
        .map(t => t.trim())
        .filter(Boolean)
      if (targets.length > 0) body.target_addresses = targets

      const res = await fetch(`${API}/api/pipeline/manual-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.error) {
        onError && onError(data.error)
      } else {
        onSuccess && onSuccess(`Added ${data.generated} entries from ${sourceAddress}`)
        setSourceAddress('')
        setSourcePrice('')
        setExplicitTargets('')
      }
    } catch (e) {
      onError && onError('Failed to connect to backend')
    }
    setSubmitting(false)
  }

  return (
    <form
      onSubmit={submit}
      style={{
        background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px',
        padding: '16px 20px', marginBottom: '16px',
      }}>
      <div style={{ marginBottom: '10px', fontSize: '13px', color: '#78350f' }}>
        Add a sale the scraper missed (off-market, broker network, missing date in REIWA, etc).
        Auto-generates ±1 / ±2 neighbours unless you specify explicit targets.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <input
          required
          placeholder="Source address (e.g. 28 Lillian Street)"
          value={sourceAddress}
          onChange={e => setSourceAddress(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
        <input
          required
          placeholder="Suburb"
          value={sourceSuburb}
          onChange={e => setSourceSuburb(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
        <input
          placeholder="Price (optional)"
          value={sourcePrice}
          onChange={e => setSourcePrice(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
        <input
          type="date"
          value={soldDate}
          onChange={e => setSoldDate(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}
        />
      </div>
      <div style={{ marginBottom: '10px' }}>
        <input
          placeholder="Optional: explicit target addresses, comma-separated (else auto ±1/±2)"
          value={explicitTargets}
          onChange={e => setExplicitTargets(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px', boxSizing: 'border-box' }}
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        style={{
          padding: '8px 18px', borderRadius: '6px', border: 'none',
          background: submitting ? '#fcd34d' : '#d97706', color: 'white',
          cursor: 'pointer', fontWeight: '600',
        }}>
        {submitting ? 'Adding...' : 'Add Sale'}
      </button>
    </form>
  )
}

function ActionModal({ status, onConfirm, onClose }) {
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState('')
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
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

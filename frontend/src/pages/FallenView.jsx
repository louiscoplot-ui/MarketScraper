// LOOP-3 — dedicated "Sales fallen through" page. Replaces the cramped
// sidebar dropdown: an under-offer listing that returned to active means
// finance/inspection fell through and the vendor's confidence in their
// agent is shaken — a ~2-week action window. Full-width so the agent can
// scan address / suburb / original price / date at a glance.
// Dates render DD/MM/YYYY (AU) via formatIsoDate — never raw ISO.
import { useState, useEffect, useCallback } from 'react'
import { formatIsoDate } from '../hooks/useListings'

export default function FallenView({ bootApi }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  const fetchItems = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`${bootApi}/signals/sale-fallen`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setItems(Array.isArray(d) ? d : [])
    } catch (e) {
      setError(e.message || 'Could not load fallen sales')
      setItems([])
    }
  }, [bootApi])

  useEffect(() => { fetchItems() }, [fetchItems])

  return (
    <div style={{ padding: '16px 24px', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Sales Fallen Through</h2>
        <button onClick={fetchItems} style={{ padding: '4px 10px' }}>Refresh</button>
      </div>
      <div style={{ color: '#7f8c8d', marginBottom: 16, fontSize: 14 }}>
        Under-offer listings that returned to active in the last 14 days —
        motivated vendors whose sale just collapsed. Best approached now.
      </div>

      {items === null ? (
        <div style={{ color: '#7f8c8d', padding: 24 }}>Loading…</div>
      ) : error ? (
        <div style={{ color: '#c0392b', padding: 24 }}>{error}</div>
      ) : items.length === 0 ? (
        <div style={{ color: '#7f8c8d', padding: 24 }}>
          No live fallen sales in your suburbs right now.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #dfe4e8' }}>
              <th style={{ padding: '6px 8px' }}>Address</th>
              <th style={{ padding: '6px 8px', width: 150 }}>Suburb</th>
              <th style={{ padding: '6px 8px', width: 170 }}>Was listed at</th>
              <th style={{ padding: '6px 8px', width: 150 }}>Back on market</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} style={{ borderBottom: '1px solid #eef1f3' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>
                  {it.reiwa_url ? (
                    <a href={it.reiwa_url} target="_blank" rel="noreferrer"
                       style={{ color: '#7c2d12' }}>
                      {it.address}
                    </a>
                  ) : it.address}
                </td>
                <td style={{ padding: '8px' }}>{it.suburb || ''}</td>
                <td style={{ padding: '8px' }}>{it.original_price || '—'}</td>
                <td style={{ padding: '8px' }}>{formatIsoDate(it.detected_at) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

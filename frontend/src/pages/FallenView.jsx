// LOOP-3 — dedicated "Sales fallen through" page. Replaces the cramped
// sidebar dropdown: an under-offer listing that returned to active means
// finance/inspection fell through and the vendor's confidence in their
// agent is shaken — a ~2-week action window. Full-width so the agent can
// scan address / suburb / original price / date at a glance.
// Dates render DD/MM/YYYY (AU) via formatIsoDate — never raw ISO.
import { useState, useEffect, useCallback } from 'react'
import { formatIsoDate } from '../hooks/useListings'
import { Button, Spinner } from '../components/ui'

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
        <h2 style={{ margin: 0, color: 'var(--text)' }}>Sales Fallen Through</h2>
        <Button variant="ghost" size="sm" onClick={fetchItems}>Refresh</Button>
      </div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: 14 }}>
        Under-offer listings that returned to active in the last 14 days —
        motivated vendors whose sale just collapsed. Best approached now.
      </div>

      {items === null ? (
        <div style={{ color: 'var(--text-muted)', padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spinner size={16} muted inline /> Loading…
        </div>
      ) : error ? (
        <div style={{ color: 'var(--status-alert-text)', padding: 24 }}>{error}</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>
          No live fallen sales in your suburbs right now.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Address</th>
              <th style={{ padding: '6px 8px', width: 150, color: 'var(--text-muted)' }}>Suburb</th>
              <th style={{ padding: '6px 8px', width: 170, color: 'var(--text-muted)' }}>Was listed at</th>
              <th style={{ padding: '6px 8px', width: 150, color: 'var(--text-muted)' }}>Back on market</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>
                  {it.reiwa_url ? (
                    <a href={it.reiwa_url} target="_blank" rel="noreferrer"
                       style={{ color: 'var(--accent)' }}>
                      {it.address}
                    </a>
                  ) : it.address}
                </td>
                <td style={{ padding: '8px', color: 'var(--text)' }}>{it.suburb || ''}</td>
                <td style={{ padding: '8px', color: 'var(--text)' }}>{it.original_price || '—'}</td>
                <td style={{ padding: '8px', color: 'var(--text)' }}>{formatIsoDate(it.detected_at) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

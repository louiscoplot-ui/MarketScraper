// LOOP-3 — dedicated "Sales fallen through" page. Replaces the cramped
// sidebar dropdown: an under-offer listing that returned to active means
// finance/inspection fell through and the vendor's confidence in their
// agent is shaken — a ~2-week action window. Full-width so the agent can
// scan address / suburb / original price / date at a glance.
// Dates render DD/MM/YYYY (AU) via formatIsoDate — never raw ISO.
import { useState, useEffect, useCallback } from 'react'
import { formatIsoDate } from '../hooks/useListings'
import { Button, Spinner } from '../components/ui'
import { getDeskMode } from '../lib/deskFlag'
import DeskMap from '../components/DeskMap'

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

  // ── Desk redesign — full render of mock #fallen (amber hero + table + map). ──
  if (getDeskMode() === 'desk') {
    const list = Array.isArray(items) ? items : []
    const GRID = '1.7fr 150px 150px 150px'
    return (
      <div style={{ padding: '24px 30px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Sales Fallen Through</h2>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>Under-offer listings back on market · last 14 days</div>
          </div>
          <Button variant="ghost" size="sm" onClick={fetchItems}>Refresh</Button>
        </div>

        {list.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'var(--status-watch-bg)', border: '1px solid #F5C88A', borderRadius: 16, padding: '16px 22px' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 34, lineHeight: 1, color: '#7c2d12' }}>{list.length}</span>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#92400E' }}>Motivated vendors · 14 days</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: '#92400E', fontWeight: 500 }}>sale{list.length !== 1 ? 's' : ''} fallen through — best approached now</div>
            </div>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
          <div style={{ width: '64%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-card)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              <span>Address</span><span>Suburb</span><span>Was listed at</span><span>Back on market</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {items === null ? <div style={{ padding: 24, color: 'var(--text-muted)', display: 'flex', gap: 10, alignItems: 'center' }}><Spinner size={16} muted inline /> Loading…</div>
                : error ? <div style={{ padding: 24, color: 'var(--status-alert-text)' }}>{error}</div>
                : list.length === 0 ? <div style={{ padding: 24, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>No live fallen sales right now.</div>
                : list.map(it => (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid var(--border)', borderLeft: '3px solid var(--status-watch)' }}>
                    <a href={it.reiwa_url || '#'} target={it.reiwa_url ? '_blank' : undefined} rel="noreferrer" onClick={it.reiwa_url ? undefined : (e) => e.preventDefault()}
                      style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.address}</a>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-muted)' }}>{it.suburb || ''}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)' }}>{it.original_price || '—'}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{formatIsoDate(it.detected_at) || '—'}</span>
                  </div>
                ))}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <DeskMap
              items={list}
              label={`Doorknock run · ${list.length}`}
              addressOf={(it) => it.address}
              suburbOf={(it) => it.suburb}
              colorOf={() => '#D97706'}
            />
          </div>
        </div>
      </div>
    )
  }

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

      {/* Desk-mode amber hero (mock 10). Hidden in classic via CSS. */}
      {Array.isArray(items) && items.length > 0 && (
        <div className="fallen-hero">
          <span className="fallen-hero-n">{items.length}</span>
          <div>
            <div className="fallen-hero-l">Motivated vendors · 14 days</div>
            <div className="fallen-hero-sub">
              sale{items.length !== 1 ? 's' : ''} fallen through — best approached now
            </div>
          </div>
        </div>
      )}

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

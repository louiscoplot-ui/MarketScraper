// Weekly motivated-vendor hit-list — the in-app version of the "orphan
// vendors" report. Scoped server-side to the signed-in user's suburbs
// (/api/report/orphans): withdrawn listings (expired mandates) + long-campaign
// actives (DOM >= 90), sorted hottest-first. Clicking a row opens the rich
// dossier; withdrawn rows expose the withdrawn-specific letter. Export to CSV.
// The Monday email (once Resend is verified) reuses the same backend function.
import { useState, useEffect } from 'react'
import { ExternalLink, FileText, Download } from 'lucide-react'
import { BACKEND_DIRECT } from '../lib/api'

const CATS = [
  { key: 'all', label: 'All' },
  { key: 'expired_mandate', label: 'Expired mandate' },
  { key: 'withdrawn', label: 'Withdrawn' },
  { key: 'stale', label: 'Stale 90+' },
]

// Category → status-grammar accent.
const CAT_ACCENT = {
  expired_mandate: 'var(--status-alert)',
  withdrawn_recent: 'var(--status-alert)',
  withdrawn: 'var(--status-watch)',
  stale: 'var(--status-watch)',
}
const inBucket = (cat, bucket) =>
  bucket === 'all' ? true
    : bucket === 'withdrawn' ? (cat === 'withdrawn' || cat === 'withdrawn_recent')
      : cat === bucket

const key = () => { try { return localStorage.getItem('agentdeck_access_key') || '' } catch { return '' } }

export default function HitList({ openDossier, formatIsoDate }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bucket, setBucket] = useState('all')
  const [sub, setSub] = useState('')          // '' = all suburbs
  const [downloading, setDownloading] = useState(null)

  const load = (attempt = 0) => {
    setError('')
    if (!data) setLoading(true)
    fetch(`${BACKEND_DIRECT}/api/report/orphans`, { headers: { 'X-Access-Key': key() } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { setData(d); setLoading(false) })
      .catch(() => {
        // Cold Render dyno drops the first request — retry once before erroring.
        if (attempt < 1) { setTimeout(() => load(attempt + 1), 1500); return }
        setError('Couldn’t load the hit-list — the server may be waking up.')
        setLoading(false)
      })
  }
  useEffect(() => { load() }, [])

  // Suburbs present in the data (for the picker), then filter by the chosen
  // suburb. Chip counts follow the suburb filter so they always match the list.
  const allItems = data?.items || []
  const subOptions = [...new Set(allItems.map(i => i.suburb).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const scoped = allItems.filter(i => !sub || i.suburb === sub)
  const counts = {
    total: scoped.length,
    expired_mandate: scoped.filter(i => i.category === 'expired_mandate').length,
    withdrawn: scoped.filter(i => i.category === 'withdrawn' || i.category === 'withdrawn_recent').length,
    stale: scoped.filter(i => i.category === 'stale').length,
  }
  const items = scoped.filter(i => inBucket(i.category, bucket))
  const fmtD = (d) => (formatIsoDate ? (formatIsoDate(d) || d) : d)

  const downloadLetter = async (it) => {
    setDownloading(it.id)
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/signals/withdrawn-orphans/letter/${it.id}`, {
        headers: { 'X-Access-Key': key() },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const safe = String(it.address || 'letter').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60)
      a.href = url; a.download = `withdrawn_${safe || it.id}.docx`; a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Letter not available for this listing (it may no longer be an eligible withdrawn orphan).')
    } finally {
      setDownloading(null)
    }
  }

  const exportCsv = () => {
    const rows = [['Address', 'Suburb', 'Status', 'Category', 'Reason', 'DOM', 'Withdrawn', 'Price', 'Agent', 'Agency', 'REIWA']]
    for (const i of items) {
      rows.push([
        i.address || '', i.suburb || '', i.status || '', i.category || '', i.reason || '',
        i.dom ?? '', i.withdrawn_date ? fmtD(i.withdrawn_date) : '', i.price_text || '',
        i.agent || '', i.agency || '', i.reiwa_url || '',
      ])
    }
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
    const csv = rows.map(r => r.map(esc).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = `hitlist_${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-card)' }

  return (
    <div style={{ padding: '24px 30px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 30, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>Hit-list</h2>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
            Motivated vendors in your suburbs — withdrawn mandates &amp; long campaigns. {counts.total} lead{counts.total !== 1 ? 's' : ''}.
          </div>
        </div>
        <button onClick={exportCsv} disabled={!items.length}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 13px', cursor: items.length ? 'pointer' : 'not-allowed', opacity: items.length ? 1 : 0.5 }}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* suburb picker + filter chips with counts */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {subOptions.length > 1 && (
          <select value={sub} onChange={e => setSub(e.target.value)}
            style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, padding: '6px 12px', cursor: 'pointer' }}>
            <option value="">All suburbs</option>
            {subOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {CATS.map(c => {
          const n = c.key === 'all' ? counts.total : (counts[c.key] || 0)
          const on = bucket === c.key
          return (
            <button key={c.key} onClick={() => setBucket(c.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent)' : 'var(--text-muted)' }}>
              {c.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: on ? 'var(--accent)' : 'var(--text-faint)' }}>{n}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', padding: 24, fontSize: 13 }}>Loading your hit-list… first load can take a few seconds while the server wakes up.</div>
      ) : error ? (
        <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--status-alert-text)' }}>{error}</span>
          <button onClick={() => load()} style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' }}>Try again</button>
        </div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24, fontSize: 13 }}>No motivated-vendor leads in this bucket right now. New withdrawn/stale listings surface here after the nightly scrape.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {items.map((it, i) => (
              <div key={it.id || i}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderTop: i ? '1px solid var(--border)' : 'none', borderLeft: `3px solid ${CAT_ACCENT[it.category] || 'var(--status-off)'}` }}>
                <div style={{ minWidth: 0, flex: 1, cursor: openDossier ? 'pointer' : 'default' }}
                  onClick={() => openDossier && openDossier({
                    address: it.address, suburb: it.suburb, suburb_name: it.suburb,
                    status: it.status, agent: it.agent, agency: it.agency, reiwa_url: it.reiwa_url,
                    price_text: it.price_text, withdrawn_date: it.withdrawn_date,
                    bedrooms: it.bedrooms, bathrooms: it.bathrooms, land_size: it.land_size, internal_size: it.internal_size,
                  })}>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.address}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>
                    {it.suburb}{it.agency ? ` · ${it.agency}` : ''}
                  </div>
                </div>
                <div style={{ minWidth: 0, flex: 1.3, fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.reason}>
                  {it.reason}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', minWidth: 90, textAlign: 'right' }}>
                  {it.price_text && /\$|\d{4,}/.test(it.price_text) ? it.price_text : '—'}
                </span>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, minWidth: 132, justifyContent: 'flex-end' }}>
                  {(it.category === 'expired_mandate' || it.category === 'withdrawn' || it.category === 'withdrawn_recent') && (
                    <button onClick={() => downloadLetter(it)} disabled={downloading === it.id}
                      title="Download the withdrawn-vendor letter"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 9px', cursor: 'pointer' }}>
                      <FileText size={12} /> {downloading === it.id ? '…' : 'Letter'}
                    </button>
                  )}
                  {it.reiwa_url && (
                    <a href={it.reiwa_url} target="_blank" rel="noopener" title="Open on REIWA"
                      style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 8px' }}>
                      <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

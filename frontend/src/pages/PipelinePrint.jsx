import { useState, useEffect } from 'react'
import { BACKEND_DIRECT } from '../lib/api'

// Hit Render directly — Vercel's 25s edge timeout would 504 on a cold
// start, and a print page is the worst time to hit a blank screen.
const API = BACKEND_DIRECT

function formatDate() {
  return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatPrice(p) {
  return p ? `$${Number(p).toLocaleString()}` : ''
}

export default function PipelinePrint() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [profile, setProfile] = useState(null)

  const load = () => {
    setLoading(true)
    setError('')
    // Check r.ok: a Render cold start returns a 502 HTML page, and
    // r.json() on that throws → the old code showed "No letters found",
    // making the agent think their pipeline was empty at print time.
    fetch(`${API}/api/pipeline/tracking?status=sent&limit=200`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { setEntries(d.entries || []); setLoading(false) })
      .catch(() => { setError('Could not load letters — the server may be waking up.'); setLoading(false) })
    fetch(`${API}/api/auth/me`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setProfile(d) })
      .catch(() => {})
  }
  useEffect(() => { load() }, [])

  if (loading) return <p style={{ padding: 40 }}>Loading letters...</p>
  if (error) return (
    <div style={{ padding: 40, fontFamily: 'system-ui, -apple-system, Arial, sans-serif' }}>
      <p style={{ color: '#444' }}>{error}</p>
      <button onClick={load} style={{ padding: '8px 18px', borderRadius: 6, border: '1px solid #ccc', cursor: 'pointer' }}>Retry</button>
    </div>
  )
  if (!entries.length) return <p style={{ padding: 40 }}>No letters with status "sent" found.</p>

  // These letters are posted to real homeowners. Never print placeholder
  // contact details ("0400 XXX XXX" / a shared gmail) — block printing
  // until the agent profile has a name, phone and email.
  const missing = [
    !profile?.agency_name && 'agency name',
    !profile?.agent_name && 'name',
    !profile?.agent_phone && 'phone',
    !profile?.agent_email && 'email',
  ].filter(Boolean)
  if (missing.length) {
    return (
      <div style={{ padding: 40, maxWidth: 560, fontFamily: 'system-ui, -apple-system, Arial, sans-serif' }}>
        <h2 style={{ marginTop: 0 }}>Complete your agent profile first</h2>
        <p style={{ color: '#444', lineHeight: 1.6 }}>
          These letters go to real homeowners, so SuburbDesk won't print
          them with placeholder contact details. Add your{' '}
          <strong>{missing.join(', ')}</strong> in Settings → Agent profile,
          then reopen this print view.
        </p>
      </div>
    )
  }

  // No hardcoded agency identity — these letters go to real homeowners
  // and this is a multi-tenant SaaS. Everything comes from the agent's
  // own profile (printing is blocked above until agency_name is set).
  const agencyHeader = profile.agency_name
  const agentName = profile.agent_name
  const agentRole = `Sales Agent | ${profile.agency_name}`
  const agentPhone = profile.agent_phone
  const agentEmail = profile.agent_email
  const agencyWebsite = profile.agency_website || ''

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { margin: 0; }
        }
        .letter {
          page-break-after: always;
          padding: 60px 70px;
          min-height: 100vh;
          box-sizing: border-box;
          font-family: Georgia, serif;
          font-size: 15px;
          line-height: 1.7;
          color: #111;
        }
        .letter:last-child { page-break-after: auto; }
      `}</style>

      <div className="no-print" style={{
        padding: '16px 24px', background: '#1d4ed8', display: 'flex',
        gap: '12px', alignItems: 'center'
      }}>
        <span style={{ color: 'white', fontWeight: '600', fontSize: '14px' }}>
          {entries.length} letters ready to print
        </span>
        <button
          onClick={() => window.print()}
          style={{ padding: '8px 20px', borderRadius: '6px', background: 'white', border: 'none', cursor: 'pointer', fontWeight: '600', fontSize: '14px' }}>
          🖨 Print Now
        </button>
      </div>

      {entries.map(e => (
        <div key={e.id} className="letter">
          <div style={{ marginBottom: '40px' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', letterSpacing: '2px', fontFamily: 'Arial, sans-serif' }}>
              {agencyHeader}
            </div>
          </div>

          <div style={{ marginBottom: '32px', fontFamily: 'Arial, sans-serif', fontSize: '14px' }}>
            {formatDate()}
          </div>

          <div style={{ marginBottom: '28px' }}>
            Dear {e.target_owner_name || 'Homeowner'},
          </div>

          <p>
            I hope this letter finds you well.
          </p>

          <p>
            I wanted to reach out personally — your neighbour at <strong>{e.source_address}</strong> recently
            sold for <strong>{formatPrice(e.source_price)}</strong>, one of {e.source_suburb}'s strongest
            results this season.
          </p>

          <p>
            With buyer demand remaining high across {e.source_suburb}, this could be the ideal moment
            to understand what your property at <strong>{e.target_address}</strong> is truly worth
            in today's market.
          </p>

          <p>
            I would love to offer you a complimentary, no-obligation market appraisal at a time
            that suits you — no pressure, just clarity.
          </p>

          <p>Please don't hesitate to reach out.</p>

          <div style={{ marginTop: '48px' }}>
            <div style={{ marginBottom: '4px' }}>Warm regards,</div>
            <div style={{ marginTop: '24px', fontWeight: '700', fontSize: '16px' }}>{agentName}</div>
            <div style={{ color: '#444', fontSize: '14px' }}>{agentRole}</div>
            <div style={{ color: '#444', fontSize: '14px', marginTop: '8px' }}>
              M: {agentPhone}<br/>
              E: {agentEmail}{agencyWebsite ? <><br/>W: {agencyWebsite}</> : null}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

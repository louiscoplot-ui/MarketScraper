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
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    fetch(`${API}/api/pipeline/tracking?status=sent&limit=200`)
      .then(r => r.json())
      .then(d => { setEntries(d.entries || []); setLoading(false) })
      .catch(() => setLoading(false))
    fetch(`${API}/api/auth/me`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setProfile(d) })
      .catch(() => {})
  }, [])

  if (loading) return <p style={{ padding: 40 }}>Loading letters...</p>
  if (!entries.length) return <p style={{ padding: 40 }}>No letters with status "sent" found.</p>

  // Fallbacks preserve the original hardcoded values when the user
  // hasn't filled their agent profile yet.
  const agencyHeader = profile?.agency_name || 'BELLE PROPERTY  |  Cottesloe'
  const agentName = profile?.agent_name || 'Louis Coplot'
  const agentRole = `Sales Agent | ${profile?.agency_name || 'Belle Property Cottesloe'}`
  const agentPhone = profile?.agent_phone || '0400 XXX XXX'
  const agentEmail = profile?.agent_email || 'louis@belleproperty.com.au'

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
            <div style={{ fontSize: '13px', color: '#666', fontFamily: 'Arial, sans-serif', marginTop: '4px' }}>
              160 Stirling Highway, Nedlands WA 6009
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
              E: {agentEmail}<br/>
              W: belleproperty.com.au/cottesloe
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

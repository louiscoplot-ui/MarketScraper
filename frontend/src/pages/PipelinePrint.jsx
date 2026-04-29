import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL || 'https://marketscraper-backend.onrender.com'

function formatDate() {
  return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatPrice(p) {
  return p ? `$${Number(p).toLocaleString()}` : ''
}

export default function PipelinePrint() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API}/api/pipeline/tracking?status=sent&limit=200`)
      .then(r => r.json())
      .then(d => { setEntries(d.entries || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <p style={{ padding: 40 }}>Loading letters...</p>
  if (!entries.length) return <p style={{ padding: 40 }}>No letters with status "sent" found.</p>

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
              BELLE PROPERTY  |  Cottesloe
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
            <div style={{ marginTop: '24px', fontWeight: '700', fontSize: '16px' }}>Louis Coplot</div>
            <div style={{ color: '#444', fontSize: '14px' }}>Sales Agent | Belle Property Cottesloe</div>
            <div style={{ color: '#444', fontSize: '14px', marginTop: '8px' }}>
              M: 0400 XXX XXX<br/>
              E: louis@belleproperty.com.au<br/>
              W: belleproperty.com.au/cottesloe
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

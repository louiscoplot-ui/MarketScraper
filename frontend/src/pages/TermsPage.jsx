import { useEffect, useState } from 'react'
import { BACKEND_DIRECT, fetchWithRetry } from '../lib/api'
import Footer from '../components/Footer'

// Standalone legal page — reachable with or without auth via #terms.
// Pulls the canonical copy from /api/legal/terms so the legal text is
// source-controlled on the backend (one place to update).
export default function TermsPage() {
  const [body, setBody] = useState('')
  const [err, setErr] = useState(false)

  useEffect(() => {
    fetchWithRetry(`${BACKEND_DIRECT}/api/legal/terms`, {}, 3)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.content) setBody(d.content); else setErr(true) })
      .catch(() => setErr(true))
  }, [])

  const goBack = () => {
    window.location.hash = ''
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }

  return (
    <div style={s.page}>
      <div style={s.shell}>
        <button onClick={goBack} style={s.back}>← Back</button>
        <h1 style={s.h1}>Terms of Service</h1>
        {err && <p style={s.err}>Could not load terms. Please try again later.</p>}
        {!err && <pre style={s.body}>{body || 'Loading…'}</pre>}
      </div>
      <Footer />
    </div>
  )
}

const s = {
  page: {
    minHeight: '100vh', background: '#fff',
    fontFamily: 'system-ui, -apple-system, Arial, sans-serif',
    display: 'flex', flexDirection: 'column',
  },
  shell: { maxWidth: 800, margin: '0 auto', padding: '32px 24px', flex: 1, width: '100%', boxSizing: 'border-box' },
  back: {
    background: 'none', border: 'none', color: 'var(--accent)',
    fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 16,
  },
  h1: { fontSize: 24, color: '#111827', margin: '0 0 24px' },
  body: {
    whiteSpace: 'pre-wrap', fontFamily: 'inherit',
    fontSize: 14, lineHeight: 1.6, color: '#374151', margin: 0,
  },
  err: { color: '#b91c1c', fontSize: 14 },
}

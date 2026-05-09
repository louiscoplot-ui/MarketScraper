import { useState } from 'react'
import { setAccessKey } from '../lib/api'

// Magic-link login. The user types their email; we POST to
// /api/auth/request-link which silently 200s (no email enumeration)
// and emails a one-click link if the address matches a user.
//
// Escape hatch for the bootstrap admin (or anyone whose Resend is
// misbehaving): a "Have an access key?" toggle that lets you paste
// the 32-char key directly. The key is validated against /api/auth/me
// before we redirect into the app.
export default function Login() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState('')
  const [directError, setDirectError] = useState('')

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    try {
      await fetch('/api/auth/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
    } catch {}
    setSubmitted(true)
    setBusy(false)
  }

  const onSubmitDirect = async () => {
    if (!email.trim() || busy) return
    setBusy(true)
    setDirectError('')
    try {
      const res = await fetch('/api/auth/login-by-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (res.status === 404) {
        setDirectError('Email not found — use the magic link below')
        setBusy(false)
        return
      }
      if (!res.ok) {
        setDirectError('Server error. Please try again.')
        setBusy(false)
        return
      }
      const data = await res.json()
      setAccessKey(data.access_key)
      window.location.reload()
    } catch {
      setDirectError('Could not reach the server. Try again in a moment.')
      setBusy(false)
    }
  }

  const onSubmitKey = async (e) => {
    e.preventDefault()
    const k = keyInput.trim()
    if (!k || busy) return
    setBusy(true)
    setKeyError('')
    try {
      const res = await fetch('/api/auth/me', { headers: { 'X-Access-Key': k } })
      if (!res.ok) {
        setKeyError('Key not recognised. Double-check it or request a magic link instead.')
        setBusy(false)
        return
      }
      setAccessKey(k)
      window.location.replace('/')
    } catch {
      setKeyError('Could not reach the server. Try again in a moment.')
      setBusy(false)
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.brandBand}>
          <h1 style={styles.brandTitle}>SUBURBDESK</h1>
          <div style={styles.brandSub}>Real-estate prospecting</div>
        </div>
        <div style={styles.body}>
          {submitted ? (
            <>
              <h2 style={styles.h2}>Check your inbox</h2>
              <p style={styles.p}>
                If <strong>{email}</strong> matches a SuburbDesk account,
                you'll receive a login link in the next minute. Click it
                from any device — you stay signed in forever on that browser.
              </p>
              <button
                style={styles.linkBtn}
                onClick={() => { setSubmitted(false); setEmail('') }}
              >
                Use a different email
              </button>
            </>
          ) : (
            <>
              <h2 style={styles.h2}>Sign in</h2>
              <p style={styles.p}>
                Enter the email your administrator used to invite you.
                We'll send you a one-click login link.
              </p>
              <form onSubmit={onSubmit}>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="you@agency.com.au"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={styles.input}
                />
                <button type="submit" disabled={busy} style={styles.btn}>
                  {busy ? 'Sending…' : 'Send login link'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onSubmitDirect}
                  style={{ ...styles.btnSecondary, marginTop: 10 }}
                >
                  Sign in with my email
                </button>
                {directError && <div style={{ ...styles.err, marginTop: 10 }}>{directError}</div>}
              </form>
              <p style={styles.fineprint}>
                No public sign-up. Access is granted by your administrator.
              </p>
              <div style={styles.keyToggleWrap}>
                <button
                  type="button"
                  style={styles.linkBtn}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? 'Hide access key field' : 'Have an access key?'}
                </button>
                {showKey && (
                  <form onSubmit={onSubmitKey} style={{ marginTop: 12 }}>
                    <input
                      type="text"
                      placeholder="Paste your 32-character key"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                    />
                    {keyError && <div style={styles.err}>{keyError}</div>}
                    <button type="submit" disabled={busy} style={styles.btnSecondary}>
                      Sign in with key
                    </button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5f5',
    padding: '24px',
    fontFamily: 'system-ui, -apple-system, Arial, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    background: '#fff',
    borderRadius: 10,
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    overflow: 'hidden',
  },
  brandBand: {
    background: '#386351',
    padding: '28px 32px',
    color: '#fff',
  },
  brandTitle: {
    margin: 0,
    fontSize: 26,
    letterSpacing: 3,
    fontWeight: 700,
  },
  brandSub: {
    marginTop: 6,
    fontSize: 13,
    color: '#cfe0d6',
  },
  body: { padding: '32px' },
  h2: { margin: '0 0 12px', fontSize: 20, color: '#222' },
  p: {
    margin: '0 0 20px',
    color: '#444',
    fontSize: 14,
    lineHeight: 1.55,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 14px',
    fontSize: 15,
    border: '1px solid #d4d4d4',
    borderRadius: 6,
    marginBottom: 12,
    outline: 'none',
  },
  btn: {
    width: '100%',
    padding: '12px 16px',
    background: '#386351',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: '#386351',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
    marginTop: 8,
  },
  fineprint: {
    margin: '20px 0 0',
    color: '#999',
    fontSize: 12,
    textAlign: 'center',
  },
  keyToggleWrap: {
    marginTop: 18,
    paddingTop: 18,
    borderTop: '1px solid #eee',
    textAlign: 'center',
  },
  btnSecondary: {
    width: '100%',
    padding: '10px 16px',
    background: '#fff',
    color: '#386351',
    border: '1px solid #386351',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  err: {
    color: '#b91c1c',
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'left',
  },
}

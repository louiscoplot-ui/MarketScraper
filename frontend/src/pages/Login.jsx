import { useState, useEffect } from 'react'
import { MapPin } from 'lucide-react'
import { setAccessKey, BACKEND_DIRECT } from '../lib/api'
import Footer from '../components/Footer'
import { getDeskMode } from '../lib/deskFlag'

const goLegal = (hash) => (e) => {
  e.preventDefault()
  window.location.hash = hash
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

// styles.input sets outline:'none', so without these the keyboard focus
// position is invisible (WCAG 2.4.7). Same ring as Select.jsx.
const focusInput = (e) => {
  e.currentTarget.style.borderColor = 'var(--accent)'
  e.currentTarget.style.boxShadow = 'var(--focus-ring)'
}
const blurInput = (e) => {
  e.currentTarget.style.borderColor = 'var(--border)'
  e.currentTarget.style.boxShadow = 'none'
}

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
  // Which action is in flight ('password' | 'link' | 'key' | null) —
  // a single shared boolean made the magic-link button say "Sending…"
  // while a password sign-in was the request actually running.
  const [busyAction, setBusyAction] = useState(null)
  const busy = busyAction !== null
  const [showKey, setShowKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState('')
  const [directError, setDirectError] = useState('')
  const [password, setPassword] = useState('')

  const onSubmit = async (e) => {
    // Called both as the (now secondary) "Send login link" button click
    // and from any legacy code path that still wires this to a form. The
    // null-event guard lets the magic-link button trigger us without
    // pretending to be a form submission.
    if (e && typeof e.preventDefault === 'function') e.preventDefault()
    if (!email.trim() || busy) return
    setBusyAction('link')
    setDirectError('')
    // Hit Render directly — via the Vercel proxy a cold-start 504 (25s)
    // was swallowed and we showed "Check your inbox" anyway, so a
    // first-time prospect waited for an email that never sent. Only show
    // the confirmation when the request actually succeeded.
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/auth/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!res.ok) {
        setDirectError('Could not send the link right now. Please try again in a moment.')
        setBusyAction(null)
        return
      }
      setSubmitted(true)
    } catch {
      setDirectError('Could not reach the server. Try again in a moment.')
    }
    setBusyAction(null)
  }

  const onSubmitDirect = async () => {
    if (!email.trim() || busy) return
    setBusyAction('password')
    setDirectError('')
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/auth/login-by-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      if (res.status === 404) {
        setDirectError('Email not found — use the magic link below')
        setBusyAction(null)
        return
      }
      if (res.status === 401) {
        setDirectError('Incorrect password')
        setBusyAction(null)
        return
      }
      if (res.status === 403) {
        // First-time account (no password yet). The backend no longer
        // hands out the access_key on this path — the user must prove
        // inbox ownership via the magic link.
        const d = await res.json().catch(() => ({}))
        setDirectError(
          d && d.need_magic_link
            ? 'First time here? Tap “Send login link” below — we’ll email you a one-click link.'
            : 'Server error. Please try again.'
        )
        setBusyAction(null)
        return
      }
      if (!res.ok) {
        setDirectError('Server error. Please try again.')
        setBusyAction(null)
        return
      }
      const data = await res.json()
      setAccessKey(data.access_key)
      window.location.reload()
    } catch {
      setDirectError('Could not reach the server. Try again in a moment.')
      setBusyAction(null)
    }
  }

  const onSubmitKey = async (e) => {
    e.preventDefault()
    const k = keyInput.trim()
    if (!k || busy) return
    setBusyAction('key')
    setKeyError('')
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/auth/me`, { headers: { 'X-Access-Key': k } })
      if (!res.ok) {
        setKeyError('Key not recognised. Double-check it or request a magic link instead.')
        setBusyAction(null)
        return
      }
      setAccessKey(k)
      window.location.replace('/')
    } catch {
      setKeyError('Could not reach the server. Try again in a moment.')
      setBusyAction(null)
    }
  }

  const desk = getDeskMode() === 'desk'
  // Inline styles can't carry media queries, so track the breakpoint in
  // JS: below ~720px the desk split stacks into a single column instead
  // of squeezing the form beside a 44% brand band.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 720px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)')
    const onChange = (e) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return (
    <div style={styles.page}>
      <div style={desk ? { ...styles.card, maxWidth: narrow ? 440 : 940, display: 'flex', alignItems: 'stretch', flexDirection: narrow ? 'column' : 'row' } : styles.card}>
        <div style={desk ? { ...styles.brandBand, flex: narrow ? '0 0 auto' : '0 0 44%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 28, padding: narrow ? '32px 28px' : '44px 38px', background: 'linear-gradient(178deg,#0E1A14 0%,#0C120E 55%,#0A0F0C 100%)' } : styles.brandBand}>
          <div style={styles.brandLogo}>
            <MapPin size={22} strokeWidth={2.5} aria-hidden="true" />
            <h1 className="login-title" style={styles.brandTitle}>SuburbDesk</h1>
          </div>
          {desk ? (
            <>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: 30, lineHeight: 1.2, letterSpacing: '-0.02em', color: '#F5F5F4' }}>
                The market's vendor signals, on your desk before 7am.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {['Every listing, price move & withdrawal — nightly', 'Owners scored by likelihood to sell', 'Letters & pipeline, one click away'].map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#7fbfa1', fontWeight: 600, marginTop: 1 }}>0{i + 1}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: '#8A938C', lineHeight: 1.5 }}>{t}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={styles.brandSub}>Real-estate prospecting</div>
          )}
        </div>
        <div style={desk ? { ...styles.body, flex: 1, padding: narrow ? '32px 28px' : '44px 40px', display: 'flex', flexDirection: 'column', justifyContent: 'center' } : styles.body}>
          {submitted ? (
            <>
              <h2 className="login-h2" style={styles.h2}>Check your inbox</h2>
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
              <h2 className="login-h2" style={styles.h2}>Sign in</h2>
              <p style={styles.p}>
                Sign in with your email and password. First time here?
                We'll email you a one-click login link instead.
              </p>
              <form onSubmit={(e) => { e.preventDefault(); onSubmitDirect() }}>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="you@agency.com.au"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={focusInput}
                  onBlur={blurInput}
                  style={styles.input}
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={focusInput}
                  onBlur={blurInput}
                  style={styles.input}
                />
                {/* Primary action — Enter on either input hits this one. */}
                <button
                  type="submit"
                  disabled={busy}
                  style={{ ...styles.btn, opacity: busy ? 0.6 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
                >
                  {busyAction === 'password' ? 'Signing in…' : 'Sign in with my email'}
                </button>
                <p style={styles.helperText}>
                  Instant access if you already have an account
                </p>
                {directError && <div style={{ ...styles.err, marginTop: 4, marginBottom: 12 }}>{directError}</div>}
                {/* Secondary action — magic-link fallback for first-time
                    sign-in or when a user has forgotten their password. */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSubmit()}
                  style={{ ...styles.btnSecondary, opacity: busy ? 0.6 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
                >
                  {busyAction === 'link' ? 'Sending…' : 'Send login link'}
                </button>
                <p style={styles.helperText}>
                  Email a one-click link (first time signing in)
                </p>
              </form>
              <p style={styles.fineprint}>
                No public sign-up. Access is granted by your administrator.
              </p>
              <p style={styles.agreement}>
                By signing in, you agree to our{' '}
                <a href="#terms" onClick={goLegal('terms')} style={styles.agreementLink}>Terms of Service</a>
                {' '}and{' '}
                <a href="#privacy" onClick={goLegal('privacy')} style={styles.agreementLink}>Privacy Policy</a>.
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
                      onFocus={focusInput}
                      onBlur={blurInput}
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                    />
                    {keyError && <div style={styles.err}>{keyError}</div>}
                    <button
                      type="submit"
                      disabled={busy}
                      style={{ ...styles.btnSecondary, opacity: busy ? 0.6 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
                    >
                      {busyAction === 'key' ? 'Signing in…' : 'Sign in with key'}
                    </button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <Footer />
    </div>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    padding: '24px',
    fontFamily: 'var(--font-ui)',
  },
  agreement: {
    margin: '12px 0 0', color: 'var(--text-faint)', fontSize: 11,
    textAlign: 'center', lineHeight: 1.5,
  },
  agreementLink: {
    color: 'var(--text-muted)', textDecoration: 'underline',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    background: 'var(--surface)',
    borderRadius: 'var(--radius-card)',
    boxShadow: 'var(--shadow-pop)',
    overflow: 'hidden',
    border: '1px solid var(--border)',
  },
  brandBand: {
    background: 'var(--accent)',
    padding: '28px 32px',
    color: 'var(--accent-fg)',
  },
  brandLogo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  brandTitle: {
    margin: 0,
    fontSize: 24,
    letterSpacing: '-0.02em',
    fontWeight: 700,
  },
  brandSub: {
    marginTop: 6,
    fontSize: 13,
    color: 'color-mix(in srgb, var(--accent-fg) 78%, var(--accent))',
  },
  body: { padding: '32px' },
  h2: { margin: '0 0 12px', fontSize: 20, color: 'var(--text)' },
  p: {
    margin: '0 0 20px',
    color: 'var(--text-muted)',
    fontSize: 14,
    lineHeight: 1.55,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 14px',
    fontSize: 15,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    marginBottom: 12,
    outline: 'none',
  },
  btn: {
    width: '100%',
    padding: '12px 16px',
    background: 'var(--accent)',
    color: 'var(--accent-fg)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--accent)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
    marginTop: 8,
  },
  fineprint: {
    margin: '20px 0 0',
    color: 'var(--text-faint)',
    fontSize: 12,
    textAlign: 'center',
  },
  keyToggleWrap: {
    marginTop: 18,
    paddingTop: 18,
    borderTop: '1px solid var(--border)',
    textAlign: 'center',
  },
  btnSecondary: {
    width: '100%',
    padding: '10px 16px',
    background: 'var(--surface)',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  helperText: {
    margin: '6px 0 14px',
    color: 'var(--text-muted)',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 1.4,
  },
  err: {
    color: 'var(--status-alert-text)',
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'left',
  },
}

import { useState } from 'react'
import { BACKEND_DIRECT } from '../lib/api'

// Forced setup modal: rendered by AuthGate when /api/auth/me returns
// password_set=false. Non-dismissible — no close button, no backdrop
// click handler, no ESC. The user MUST set a password before they get
// to interact with anything else.
export default function SetPasswordModal() {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const onSubmit = async (e) => {
    e.preventDefault()
    if (busy) return
    if (pw.length < 8) { setErr('Password must be at least 8 characters'); return }
    if (pw !== pw2) { setErr('Passwords do not match'); return }
    setErr('')
    setBusy(true)
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/users/me/set-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': localStorage.getItem('agentdeck_access_key') || '',
        },
        body: JSON.stringify({ password: pw }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setErr(data.error || 'Could not save password')
        setBusy(false)
        return
      }
      window.location.reload()
    } catch {
      setErr('Could not reach the server. Try again.')
      setBusy(false)
    }
  }

  return (
    <div style={S.backdrop}>
      <div style={S.card}>
        <div style={S.brandBand}>
          <h1 className="login-title" style={S.brandTitle}>SuburbDesk</h1>
          <div style={S.brandSub}>Set your password</div>
        </div>
        <div style={S.body}>
          <p style={S.p}>
            For security on new devices, please choose a password. You'll
            use it together with your email next time you sign in.
          </p>
          <form onSubmit={onSubmit}>
            <input type="password" autoFocus required
                   placeholder="New password (min 8 chars)"
                   value={pw} onChange={(e) => setPw(e.target.value)}
                   onFocus={focusInput} onBlur={blurInput}
                   style={S.input} />
            <input type="password" required
                   placeholder="Confirm password"
                   value={pw2} onChange={(e) => setPw2(e.target.value)}
                   onFocus={focusInput} onBlur={blurInput}
                   style={S.input} />
            {err && <div style={S.err}>{err}</div>}
            <button type="submit" disabled={busy} style={S.btn}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

// S.input sets outline:'none', so without these the keyboard focus
// position is invisible (WCAG 2.4.7). Same ring as Select.jsx / Login.
const focusInput = (e) => {
  e.currentTarget.style.borderColor = 'var(--accent)'
  e.currentTarget.style.boxShadow = 'var(--focus-ring)'
}
const blurInput = (e) => {
  e.currentTarget.style.borderColor = 'var(--border)'
  e.currentTarget.style.boxShadow = 'none'
}

const S = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'var(--overlay)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, fontFamily: 'var(--font-ui)',
  },
  card: {
    width: '100%', maxWidth: 440, background: 'var(--surface)',
    borderRadius: 'var(--radius-card)', overflow: 'hidden',
    boxShadow: 'var(--shadow-pop)',
    border: '1px solid var(--border)',
  },
  brandBand: { background: 'var(--accent)', padding: '24px 32px', color: 'var(--accent-fg)' },
  brandTitle: { margin: 0, fontSize: 22, letterSpacing: '-0.02em', fontWeight: 700 },
  brandSub: { marginTop: 6, fontSize: 13, color: 'color-mix(in srgb, var(--accent-fg) 78%, var(--accent))' },
  body: { padding: 32 },
  p: { margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.55 },
  input: {
    width: '100%', boxSizing: 'border-box',
    padding: '12px 14px', fontSize: 15,
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    marginBottom: 12, outline: 'none',
  },
  btn: {
    width: '100%', padding: '12px 16px',
    background: 'var(--accent)', color: 'var(--accent-fg)',
    border: 'none', borderRadius: 'var(--radius-sm)',
    fontSize: 15, fontWeight: 600, cursor: 'pointer',
  },
  err: { color: 'var(--status-alert-text)', fontSize: 13, marginBottom: 12, textAlign: 'left' },
}

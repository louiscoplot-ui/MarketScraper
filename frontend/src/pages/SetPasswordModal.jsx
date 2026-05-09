import { useState } from 'react'

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
      const res = await fetch('/api/users/me/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          <h1 style={S.brandTitle}>SUBURBDESK</h1>
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
                   style={S.input} />
            <input type="password" required
                   placeholder="Confirm password"
                   value={pw2} onChange={(e) => setPw2(e.target.value)}
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

const S = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.55)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, fontFamily: 'system-ui, -apple-system, Arial, sans-serif',
  },
  card: {
    width: '100%', maxWidth: 440, background: '#fff',
    borderRadius: 10, overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
  },
  brandBand: { background: '#386351', padding: '24px 32px', color: '#fff' },
  brandTitle: { margin: 0, fontSize: 22, letterSpacing: 2, fontWeight: 700 },
  brandSub: { marginTop: 6, fontSize: 13, color: '#cfe0d6' },
  body: { padding: 32 },
  p: { margin: '0 0 20px', color: '#444', fontSize: 14, lineHeight: 1.55 },
  input: {
    width: '100%', boxSizing: 'border-box',
    padding: '12px 14px', fontSize: 15,
    border: '1px solid #d4d4d4', borderRadius: 6,
    marginBottom: 12, outline: 'none',
  },
  btn: {
    width: '100%', padding: '12px 16px',
    background: '#386351', color: '#fff',
    border: 'none', borderRadius: 6,
    fontSize: 15, fontWeight: 600, cursor: 'pointer',
  },
  err: { color: '#b91c1c', fontSize: 13, marginBottom: 12, textAlign: 'left' },
}

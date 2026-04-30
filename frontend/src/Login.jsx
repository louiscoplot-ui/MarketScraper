import { useState } from 'react'
import { setToken } from './auth'

export default function Login() {
  const [credential, setCredential] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!credential.trim()) return
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: credential.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Sign-in failed')
      setToken(data.token)
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Sign-in failed')
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>AgentDeck</h1>
        <p className="login-sub">Private beta · early access only</p>
        <input
          type="text"
          className="login-input"
          placeholder="Email or access key"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          autoFocus
          autoComplete="username"
        />
        <button
          type="submit"
          className="btn btn-primary login-btn"
          disabled={loading || !credential.trim()}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="login-error">{error}</div>}
        <p className="login-foot">
          Need access? Email{' '}
          <a href="mailto:louiscoplot@bellepropertycottesloe.com.au">
            louiscoplot@bellepropertycottesloe.com.au
          </a>
        </p>
      </form>
    </div>
  )
}

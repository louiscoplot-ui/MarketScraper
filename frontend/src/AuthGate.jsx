import { useEffect, useState } from 'react'
import Login from './pages/Login'
import { getAccessKey, setAccessKey, ACCESS_KEY_STORAGE } from './lib/api'

// Wraps the app in a global auth gate. On mount:
//   1. If the URL has ?key=<hex>, save it to localStorage and strip the
//      query string so the key isn't visible in the address bar.
//   2. Call /api/auth/me to validate the stored key. 401 → clear it and
//      show <Login />. 2xx → render the children.
//   3. Network failure (Render cold start) → optimistic: render the app
//      anyway so the user isn't stuck. The API will return 401 itself
//      if the key is wrong; individual data calls will surface that.
export default function AuthGate({ children }) {
  const [state, setState] = useState('checking') // 'checking' | 'in' | 'out'

  useEffect(() => {
    // Pull ?key= from URL into localStorage, then clean the URL.
    try {
      const params = new URLSearchParams(window.location.search)
      const k = params.get('key')
      if (k && /^[a-f0-9]{16,64}$/i.test(k)) {
        setAccessKey(k)
        params.delete('key')
        const qs = params.toString()
        const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
        window.history.replaceState({}, '', newUrl)
      }
    } catch {}

    const key = getAccessKey()
    if (!key) {
      setState('out')
      return
    }

    let cancelled = false
    fetch('/api/auth/me', { headers: { 'X-Access-Key': key } })
      .then((res) => {
        if (cancelled) return
        if (res.status === 401) {
          try { localStorage.removeItem(ACCESS_KEY_STORAGE) } catch {}
          setState('out')
        } else {
          // 200 or transient network error / cold-start fail → let them in
          setState('in')
        }
      })
      .catch(() => {
        if (cancelled) return
        // Backend unreachable (cold start, offline). Don't lock the user
        // out — the per-route auth check will still 401 if needed.
        setState('in')
      })

    return () => { cancelled = true }
  }, [])

  if (state === 'checking') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: '#386351',
        fontFamily: 'system-ui, sans-serif', fontSize: 14,
      }}>
        Loading…
      </div>
    )
  }
  if (state === 'out') return <Login />
  return children
}

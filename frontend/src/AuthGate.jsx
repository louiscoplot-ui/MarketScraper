import { useEffect, useState } from 'react'
import Login from './pages/Login'
import { getAccessKey, setAccessKey, ACCESS_KEY_STORAGE } from './lib/api'

// Wraps the app in a global auth gate.
//
// UX rule: never make the user wait on the Render cold start (30–60s
// on the free tier). If they already have a key in localStorage we
// render the app *immediately* and validate /api/auth/me in the
// background. A 401 from that validation evicts them and shows Login.
// A network failure / cold-start timeout leaves them in — individual
// data calls will 401 themselves if the key is genuinely invalid.
//
// Only flow that needs the spinner is the magic-link landing
// (`?key=<hex>` in the URL): we need to write the key before the app
// reads it, but that's a synchronous step so the spinner is brief.
export default function AuthGate({ children }) {
  const [state, setState] = useState(() => {
    // Synchronous initial decision so we don't flash a spinner.
    let urlKey = null
    try {
      const params = new URLSearchParams(window.location.search)
      const k = params.get('key')
      if (k && /^[a-f0-9]{16,64}$/i.test(k)) urlKey = k
    } catch {}
    if (urlKey) {
      setAccessKey(urlKey)
      try {
        const params = new URLSearchParams(window.location.search)
        params.delete('key')
        const qs = params.toString()
        const newUrl = window.location.pathname
          + (qs ? `?${qs}` : '')
          + window.location.hash
        window.history.replaceState({}, '', newUrl)
      } catch {}
      return 'in'
    }
    return getAccessKey() ? 'in' : 'out'
  })

  useEffect(() => {
    if (state !== 'in') return
    const key = getAccessKey()
    if (!key) return
    let cancelled = false
    // Background validation — only acts on a definitive 401.
    fetch('/api/auth/me', { headers: { 'X-Access-Key': key } })
      .then((res) => {
        if (cancelled) return
        if (res.status === 401) {
          try { localStorage.removeItem(ACCESS_KEY_STORAGE) } catch {}
          setState('out')
        }
      })
      .catch(() => { /* cold start / offline — leave them in */ })
    return () => { cancelled = true }
  }, [state])

  if (state === 'out') return <Login />
  return children
}


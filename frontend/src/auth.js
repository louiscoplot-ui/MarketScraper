// Beta-gate auth helpers — token in localStorage + global fetch
// interceptor that injects the Bearer header into every /api/* call
// and force-logs-out on a 401 from anything other than /api/auth/login.

const TOKEN_KEY = 'agentdeck_auth_token'

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

export function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t) } catch {}
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch {}
}

export function signOut() {
  clearToken()
  window.location.reload()
}

export function installAuthFetch() {
  if (window.__authFetchInstalled) return
  window.__authFetchInstalled = true
  const origFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string'
      ? input
      : (input && input.url) || ''
    const isApi = url.startsWith('/api/') || url.includes('/api/')
    const isLogin = url.includes('/api/auth/login')
    if (isApi && !isLogin) {
      const t = getToken()
      if (t) {
        const headers = new Headers(
          (init && init.headers) ||
          (typeof input !== 'string' && input && input.headers) ||
          {}
        )
        headers.set('Authorization', `Bearer ${t}`)
        init = { ...init, headers }
      }
    }
    const res = await origFetch(input, init)
    if (res.status === 401 && isApi && !isLogin) {
      clearToken()
      window.location.reload()
    }
    return res
  }
}

// Centralised fetch wrapper. Pulls the access_key from localStorage and
// adds it as X-Access-Key on every API call so the backend can scope
// data to the calling user (admins still see everything).
//
// Use this instead of raw `fetch` for any /api/* call. Public assets
// (images, the Vite app shell) don't need this.

export const ACCESS_KEY_STORAGE = 'agentdeck_access_key'

export function getAccessKey() {
  try { return localStorage.getItem(ACCESS_KEY_STORAGE) || '' }
  catch { return '' }
}

export function setAccessKey(key) {
  try { localStorage.setItem(ACCESS_KEY_STORAGE, key) }
  catch {}
}

export async function api(url, options = {}) {
  const key = getAccessKey()
  const headers = {
    ...(key ? { 'X-Access-Key': key } : {}),
    ...(options.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  }
  return fetch(url, { ...options, headers })
}

// Same as `api()` but parses JSON and throws on non-2xx, surfacing the
// backend's error message when present.
export async function apiJson(url, options = {}) {
  const res = await api(url, options)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} }
  catch { data = { error: text || `HTTP ${res.status}` } }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

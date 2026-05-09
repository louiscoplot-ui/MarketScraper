// Centralised fetch wrapper. Pulls the access_key from localStorage and
// adds it as X-Access-Key on every API call so the backend can scope
// data to the calling user (admins still see everything).
//
// Use this instead of raw `fetch` for any /api/* call. Public assets
// (images, the Vite app shell) don't need this.

export const ACCESS_KEY_STORAGE = 'agentdeck_access_key'

// Direct Render URL — bypasses Vercel's 25-second edge proxy timeout.
// Use for any call that may legitimately take longer than 25s (Render
// free-tier cold-start, big CSV uploads, slow Excel builds). The
// global fetch interceptor in main.jsx still injects X-Access-Key for
// these calls, and CORS(app) in the backend allows the origin.
export const BACKEND_DIRECT = 'https://marketscraper-backend.onrender.com'

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

// Retry a fetch up to `tries` times with exponential backoff. Used for
// bootstrap calls (suburbs, listings) where Render's free-tier cold
// start can take 30-60s and Vercel's edge proxy kills the request at
// 25s — the second attempt usually lands once Render is warm.
//
// Retries on: network errors, 5xx, 502 (bad gateway from Vercel after
// the proxy timeout). Does NOT retry on 4xx (client error / auth).
export async function fetchWithRetry(url, options = {}, tries = 4) {
  const delays = [0, 2000, 4000, 8000]
  let lastErr
  for (let i = 0; i < tries; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]))
    try {
      const res = await fetch(url, options)
      if (res.ok) return res
      if (res.status < 500 && res.status !== 0) return res  // 4xx — don't retry
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('fetchWithRetry: out of attempts')
}

// localStorage cache for slow bootstrap data (listings, suburbs).
// Stale-while-revalidate UX: on page load we render the previous
// snapshot instantly, then refresh in the background. The key is
// scoped to the access_key prefix so two users on the same browser
// (admin + beta tester) don't see each other's cached data.
//
// VERSION suffix bumped to 'v3' alongside the prefix-length change
// (8 → 16 chars). The 8-char prefix had a 1-in-4M birthday-collision
// risk: two users sharing the same first 8 hex chars of their access
// key would silently read each other's cached listings/pipeline. 16
// chars (64 bits of entropy) reduces that to negligible. The version
// bump invalidates every existing entry so no client keeps serving
// stale data after the prefix change.
const CACHE_VERSION = 'v3'
function _cacheKey(suffix) {
  const k = getAccessKey() || 'anon'
  return `sd_cache_${CACHE_VERSION}_${k.slice(0, 16)}_${suffix}`
}

export function readCache(suffix) {
  try {
    const raw = localStorage.getItem(_cacheKey(suffix))
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function writeCache(suffix, value) {
  try {
    localStorage.setItem(_cacheKey(suffix), JSON.stringify(value))
  } catch {
    // Storage full or private mode — silently skip; the network is
    // still the source of truth.
  }
}

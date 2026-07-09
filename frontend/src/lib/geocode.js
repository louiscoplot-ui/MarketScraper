// Free address geocoding for the lateral maps — no API key, no cost.
//
// Uses Photon (Komoot's open geocoder, https://photon.komoot.io) which is
// CORS-enabled and keyless. Every lookup is cached in localStorage so an
// address is only ever geocoded once per browser, and requests run through
// a small rate-limited queue so we stay well within fair-use.
//
// Precision: per-address (house level) when Photon resolves it; falls back
// to null when it can't (the caller then just skips that pin). Results are
// biased toward Perth via the lat/lon hint.

const CACHE_PREFIX = 'sd_geo_v1_'
const PERTH = { lat: -31.9505, lon: 115.8605 }
const GAP_MS = 220           // ~4.5 requests / second

function keyFor(q) {
  let h = 0
  const s = String(q).toLowerCase().trim()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff
  return CACHE_PREFIX + h
}

const queue = []
let running = false

async function pump() {
  if (running) return
  running = true
  while (queue.length) {
    const { q, resolve } = queue.shift()
    let out = null
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lat=${PERTH.lat}&lon=${PERTH.lon}`
      const res = await fetch(url)
      if (res.ok) {
        const j = await res.json()
        const c = j && j.features && j.features[0] && j.features[0].geometry && j.features[0].geometry.coordinates
        if (Array.isArray(c) && c.length === 2) out = { lng: c[0], lat: c[1] }
      }
    } catch { /* network / rate-limit — leave null */ }
    try { localStorage.setItem(keyFor(q), JSON.stringify(out)) } catch {}
    resolve(out)
    await new Promise(r => setTimeout(r, GAP_MS))
  }
  running = false
}

// Returns Promise<{lat,lng}|null>. Cached hits resolve synchronously-ish.
export function geocode(q) {
  if (!q) return Promise.resolve(null)
  try {
    const cached = localStorage.getItem(keyFor(q))
    if (cached !== null) return Promise.resolve(JSON.parse(cached))
  } catch { /* ignore */ }
  return new Promise(resolve => { queue.push({ q, resolve }); pump() })
}

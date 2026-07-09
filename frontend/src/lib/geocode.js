// Free address geocoding for the lateral maps — no API key, no cost.
//
// Uses Photon (Komoot's open geocoder, https://photon.komoot.io) which is
// CORS-enabled and keyless. Every lookup is cached in localStorage so an
// address is only ever geocoded once per browser.
//
// Accuracy over coverage: Photon fuzzy-matches, so it will happily return a
// same-named street in the wrong suburb. We VALIDATE every hit against the
// expected suburb + postcode and drop it if it doesn't match — an accurate
// sparse map beats a dense wrong one (a pin on the wrong street is worse
// than no pin). Callers pass a structured {address, suburb, postcode}.
//
// Speed: a small worker pool (3 in flight) instead of one-at-a-time, so a
// screen of ~40 addresses resolves in a few seconds on first load, then
// instantly from cache afterwards.

const CACHE_PREFIX = 'sd_geo_v2_'   // v2 — validated results, separate cache
const PERTH = { lat: -31.9505, lon: 115.8605 }
const WORKERS = 3

function keyFor(q) {
  let h = 0
  const s = String(q).toLowerCase().trim()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff
  return CACHE_PREFIX + h
}

// Pull a 4-digit AU postcode out of a free-text address, if present.
function extractPostcode(s) {
  const m = String(s || '').match(/\b(6\d{3})\b/)   // WA postcodes start with 6
  return m ? m[1] : null
}

// Strip a leading unit ("5B/12 Smith St", "2/80 …") down to the street part
// Photon indexes, and drop the postcode/state tail.
function cleanStreet(addr) {
  return String(addr || '')
    .replace(/\b6\d{3}\b/g, '')
    .replace(/\b(WA|Western Australia|Australia)\b/gi, '')
    .replace(/^\s*\d+[A-Za-z]?\s*\/\s*/, '')   // "5B/12 " -> "12 "
    .replace(/,\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, '') }

// Does a Photon feature actually sit in the suburb/postcode we asked for?
function matches(props, suburb, postcode) {
  if (!props) return false
  if (props.countrycode && props.countrycode !== 'AU') return false
  if (postcode && props.postcode && props.postcode !== postcode) return false
  if (suburb) {
    const want = norm(suburb)
    const got = [props.city, props.district, props.locality, props.county, props.name]
      .map(norm).filter(Boolean)
    // accept if any locality field contains (or is contained by) the suburb
    if (!got.some(g => g && (g.includes(want) || want.includes(g)))) {
      // no postcode corroboration either → reject
      if (!(postcode && props.postcode === postcode)) return false
    }
  }
  return true
}

async function lookup(address, suburb, postcode) {
  const street = cleanStreet(address)
  const q = `${street}, ${suburb || ''} ${postcode || ''} Western Australia`.replace(/\s+/g, ' ').trim()
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lat=${PERTH.lat}&lon=${PERTH.lon}`
  const res = await fetch(url)
  if (!res.ok) return null
  const j = await res.json()
  const feats = (j && j.features) || []
  // Prefer a house-number hit in the right suburb; then any hit in the right
  // suburb; reject everything else.
  const houses = feats.filter(f => f.properties && f.properties.housenumber && matches(f.properties, suburb, postcode))
  const inSuburb = feats.filter(f => matches(f.properties, suburb, postcode))
  const pick = houses[0] || inSuburb[0]
  const c = pick && pick.geometry && pick.geometry.coordinates
  if (Array.isArray(c) && c.length === 2) return { lng: c[0], lat: c[1] }
  return null
}

const queue = []
let active = 0

function drain() {
  while (active < WORKERS && queue.length) {
    const job = queue.shift()
    active++
    lookup(job.address, job.suburb, job.postcode)
      .catch(() => null)
      .then(out => {
        try { localStorage.setItem(keyFor(job.cacheKey), JSON.stringify(out ?? null)) } catch {}
        job.resolve(out ?? null)
      })
      .finally(() => { active--; drain() })
  }
}

// Returns Promise<{lat,lng}|null>. `q` is a structured object
// {address, suburb, postcode?}; a bare string is treated as the address.
export function geocode(q) {
  if (!q) return Promise.resolve(null)
  const address = typeof q === 'string' ? q : q.address
  const suburb = typeof q === 'string' ? '' : (q.suburb || '')
  const postcode = (typeof q === 'string' ? null : q.postcode) || extractPostcode(address)
  if (!address) return Promise.resolve(null)
  const cacheKey = `${cleanStreet(address)}|${norm(suburb)}|${postcode || ''}`
  try {
    const cached = localStorage.getItem(keyFor(cacheKey))
    if (cached !== null) return Promise.resolve(JSON.parse(cached))
  } catch { /* ignore */ }
  return new Promise(resolve => { queue.push({ address, suburb, postcode, cacheKey, resolve }); drain() })
}

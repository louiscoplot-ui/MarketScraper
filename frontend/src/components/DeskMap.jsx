// Real lateral map (MapLibre GL + free OpenStreetMap raster tiles) with
// exact per-address pins. Addresses are geocoded for free via lib/geocode
// (Photon, cached), so pins land at the house, not a suburb centroid.
// No API key, no cost. Pins are coloured by the status grammar; the map
// fits its bounds as pins resolve. Falls back gracefully: rows that can't
// be geocoded are simply skipped.
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { geocode } from '../lib/geocode'

// Clean light basemap — CARTO "Positron" (the muted grey style realestate
// portals use). Free, keyless raster tiles; retina @2x for a crisp look.
const CARTO_STYLE = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
}

// Single source of truth for map-pin colours (MapLibre markers are raw
// DOM, so CSS vars can't cascade into them). Values mirror --status-*.
export const STATUS_COLOR = {
  active: '#16A34A', under_offer: '#D97706', sold: '#2563EB', withdrawn: '#DC2626',
  New: '#16A34A', Active: '#16A34A', Leased: '#9CA3AF',
}

export default function DeskMap({
  items = [],
  label,
  addressOf = (i) => i.address,
  suburbOf = (i) => i.suburb_name || i.suburb,
  statusOf = (i) => i.status,
  colorOf,
  popupOf,
  // Rich pin cards (used when popupOf is not given): price + facts line,
  // and an optional click-through to the property dossier.
  priceOf = (i) => i.price_text || i.sold_price || i.price || i.rent || i.original_price || '',
  domOf = (i) => (i.days_on_market ?? i.dom ?? null),
  onSelect,
  max = 250,
  minHeight = 220,
}) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const lastSigRef = useRef(null)
  const runIdRef = useRef(0)
  // Once the user pans/zooms by hand, the auto fitBounds (which fires as
  // pins geocode in over several seconds) must stop stealing the camera.
  const userMovedRef = useRef(false)
  // Offline / blocked CDN → the canvas stays blank grey with no
  // explanation. Track tile errors so we can say "Map unavailable"
  // instead; a later successful tile load clears it (network came back).
  const [tilesDown, setTilesDown] = useState(false)
  // All geocodes failed (Photon down / rate-limited) → the map would sit
  // empty while the label announces N listings. Say so, discreetly.
  const [noPins, setNoPins] = useState(false)

  // Init map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: elRef.current,
      style: CARTO_STYLE,
      center: [115.8605, -31.9505],
      zoom: 10.5,
      attributionControl: true,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', (e) => {
      // MapLibre reports failed tile fetches here; anything else (style
      // warnings etc.) is ignored so we don't cry wolf.
      if (e && e.error && /tile|fetch|network|failed/i.test(String(e.error.message || e.error))) {
        setTilesDown(true)
      }
    })
    map.on('sourcedata', (e) => {
      if (e.isSourceLoaded) setTilesDown(false)
    })
    // Manual interaction only — programmatic fitBounds also emits
    // zoomstart, but without an originalEvent.
    map.on('dragstart', () => { userMovedRef.current = true })
    map.on('wheel', () => { userMovedRef.current = true })
    map.on('zoomstart', (e) => { if (e && e.originalEvent) userMovedRef.current = true })
    mapRef.current = map
    return () => { try { map.remove() } catch {} ; mapRef.current = null }
  }, [])

  // Plot pins whenever the item set changes — by CONTENT, not array
  // identity. Parents often pass a freshly-built array literal every
  // render (e.g. Report during its divider drag); rebuilding + re-geocoding
  // every pin on each of those renders made the map flicker and re-animate
  // its zoom constantly. A signature of address+colour skips no-op runs.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const list0 = (items || []).slice(0, max)
    const sig = list0.map(it =>
      `${addressOf(it) || ''}~${(colorOf && colorOf(it)) || statusOf(it) || ''}`
    ).join('|')
    if (sig === lastSigRef.current) return
    lastSigRef.current = sig

    // Cancellation via runId (NOT effect cleanup): a skipped re-run must
    // not cancel the in-flight geocoding of the previous real run. A new
    // real run — or unmount (mapRef nulled) — invalidates older runs.
    const runId = ++runIdRef.current
    const cancelled = () => runIdRef.current !== runId || !mapRef.current
    markersRef.current.forEach(m => { try { m.remove() } catch {} })
    markersRef.current = []
    // A new item set may re-frame the view; interaction during THIS run
    // re-raises the flag and stops the auto-fit again.
    userMovedRef.current = false
    setNoPins(false)

    const list = list0
    const bounds = new maplibregl.LngLatBounds()
    let placed = 0
    // Listings that geocode to the SAME point (units in one building,
    // strata blocks) share one marker: the dot becomes a count badge and
    // the card lists every unit. Key = coords to ~1m precision.
    const groups = new Map()

    const colorFor = (it) => (colorOf && colorOf(it)) || STATUS_COLOR[statusOf(it)] || '#9CA3AF'

    // Approximate pins (geocoder returned the suburb centroid, not the
    // house) used to all land on the exact same point → a dozen unrelated
    // addresses stacked into a fake "building" cluster. Spread each one by a
    // small deterministic offset (~±400m, stable per address) so they sit
    // apart within the suburb, and render them hollow so it's clear they're
    // approximate, not exact.
    const jitter = (addr) => {
      let h = 0; const s = String(addr || '')
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff
      const a = (h & 0xffff) / 0xffff, b = ((h >>> 16) & 0xffff) / 0xffff
      return [(a - 0.5) * 0.008, (b - 0.5) * 0.008]   // ±0.004° ≈ ±400 m
    }

    // Rich pin card — address + facts line + serif price per item; rows
    // click through to the dossier when the parent wires onSelect.
    // MapLibre's .maplibregl-popup-content background is a fixed white,
    // so colours here are explicit light-theme hex (all ≥4.5:1 on white)
    // — theme tokens would paint near-white text on it under dark presets.
    const buildCard = (its, approx) => {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'font-family:var(--font-ui);min-width:220px;max-width:300px;max-height:240px;overflow-y:auto'
      if (its.length > 1) {
        const head = document.createElement('div')
        head.style.cssText = 'font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#736D66;padding:2px 4px 7px;border-bottom:1px solid #E7E5E4;margin-bottom:2px'
        head.textContent = `${its.length} listings at this point`
        wrap.appendChild(head)
      } else if (approx) {
        // Honest: this pin is a suburb-level approximation, not the house.
        const note = document.createElement('div')
        note.style.cssText = 'font-family:var(--font-mono);font-size:9.5px;color:#92400E;padding:2px 4px 6px'
        note.textContent = 'Approximate location — exact address not found'
        wrap.appendChild(note)
      }
      its.forEach((it, i) => {
        const row = document.createElement('div')
        row.style.cssText = `display:flex;align-items:center;gap:10px;padding:7px 4px;${i < its.length - 1 ? 'border-bottom:1px solid #E7E5E4;' : ''}${onSelect ? 'cursor:pointer;border-radius:6px;' : ''}`
        const left = document.createElement('div')
        left.style.cssText = 'min-width:0;flex:1'
        const addr = document.createElement('div')
        addr.style.cssText = 'font-size:12.5px;font-weight:600;color:#0C0A09;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
        addr.textContent = addressOf(it) || '—'
        const dom = domOf(it)
        const facts = [
          suburbOf(it),
          it.bedrooms != null ? `${it.bedrooms} bd` : (it.beds != null ? `${it.beds} bd` : null),
          it.land_size || null,
        ].filter(Boolean).join(' · ')
        const sub = document.createElement('div')
        sub.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:#57534E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
        sub.innerHTML = ''
        const dot = document.createElement('span')
        dot.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:50%;background:${colorFor(it)};margin-right:5px;vertical-align:0`
        sub.appendChild(dot)
        sub.appendChild(document.createTextNode(facts))
        if (dom != null) {
          const d = document.createElement('span')
          d.style.cssText = `font-weight:600;color:${dom >= 60 ? '#991B1B' : '#57534E'}`
          d.textContent = `${facts ? ' · ' : ''}${dom} DOM`
          sub.appendChild(d)
        }
        left.appendChild(addr); left.appendChild(sub)
        if (onSelect) {
          const open = document.createElement('div')
          open.style.cssText = 'font-size:10.5px;font-weight:600;color:#386350;margin-top:1px'
          open.textContent = 'Open dossier →'
          left.appendChild(open)
        }
        row.appendChild(left)
        const price = String(priceOf(it) || '').trim()
        if (price) {
          const p = document.createElement('span')
          p.style.cssText = "flex:none;font-family:var(--font-display),Georgia,serif;font-size:15px;color:#0C0A09"
          p.textContent = price
          row.appendChild(p)
        }
        if (onSelect) {
          row.addEventListener('mouseenter', () => { row.style.background = '#F5F5F4' })
          row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
          row.addEventListener('click', () => onSelect(it))
        }
        wrap.appendChild(row)
      })
      return wrap
    }

    const renderGroup = (g) => {
      const its = g.items
      if (its.length === 1) {
        if (g.precise === false) {
          // Approximate: hollow ring (dashed), no solid fill — reads as
          // "somewhere in this suburb", not an exact address.
          g.el.style.cssText = `width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,.6);border:2px dashed ${colorFor(its[0])};box-shadow:0 1px 3px rgba(15,23,42,.2);cursor:pointer`
        } else {
          g.el.style.cssText = `width:13px;height:13px;border-radius:50%;background:${colorFor(its[0])};border:2.5px solid #fff;box-shadow:0 1px 5px rgba(15,23,42,.35);cursor:pointer`
        }
        g.el.textContent = ''
      } else {
        // Count badge — several properties share this EXACT point (real
        // strata/building; only precise pins ever group).
        g.el.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#386350;border:2.5px solid #fff;box-shadow:0 1px 6px rgba(15,23,42,.4);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-family:var(--font-mono),monospace;font-size:10px;font-weight:700'
        g.el.textContent = String(its.length)
      }
      if (popupOf) {
        g.popup.setText(its.map(popupOf).join(' · '))
      } else {
        g.popup.setDOMContent(buildCard(its, g.precise === false))
      }
    }

    const place = (it, c) => {
      if (cancelled() || !c) return
      // precise !== false → exact house pin (default for legacy string coords).
      const precise = c.precise !== false
      let lng = c.lng, lat = c.lat
      if (!precise) {
        const [dx, dy] = jitter(addressOf(it) || '')
        lng += dx; lat += dy   // spread approximate pins so they don't stack
      }
      const key = `${lng.toFixed(5)},${lat.toFixed(5)}`
      let g = groups.get(key)
      if (!g) {
        const el = document.createElement('div')
        const popup = new maplibregl.Popup({ offset: 15, closeButton: false, maxWidth: '320px' })
        const mk = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).setPopup(popup).addTo(map)
        g = { items: [], el, popup, precise }
        groups.set(key, g)
        markersRef.current.push(mk)
        bounds.extend([lng, lat])
        placed++
        // Re-fit as pins land (debounced by count) so the view tracks
        // results — unless the user has taken the camera.
        if (!userMovedRef.current && (placed === 4 || (placed > 4 && placed % 12 === 0))) {
          try { map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 500 }) } catch {}
        }
      }
      g.items.push(it)
      renderGroup(g)
    }

    // Fire every lookup at once — the geocoder's own worker pool throttles
    // fairly, and pins appear as each resolves (much faster than serial).
    const run = async () => {
      await Promise.all(list.map(async (it) => {
        const addr = addressOf(it)
        if (!addr) return
        const c = await geocode({ address: addr, suburb: suburbOf(it) || '' })
        place(it, c)
      }))
      if (cancelled()) return
      if (placed > 0) {
        if (!userMovedRef.current) { try { map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 500 }) } catch {} }
      } else if (list.length > 0) {
        setNoPins(true)
      }
    }
    run()
  }, [items, max])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight }}>
      <div ref={elRef} style={{ position: 'absolute', inset: 0 }} />
      {label && (
        // Caption bg is a fixed light glass over the light tiles, so the
        // text is an explicit hex too: #6b6862 ≥ 5:1 on the composite
        // (the old #9a978f sat at ~2.9:1; a theme token would go light
        // under dark presets and fail the same way).
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 1, fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase', color: '#6b6862', background: 'rgba(255,255,255,.82)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px' }}>
          {label}
        </div>
      )}
      {noPins && !tilesDown && (
        <div style={{ position: 'absolute', bottom: 28, left: 12, zIndex: 1, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: '#6b6862', background: 'rgba(255,255,255,.82)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', pointerEvents: 'none' }}>
          No addresses could be located on the map right now.
        </div>
      )}
      {tilesDown && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--surface)', pointerEvents: 'none' }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Map unavailable</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)' }}>Tiles couldn't load — check your connection.</div>
        </div>
      )}
    </div>
  )
}

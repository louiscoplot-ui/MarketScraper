// Real lateral map (MapLibre GL + free OpenStreetMap raster tiles) with
// exact per-address pins. Addresses are geocoded for free via lib/geocode
// (Photon, cached), so pins land at the house, not a suburb centroid.
// No API key, no cost. Pins are coloured by the status grammar; the map
// fits its bounds as pins resolve. Falls back gracefully: rows that can't
// be geocoded are simply skipped.
import { useEffect, useRef } from 'react'
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

const STATUS_COLOR = {
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
  max = 250,
}) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const lastSigRef = useRef(null)
  const runIdRef = useRef(0)

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

    const list = list0
    const bounds = new maplibregl.LngLatBounds()
    let placed = 0

    const place = (it, c) => {
      if (cancelled() || !c) return
      const el = document.createElement('div')
      const color = (colorOf && colorOf(it)) || STATUS_COLOR[statusOf(it)] || '#9CA3AF'
      el.style.cssText = `width:13px;height:13px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 1px 5px rgba(15,23,42,.35);cursor:pointer`
      const popupText = popupOf ? popupOf(it) : `${addressOf(it)}${suburbOf(it) ? ' · ' + suburbOf(it) : ''}`
      const popup = new maplibregl.Popup({ offset: 13, closeButton: false }).setText(popupText)
      const mk = new maplibregl.Marker({ element: el }).setLngLat([c.lng, c.lat]).setPopup(popup).addTo(map)
      markersRef.current.push(mk)
      bounds.extend([c.lng, c.lat])
      placed++
      // Re-fit as pins land (debounced by count) so the view tracks results.
      if (placed === 4 || (placed > 4 && placed % 12 === 0)) {
        try { map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 500 }) } catch {}
      }
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
      if (!cancelled() && placed > 0) { try { map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 500 }) } catch {} }
    }
    run()
  }, [items, max])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 220 }}>
      <div ref={elRef} style={{ position: 'absolute', inset: 0 }} />
      {label && (
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 1, fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase', color: '#5b5b57', background: 'rgba(255,255,255,.82)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px' }}>
          {label}
        </div>
      )}
    </div>
  )
}

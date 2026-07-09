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

const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
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

  // Init map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: elRef.current,
      style: OSM_STYLE,
      center: [115.8605, -31.9505],
      zoom: 10.5,
      attributionControl: true,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map
    return () => { try { map.remove() } catch {} ; mapRef.current = null }
  }, [])

  // Plot pins whenever the item set changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let cancelled = false
    markersRef.current.forEach(m => { try { m.remove() } catch {} })
    markersRef.current = []

    const list = (items || []).slice(0, max)
    const bounds = new maplibregl.LngLatBounds()
    let placed = 0

    const run = async () => {
      for (const it of list) {
        if (cancelled) return
        const addr = addressOf(it)
        if (!addr) continue
        const q = `${addr}, ${suburbOf(it) || ''} Western Australia`.replace(/\s+/g, ' ').trim()
        const c = await geocode(q)
        if (cancelled || !c) continue
        const el = document.createElement('div')
        const color = (colorOf && colorOf(it)) || STATUS_COLOR[statusOf(it)] || '#9CA3AF'
        el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer`
        const popupText = popupOf ? popupOf(it) : `${addr}${suburbOf(it) ? ' · ' + suburbOf(it) : ''}`
        const popup = new maplibregl.Popup({ offset: 12, closeButton: false }).setText(popupText)
        const mk = new maplibregl.Marker({ element: el }).setLngLat([c.lng, c.lat]).setPopup(popup).addTo(map)
        markersRef.current.push(mk)
        bounds.extend([c.lng, c.lat])
        placed++
        // Ease to the pins once we have a few, then only occasionally.
        if (placed === 6 || (placed > 6 && placed % 40 === 0)) {
          try { map.fitBounds(bounds, { padding: 44, maxZoom: 14, duration: 400 }) } catch {}
        }
      }
      if (!cancelled && placed > 0) { try { map.fitBounds(bounds, { padding: 44, maxZoom: 14, duration: 400 }) } catch {} }
    }
    run()
    return () => { cancelled = true }
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

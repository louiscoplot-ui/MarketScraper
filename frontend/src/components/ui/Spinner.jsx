// Spinner — the ONE loading indicator for the app. Replaces the four
// hand-rolled @keyframes sd-spin / hv-spin / loading-spin copies that
// were scattered across Pipeline, HotVendors, Report and SignalsView.
//
// Uses lucide's Loader2 (a circular stroke) + a single CSS animation
// injected once. Colour defaults to the brand accent; pass `muted` for
// a low-emphasis grey one (inside neutral banners).
import { Loader2 } from 'lucide-react'

// Inject the keyframes exactly once, no matter how many spinners mount.
const KEYFRAMES_ID = 'sd-spinner-keyframes'
function ensureKeyframes() {
  if (typeof document === 'undefined') return
  if (document.getElementById(KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = KEYFRAMES_ID
  style.textContent = '@keyframes sd-spin { to { transform: rotate(360deg) } }'
  document.head.appendChild(style)
}

export default function Spinner({ size = 18, muted = false, inline = false, style }) {
  ensureKeyframes()
  return (
    <Loader2
      size={size}
      strokeWidth={2.25}
      aria-label="Loading"
      style={{
        color: muted ? 'var(--text-muted)' : 'var(--accent)',
        animation: 'sd-spin 0.7s linear infinite',
        flexShrink: 0,
        verticalAlign: inline ? 'middle' : undefined,
        ...style,
      }}
    />
  )
}

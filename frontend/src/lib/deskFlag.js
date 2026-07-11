// "The Morning Desk" redesign — an isolated visual MODE that lives
// ALONGSIDE the classic UI, not on top of it. Its own flag so:
//   1. classic stays byte-for-byte the fallback (default), and
//   2. the operator flips the whole redesign off in one click.
//
// Deliberately independent from themeFlag.js (classic/v2): the redesign
// is a separate dimension, not a replacement of that switch. We drive
// two <html> attributes — data-desk="on|off" (mode) and data-rail-tone
// (which of the 4 rail palettes) — so every desk style can be scoped
// under [data-desk="on"] and never leak into classic.

const MODE_KEY = 'sd_desk_mode'   // 'desk' | 'classic'
const TONE_KEY = 'sd_desk_tone'   // one of DESK_TONES, or 'custom'
const CUSTOM_KEY = 'sd_desk_custom_color'  // '#rrggbb' picked by the operator

// ── MASTER SWITCH ────────────────────────────────────────────────────
// "The Morning Desk" is THE official website — the classic UI is retired.
// Flip this ONE constant to true to bring the old classic interface back
// (it restores localStorage-driven mode + the classic/desk toggle buttons
// in the header and the rail). Left in place as the single revert lever.
const ALLOW_CLASSIC = false
export function isClassicAllowed() { return ALLOW_CLASSIC }

export const DESK_TONES = ['ink', 'forest', 'slate', 'bone']

// 'custom' is a valid tone value on top of the 4 presets: the rail
// derives a full palette from the stored colour at render time
// (Rail.jsx paletteFromColor), guaranteeing WCAG AA text contrast on
// any background the operator picks.
export const DEFAULT_CUSTOM_COLOR = '#123322'

export function getDeskCustomColor() {
  try {
    const v = localStorage.getItem(CUSTOM_KEY)
    return /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : DEFAULT_CUSTOM_COLOR
  } catch { return DEFAULT_CUSTOM_COLOR }
}

export function setDeskCustomColor(hex) {
  try {
    if (/^#[0-9a-fA-F]{6}$/.test(hex || '')) localStorage.setItem(CUSTOM_KEY, hex)
  } catch {}
}

// Vercel PREVIEW deployments (branch / per-commit URLs) — NOT the prod
// alias market-scraper.vercel.app, NOT suburbdesk.com, NOT localhost.
// Used so a preview opens straight into the redesign (below).
function isPreviewHost() {
  try {
    const h = window.location.hostname
    return h.endsWith('.vercel.app') && h !== 'market-scraper.vercel.app'
  } catch { return false }
}

export function getDeskMode() {
  // Classic retired → desk is forced everywhere. Only when the master
  // switch ALLOW_CLASSIC is re-enabled does the stored preference matter.
  if (!ALLOW_CLASSIC) return 'desk'
  try {
    const v = localStorage.getItem(MODE_KEY)
    if (v === 'desk') return 'desk'
    if (v === 'classic') return 'classic'
    return 'desk'
  } catch { return 'desk' }
}

export function setDeskMode(m) {
  try { localStorage.setItem(MODE_KEY, m === 'desk' ? 'desk' : 'classic') } catch {}
  applyDesk()
}

export function toggleDeskMode() {
  setDeskMode(getDeskMode() === 'desk' ? 'classic' : 'desk')
}

export function getDeskTone() {
  try {
    const t = localStorage.getItem(TONE_KEY)
    return (DESK_TONES.includes(t) || t === 'custom') ? t : 'ink'
  } catch { return 'ink' }
}

export function setDeskTone(t) {
  const valid = DESK_TONES.includes(t) || t === 'custom'
  try { localStorage.setItem(TONE_KEY, valid ? t : 'ink') } catch {}
  applyDesk()
}

export function applyDesk() {
  const root = document.documentElement
  root.setAttribute('data-desk', getDeskMode() === 'desk' ? 'on' : 'off')
  root.setAttribute('data-rail-tone', getDeskTone())
}

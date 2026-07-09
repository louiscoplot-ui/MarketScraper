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
const TONE_KEY = 'sd_desk_tone'   // one of DESK_TONES

export const DESK_TONES = ['ink', 'forest', 'slate', 'bone']

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
  try {
    const v = localStorage.getItem(MODE_KEY)
    if (v === 'desk') return 'desk'
    if (v === 'classic') return 'classic'
    // No explicit choice yet → default. Preview deployments land straight
    // in "The Morning Desk" so it's visible without hunting for the entry
    // button; production stays classic (the redesign remains opt-in).
    return isPreviewHost() ? 'desk' : 'classic'
  } catch { return 'classic' }
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
    return DESK_TONES.includes(t) ? t : 'ink'
  } catch { return 'ink' }
}

export function setDeskTone(t) {
  try { localStorage.setItem(TONE_KEY, DESK_TONES.includes(t) ? t : 'ink') } catch {}
  applyDesk()
}

export function applyDesk() {
  const root = document.documentElement
  root.setAttribute('data-desk', getDeskMode() === 'desk' ? 'on' : 'off')
  root.setAttribute('data-rail-tone', getDeskTone())
}

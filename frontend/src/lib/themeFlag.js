// Single-flag rollback switch for the v2 visual identity.
//
// Default = 'classic' (V1 layout) — but several V2 styling wins
// (brand purple for active tabs, spaced 'All suburbs' row, '+' add
// button colour) are promoted to always-on in theme-v2.css so the
// classic mode keeps the parts the operator liked. Toggle to 'v2'
// via the header button or
// `localStorage.setItem('sd_theme', 'v2')` to opt back into the full
// new identity.

const KEY = 'sd_theme'

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'v2' ? 'v2' : 'classic'
  } catch {
    return 'classic'
  }
}

export function setTheme(t) {
  try {
    localStorage.setItem(KEY, t === 'v2' ? 'v2' : 'classic')
  } catch {}
  applyTheme()
}

export function toggleTheme() {
  setTheme(getTheme() === 'v2' ? 'classic' : 'v2')
}

export function applyTheme() {
  const t = getTheme()
  document.documentElement.setAttribute('data-theme', t)
}

// Single-flag rollback switch for the v2 visual identity.
//
// Default = 'classic' (V1 layout) — the operator wants every fresh
// load (new browser, new user, cleared cache) to land on V1. The
// V2 styling wins they kept (brand purple, active-tab pill, '+'
// button, sidebar layout) are promoted to always-on in theme-v2.css
// so they show up in classic mode too. Click the toggle in the header
// to opt into the full V2 look — the choice persists per browser.

// v2 of the storage key — bumped so anyone who was on the previous
// 'sd_theme=v2' default gets reset to classic on next load. They can
// still flip back via the toggle, which writes to this new key.
const KEY = 'sd_theme_v2'

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

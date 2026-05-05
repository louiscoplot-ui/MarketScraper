// Single-flag rollback switch for the v2 visual identity.
//
// Default = 'v2'. Toggle via the ThemeToggle button in the header (or
// `localStorage.setItem('sd_theme', 'classic')` from devtools) to fall
// back to the original look in one click — useful while the new
// design is being trialled with users.

const KEY = 'sd_theme'

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'classic' ? 'classic' : 'v2'
  } catch {
    return 'v2'
  }
}

export function setTheme(t) {
  try {
    localStorage.setItem(KEY, t === 'classic' ? 'classic' : 'v2')
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

// Persistent footer shown below the main content on every page,
// including the Login screen (so legal links are reachable pre-auth).
// Hash-based navigation — clicking Terms/Privacy sets the URL hash
// which AuthGate / App route to the standalone page renderer.

export default function Footer() {
  const goTo = (hash) => (e) => {
    e.preventDefault()
    window.location.hash = hash
    // Force AuthGate / App to re-read the hash and rerender.
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  return (
    <footer style={s.bar}>
      <span>© 2026 SuburbDesk</span>
      <span style={s.dot}>·</span>
      <a href="#terms" onClick={goTo('terms')} style={s.link}>Terms of Service</a>
      <span style={s.dot}>·</span>
      <a href="#privacy" onClick={goTo('privacy')} style={s.link}>Privacy Policy</a>
      <span style={s.dot}>·</span>
      <a href="mailto:suburbdesk@gmail.com" style={s.link}>suburbdesk@gmail.com</a>
    </footer>
  )
}

const s = {
  bar: {
    padding: '16px 24px',
    borderTop: '1px solid #e5e7eb',
    color: '#9ca3af',
    fontSize: 12,
    textAlign: 'center',
    fontFamily: 'system-ui, -apple-system, Arial, sans-serif',
    background: 'transparent',
  },
  dot: { margin: '0 8px', color: '#d1d5db' },
  link: {
    color: '#6b7280',
    textDecoration: 'none',
    borderBottom: '1px dotted #cbd5e1',
  },
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AuthGate from './AuthGate'
import PipelinePrint from './pages/PipelinePrint'
import { getAccessKey } from './lib/api'
import { applyTheme } from './lib/themeFlag'
import './index.css'
import './theme-v2.css'
import './components/header.css'
import './components/listings.css'

// Apply the persisted theme flag synchronously on boot so the very
// first paint is already correct (avoids a flash of the wrong palette).
applyTheme()

// Global fetch interceptor — every API call automatically carries the
// user's access_key in the X-Access-Key header. Matches both the Vercel
// proxy form (/api/...) and the direct Render form
// (https://marketscraper-backend.onrender.com/api/...) — the second
// form is used to bypass Vercel's 25s edge timeout when Render is
// cold-starting (would otherwise 504 before the response lands).
const BACKEND_HOST = 'marketscraper-backend.onrender.com'
const _originalFetch = window.fetch.bind(window)
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  const isLocalApi = url.startsWith('/api/')
  const isDirectApi = url.includes(`${BACKEND_HOST}/api/`)
  if (isLocalApi || isDirectApi) {
    const key = getAccessKey()
    if (key) {
      init.headers = { ...(init.headers || {}), 'X-Access-Key': key }
    }
  }
  return _originalFetch(input, init)
}

// Render free-tier sleeps after 15min idle. Fire a silent /api/ping
// the instant the app shell loads — and every 14 min while the tab
// stays open — so the dyno is always warm by the time the user
// clicks anything. Direct to Render to bypass Vercel's 25s edge
// timeout. Fire-and-forget: no await, no error display — failure
// here is harmless. 14 min is just under Render's 15-min sleep.
function startKeepAlive() {
  const ping = () => fetch(`https://${BACKEND_HOST}/api/ping`).catch(() => {})
  ping()
  setInterval(ping, 14 * 60 * 1000)
}
startKeepAlive()

// Lightweight URL-based routing — no React Router. The print view is a
// truly separate render tree (no header, sidebar, or theme controls)
// because letters need a clean canvas for browser print.
const isPrintView = window.location.pathname === '/pipeline/print'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isPrintView ? <PipelinePrint /> : <AuthGate><App /></AuthGate>}
  </React.StrictMode>
)

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AuthGate from './AuthGate'
import PipelinePrint from './pages/PipelinePrint'
import { getAccessKey } from './lib/api'
import './index.css'
import './components/header.css'
import './components/listings.css'

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

// Lightweight URL-based routing — no React Router. The print view is a
// truly separate render tree (no header, sidebar, or theme controls)
// because letters need a clean canvas for browser print.
const isPrintView = window.location.pathname === '/pipeline/print'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isPrintView ? <PipelinePrint /> : <AuthGate><App /></AuthGate>}
  </React.StrictMode>
)

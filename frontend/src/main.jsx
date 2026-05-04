import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import PipelinePrint from './pages/PipelinePrint'
import { getAccessKey } from './lib/api'
import './index.css'
import './components/header.css'
import './components/listings.css'

// Global fetch interceptor — every /api/* call automatically carries
// the user's access_key in the X-Access-Key header. Lets the backend
// scope listings/suburbs per user without touching every component.
// External URLs (Vercel assets, third-party APIs) are left alone.
const _originalFetch = window.fetch.bind(window)
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  if (url.startsWith('/api/')) {
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
    {isPrintView ? <PipelinePrint /> : <App />}
  </React.StrictMode>
)

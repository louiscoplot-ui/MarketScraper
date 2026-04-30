import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import PipelinePrint from './pages/PipelinePrint'
import Login from './Login'
import { getToken, installAuthFetch } from './auth'
import './index.css'
import './components/header.css'
import './components/listings.css'

// Inject the Bearer token into every /api/* fetch and force-logout on
// a 401. Must run before any component mounts.
installAuthFetch()

// Lightweight URL-based routing — no React Router. The print view is a
// truly separate render tree (no header, sidebar, or theme controls)
// because letters need a clean canvas for browser print.
const isPrintView = window.location.pathname === '/pipeline/print'
const authed = !!getToken()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {!authed
      ? <Login />
      : isPrintView
        ? <PipelinePrint />
        : <App />}
  </React.StrictMode>
)

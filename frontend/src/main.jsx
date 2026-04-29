import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import PipelinePrint from './pages/PipelinePrint'
import './index.css'

// Lightweight URL-based routing — no React Router. The print view is a
// truly separate render tree (no header, sidebar, or theme controls)
// because letters need a clean canvas for browser print.
const isPrintView = window.location.pathname === '/pipeline/print'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isPrintView ? <PipelinePrint /> : <App />}
  </React.StrictMode>
)

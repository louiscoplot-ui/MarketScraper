// Theme + Scrape progress + Account modals — extracted from App.jsx to
// keep modules under the MCP push size limit.

import { useState } from 'react'
import { BACKEND_DIRECT } from '../lib/api'

// Deliberate account/security modal — set or change the password for the
// currently authenticated user. Unlike the forced SetPasswordModal, this
// is dismissible and reachable any time from the header. It writes via the
// existing auth-required POST /api/users/me/set-password: the gate resolves
// the caller from their access_key, so there is no way to set a password
// for an account you can't already authenticate as (no grace-path
// equivalent to the one we removed in S-1). Hits Render directly so a
// cold-start 504 through the Vercel proxy can't break the save.
export function AccountModal({ me, onClose }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const hasPw = !!(me && me.password_set)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    if (pw.length < 8) { setErr('Password must be at least 8 characters'); return }
    if (pw !== pw2) { setErr('Passwords do not match'); return }
    setErr(''); setBusy(true)
    try {
      const res = await fetch(`${BACKEND_DIRECT}/api/users/me/set-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': localStorage.getItem('agentdeck_access_key') || '',
        },
        body: JSON.stringify({ password: pw }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error || 'Could not save password')
        setBusy(false)
        return
      }
      setDone(true); setBusy(false)
    } catch {
      setErr('Could not reach the server. Try again.')
      setBusy(false)
    }
  }

  const inp = {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px',
    fontSize: 15, border: '1px solid var(--border, #d4d4d4)',
    borderRadius: 6, marginBottom: 10, outline: 'none',
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>{hasPw ? 'Change password' : 'Set password'}</h2>
          <button className="btn btn-icon" onClick={onClose}>×</button>
        </div>
        {done ? (
          <>
            <p style={{ margin: '12px 0', color: '#166534', fontSize: 14, lineHeight: 1.5 }}>
              Password saved. You can now sign in with your email and this
              password on any device.
            </p>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p style={{ margin: '4px 0 16px', color: 'var(--text-muted, #666)', fontSize: 14, lineHeight: 1.5 }}>
              {me && me.email ? <>Signed in as <strong>{me.email}</strong>. </> : null}
              Choose a password (min 8 characters) so you can sign in with
              your email next time — no access key needed.
            </p>
            <input
              type="password" autoFocus required
              placeholder={hasPw ? 'New password' : 'Password (min 8 chars)'}
              value={pw} onChange={(e) => setPw(e.target.value)} style={inp}
            />
            <input
              type="password" required placeholder="Confirm password"
              value={pw2} onChange={(e) => setPw2(e.target.value)} style={inp}
            />
            {err && <div style={{ color: '#b91c1c', fontSize: 13, margin: '2px 0 10px' }}>{err}</div>}
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export function ThemeModal({ theme, setTheme, defaultTheme, presets, updateColor, onClose }) {
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal theme-modal">
        <div className="modal-header">
          <h2>Customize Theme</h2>
          <button className="btn btn-icon" onClick={onClose}>x</button>
        </div>
        <div className="theme-presets">
          {Object.entries(presets).map(([name, colors]) => (
            <button
              key={name}
              className="theme-preset-btn"
              style={{ background: colors.surface, color: colors.text, borderColor: colors.primary }}
              onClick={() => setTheme(colors)}
            >
              <span className="preset-dot" style={{ background: colors.primary }} />
              {name}
            </button>
          ))}
        </div>
        <div className="theme-colors">
          {[
            ['bg', 'Background'],
            ['surface', 'Panels'],
            ['border', 'Borders'],
            ['text', 'Text'],
            ['textMuted', 'Text Secondary'],
            ['primary', 'Accent Color'],
          ].map(([key, label]) => (
            <div key={key} className="theme-color-row">
              <label>{label}</label>
              <div className="color-input-group">
                <input type="color" value={theme[key]} onChange={e => updateColor(key, e.target.value)} />
                <input type="text" value={theme[key]} onChange={e => updateColor(key, e.target.value)} className="color-hex" />
              </div>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setTheme(defaultTheme)}>Reset</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}


export function ScrapeModal({
  scrapeJobs, isAnyScraping, completedCount, totalJobs,
  elapsed, estimatedRemaining, formatTime, cancelScrape, onClose,
  connecting = false, connectError = null,
}) {
  // Error branch — the POST itself failed (network / 4xx / 5xx) before
  // any backend job was started. Show the message + a Close button,
  // skip the progress bar entirely.
  if (connectError) {
    return (
      <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="modal">
          <div className="modal-header">
            <h2>Scraping Progress</h2>
            <button className="btn btn-icon" onClick={onClose}>×</button>
          </div>
          <div style={{
            margin: '12px 0', padding: '10px 14px', borderRadius: 6,
            background: '#fef2f2', border: '1px solid #fecaca',
            color: '#991b1b', fontSize: 14,
          }}>
            Could not start scrape: {connectError}
          </div>
          <div className="modal-footer">
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  // Connecting branch — modal opens synchronously on click, POST is
  // still in flight. No progress bar yet because the backend hasn't
  // ack'd the job. Once the POST returns, parent flips connecting=false
  // and we fall through to the normal progress UI below.
  if (connecting && scrapeJobs.length === 0) {
    return (
      <div className="modal-overlay">
        <div className="modal">
          <div className="modal-header">
            <h2>Scraping Progress</h2>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            margin: '16px 0', padding: '12px 14px', borderRadius: 6,
            background: '#eff6ff', border: '1px solid #bfdbfe',
            color: '#1e40af', fontSize: 14,
          }}>
            <span className="loading-spinner loading-spinner-sm" />
            <span>Connecting to server… this takes 15–30s on first request.</span>
          </div>
        </div>
      </div>
    )
  }

  // First-run hint: Render's free-tier sometimes lazy-installs the
  // Playwright chromium binary (~30-60s) and the modal otherwise just
  // sits on "Starting…" with no explanation. Show the hint while we're
  // running, under 90s elapsed, AND no job has emitted a real scrape-
  // phase progress yet (anything containing "page" / "Fetching" means
  // the browser is up and we're past the boot).
  const stillBooting = scrapeJobs.some(j => {
    if (j.status !== 'running') return false
    const p = (j.progress || '').toLowerCase()
    return !p.includes('page') && !p.includes('fetching')
  })
  const showBootHint = isAnyScraping && elapsed < 90 && stillBooting
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isAnyScraping) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>Scraping Progress</h2>
          {!isAnyScraping && <button className="btn btn-icon" onClick={onClose}>×</button>}
        </div>

        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{ width: `${totalJobs > 0 ? (completedCount / totalJobs) * 100 : 0}%` }} />
        </div>
        <div className="progress-stats">
          <span>{completedCount}/{totalJobs} suburbs done</span>
          <span>Elapsed: {formatTime(elapsed)}</span>
          {estimatedRemaining !== null && isAnyScraping && (
            <span>~{formatTime(estimatedRemaining)} remaining</span>
          )}
          {isAnyScraping && (
            <button className="btn btn-danger btn-small" onClick={cancelScrape}>Cancel Scraping</button>
          )}
        </div>

        {showBootHint && (
          <div style={{
            margin: '8px 0 4px', padding: '8px 12px', borderRadius: 6,
            background: '#eff6ff', border: '1px solid #bfdbfe',
            color: '#1e40af', fontSize: 13,
          }}>
            Starting up browser… first run takes 30–60s.
          </div>
        )}

        <div className="modal-jobs">
          {scrapeJobs.map(job => (
            <div key={job.id} className={`modal-job status-${job.status}`}>
              <span className="job-name">{job.name}</span>
              <span className={`job-status ${job.status}`}>
                {job.status === 'running' && '⏳ '}
                {job.status === 'completed' && '✓ '}
                {job.status === 'cancelled' && '⊘ '}
                {job.status === 'error' && '✗ '}
                {job.progress || job.status}
              </span>
            </div>
          ))}
        </div>

        {!isAnyScraping && (
          <div className="modal-footer">
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

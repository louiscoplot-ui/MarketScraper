// Theme + Scrape progress + Account + Add-suburb modals — extracted from
// App.jsx to keep modules under the MCP push size limit.

import { useState } from 'react'
import { BACKEND_DIRECT, fetchWithRetry } from '../lib/api'
import { searchSuburbs } from '../lib/waSuburbs'

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

// Add a suburb to the scraped coverage. The classic sidebar carried this
// form, but the Morning Desk redesign hides that column
// (desk.css `.app.desk .layout > .sidebar { display:none }`) and desk mode
// is forced everywhere since ALLOW_CLASSIC went false — so the create path
// became unreachable in prod. The chips row in ListingsView only toggles
// the VISIBILITY of suburbs that already exist; it never creates one.
//
// Same contract as the old form: local autocomplete against the bundled WA
// list (no round-trip to a cold Render), then POST /api/suburbs, which
// inserts with active=1 so the nightly cron picks it up. Direct to Render +
// fetchWithRetry — a cold start would 504 through Vercel's 25s edge proxy.
// The backend gate (app.py create_suburb) is the real authority: admin or
// can_add_suburbs only. This modal is just the reachable surface for it.
export function AddSuburbModal({ suburbs = [], onClose, onAdded, onDeleted }) {
  const [q, setQ] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState('')
  const [err, setErr] = useState('')
  const [added, setAdded] = useState([])
  const [removing, setRemoving] = useState(0)

  // Hard delete — the backend drops the suburb plus every listing, note
  // and scrape log hanging off it (app.py delete_suburb, admins only).
  // Irreversible, hence the spelled-out confirm.
  const remove = async (s) => {
    if (removing || busy) return
    const ok = window.confirm(
      `Remove ${s.name}?\n\n` +
      'This deletes the suburb and every listing, note and scrape log ' +
      'attached to it, and stops it being scraped. This cannot be undone.'
    )
    if (!ok) return
    setRemoving(s.id)
    setErr('')
    try {
      const res = await fetchWithRetry(
        `${BACKEND_DIRECT}/api/suburbs/${s.id}`, { method: 'DELETE' }, 4
      )
      if (!res.ok) {
        let d = null
        try { d = await res.json() } catch { /* HTML 502 */ }
        setErr((d && d.error) || `Could not remove ${s.name} (HTTP ${res.status})`)
      } else if (onDeleted) {
        onDeleted(s)
      }
    } catch (e) {
      setErr(`Could not reach the server — ${e.message || 'network error'}.`)
    }
    setRemoving(0)
  }

  const onInput = (val) => {
    setQ(val)
    setErr('')
    setSuggestions(val.trim().length < 2 ? [] : searchSuburbs(val))
  }

  const add = async (raw) => {
    const name = (raw || '').trim()
    if (!name || busy) return
    setBusy(true)
    setPending(name)
    setErr('')
    let res
    try {
      res = await fetchWithRetry(`${BACKEND_DIRECT}/api/suburbs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, 4)
    } catch (e) {
      setErr(`Could not reach the server — ${e.message || 'network error'}. Try again.`)
      setBusy(false)
      return
    }
    let data = null
    try { data = await res.json() } catch { /* HTML 502 from a cold dyno */ }
    // 200 = the suburb already existed and was (re)assigned to the caller —
    // the backend promotes it back to active=1. Treat it as a success, same
    // as the old sidebar form did.
    if (!res.ok && !(data && data.error === 'Suburb already exists')) {
      setErr((data && (data.detail || data.error)) || `Server error ${res.status}`)
      setBusy(false)
      return
    }
    setAdded(prev => (prev.includes(data?.name || name) ? prev : [...prev, data?.name || name]))
    setQ('')
    setSuggestions([])
    setBusy(false)
    if (onAdded) onAdded(data)
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>Add a suburb</h2>
          <button className="btn btn-icon" onClick={onClose}>×</button>
        </div>
        {/* .modal brings no padding of its own — only .modal-header and
            .modal-footer carry their own (index.css). Without this wrapper
            the copy and the input ran edge to edge. */}
        <div style={{ padding: '16px 20px' }}>
        <p style={{ margin: '0 0 14px', color: 'var(--text-muted, #666)', fontSize: 14, lineHeight: 1.5 }}>
          The suburb goes live straight away and the nightly scrape picks it
          up on its next run (midnight Perth). Add it before then to have the
          listings waiting for you in the morning.
        </p>
        {/* NOT .autocomplete-wrapper — that class carries `flex: 1` for its
            home in the sidebar's .add-form row. As a direct child of .modal
            (display:flex; flex-direction:column) the flex-basis:0 collapsed
            this box to ~0 height, so the dropdown's `top: 100%` landed on
            top of the input instead of under it and most clicks missed the
            row they were aimed at. Plain relative box, explicit width. */}
        <form
          onSubmit={(e) => { e.preventDefault(); add(q) }}
          style={{ marginBottom: 12 }}
        >
          <div style={{ position: 'relative', width: '100%' }}>
            <input
              type="text" autoFocus value={q} autoComplete="off"
              onChange={(e) => onInput(e.target.value)}
              placeholder="Type suburb name…"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                fontSize: 15, border: '1px solid var(--border, #d4d4d4)',
                borderRadius: 6, outline: 'none',
              }}
            />
            {suggestions.length > 0 && !busy && (
              <div className="suggestions-dropdown">
                {suggestions.map(s => {
                  const name = s.name || s
                  const postcode = s.postcode || ''
                  return (
                    <button
                      key={name}
                      type="button"
                      className="suggestion-item"
                      // onMouseDown, not onClick: it fires before the input
                      // blurs and before any re-render can move the row out
                      // from under the cursor.
                      onMouseDown={(e) => { e.preventDefault(); add(name) }}
                      // Hover inline rather than via .suggestion-item:hover —
                      // the inline `background` below would outrank the
                      // stylesheet rule and the row would never light up.
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--primary)'; e.currentTarget.style.color = '#fff' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text)' }}
                      style={{
                        display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center', width: '100%', textAlign: 'left',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      <span>{name}</span>
                      {postcode && (
                        <span style={{ fontSize: 11, opacity: 0.6, fontFeatureSettings: '"tnum"' }}>
                          {postcode}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </form>
        {/* Render's free tier hibernates after 15min idle; the first call
            back can take 30-60s. Say so, otherwise a dead "Adding…" reads
            as a frozen app and the operator clicks again and again. */}
        {busy && (
          <div style={{ color: 'var(--text-muted, #666)', fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
            Adding {pending}… if the server was idle it can take up to a
            minute to wake up. You can leave this open.
          </div>
        )}
        {err && <div style={{ color: '#b91c1c', fontSize: 13, margin: '0 0 10px' }}>{err}</div>}
        {added.length > 0 && (
          <div style={{ color: '#166534', fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
            Added: {added.join(', ')} — scraping tonight.
          </div>
        )}

        {/* Current coverage — also the honest answer to "did my add stick?".
            This list comes from GET /api/suburbs, the same source the chips
            and the nightly cron read. */}
        <div style={{ marginTop: 4 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '.05em', color: 'var(--text-muted, #666)',
            marginBottom: 6,
          }}>
            Scraped suburbs ({suburbs.length})
          </div>
          <div style={{
            maxHeight: 190, overflowY: 'auto',
            border: '1px solid var(--border, #d4d4d4)', borderRadius: 6,
          }}>
            {suburbs.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--text-muted, #666)' }}>
                None yet.
              </div>
            )}
            {suburbs.map(s => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 12px', fontSize: 13,
                borderBottom: '1px solid var(--border, #ececec)',
              }}>
                <span style={{ flex: 1 }}>{s.name}</span>
                <span style={{
                  fontSize: 11, color: 'var(--text-muted, #888)',
                  fontFeatureSettings: '"tnum"',
                }}>
                  {(s.active_count || 0) + (s.under_offer_count || 0)} live
                </span>
                <button
                  type="button"
                  onClick={() => remove(s)}
                  disabled={removing === s.id}
                  title={`Remove ${s.name} and all its data`}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: '#b91c1c', fontSize: 12, padding: '2px 4px',
                  }}
                >
                  {removing === s.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        </div>
        </div>
        <div className="modal-footer">
          {/* Never disabled: the add keeps running and the suburb is already
              committed server-side, so there's no reason to trap the operator
              in the modal while Render wakes up. */}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
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
          <button className="btn btn-icon" onClick={onClose}>×</button>
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
    // Closable even while connecting: if the POST hangs (mute socket on
    // a cold start) the full-screen modal must not trap the app. Closing
    // only hides the modal — the request keeps going in the background.
    return (
      <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="modal">
          <div className="modal-header">
            <h2>Scraping Progress</h2>
            <button className="btn btn-icon" onClick={onClose}>×</button>
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

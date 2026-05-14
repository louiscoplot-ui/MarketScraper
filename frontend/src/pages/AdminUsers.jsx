// SuburbDesk admin — user management + suburb assignment.
// Admin-only page that lists every user, lets the admin add/revoke
// access, and manages which suburbs each user can see and scrape.
// "Personne vole rien à personne" — a user only sees their assigned
// patch; admins see everything.

import { useState, useEffect } from 'react'
import { apiJson, getAccessKey, setAccessKey } from '../lib/api'

// Backend stores timestamps as naive UTC (datetime.utcnow().isoformat()
// or SQLite datetime('now')). JS new Date() treats a naive ISO string
// as *local* time, which is why "Last seen 2:46 AM" looked random for
// a Perth user — the value was actually 2:46 AM UTC = 10:46 AM Perth.
// Always force-interpret as UTC, then render in Perth time.
const PERTH_TZ = 'Australia/Perth'

function toUtcDate(s) {
  if (!s) return null
  let iso = s.includes('T') ? s : s.replace(' ', 'T')
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  if (!hasTz) iso += 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

function fmtPerthDateTime(s) {
  const d = toUtcDate(s)
  if (!d) return ''
  return d.toLocaleString('en-AU', {
    timeZone: PERTH_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtPerthDate(s) {
  const d = toUtcDate(s)
  if (!d) return ''
  return d.toLocaleDateString('en-AU', {
    timeZone: PERTH_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

export default function AdminUsers() {
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [allSuburbs, setAllSuburbs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // New-user form
  const [draft, setDraft] = useState({ email: '', first_name: '', last_name: '', phone: '', role: 'user' })
  const [saving, setSaving] = useState(false)
  const [newKey, setNewKey] = useState(null)

  // Rental module: separate admin allowlist + per-user toggle.
  const [rentalSuburbs, setRentalSuburbs] = useState([])
  const [newRentalSuburb, setNewRentalSuburb] = useState('')
  const [addingRentalSuburb, setAddingRentalSuburb] = useState(false)
  // Pending checkbox edits — keyed by suburb id, value is the new
  // active bool. Save button reads this set and POSTs the batch.
  const [pendingRental, setPendingRental] = useState({})
  const [savingRentalBatch, setSavingRentalBatch] = useState(false)

  // Rental per-user assignment modal — mirrors `assigning` below but
  // keyed on suburb_name (TEXT). { user, assigned: Set<string>,
  // available: string[] } where `assigned` is the operator-visible
  // editable state we POST/DELETE against the rental admin routes.
  const [rentalAssigning, setRentalAssigning] = useState(null)
  const [rentalAssignSaving, setRentalAssignSaving] = useState(false)

  // Suburb-assignment modal — keyed by user id
  const [assigning, setAssigning] = useState(null)  // { user, suburb_ids: Set }
  const [assignSaving, setAssignSaving] = useState(false)
  // Inline "add new suburb" input inside the assign modal — lets the
  // admin set up the suburb for an agent without leaving the modal
  // (the new suburb auto-checks for them; nightly scrape picks it up).
  const [newSuburbDraft, setNewSuburbDraft] = useState('')
  const [addingSuburb, setAddingSuburb] = useState(false)

  // Per-user prospecting-letter profile — fed by /api/admin/me, saved
  // via PATCH /api/users/me/profile. Available to every authenticated
  // user, not just admins.
  const [profileDraft, setProfileDraft] = useState({
    agency_name: '', agent_name: '', agent_phone: '', agent_email: '',
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)
  const [profileError, setProfileError] = useState('')

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const meRes = await apiJson('/api/admin/me')
      setMe(meRes.user)
      setProfileDraft({
        agency_name: meRes.user?.agency_name || '',
        agent_name: meRes.user?.agent_name || '',
        agent_phone: meRes.user?.agent_phone || '',
        agent_email: meRes.user?.agent_email || '',
      })
      // Admin-only calls — wrapped so non-admins still reach the
      // profile form below instead of crashing the whole page.
      try {
        const list = await apiJson('/api/admin/users')
        setUsers(list.users)
        const subRes = await fetch('/api/suburbs', {
          headers: { 'X-Access-Key': getAccessKey() }
        }).then(r => r.json())
        setAllSuburbs(Array.isArray(subRes) ? subRes : [])
        try {
          const rs = await apiJson('/api/admin/rental-suburbs')
          setRentalSuburbs(rs.suburbs || [])
        } catch { /* rental tables not initialised yet — silent skip */ }
      } catch (e) {
        if (meRes.user?.role === 'admin') throw e
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const saveProfile = async (e) => {
    e.preventDefault()
    setProfileError('')
    setProfileSaved(false)
    if (!profileDraft.agent_name.trim()) {
      setProfileError('Agent name is required.')
      return
    }
    setProfileSaving(true)
    try {
      const updated = await apiJson('/api/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify(profileDraft),
      })
      setMe(updated)
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 3000)
    } catch (err) {
      setProfileError(err.message)
    } finally {
      setProfileSaving(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const create = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const res = await apiJson('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      setNewKey({
        email: res.email,
        key: res.access_key,
        email_sent: !!res.email_sent,
        email_error: res.email_error || null,
      })
      setDraft({ email: '', first_name: '', last_name: '', phone: '', role: 'user' })
      refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const revoke = async (u) => {
    const yes = window.confirm(
      `Revoke access for ${u.email}? They won't be able to log in until re-added.`
    )
    if (!yes) return
    try {
      await apiJson(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      refresh()
    } catch (e) {
      alert(`Could not revoke: ${e.message}`)
    }
  }

  const toggleRole = async (u) => {
    // Defence against accidental self-demote — also enforced server-side
    // for the seeded admin (ADMIN_EMAIL is always promoted back), but we
    // block it in the UI too so the user never sees their role flicker.
    if (me && me.id === u.id) return
    const newRole = u.role === 'admin' ? 'user' : 'admin'
    try {
      await apiJson(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      })
      refresh()
    } catch (e) {
      alert(`Could not change role: ${e.message}`)
    }
  }

  const openAssign = async (u) => {
    try {
      const res = await apiJson(`/api/admin/users/${u.id}/suburbs`)
      setAssigning({ user: u, suburb_ids: new Set(res.suburb_ids) })
    } catch (e) {
      alert(`Could not load assignments: ${e.message}`)
    }
  }

  const toggleAssignedSuburb = (sid) => {
    setAssigning(a => {
      const next = new Set(a.suburb_ids)
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return { ...a, suburb_ids: next }
    })
  }

  const saveAssignments = async () => {
    if (!assigning) return
    setAssignSaving(true)
    try {
      await apiJson(`/api/admin/users/${assigning.user.id}/suburbs`, {
        method: 'PUT',
        body: JSON.stringify({ suburb_ids: Array.from(assigning.suburb_ids) }),
      })
      setAssigning(null)
      // Refresh the users table so the Suburbs column reflects the
      // new assignment immediately — without this the admin sees the
      // old chip list and assumes the save failed.
      refresh()
    } catch (e) {
      alert(`Could not save: ${e.message}`)
    } finally {
      setAssignSaving(false)
    }
  }

  // Add a brand-new suburb from inside the assign modal. The new entry
  // is auto-ticked for the current user so the admin doesn't have to
  // click twice. Nightly scrape picks it up on the next run because
  // `run_daily_scrape.py` reads the suburbs table at runtime.
  const addSuburbFromModal = async () => {
    const name = newSuburbDraft.trim()
    if (!name || !assigning) return
    setAddingSuburb(true)
    try {
      const res = await apiJson('/api/suburbs', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      // Insert into the local list, sorted alphabetically.
      setAllSuburbs(prev => [...prev, res].sort((a, b) =>
        (a.name || '').localeCompare(b.name || '')
      ))
      // Auto-tick for the current user.
      setAssigning(a => ({
        ...a,
        suburb_ids: new Set([...a.suburb_ids, res.id]),
      }))
      setNewSuburbDraft('')
    } catch (e) {
      alert(`Could not add suburb: ${e.message}`)
    } finally {
      setAddingSuburb(false)
    }
  }

  // Open the per-user rental-suburb assignment modal. Fetches both
  // assigned + available lists in one round-trip from the backend.
  const openRentalAssign = async (u) => {
    try {
      const res = await apiJson(`/api/admin/users/${u.id}/rental-suburbs`)
      setRentalAssigning({
        user: u,
        assigned: new Set(res.assigned || []),
        available: res.available || [],
      })
    } catch (e) {
      alert(`Could not load rental assignments: ${e.message}`)
    }
  }
  // Click on a suburb chip → toggle locally. Persisted to the
  // backend only when the operator hits Save.
  const toggleRentalSuburbInModal = (name) => {
    setRentalAssigning(a => {
      if (!a) return a
      const next = new Set(a.assigned)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { ...a, assigned: next }
    })
  }
  // Save the diff: compare modal state vs backend (re-fetch the
  // current assignment list, compute add + remove sets, fire the
  // minimum number of POST/DELETE calls). Atomic-ish — failures on
  // individual calls log a warning and continue, surfacing a count
  // at the end so the operator can retry if needed.
  const saveRentalAssignments = async () => {
    if (!rentalAssigning) return
    setRentalAssignSaving(true)
    try {
      const userId = rentalAssigning.user.id
      const fresh = await apiJson(`/api/admin/users/${userId}/rental-suburbs`)
      const currentSet = new Set(fresh.assigned || [])
      const desired = rentalAssigning.assigned
      const toAdd = [...desired].filter(n => !currentSet.has(n))
      const toRemove = [...currentSet].filter(n => !desired.has(n))
      let failures = 0
      for (const name of toAdd) {
        try {
          await apiJson(`/api/admin/users/${userId}/rental-suburbs`, {
            method: 'POST',
            body: JSON.stringify({ suburb_name: name }),
          })
        } catch (e) {
          console.warn(`Add ${name} failed:`, e.message)
          failures++
        }
      }
      for (const name of toRemove) {
        try {
          await apiJson(
            `/api/admin/users/${userId}/rental-suburbs/${encodeURIComponent(name)}`,
            { method: 'DELETE' }
          )
        } catch (e) {
          console.warn(`Remove ${name} failed:`, e.message)
          failures++
        }
      }
      setRentalAssigning(null)
      if (failures > 0) {
        alert(`${failures} rental suburb change(s) failed — please retry.`)
      }
    } catch (e) {
      alert(`Save failed: ${e.message}`)
    } finally {
      setRentalAssignSaving(false)
    }
  }

  // Per-user rental_access toggle — flips the column in users table.
  const toggleRentalAccess = async (u) => {
    const next = !u.rental_access
    try {
      await apiJson(`/api/admin/users/${u.id}/rental-access`, {
        method: 'PATCH',
        body: JSON.stringify({ rental_access: next }),
      })
      refresh()
    } catch (e) {
      alert(`Could not toggle rental access: ${e.message}`)
    }
  }

  // Rental Suburbs allowlist — separate from sales suburbs.
  const addRentalSuburb = async () => {
    const name = newRentalSuburb.trim()
    if (!name) return
    setAddingRentalSuburb(true)
    try {
      await apiJson('/api/admin/rental-suburbs', {
        method: 'POST', body: JSON.stringify({ name }),
      })
      const rs = await apiJson('/api/admin/rental-suburbs')
      setRentalSuburbs(rs.suburbs || [])
      setNewRentalSuburb('')
    } catch (e) {
      alert(`Could not add rental suburb: ${e.message}`)
    } finally {
      setAddingRentalSuburb(false)
    }
  }
  // Stage a checkbox change locally — saved later via Save changes.
  const toggleRentalCheckbox = (s) => {
    setPendingRental(prev => {
      const next = { ...prev }
      const current = (s.id in next) ? next[s.id] : !!s.active
      const flipped = !current
      // If the new value matches the DB-truth, clear the entry so we
      // don't POST a no-op update.
      if (flipped === !!s.active) {
        delete next[s.id]
      } else {
        next[s.id] = flipped
      }
      return next
    })
  }
  // Treat the pending map as the source of truth when rendering a row.
  const effectiveActive = (s) =>
    (s.id in pendingRental) ? pendingRental[s.id] : !!s.active
  const dirtyCount = Object.keys(pendingRental).length
  const selectAllRental = () => {
    setPendingRental(() => {
      const next = {}
      for (const s of rentalSuburbs) if (!s.active) next[s.id] = true
      return next
    })
  }
  const deselectAllRental = () => {
    setPendingRental(() => {
      const next = {}
      for (const s of rentalSuburbs) if (s.active) next[s.id] = false
      return next
    })
  }
  const saveRentalBatch = async () => {
    const updates = Object.entries(pendingRental).map(([id, active]) => ({
      id: Number(id), active,
    }))
    if (!updates.length) return
    setSavingRentalBatch(true)
    try {
      await apiJson('/api/admin/rental-suburbs/batch', {
        method: 'PATCH',
        body: JSON.stringify({ updates }),
      })
      const rs = await apiJson('/api/admin/rental-suburbs')
      setRentalSuburbs(rs.suburbs || [])
      setPendingRental({})
    } catch (e) {
      alert(`Save failed: ${e.message}`)
    } finally {
      setSavingRentalBatch(false)
    }
  }
  const deleteRentalSuburb = async (s) => {
    const yes = window.confirm(
      `Delete rental suburb "${s.name}"? This also removes every rental_listing + rental_owner row for that suburb. Cannot be undone.`
    )
    if (!yes) return
    try {
      await apiJson(`/api/admin/rental-suburbs/${s.id}`, { method: 'DELETE' })
      const rs = await apiJson('/api/admin/rental-suburbs')
      setRentalSuburbs(rs.suburbs || [])
    } catch (e) {
      alert(`Could not delete: ${e.message}`)
    }
  }

  const [keyInput, setKeyInput] = useState(getAccessKey())
  const saveKey = () => {
    setAccessKey(keyInput.trim())
    refresh()
  }

  return (
    <div className="admin-users">
      <h2>Users &amp; Access</h2>

      <div className="admin-keybox">
        <label className="admin-keylabel">Your access key</label>
        <div className="admin-keyrow">
          <input
            type="password"
            className="admin-keyinput"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="paste 32-char hex from Render logs"
          />
          <button className="btn btn-primary btn-sm" onClick={saveKey}>Save key</button>
        </div>
        <div className="admin-keyhint">
          The key is stored in this browser's localStorage. To revoke device access, clear browser data.
        </div>
      </div>

      {me && (
        <div className="admin-me">
          Signed in as <strong>{me.email}</strong>
          {' · '}
          <span className={`role-pill role-${me.role}`} style={{ cursor: 'default' }}>
            {me.role}
          </span>
          {me.role === 'admin' && (
            <span className="admin-me-locked" title="Sealed by ADMIN_EMAIL on Render — only env var or DB edit can change this">
              {' · 🔒 permanent'}
            </span>
          )}
        </div>
      )}

      {me && (
        <form className="admin-form" onSubmit={saveProfile} style={{ marginTop: 16 }}>
          <h3>Agent Profile</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            These details appear on prospecting letters. Empty fields fall back to server env vars.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              type="text" placeholder="Agency Name"
              value={profileDraft.agency_name}
              onChange={(e) => setProfileDraft({ ...profileDraft, agency_name: e.target.value })}
            />
            <input
              type="text" placeholder="Agent Name"
              value={profileDraft.agent_name}
              onChange={(e) => setProfileDraft({ ...profileDraft, agent_name: e.target.value })}
              required
            />
            <input
              type="tel" placeholder="Phone"
              value={profileDraft.agent_phone}
              onChange={(e) => setProfileDraft({ ...profileDraft, agent_phone: e.target.value })}
            />
            <input
              type="email" placeholder="Email"
              value={profileDraft.agent_email}
              onChange={(e) => setProfileDraft({ ...profileDraft, agent_email: e.target.value })}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={profileSaving}>
              {profileSaving ? 'Saving…' : 'Save profile'}
            </button>
            {profileSaved && <span style={{ color: 'var(--active)', fontSize: 13 }}>✓ Saved</span>}
            {profileError && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{profileError}</span>}
          </div>
        </form>
      )}

      {error && <div className="admin-error">{error}</div>}
      {loading && <div className="admin-loading">Loading…</div>}

      {newKey && (
        <div className={`admin-newkey ${newKey.email_sent ? 'admin-newkey-success' : ''}`}>
          <div className="admin-newkey-title">
            {newKey.email_sent
              ? `✓ User created — welcome email sent to ${newKey.email}`
              : '✓ User created — email NOT sent, copy the key below manually'}
          </div>
          {!newKey.email_sent && newKey.email_error && (
            <div className="admin-newkey-warn">
              Email failed: {newKey.email_error}. Most likely cause: RESEND_API_KEY env var not set on Render.
            </div>
          )}
          <div className="admin-newkey-row">
            <span className="admin-newkey-email">{newKey.email}</span>
            <code className="admin-newkey-code">{newKey.key}</code>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigator.clipboard.writeText(newKey.key)}
            >
              Copy key
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setNewKey(null)}
            >
              Dismiss
            </button>
          </div>
          {newKey.email_sent && (
            <div className="admin-newkey-hint">
              They'll receive the access key + step-by-step instructions
              by email. You can still copy the key here as a backup.
            </div>
          )}
        </div>
      )}

      <form className="admin-form" onSubmit={create}>
        <h3>Add user</h3>
        <div className="admin-form-grid">
          <input type="email" required placeholder="email@example.com"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          <input placeholder="First name"
            value={draft.first_name}
            onChange={(e) => setDraft({ ...draft, first_name: e.target.value })} />
          <input placeholder="Last name"
            value={draft.last_name}
            onChange={(e) => setDraft({ ...draft, last_name: e.target.value })} />
          <input placeholder="Phone (optional)"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          <select value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Adding…' : 'Add user'}
          </button>
        </div>
      </form>

      <table className="admin-users-table">
        <thead>
          <tr>
            <th>Email</th><th>Name</th><th>Phone</th>
            <th>Role</th><th>Suburbs</th><th>Rental</th>
            <th>Last seen</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {[...users].sort((a, b) => {
            // Pin the current user to the top so they always see their
            // own row first, then everyone else by creation date desc.
            if (me && a.id === me.id) return -1
            if (me && b.id === me.id) return 1
            return (b.created_at || '').localeCompare(a.created_at || '')
          }).map(u => (
            <tr key={u.id} className={me && u.id === me.id ? 'admin-row-me' : undefined}>
              <td>
                {u.email}
                {me && u.id === me.id && <span className="admin-you-badge"> (you)</span>}
              </td>
              <td>{[u.first_name, u.last_name].filter(Boolean).join(' ') || '-'}</td>
              <td>{u.phone || '-'}</td>
              <td>
                <button
                  className={`role-pill role-${u.role}`}
                  onClick={() => toggleRole(u)}
                  disabled={me && me.id === u.id}
                  title={me && me.id === u.id
                    ? "You can't change your own role"
                    : "Click to toggle role"}
                >
                  {u.role}
                </button>
              </td>
              <td className="admin-suburbs-cell">
                {u.role === 'admin' ? (
                  <span className="admin-suburbs-all" title="Admins see every suburb automatically">All suburbs</span>
                ) : (u.suburbs && u.suburbs.length > 0) ? (
                  <button
                    type="button"
                    className="admin-suburbs-chips"
                    onClick={() => openAssign(u)}
                    title={u.suburbs.map(s => s.name).join(', ')}
                  >
                    {u.suburbs.slice(0, 3).map(s => (
                      <span key={s.id} className="admin-suburb-chip">{s.name}</span>
                    ))}
                    {u.suburbs.length > 3 && (
                      <span className="admin-suburb-more">+{u.suburbs.length - 3}</span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="admin-suburbs-empty"
                    onClick={() => openAssign(u)}
                  >
                    None — click to assign
                  </button>
                )}
              </td>
              <td style={{ textAlign: 'center' }}>
                {u.role === 'admin' ? (
                  <span title="Admins always have rental access" style={{
                    fontSize: 11, color: '#6b7280',
                  }}>auto</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleRentalAccess(u)}
                    title={u.rental_access ? 'Click to revoke rental access' : 'Click to grant rental access'}
                    style={{
                      cursor: 'pointer', border: 'none', padding: '3px 10px',
                      borderRadius: 10, fontSize: 11, fontWeight: 600,
                      background: u.rental_access ? '#d1fae5' : '#f3f4f6',
                      color: u.rental_access ? '#065f46' : '#9ca3af',
                    }}
                  >
                    {u.rental_access ? 'ON' : 'OFF'}
                  </button>
                )}
              </td>
              <td>{u.last_seen ? fmtPerthDateTime(u.last_seen) : 'Never'}</td>
              <td>{u.created_at ? fmtPerthDate(u.created_at) : '-'}</td>
              <td className="admin-row-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => openAssign(u)}
                  disabled={u.role === 'admin'}
                  title={u.role === 'admin' ? 'Admins see all suburbs automatically' : 'Manage suburb access'}
                >
                  Suburbs
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => openRentalAssign(u)}
                  disabled={u.role === 'admin' || !u.rental_access}
                  title={
                    u.role === 'admin' ? 'Admins see all rental suburbs automatically'
                    : !u.rental_access ? 'Toggle Rental access on first'
                    : 'Manage rental suburb access'
                  }
                >
                  Rental
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-danger"
                  onClick={() => revoke(u)}
                  disabled={me && me.id === u.id}
                  title={me && me.id === u.id ? "Can't delete yourself" : 'Revoke access'}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          {!users.length && !loading && (
            <tr><td colSpan="9" className="empty">No users yet. Add one above.</td></tr>
          )}
        </tbody>
      </table>

      {me && me.role === 'admin' && (
        <div style={{ marginTop: 32 }}>
          <h3>Rental Suburbs</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Allowlist for the rental scraper. Tick the suburbs to keep
            active, untick to skip; click Save to apply. Delete cascades
            — it removes every rental_listing + rental_owner row for
            that suburb. Use the input below to add a new one.
          </p>

          {/* Add new suburb — visible block above the list with its
              own label so it can't be confused with a toolbar item. */}
          <div style={{
            border: '1px solid #d1d5db', borderRadius: 8,
            padding: '10px 12px', marginBottom: 14, background: '#f9fafb',
          }}>
            <label style={{
              display: 'block', fontSize: 11, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: 0.4,
              color: '#475569', marginBottom: 6,
            }}>
              Add a new rental suburb
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="e.g. Karrinyup, Trigg, Burns Beach"
                value={newRentalSuburb}
                onChange={(e) => setNewRentalSuburb(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addRentalSuburb() }
                }}
                style={{
                  flex: 1, padding: '8px 12px', fontSize: 14,
                  border: '1px solid #cbd5e1', borderRadius: 6,
                  background: 'white',
                }}
              />
              <button
                type="button"
                onClick={addRentalSuburb}
                disabled={!newRentalSuburb.trim() || addingRentalSuburb}
                style={{
                  padding: '8px 18px', fontSize: 14, fontWeight: 600,
                  background: (!newRentalSuburb.trim() || addingRentalSuburb)
                    ? '#94a3b8' : '#386351',
                  color: 'white', border: 'none', borderRadius: 6,
                  cursor: (!newRentalSuburb.trim() || addingRentalSuburb)
                    ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {addingRentalSuburb ? 'Adding…' : '+ Add suburb'}
              </button>
            </div>
          </div>

          {/* Multi-select toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 8, flexWrap: 'wrap',
          }}>
            <button type="button" className="btn-link" onClick={selectAllRental}>
              Select all
            </button>
            <span style={{ color: '#cbd5e1' }}>·</span>
            <button type="button" className="btn-link" onClick={deselectAllRental}>
              Deselect all
            </button>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              {dirtyCount > 0 && (
                <span style={{ fontSize: 12, color: '#b45309' }}>
                  {dirtyCount} unsaved change{dirtyCount !== 1 ? 's' : ''}
                </span>
              )}
              <button
                type="button"
                onClick={saveRentalBatch}
                disabled={dirtyCount === 0 || savingRentalBatch}
                style={{
                  padding: '6px 16px', fontSize: 13, fontWeight: 600,
                  background: dirtyCount === 0 ? '#cbd5e1' : '#0f766e',
                  color: 'white', border: 'none', borderRadius: 6,
                  cursor: dirtyCount === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {savingRentalBatch ? 'Saving…' : 'Save changes'}
              </button>
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6,
                        maxHeight: 360, overflowY: 'auto',
                        border: '1px solid #e5e7eb', borderRadius: 6,
                        padding: 8, background: 'white' }}>
            {rentalSuburbs.length === 0 && (
              <div style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>
                No rental suburbs yet. Add one above.
              </div>
            )}
            {rentalSuburbs.map(s => {
              const isActive = effectiveActive(s)
              const dirty = s.id in pendingRental
              return (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 10px', borderRadius: 4,
                background: dirty ? '#fef3c7' : (isActive ? 'transparent' : '#fafafa'),
              }}>
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={() => toggleRentalCheckbox(s)}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{
                  flex: 1, fontSize: 13,
                  color: isActive ? '#111827' : '#9ca3af',
                  textDecoration: isActive ? 'none' : 'line-through',
                }}>
                  {s.name}
                </span>
                {dirty && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: '#b45309',
                    textTransform: 'uppercase', letterSpacing: 0.4,
                  }}>
                    pending
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-danger"
                  onClick={() => deleteRentalSuburb(s)}
                >
                  Delete
                </button>
              </div>
              )
            })}
          </div>

          <p style={{
            fontSize: 12, color: '#0c4a6e',
            background: '#f0f9ff', border: '1px solid #bae6fd',
            borderRadius: 6, padding: '8px 12px', marginTop: 12,
          }}>
            ℹ️ Active suburbs are automatically scraped daily at 5am Perth time.
          </p>
        </div>
      )}

      {assigning && (
        // Backdrop is non-interactive — clicking outside the modal does
        // NOT close it. The previous behavior (close on backdrop click)
        // was eating the user's progress: tick a few suburbs, click
        // anywhere outside the panel by accident → ticks gone, no save.
        // Use the × or Cancel button to close explicitly.
        <div className="note-modal-overlay">
          <div className="note-modal admin-assign-modal">
            <div className="note-modal-header">
              <div>
                <div className="note-modal-title">Assign suburbs</div>
                <div className="note-modal-sub">{assigning.user.email}</div>
              </div>
              <button className="btn-icon" onClick={() => setAssigning(null)} title="Close">×</button>
            </div>
            <div className="admin-assign-hint">
              Tick the suburbs this user can see and scrape. Untick to revoke.
            </div>
            <div className="admin-assign-add">
              <input
                className="admin-assign-add-input"
                placeholder="+ Add a new suburb (e.g. Karrinyup) — picked up by tonight's scrape"
                value={newSuburbDraft}
                onChange={(e) => setNewSuburbDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addSuburbFromModal()
                  }
                }}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={addSuburbFromModal}
                disabled={!newSuburbDraft.trim() || addingSuburb}
              >
                {addingSuburb ? 'Adding…' : 'Add'}
              </button>
            </div>
            <div className="admin-assign-grid">
              {allSuburbs.map(s => (
                <label key={s.id} className="admin-assign-row">
                  <input
                    type="checkbox"
                    checked={assigning.suburb_ids.has(s.id)}
                    onChange={() => toggleAssignedSuburb(s.id)}
                  />
                  <span className="admin-assign-name">{s.name}</span>
                  <span className="admin-assign-count">
                    {(s.active_count || 0) + (s.under_offer_count || 0)} live
                  </span>
                </label>
              ))}
              {!allSuburbs.length && (
                <div className="empty">No suburbs in the system yet.</div>
              )}
            </div>
            <div className="note-modal-footer">
              <span className="note-hint">{assigning.suburb_ids.size} selected</span>
              <div className="note-modal-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setAssigning(null)} disabled={assignSaving}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveAssignments}
                  disabled={assignSaving}
                >
                  {assignSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {rentalAssigning && (
        // Same shell as the sales assign modal — different mutation
        // shape (POST/DELETE diff against rental_user_suburbs instead
        // of PUT replace-all). Suburb chips toggle on click.
        <div className="note-modal-overlay">
          <div className="note-modal admin-assign-modal">
            <div className="note-modal-header">
              <div>
                <div className="note-modal-title">Rental suburbs</div>
                <div className="note-modal-sub">{rentalAssigning.user.email}</div>
              </div>
              <button className="btn-icon" onClick={() => setRentalAssigning(null)} title="Close">×</button>
            </div>
            <div className="admin-assign-hint">
              Tick the rental suburbs this user can see and import.
              Empty assignment = legacy fallback (all active rental
              suburbs visible). Untick to remove a suburb from their scope.
            </div>
            <div className="admin-assign-grid">
              {(rentalAssigning.available || []).map(name => (
                <label key={name} className="admin-assign-row">
                  <input
                    type="checkbox"
                    checked={rentalAssigning.assigned.has(name)}
                    onChange={() => toggleRentalSuburbInModal(name)}
                  />
                  <span className="admin-assign-name">{name}</span>
                </label>
              ))}
              {(rentalAssigning.available || []).length === 0 && (
                <div className="empty">
                  No active rental suburbs configured yet — add some via the
                  Rental Suburbs panel.
                </div>
              )}
            </div>
            <div className="note-modal-footer">
              <span className="note-hint">{rentalAssigning.assigned.size} selected</span>
              <div className="note-modal-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRentalAssigning(null)}
                  disabled={rentalAssignSaving}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveRentalAssignments}
                  disabled={rentalAssignSaving}
                >
                  {rentalAssignSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// SuburbDesk admin — user management + suburb assignment.
// Admin-only page that lists every user, lets the admin add/revoke
// access, and manages which suburbs each user can see and scrape.
// "Personne vole rien à personne" — a user only sees their assigned
// patch; admins see everything.

import { useState, useEffect } from 'react'
import { apiJson, getAccessKey, setAccessKey } from '../lib/api'

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

  // Suburb-assignment modal — keyed by user id
  const [assigning, setAssigning] = useState(null)  // { user, suburb_ids: Set }
  const [assignSaving, setAssignSaving] = useState(false)
  // Inline "add new suburb" input inside the assign modal — lets the
  // admin set up the suburb for an agent without leaving the modal
  // (the new suburb auto-checks for them; nightly scrape picks it up).
  const [newSuburbDraft, setNewSuburbDraft] = useState('')
  const [addingSuburb, setAddingSuburb] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const meRes = await apiJson('/api/admin/me')
      setMe(meRes.user)
      const list = await apiJson('/api/admin/users')
      setUsers(list.users)
      // Suburbs list — admins see everything because they bypass the filter
      const subRes = await fetch('/api/suburbs', {
        headers: { 'X-Access-Key': getAccessKey() }
      }).then(r => r.json())
      setAllSuburbs(Array.isArray(subRes) ? subRes : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
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
            <th>Role</th><th>Last seen</th><th>Created</th><th></th>
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
              <td>{u.last_seen ? new Date(u.last_seen).toLocaleString() : 'Never'}</td>
              <td>{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
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
            <tr><td colSpan="7" className="empty">No users yet. Add one above.</td></tr>
          )}
        </tbody>
      </table>

      {assigning && (
        <div className="note-modal-overlay" onClick={() => setAssigning(null)}>
          <div className="note-modal admin-assign-modal" onClick={(e) => e.stopPropagation()}>
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
    </div>
  )
}

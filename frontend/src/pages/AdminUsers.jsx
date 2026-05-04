// AgentDeck admin — user management.
// Admin-only page that lists every user in the allowlist and lets
// the admin add new ones (which generates an access_key to share)
// or revoke access (delete row).

import { useState, useEffect } from 'react'

const ACCESS_KEY_STORAGE = 'agentdeck_access_key'


// Centralised fetch wrapper so every admin call carries the X-Access-Key
// header automatically and surfaces backend error messages clearly.
async function adminFetch(url, options = {}) {
  const key = localStorage.getItem(ACCESS_KEY_STORAGE) || ''
  const headers = {
    'X-Access-Key': key,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  }
  const res = await fetch(url, { ...options, headers })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `HTTP ${res.status}` } }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}


export default function AdminUsers() {
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // New-user form
  const [draft, setDraft] = useState({ email: '', first_name: '', last_name: '', phone: '', role: 'user' })
  const [saving, setSaving] = useState(false)
  // The access_key returned by the API on creation. Surfaced once in a
  // banner so the admin can copy it before refreshing the page.
  const [newKey, setNewKey] = useState(null)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const meRes = await adminFetch('/api/admin/me')
      setMe(meRes.user)
      const list = await adminFetch('/api/admin/users')
      setUsers(list.users)
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
      const res = await adminFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      setNewKey({ email: res.email, key: res.access_key })
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
      await adminFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      refresh()
    } catch (e) {
      alert(`Could not revoke: ${e.message}`)
    }
  }

  const toggleRole = async (u) => {
    const newRole = u.role === 'admin' ? 'user' : 'admin'
    try {
      await adminFetch(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      })
      refresh()
    } catch (e) {
      alert(`Could not change role: ${e.message}`)
    }
  }

  // Setup hint — the user pastes their access_key into a text field that
  // lives at the very top of the page when no key is stored, so they can
  // bootstrap themselves on first visit.
  const [keyInput, setKeyInput] = useState(localStorage.getItem(ACCESS_KEY_STORAGE) || '')
  const saveKey = () => {
    localStorage.setItem(ACCESS_KEY_STORAGE, keyInput.trim())
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
          Signed in as <strong>{me.email}</strong> ({me.role})
        </div>
      )}

      {error && <div className="admin-error">{error}</div>}
      {loading && <div className="admin-loading">Loading…</div>}

      {newKey && (
        <div className="admin-newkey">
          <div className="admin-newkey-title">
            ✓ User created — copy this key NOW, it won't be shown again
          </div>
          <div className="admin-newkey-row">
            <span className="admin-newkey-email">{newKey.email}</span>
            <code className="admin-newkey-code">{newKey.key}</code>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { navigator.clipboard.writeText(newKey.key); }}
            >
              Copy
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setNewKey(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <form className="admin-form" onSubmit={create}>
        <h3>Add user</h3>
        <div className="admin-form-grid">
          <input
            type="email" required placeholder="email@example.com"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          />
          <input
            placeholder="First name"
            value={draft.first_name}
            onChange={(e) => setDraft({ ...draft, first_name: e.target.value })}
          />
          <input
            placeholder="Last name"
            value={draft.last_name}
            onChange={(e) => setDraft({ ...draft, last_name: e.target.value })}
          />
          <input
            placeholder="Phone (optional)"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          />
          <select
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          >
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
            <th>Email</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Role</th>
            <th>Last seen</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{[u.first_name, u.last_name].filter(Boolean).join(' ') || '-'}</td>
              <td>{u.phone || '-'}</td>
              <td>
                <button
                  className={`role-pill role-${u.role}`}
                  onClick={() => toggleRole(u)}
                  title="Click to toggle role"
                >
                  {u.role}
                </button>
              </td>
              <td>{u.last_seen ? new Date(u.last_seen).toLocaleString() : 'Never'}</td>
              <td>{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
              <td>
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
            <tr>
              <td colSpan="7" className="empty">
                No users yet. Add one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// SuburbDesk admin — user management + suburb assignment.
// Admin-only page that lists every user, lets the admin add/revoke
// access, and manages which suburbs each user can see and scrape.
// "No tenant steals from any other" — a user only sees their assigned
// patch; admins see everything.

import { useState, useEffect, useRef } from 'react'
import { apiJson, getAccessKey, setAccessKey, readCache, writeCache } from '../lib/api'

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
  // Stale-while-revalidate: hydrate from localStorage synchronously so
  // returning to the Admin tab paints the user list INSTANTLY instead
  // of a 15-20s "Loading…" while Render wakes + the fetch lands. The
  // background refresh below overwrites once fresh data arrives.
  const [me, setMe] = useState(() => readCache('admin_me') || null)
  const [users, setUsers] = useState(() => readCache('admin_users') || [])
  const [allSuburbs, setAllSuburbs] = useState(() => readCache('admin_all_suburbs') || [])
  // Only block the page with "Loading…" when there's nothing cached to
  // show yet (first ever visit). With cache, refresh is silent.
  const [loading, setLoading] = useState(() => (readCache('admin_users') || []).length === 0)
  const [error, setError] = useState('')

  // New-user form
  const [draft, setDraft] = useState({ email: '', first_name: '', last_name: '', phone: '', role: 'user' })
  const [saving, setSaving] = useState(false)
  const [newKey, setNewKey] = useState(null)

  // Rental module: separate admin allowlist + per-user toggle.
  const [rentalSuburbs, setRentalSuburbs] = useState(() => readCache('admin_rental_suburbs') || [])
  const [newRentalSuburb, setNewRentalSuburb] = useState('')
  const [addingRentalSuburb, setAddingRentalSuburb] = useState(false)
  // Pending checkbox edits — keyed by suburb id, value is the new
  // active bool. Save button reads this set and POSTs the batch.
  const [pendingRental, setPendingRental] = useState({})
  const [savingRentalBatch, setSavingRentalBatch] = useState(false)

  // Unified Manage Access modal — sales suburbs + rental access +
  // rental suburbs + digest, all in one save. Shape:
  // { user, sales_suburb_ids: Set<int>, rental_access: bool,
  //   rental_assigned: Set<string>, rental_available: string[],
  //   digest_enabled: bool, loading: bool, saving: bool,
  //   message: string|null, error: string|null }
  const [managing, setManaging] = useState(null)
  // Escape closes the Manage Access modal — same affordance as the
  // backdrop click and the × button, so the operator never gets stuck.
  // Guard against closing mid-save: drop the keypress if a write is
  // in flight.
  useEffect(() => {
    if (!managing) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !managing.saving) setManaging(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [managing])

  // Per-user prospecting-letter profile — fed by /api/admin/me, saved
  // via PATCH /api/users/me/profile. Available to every authenticated
  // user, not just admins.
  const [profileDraft, setProfileDraft] = useState({
    agency_name: '', agent_name: '', agent_phone: '', agent_email: '',
    digest_enabled: true,
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)
  const [profileError, setProfileError] = useState('')

  const refresh = async () => {
    // Don't flash the "Loading…" blocker when we already have cached
    // rows on screen — refresh silently in the background instead.
    if (users.length === 0) setLoading(true)
    setError('')
    try {
      const meRes = await apiJson('/api/admin/me')
      setMe(meRes.user)
      writeCache('admin_me', meRes.user)
      setProfileDraft({
        agency_name: meRes.user?.agency_name || '',
        agent_name: meRes.user?.agent_name || '',
        agent_phone: meRes.user?.agent_phone || '',
        agent_email: meRes.user?.agent_email || '',
        // digest_enabled defaults to true server-side; coerce ints to bool.
        digest_enabled: meRes.user?.digest_enabled !== 0 && meRes.user?.digest_enabled !== false,
      })
      // Admin-only calls — wrapped so non-admins still reach the
      // profile form below instead of crashing the whole page.
      // Fired in parallel (Promise.all) so the admin page bootstrap +
      // every post-save refresh pays ONE round-trip latency, not three
      // stacked. apiJson guards on res.ok and throws a clean error
      // instead of choking on a Render cold-start HTML 502.
      try {
        const [list, subRes, rs] = await Promise.all([
          apiJson('/api/admin/users'),
          apiJson('/api/suburbs'),
          apiJson('/api/admin/rental-suburbs').catch(() => null),
        ])
        setUsers(list.users)
        writeCache('admin_users', list.users)
        const subs = Array.isArray(subRes) ? subRes : []
        setAllSuburbs(subs)
        writeCache('admin_all_suburbs', subs)
        // rs null = rental tables not initialised yet — silent skip.
        if (rs) {
          setRentalSuburbs(rs.suburbs || [])
          writeCache('admin_rental_suburbs', rs.suburbs || [])
        }
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

  const toggleDigest = async (u) => {
    const cur = u.digest_enabled !== 0 && u.digest_enabled !== false
    try {
      await apiJson(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ digest_enabled: !cur }),
      })
      refresh()
    } catch (e) {
      alert(`Could not toggle morning digest: ${e.message}`)
    }
  }

  // Unified Manage Access modal — opens with optimistic placeholder
  // state (from the user row that's already in the table) then patches
  // in the authoritative server state once the two fetches return.
  const openManage = async (u) => {
    const optimisticDigest = u.digest_enabled !== 0 && u.digest_enabled !== false
    setManaging({
      user: u,
      sales_suburb_ids: new Set(),
      sales_user_suburbs: [],
      rental_access: !!u.rental_access,
      rental_assigned: new Set(),
      rental_available: [],
      all_suburbs: !!u.all_suburbs,
      can_add_suburbs: !!u.can_add_suburbs,
      digest_enabled: optimisticDigest,
      loading: true,
      saving: false,
      message: null,
      error: null,
      customSearch: '',
      customSuggestions: [],
      customAdding: false,
      rentalCustomSearch: '',
      rentalCustomSuggestions: [],
      rentalCustomAdding: false,
    })
    // Fire both calls independently and paint each section as it lands
    // — the sales grid (primary content) clears `loading` as soon as it
    // arrives instead of waiting for the rental call too, so the modal
    // feels responsive even when one endpoint is slower.
    apiJson(`/api/admin/users/${u.id}/suburbs`)
      .then(salesRes => setManaging(prev => prev && prev.user.id === u.id ? {
        ...prev,
        sales_suburb_ids: new Set(salesRes.suburb_ids || []),
        // {id, name} pairs of every assigned suburb — incl. active=0
        // customs absent from allSuburbs — so they still render a row.
        sales_user_suburbs: salesRes.suburbs || [],
        loading: false,
      } : prev))
      .catch(e => setManaging(prev => prev && prev.user.id === u.id
        ? { ...prev, loading: false, error: `Load failed: ${e.message}` }
        : prev))
    apiJson(`/api/admin/users/${u.id}/rental-suburbs`)
      .then(rentalRes => setManaging(prev => prev && prev.user.id === u.id ? {
        ...prev,
        rental_assigned: new Set(rentalRes.assigned || []),
        rental_available: rentalRes.available || [],
      } : prev))
      .catch(() => { /* rentals optional — sales already cleared loading */ })
  }

  // Debounced suburb search for the custom-add row in the Sales
  // section. Calls /api/suburbs/search which returns ALL WA suburb
  // names from wa_suburbs.py (much wider than the 15 currently
  // scraped suburbs), so the admin can scope a user to any suburb.
  const customSearchTimerRef = useRef(null)
  const onManagingCustomSearch = (q) => {
    updateManaging({ customSearch: q })
    if (customSearchTimerRef.current) clearTimeout(customSearchTimerRef.current)
    if (!q.trim()) {
      updateManaging({ customSuggestions: [] })
      return
    }
    customSearchTimerRef.current = setTimeout(async () => {
      try {
        const matches = await apiJson(`/api/suburbs/search?q=${encodeURIComponent(q.trim())}`)
        setManaging(m => m ? { ...m, customSuggestions: Array.isArray(matches) ? matches : [] } : m)
      } catch {}
    }, 300)
  }

  const addCustomSuburb = async (name) => {
    if (!managing || managing.customAdding) return
    const target = (name || managing.customSearch || '').trim()
    if (!target) return
    updateManaging({ customAdding: true, error: null })
    try {
      const res = await apiJson(`/api/admin/users/${managing.user.id}/suburbs/custom`, {
        method: 'POST',
        body: JSON.stringify({ suburb_name: target }),
      })
      setManaging(m => {
        if (!m) return m
        const nextIds = new Set(m.sales_suburb_ids)
        nextIds.add(res.suburb_id)
        const exists = (m.sales_user_suburbs || []).some(s => s.id === res.suburb_id)
        const nextUser = exists
          ? m.sales_user_suburbs
          : [...(m.sales_user_suburbs || []), { id: res.suburb_id, name: res.suburb_name, active: 0 }]
        return {
          ...m,
          sales_suburb_ids: nextIds,
          sales_user_suburbs: nextUser,
          customSearch: '',
          customSuggestions: [],
          customAdding: false,
        }
      })
    } catch (e) {
      updateManaging({ customAdding: false, error: `Could not add suburb: ${e.message}` })
    }
  }

  // Same shape as the sales custom-add above, but POSTs to the
  // rental-side route and pushes the new entry into rental_available
  // + rental_assigned so the checkbox renders ticked immediately.
  const rentalSearchTimerRef = useRef(null)
  const onManagingRentalCustomSearch = (q) => {
    updateManaging({ rentalCustomSearch: q })
    if (rentalSearchTimerRef.current) clearTimeout(rentalSearchTimerRef.current)
    if (!q.trim()) {
      updateManaging({ rentalCustomSuggestions: [] })
      return
    }
    rentalSearchTimerRef.current = setTimeout(async () => {
      try {
        const matches = await apiJson(`/api/suburbs/search?q=${encodeURIComponent(q.trim())}`)
        setManaging(m => m ? { ...m, rentalCustomSuggestions: Array.isArray(matches) ? matches : [] } : m)
      } catch {}
    }, 300)
  }

  const addCustomRentalSuburb = async (name) => {
    if (!managing || managing.rentalCustomAdding) return
    const target = (name || managing.rentalCustomSearch || '').trim()
    if (!target) return
    updateManaging({ rentalCustomAdding: true, error: null })
    try {
      const res = await apiJson(`/api/admin/users/${managing.user.id}/rental-suburbs/custom`, {
        method: 'POST',
        body: JSON.stringify({ suburb_name: target }),
      })
      const canonical = res.suburb_name || target
      setManaging(m => {
        if (!m) return m
        const nextAvail = (m.rental_available || []).includes(canonical)
          ? m.rental_available
          : [...(m.rental_available || []), canonical].sort((a, b) => a.localeCompare(b))
        const nextAssigned = new Set(m.rental_assigned)
        nextAssigned.add(canonical)
        return {
          ...m,
          rental_available: nextAvail,
          rental_assigned: nextAssigned,
          rentalCustomSearch: '',
          rentalCustomSuggestions: [],
          rentalCustomAdding: false,
        }
      })
    } catch (e) {
      updateManaging({ rentalCustomAdding: false, error: `Could not add rental suburb: ${e.message}` })
    }
  }

  const updateManaging = (patch) => setManaging(m => m ? { ...m, ...patch } : m)

  const toggleManagingSales = (sid) => setManaging(m => {
    if (!m) return m
    const next = new Set(m.sales_suburb_ids)
    if (next.has(sid)) next.delete(sid); else next.add(sid)
    return { ...m, sales_suburb_ids: next }
  })

  const toggleManagingRental = (name) => setManaging(m => {
    if (!m) return m
    const next = new Set(m.rental_assigned)
    if (next.has(name)) next.delete(name); else next.add(name)
    return { ...m, rental_assigned: next }
  })

  // One Save button does everything: PUT sales, PATCH flags, then
  // POST/DELETE per rental-suburb diff. Stops early on the PUT/PATCH
  // failures (they're the user-scope flags); soldiers through rental
  // failures and reports a count so the operator can retry.
  const saveManagement = async () => {
    if (!managing) return
    updateManaging({ saving: true, error: null, message: null })
    const m = managing
    const userId = m.user.id
    try {
      // 1) Sales suburb assignment — full replace
      await apiJson(`/api/admin/users/${userId}/suburbs`, {
        method: 'PUT',
        body: JSON.stringify({ suburb_ids: Array.from(m.sales_suburb_ids) }),
      })
      // 2) Feature flags — rental_access + digest_enabled + all_suburbs
      //    in one PATCH
      await apiJson(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          rental_access: m.rental_access,
          digest_enabled: m.digest_enabled,
          all_suburbs: m.all_suburbs,
          can_add_suburbs: m.can_add_suburbs,
        }),
      })
      // 3) Rental suburb full-replace in ONE call — was a GET + a
      //    POST-per-add + DELETE-per-remove loop (N sequential requests,
      //    ~a minute over Render's US->AU latency). Skip entirely when
      //    rental access is off.
      let failures = 0
      if (m.rental_access) {
        try {
          const res = await apiJson(`/api/admin/users/${userId}/rental-suburbs`, {
            method: 'PUT',
            body: JSON.stringify({ suburb_names: [...m.rental_assigned] }),
          })
          failures = (res.skipped || []).length
        } catch (e) {
          console.warn('rental-suburbs PUT failed:', e.message)
          failures = m.rental_assigned.size || 1
        }
      }
      const msg = failures > 0
        ? `Saved with ${failures} rental suburb error(s) — retry to fix.`
        : 'Saved.'
      updateManaging({ saving: false, message: msg })
      refresh()
    } catch (e) {
      updateManaging({ saving: false, error: `Save failed: ${e.message}` })
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
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <h4 style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--text)' }}>Notifications</h4>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={profileDraft.digest_enabled}
                onChange={(e) => setProfileDraft({ ...profileDraft, digest_enabled: e.target.checked })}
              />
              Send me the SuburbDesk Morning Brief (after the nightly scrape)
            </label>
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
            <th>Role</th><th>Suburbs</th><th>Rental</th><th>Digest</th>
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
                    onClick={() => openManage(u)}
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
                    onClick={() => openManage(u)}
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
              <td style={{ textAlign: 'center' }}>
                {(() => {
                  const on = u.digest_enabled !== 0 && u.digest_enabled !== false
                  return (
                    <button
                      type="button"
                      onClick={() => toggleDigest(u)}
                      title={on ? 'Click to disable morning digest' : 'Click to enable morning digest'}
                      style={{
                        cursor: 'pointer', border: 'none', padding: '3px 10px',
                        borderRadius: 10, fontSize: 11, fontWeight: 600,
                        background: on ? '#d1fae5' : '#f3f4f6',
                        color: on ? '#065f46' : '#9ca3af',
                      }}
                    >
                      {on ? 'ON' : 'OFF'}
                    </button>
                  )
                })()}
              </td>
              <td>{u.last_seen ? fmtPerthDateTime(u.last_seen) : 'Never'}</td>
              <td>{u.created_at ? fmtPerthDate(u.created_at) : '-'}</td>
              <td className="admin-row-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => openManage(u)}
                  disabled={u.role === 'admin'}
                  title={u.role === 'admin'
                    ? 'Admins see every suburb / rental / digest automatically'
                    : 'Manage sales suburbs, rental access and notifications in one place'}
                >
                  Manage Access
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
            ℹ️ Active suburbs are automatically scraped nightly at midnight Perth time.
          </p>
        </div>
      )}

      {managing && (
        // Inline styles override the legacy note-modal CSS so the
        // header + footer stay visible regardless of body length and
        // the backdrop click closes — the previous markup relied on
        // CSS that pinned the modal to the viewport top and pushed the
        // close button + Save action below the fold on small screens.
        <div
          onClick={() => { if (!managing.saving) setManaging(null) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 8,
              width: '100%', maxWidth: 640, maxHeight: '85vh',
              display: 'flex', flexDirection: 'column',
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            }}
          >
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
              flexShrink: 0,
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
              gap: 16,
            }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Manage Access</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {[managing.user.first_name, managing.user.last_name].filter(Boolean).join(' ') || managing.user.email}
                  {' — '}{managing.user.email}
                  {' · Role: '}{managing.user.role}
                </div>
              </div>
              <button
                type="button"
                onClick={() => { if (!managing.saving) setManaging(null) }}
                aria-label="Close"
                style={{
                  background: 'none', border: 'none',
                  fontSize: 24, lineHeight: 1, color: '#6b7280',
                  cursor: 'pointer', padding: 0, width: 32, height: 32,
                  flexShrink: 0,
                }}
              >×</button>
            </div>

            <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
            {managing.loading && (
              <div className="admin-assign-hint">Loading current access…</div>
            )}

            {/* All-suburbs access — full read scope without per-suburb
                assignment. When on, the sales grid below is irrelevant
                (the user already sees every suburb, current + future). */}
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '10px 12px', marginTop: 4, marginBottom: 8,
              background: managing.all_suburbs ? '#eff6ff' : 'transparent',
              border: '1px solid', borderColor: managing.all_suburbs ? '#bfdbfe' : 'var(--border)',
              borderRadius: 6, cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={!!managing.all_suburbs}
                onChange={() => updateManaging({ all_suburbs: !managing.all_suburbs })}
                disabled={managing.saving || managing.loading}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong style={{ fontSize: 13 }}>Access to all suburbs</strong>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Sees every suburb now and any added later — no per-suburb
                  assignment needed. Stays a regular user (no admin powers).
                </span>
              </span>
            </label>

            {/* Can add suburbs — lets this user introduce NEW suburbs
                to the system (scraped nightly) without the admin role. */}
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '10px 12px', marginBottom: 8,
              background: managing.can_add_suburbs ? '#eff6ff' : 'transparent',
              border: '1px solid', borderColor: managing.can_add_suburbs ? '#bfdbfe' : 'var(--border)',
              borderRadius: 6, cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={!!managing.can_add_suburbs}
                onChange={() => updateManaging({ can_add_suburbs: !managing.can_add_suburbs })}
                disabled={managing.saving || managing.loading}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong style={{ fontSize: 13 }}>Can add new suburbs</strong>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Shows the "+ add suburb" box in their sidebar so they can
                  start scraping any WA suburb themselves. Still no admin powers.
                </span>
              </span>
            </label>

            {/* Sales suburbs — disabled when all-suburbs is on. */}
            <div style={{ marginTop: 4, opacity: managing.all_suburbs ? 0.45 : 1, pointerEvents: managing.all_suburbs ? 'none' : 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>Sales suburbs</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button" className="btn btn-ghost btn-sm"
                    onClick={() => updateManaging({
                      sales_suburb_ids: new Set([
                        ...allSuburbs.map(s => s.id),
                        ...(managing.sales_user_suburbs || []).map(s => s.id),
                      ]),
                    })}
                    disabled={managing.saving || managing.loading}
                  >Select all</button>
                  <button
                    type="button" className="btn btn-ghost btn-sm"
                    onClick={() => updateManaging({ sales_suburb_ids: new Set() })}
                    disabled={managing.saving || managing.loading}
                  >Clear all</button>
                </div>
              </div>
              <div className="admin-assign-grid">
                {(() => {
                  // Merge: every active suburb (allSuburbs) plus every
                  // assigned suburb that is NOT in the active list
                  // (custom adds with active=0). Deduped by id, sorted
                  // by name. Without this, custom suburbs would be
                  // ticked in sales_suburb_ids state but never render
                  // as a row.
                  const byId = new Map()
                  for (const s of allSuburbs) byId.set(s.id, { ...s, active: 1 })
                  for (const s of (managing.sales_user_suburbs || [])) {
                    if (!byId.has(s.id)) byId.set(s.id, { ...s, active: 0 })
                  }
                  const merged = Array.from(byId.values()).sort((a, b) =>
                    (a.name || '').localeCompare(b.name || '')
                  )
                  return merged.map(s => (
                    <label key={s.id} className="admin-assign-row">
                      <input
                        type="checkbox"
                        checked={managing.sales_suburb_ids.has(s.id)}
                        onChange={() => toggleManagingSales(s.id)}
                        disabled={managing.saving || managing.loading}
                      />
                      <span className="admin-assign-name">{s.name}</span>
                      {!s.active && (
                        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 4 }}>(custom)</span>
                      )}
                    </label>
                  ))
                })()}
                {!allSuburbs.length && !(managing.sales_user_suburbs || []).length && (
                  <div className="empty">No sales suburbs in the system yet.</div>
                )}
              </div>

              {/* Search-to-add: any WA suburb (from wa_suburbs.py), not
                  just the 15 currently-scraped ones. POSTed to the
                  /custom route which inserts with active=0 when the
                  suburb isn't already in the suburbs table, then
                  upserts the user_suburbs assignment. */}
              <div style={{ marginTop: 10, display: 'flex', gap: 6, position: 'relative' }}>
                <input
                  type="text"
                  value={managing.customSearch}
                  onChange={(e) => onManagingCustomSearch(e.target.value)}
                  placeholder="Search any WA suburb to add…"
                  disabled={managing.saving || managing.loading || managing.customAdding}
                  style={{
                    flex: 1, padding: '6px 10px', fontSize: 13,
                    border: '1px solid #d1d5db', borderRadius: 6,
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addCustomSuburb(managing.customSearch)
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => addCustomSuburb(managing.customSearch)}
                  disabled={!managing.customSearch.trim() || managing.customAdding}
                >
                  {managing.customAdding ? 'Adding…' : '+ Add'}
                </button>
                {managing.customSuggestions && managing.customSuggestions.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0,
                    background: '#fff', border: '1px solid #d1d5db',
                    borderRadius: 6, marginTop: 4, maxHeight: 180, overflowY: 'auto',
                    zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  }}>
                    {managing.customSuggestions.slice(0, 10).map(name => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => addCustomSuburb(name)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '6px 12px', background: 'transparent',
                          border: 'none', borderBottom: '1px solid #f3f4f6',
                          fontSize: 13, cursor: 'pointer',
                        }}
                      >{name}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Rental access + suburbs */}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {/* The toggle is hydrated from the row (u.rental_access)
                    the instant the modal opens, so it doesn't depend on
                    the async fetch — disable only while a save is in
                    flight, not while the suburb lists are loading. */}
                <input
                  type="checkbox"
                  checked={managing.rental_access}
                  onChange={(e) => updateManaging({ rental_access: e.target.checked })}
                  disabled={managing.saving}
                />
                Rental enabled
              </label>
              {managing.rental_access && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <strong style={{ fontSize: 12, color: 'var(--text-muted)' }}>Rental suburbs</strong>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button" className="btn btn-ghost btn-sm"
                        onClick={() => updateManaging({ rental_assigned: new Set(managing.rental_available) })}
                        disabled={managing.saving || managing.loading}
                      >Select all</button>
                      <button
                        type="button" className="btn btn-ghost btn-sm"
                        onClick={() => updateManaging({ rental_assigned: new Set() })}
                        disabled={managing.saving || managing.loading}
                      >Clear all</button>
                    </div>
                  </div>
                  <div className="admin-assign-grid">
                    {(managing.rental_available || []).map(name => (
                      <label key={name} className="admin-assign-row">
                        <input
                          type="checkbox"
                          checked={managing.rental_assigned.has(name)}
                          onChange={() => toggleManagingRental(name)}
                          disabled={managing.saving || managing.loading}
                        />
                        <span className="admin-assign-name">{name}</span>
                      </label>
                    ))}
                    {!(managing.rental_available && managing.rental_available.length) && (
                      <div className="empty">No rental suburbs available — set them up in the Rental Suburbs panel below.</div>
                    )}
                  </div>

                  {/* Mirrors the sales search-to-add row but POSTs to
                      /rental-suburbs/custom — pushes the canonical
                      name into rental_available and rental_assigned
                      so the freshly-added row renders ticked. */}
                  <div style={{ marginTop: 10, display: 'flex', gap: 6, position: 'relative' }}>
                    <input
                      type="text"
                      value={managing.rentalCustomSearch || ''}
                      onChange={(e) => onManagingRentalCustomSearch(e.target.value)}
                      placeholder="Search any WA suburb to add (rental)…"
                      disabled={managing.saving || managing.loading || managing.rentalCustomAdding}
                      style={{
                        flex: 1, padding: '6px 10px', fontSize: 13,
                        border: '1px solid #d1d5db', borderRadius: 6,
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addCustomRentalSuburb(managing.rentalCustomSearch)
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => addCustomRentalSuburb(managing.rentalCustomSearch)}
                      disabled={!(managing.rentalCustomSearch || '').trim() || managing.rentalCustomAdding}
                    >
                      {managing.rentalCustomAdding ? 'Adding…' : '+ Add'}
                    </button>
                    {managing.rentalCustomSuggestions && managing.rentalCustomSuggestions.length > 0 && (
                      <div style={{
                        position: 'absolute', top: '100%', left: 0, right: 0,
                        background: '#fff', border: '1px solid #d1d5db',
                        borderRadius: 6, marginTop: 4, maxHeight: 180, overflowY: 'auto',
                        zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                      }}>
                        {managing.rentalCustomSuggestions.slice(0, 10).map(name => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => addCustomRentalSuburb(name)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '6px 12px', background: 'transparent',
                              border: 'none', borderBottom: '1px solid #f3f4f6',
                              fontSize: 13, cursor: 'pointer',
                            }}
                          >{name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Features */}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>Features</strong>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                {/* digest_enabled is hydrated from u (row data) the
                    instant the modal opens — no dependency on the
                    suburb fetch, so gate only on saving. */}
                <input
                  type="checkbox"
                  checked={managing.digest_enabled}
                  onChange={(e) => updateManaging({ digest_enabled: e.target.checked })}
                  disabled={managing.saving}
                />
                Morning digest email
              </label>
            </div>

            {managing.error && (
              <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', fontSize: 12 }}>
                {managing.error}
              </div>
            )}
            {managing.message && !managing.error && (
              <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: '#ecfdf5', border: '1px solid #6ee7b7', color: '#065f46', fontSize: 12 }}>
                {managing.message}
              </div>
            )}

            </div>{/* end scrollable body */}

            <div style={{
              padding: '12px 20px', borderTop: '1px solid #e5e7eb',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, background: '#fafafa',
            }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                {managing.all_suburbs ? 'all suburbs' : `${managing.sales_suburb_ids.size} sales`} · {managing.rental_access ? `${managing.rental_assigned.size} rental` : 'rental off'} · digest {managing.digest_enabled ? 'on' : 'off'}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setManaging(null)}
                  disabled={managing.saving}
                >Close</button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveManagement}
                  disabled={managing.saving || managing.loading}
                >
                  {managing.saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

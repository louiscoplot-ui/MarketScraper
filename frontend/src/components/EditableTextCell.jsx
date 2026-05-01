import { useState, useEffect, useRef } from 'react'

// Click a text cell → it becomes a text input. Blur / Enter saves,
// Escape cancels. Used for free-form columns like price_text where
// the agent has off-platform info ("Price guide $1.8M from chat with
// the agency") they want to attach to the listing.

export default function EditableTextCell({ value, onSave, placeholder = '+ edit' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.select()
    }
  }, [editing])

  const start = () => {
    setDraft(value || '')
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== (value || '').trim()) {
      onSave(next || null)
    }
  }

  const cancel = () => setEditing(false)

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        value={draft}
        className="editable-text-input"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') cancel()
        }}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className={`editable-cell${value ? '' : ' editable-cell-empty'}`}
      onClick={(e) => { e.stopPropagation(); start() }}
      title="Click to edit"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') start() }}
    >
      {value || placeholder}
    </span>
  )
}

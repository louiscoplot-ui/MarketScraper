import { useState, useEffect, useRef } from 'react'

// Click a date cell → it becomes an HTML5 date input. Pick a value,
// blur or hit Enter → onSave is called with YYYY-MM-DD (or empty).
// Escape cancels.
//
// Two date formats roam the codebase:
//   - listing_date is REIWA-style "DD/MM/YYYY"
//   - sold_date / withdrawn_date are ISO ("2026-04-28" or "2026-04-28T..")
// This component normalises both into the YYYY-MM-DD form for the input
// and renders DD/MM/YYYY for display, so the parent only has to know
// which field it's binding.

function toInputDate(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return ''
}

function toDisplayDate(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split('-')
    return `${d}/${m}/${y}`
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) return value
  return value
}


export default function EditableDateCell({ value, onSave, placeholder = '+ add' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      // Some browsers (Chrome/Edge) auto-open the picker on focus,
      // others (Firefox/Safari) require an explicit user action.
      ref.current.showPicker?.()
    }
  }, [editing])

  const start = () => {
    setDraft(toInputDate(value))
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    const original = toInputDate(value)
    if (draft !== original) {
      onSave(draft || null)
    }
  }

  const cancel = () => setEditing(false)

  if (editing) {
    return (
      <input
        ref={ref}
        type="date"
        value={draft}
        className="editable-date-input"
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

  const display = toDisplayDate(value)
  return (
    <span
      className={`editable-cell${display ? '' : ' editable-cell-empty'}`}
      onClick={(e) => { e.stopPropagation(); start() }}
      title="Click to edit"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') start() }}
    >
      {display || placeholder}
    </span>
  )
}

// MultiSelect — a chips-based multi picker. Replaces the 18 raw suburb
// checkboxes in the Market Report and the ad-hoc suburb dropdown in
// HotVendors. Closed state shows the selected values as removable
// chips; a trigger opens a checkbox menu (built on Checkbox).
//
// Controlled: `selected` is an array of values, `onChange(nextArray)`.
// `options` is [{ value, label }]. Purely presentational — the caller
// owns the list and the fetch it drives.
import { useState, useRef, useEffect } from 'react'
import { ChevronDown, X } from 'lucide-react'
import Checkbox from './Checkbox'

export default function MultiSelect({
  options = [],
  selected = [],
  onChange,
  placeholder = 'Select…',
  allLabel = 'All',
  size = 'md',
  style,
}) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const selectedSet = new Set(selected)
  const labelFor = (v) => options.find((o) => o.value === v)?.label ?? v
  const toggle = (v) => {
    const next = new Set(selectedSet)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange?.([...next])
  }
  const clearAll = () => onChange?.([])
  const selectAll = () => onChange?.(options.map((o) => o.value))

  const fontSize = size === 'sm' ? 12 : 13

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', ...style }}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) setOpen(false) }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // Only the trigger itself — chip × buttons handle their own keys.
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) }
        }}
        onFocus={(e) => { if (e.target === e.currentTarget) setFocused(true) }}
        onBlur={(e) => { if (e.target === e.currentTarget) setFocused(false) }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          minHeight: size === 'sm' ? 30 : 36,
          padding: '4px 8px',
          fontSize,
          background: 'var(--surface)',
          border: `1px solid ${open || focused ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          outline: 'none',
          boxShadow: open || focused ? 'var(--focus-ring)' : 'none',
        }}
      >
        {selected.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>{placeholder}</span>
        ) : options.length > 1 && selected.length === options.length ? (
          // Everything selected → collapse to one "All (N)" chip instead
          // of N chips. Clicking the × clears the selection (deselect all).
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 6px 2px 8px', fontSize: fontSize - 1,
              fontWeight: 600, background: 'var(--accent-soft)',
              color: 'var(--accent)', borderRadius: 'var(--radius-pill)',
            }}
          >
            {allLabel} ({options.length})
            <button
              type="button"
              aria-label="Clear selection"
              onClick={(e) => { e.stopPropagation(); clearAll() }}
              style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, color: 'inherit', cursor: 'pointer', flexShrink: 0 }}
            >
              <X size={13} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </span>
        ) : (
          selected.map((v) => (
            <span
              key={v}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px 2px 8px',
                fontSize: fontSize - 1,
                fontWeight: 600,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                borderRadius: 'var(--radius-pill)',
              }}
            >
              {labelFor(v)}
              <button
                type="button"
                aria-label={`Remove ${labelFor(v)}`}
                onClick={(e) => { e.stopPropagation(); toggle(v) }}
                style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, color: 'inherit', cursor: 'pointer', flexShrink: 0 }}
              >
                <X size={13} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </span>
          ))
        )}
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          style={{ marginLeft: 'auto', color: 'var(--text-muted)', flexShrink: 0 }}
        />
      </div>

      {open && (
        <div
          style={{
            position: 'absolute',
            zIndex: 50,
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: '100%',
            maxHeight: 280,
            overflowY: 'auto',
            padding: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-pop)',
          }}
        >
          <div style={{ display: 'flex', gap: 12, padding: '4px 8px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            <button
              type="button"
              onClick={selectAll}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}
            >
              {allLabel}
            </button>
            <button
              type="button"
              onClick={clearAll}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}
            >
              Clear
            </button>
          </div>
          {options.map((o) => (
            <div
              key={o.value}
              style={{ padding: '5px 8px', borderRadius: 'var(--radius-sm)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <Checkbox
                checked={selectedSet.has(o.value)}
                onChange={() => toggle(o.value)}
                label={o.label}
                size={size}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

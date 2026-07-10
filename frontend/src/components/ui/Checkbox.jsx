// Checkbox — the single checkbox component for the whole app (Report
// suburb filters, Admin suburb assignment, HotVendors suburb menu).
// A visually-hidden native input keeps keyboard + form semantics; the
// visible box is a styled span that fills with the brand accent and a
// lucide Check when checked.
import { useState } from 'react'
import { Check } from 'lucide-react'

export default function Checkbox({
  checked = false,
  onChange,
  label,
  disabled = false,
  size = 'md',
  style,
}) {
  const box = size === 'sm' ? 15 : 17
  const tick = size === 'sm' ? 11 : 13
  // The native input is visually hidden, so keyboard focus must be
  // mirrored onto the visible box (inline styles can't express
  // `input:focus-visible + span`).
  const [focused, setFocused] = useState(false)

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: size === 'sm' ? 12 : 13,
        color: 'var(--text)',
        userSelect: 'none',
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          position: 'absolute',
          opacity: 0,
          width: 0,
          height: 0,
        }}
      />
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: box,
          height: box,
          flexShrink: 0,
          borderRadius: 'var(--radius-sm)',
          border: `1px solid ${checked || focused ? 'var(--accent)' : 'var(--border)'}`,
          background: checked ? 'var(--accent)' : 'var(--surface)',
          boxShadow: focused ? 'var(--focus-ring)' : 'none',
          transition: 'background 0.12s, border-color 0.12s',
        }}
      >
        {checked && <Check size={tick} strokeWidth={3} color="var(--accent-fg)" />}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  )
}

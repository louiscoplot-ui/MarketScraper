// Select — a styled wrapper around the native <select> so every
// dropdown in the app looks identical without losing native keyboard
// / mobile behaviour. Replaces the dozens of bare <select> with
// inline padding scattered across Pipeline, Signals, HotVendors, Admin.
//
// We keep the real <select> (accessibility + mobile pickers for free)
// and just style it + overlay a lucide ChevronDown, hiding the native
// arrow. Options are passed as [{ value, label }] OR as children.
import { ChevronDown } from 'lucide-react'

export default function Select({
  value,
  onChange,
  options,
  children,
  disabled = false,
  size = 'md',
  title,
  style,
  ...rest
}) {
  const dims = size === 'sm'
    ? { padding: '5px 28px 5px 10px', fontSize: 12 }
    : { padding: '8px 30px 8px 12px', fontSize: 13 }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        title={title}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          padding: dims.padding,
          fontSize: dims.fontSize,
          fontFamily: 'inherit',
          fontWeight: 500,
          color: 'var(--text)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          outline: 'none',
          ...style,
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = 'var(--focus-ring)' }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
        {...rest}
      >
        {options
          ? options.map((o) => (
              <option key={o.value ?? o.label} value={o.value}>{o.label}</option>
            ))
          : children}
      </select>
      <ChevronDown
        size={size === 'sm' ? 14 : 16}
        strokeWidth={2}
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: 9,
          color: 'var(--text-muted)',
          pointerEvents: 'none',
        }}
      />
    </span>
  )
}

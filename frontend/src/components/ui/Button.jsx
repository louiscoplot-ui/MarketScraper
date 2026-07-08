// Button — the single button primitive for the whole app.
//
// Variants:
//   primary   → brand green fill (#386350 via --accent), white text.
//               The one call-to-action colour. Generate, Save, Sign in.
//   secondary → outline: brand-green border + text on surface. The
//               "second choice" next to a primary (Cancel-adjacent
//               actions that still matter).
//   ghost     → no border/background until hover. Row actions, tertiary.
//   danger    → alert-red outline → fill on hover. Destructive only.
//
// State:
//   loading  → shows a Spinner in place of the leading icon, disables
//              the button, keeps the label so width doesn't jump.
//   disabled → 0.5 opacity, no pointer.
//
// Icons come from lucide-react and are passed as a component via the
// `icon` prop (leading) — never an emoji. size 'sm' | 'md'.
import Spinner from './Spinner'

const SIZES = {
  sm: { padding: '5px 10px', fontSize: 12, gap: 6, icon: 14 },
  md: { padding: '8px 14px', fontSize: 13, gap: 8, icon: 16 },
}

const VARIANTS = {
  primary: {
    background: 'var(--accent)',
    color: 'var(--accent-fg)',
    border: '1px solid var(--accent)',
    '--hover-bg': 'var(--accent-hover)',
    '--hover-border': 'var(--accent-hover)',
  },
  secondary: {
    background: 'var(--surface)',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    '--hover-bg': 'var(--accent-soft)',
    '--hover-border': 'var(--accent)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid transparent',
    '--hover-bg': 'var(--surface-hover)',
    '--hover-border': 'transparent',
  },
  danger: {
    background: 'var(--surface)',
    color: 'var(--status-alert-text)',
    border: '1px solid var(--status-alert)',
    '--hover-bg': 'var(--status-alert)',
    '--hover-border': 'var(--status-alert)',
    '--hover-color': 'var(--accent-fg)',
  },
}

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabled = false,
  type = 'button',
  onClick,
  title,
  style,
  ...rest
}) {
  const s = SIZES[size] || SIZES.md
  const v = VARIANTS[variant] || VARIANTS.primary
  const isDisabled = disabled || loading

  const hoverBg = v['--hover-bg']
  const hoverBorder = v['--hover-border']
  const hoverColor = v['--hover-color']

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      onMouseEnter={(e) => {
        if (isDisabled) return
        if (hoverBg) e.currentTarget.style.background = hoverBg
        if (hoverBorder) e.currentTarget.style.borderColor = hoverBorder
        if (hoverColor) e.currentTarget.style.color = hoverColor
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = v.background
        e.currentTarget.style.borderColor = v.border.split(' ').pop()
        e.currentTarget.style.color = v.color
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        padding: s.padding,
        fontSize: s.fontSize,
        fontWeight: 600,
        fontFamily: 'inherit',
        lineHeight: 1.2,
        borderRadius: 'var(--radius-sm)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled && !loading ? 0.5 : 1,
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        whiteSpace: 'nowrap',
        background: v.background,
        color: v.color,
        border: v.border,
        ...style,
      }}
      {...rest}
    >
      {loading ? (
        <Spinner size={s.icon} inline />
      ) : Icon ? (
        <Icon size={s.icon} strokeWidth={2} aria-hidden="true" />
      ) : null}
      {children}
    </button>
  )
}

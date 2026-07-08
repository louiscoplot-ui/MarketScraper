// Chip — a small status pill. The ONLY way a screen renders a status
// colour, so no screen can invent its own hex.
//
// A single `status` prop selects the palette from the token status
// grammar (tokens.css). That's the whole contract:
//
//   status="good"   → green   (active, valid, won)
//   status="watch"  → amber   (under offer, expiring, pending)
//   status="info"   → blue    (sold, informational)
//   status="alert"  → red     (stale, price drop, REAL alerts only)
//   status="off"    → grey    (withdrawn-as-neutral, empty, inactive)
//
// Listing aliases map to the same five so callers can speak listing
// language without memorising the grammar:
//   active → good · under_offer → watch · sold → info ·
//   withdrawn → alert (hot lead — deliberately NOT greyed) · else off
//
// Each palette uses the -bg (soft fill) + -text (AA-dark text) token
// pair, so contrast is guaranteed (all ≥ 6.3:1, verified Phase 1).
// Optional leading dot (default on) or a lucide icon via `icon`.

const STATUS_ALIAS = {
  active: 'good',
  under_offer: 'watch',
  'under offer': 'watch',
  sold: 'info',
  withdrawn: 'alert',
  won: 'good',
  lost: 'off',
  new: 'info',
  leased: 'off',
}

const PALETTE = {
  good: { bg: 'var(--status-good-bg)', fg: 'var(--status-good-text)', dot: 'var(--status-good)' },
  watch: { bg: 'var(--status-watch-bg)', fg: 'var(--status-watch-text)', dot: 'var(--status-watch)' },
  info: { bg: 'var(--status-info-bg)', fg: 'var(--status-info-text)', dot: 'var(--status-info)' },
  alert: { bg: 'var(--status-alert-bg)', fg: 'var(--status-alert-text)', dot: 'var(--status-alert)' },
  off: { bg: 'var(--status-off-bg)', fg: 'var(--status-off-text)', dot: 'var(--status-off)' },
}

export function resolveStatus(status) {
  const key = String(status || '').toLowerCase()
  if (PALETTE[key]) return key
  return STATUS_ALIAS[key] || 'off'
}

export default function Chip({
  status = 'off',
  children,
  dot = true,
  icon: Icon,
  size = 'md',
  style,
}) {
  const p = PALETTE[resolveStatus(status)]
  const dims = size === 'sm'
    ? { padding: '1px 7px', fontSize: 11, gap: 5, dot: 5, icon: 12 }
    : { padding: '2px 9px', fontSize: 12, gap: 6, dot: 6, icon: 13 }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        padding: dims.padding,
        fontSize: dims.fontSize,
        fontWeight: 600,
        lineHeight: 1.4,
        borderRadius: 'var(--radius-pill)',
        background: p.bg,
        color: p.fg,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {Icon ? (
        <Icon size={dims.icon} strokeWidth={2.25} aria-hidden="true" />
      ) : dot ? (
        <span
          aria-hidden="true"
          style={{
            width: dims.dot,
            height: dims.dot,
            borderRadius: '50%',
            background: p.dot,
            flexShrink: 0,
          }}
        />
      ) : null}
      {children}
    </span>
  )
}

// ScoreBadge — the Hot Vendor category badge, and the ONLY place rose
// appears in the whole app (locked decision). Given a numeric score OR
// an explicit category, it renders the right colour + label.
//
// Category thresholds MIRROR the backend's own segmentation. The
// backend (hot_vendor_scoring.py) already assigns each property a
// `category` string via dynamic per-suburb quantiles (HOT ≥ q82,
// WARM ≥ q62, MEDIUM ≥ q40, else LOW) — so the source of truth is that
// category, and callers should pass it through when they have it.
//
// The numeric fallback (when only a 0–100 score is available, e.g. the
// morning-digest hot-vendor alert which carries final_score but not the
// category) uses fixed cutoffs that approximate the typical quantile
// bands — documented here so nobody treats them as business logic:
//     score ≥ 70 → HOT      (digest already gates alerts at ≥70)
//     score ≥ 55 → WARM
//     score ≥ 40 → MEDIUM
//     else        → LOW
// These are DISPLAY cutoffs only; they never re-score anything.
//
// Colour mapping (tokens.css --score-*):
//   HOT    → rose  (reserved to this badge)
//   WARM   → amber (shares the watch family)
//   MEDIUM → green (shares the good family)
//   LOW    → grey  (off family)

const CATEGORY_PALETTE = {
  HOT: { bg: 'var(--score-hot-bg)', fg: 'var(--score-hot-text)', dot: 'var(--score-hot)', label: 'Hot' },
  WARM: { bg: 'var(--score-warm-bg)', fg: 'var(--score-warm-text)', dot: 'var(--score-warm)', label: 'Warm' },
  MEDIUM: { bg: 'var(--score-medium-bg)', fg: 'var(--score-medium-text)', dot: 'var(--score-medium)', label: 'Medium' },
  LOW: { bg: 'var(--score-low-bg)', fg: 'var(--score-low-text)', dot: 'var(--score-low)', label: 'Low' },
}

// Display-only fallback when no category string is available.
export function categoryFromScore(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return 'LOW'
  if (n >= 70) return 'HOT'
  if (n >= 55) return 'WARM'
  if (n >= 40) return 'MEDIUM'
  return 'LOW'
}

export default function ScoreBadge({
  category,
  score,
  showScore = false,
  size = 'md',
  style,
}) {
  const cat = (category && CATEGORY_PALETTE[String(category).toUpperCase()])
    ? String(category).toUpperCase()
    : categoryFromScore(score)
  const p = CATEGORY_PALETTE[cat]
  const dims = size === 'sm'
    ? { padding: '1px 7px', fontSize: 11, gap: 5, dot: 5 }
    : { padding: '2px 9px', fontSize: 12, gap: 6, dot: 6 }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        padding: dims.padding,
        fontSize: dims.fontSize,
        fontWeight: 700,
        lineHeight: 1.4,
        borderRadius: 'var(--radius-pill)',
        background: p.bg,
        color: p.fg,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: dims.dot, height: dims.dot, borderRadius: '50%', background: p.dot, flexShrink: 0 }}
      />
      {p.label}
      {showScore && Number.isFinite(Number(score)) && (
        <span style={{ opacity: 0.7, fontWeight: 600 }}>
          {Math.round(Number(score))}
        </span>
      )}
    </span>
  )
}

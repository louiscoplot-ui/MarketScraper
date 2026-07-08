// Skeleton — honest loading placeholders. Replaces the "First load can
// take 15-30 seconds while the server wakes up" dev-speak copy the
// brief called out. The operator sees a calm pulsing shape, not an
// apology about cold starts.
//
// <Skeleton /> — one line. <Skeleton.Rows count cols /> — a table body
// placeholder matching the real column count so the header doesn't jump.
const KEYFRAMES_ID = 'sd-skeleton-keyframes'
function ensureKeyframes() {
  if (typeof document === 'undefined') return
  if (document.getElementById(KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = KEYFRAMES_ID
  style.textContent =
    '@keyframes sd-skeleton-pulse { 0%,100% { opacity: 0.55 } 50% { opacity: 1 } }'
  document.head.appendChild(style)
}

export default function Skeleton({ width = '100%', height = 12, radius = 4, style }) {
  ensureKeyframes()
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: radius,
        background: 'var(--surface-hover)',
        animation: 'sd-skeleton-pulse 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  )
}

// Table-body skeleton: `count` rows × `cols` cells. The first cell is
// wider (address column), the rest vary a little so it reads organic.
Skeleton.Rows = function SkeletonRows({ count = 5, cols = 6 }) {
  ensureKeyframes()
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} style={{ padding: '10px 12px' }}>
              <Skeleton width={j === 0 ? '80%' : `${38 + ((i + j) % 4) * 13}%`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

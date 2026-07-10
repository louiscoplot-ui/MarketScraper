// StatCard — a single metric tile (value + label, optional delta and
// status accent). Replaces the bespoke .report-stat / .hv-stat / trend
// -card markup so counts read identically everywhere.
//
// `status` (optional) tints the value using the status grammar — e.g.
// a "Stale (60+)" count reads red, "Active" reads green — colour as
// information, never decoration. `delta` renders a small +/- change
// with up=good / down=bad direction unless `invertDelta` (some metrics
// like DOM are "down is good").
const VALUE_COLOR = {
  good: 'var(--status-good-text)',
  watch: 'var(--status-watch-text)',
  info: 'var(--status-info-text)',
  alert: 'var(--status-alert-text)',
  off: 'var(--text)',
}

export default function StatCard({
  value,
  label,
  status,
  delta,
  deltaSuffix = '',
  invertDelta = false,
  style,
}) {
  const valueColor = status ? (VALUE_COLOR[status] || 'var(--text)') : 'var(--text)'

  let deltaNode = null
  if (delta != null && delta !== '' && delta !== '=') {
    const n = typeof delta === 'number' ? delta : parseFloat(String(delta))
    // A zero delta is a stable metric — neutral, never good/bad colour.
    if (Number.isFinite(n) && n === 0) {
      deltaNode = (
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {delta}{deltaSuffix}
        </span>
      )
    } else {
    const positive = Number.isFinite(n) ? n > 0 : String(delta).startsWith('+')
    const good = invertDelta ? !positive : positive
    deltaNode = (
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: good ? 'var(--status-good-text)' : 'var(--status-alert-text)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {typeof delta === 'number' && delta > 0 ? '+' : ''}{delta}{deltaSuffix}
      </span>
    )
    }
  } else if (delta === '=') {
    deltaNode = <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>=</span>
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        minWidth: 0,
        ...style,
      }}
    >
      <span
        style={{
          fontSize: 22,
          fontWeight: 700,
          lineHeight: 1.1,
          color: valueColor,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
        {deltaNode}
      </span>
    </div>
  )
}

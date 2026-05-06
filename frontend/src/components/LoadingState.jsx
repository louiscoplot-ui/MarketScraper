// Shared loading indicator. Used across the app so every
// async section shows the same honest message: a brand spinner, a
// short title, and a one-line subhead about expected wait. No fake
// content while the network is in flight — operator preferred this.

export default function LoadingState({
  title = 'Loading…',
  subtext = 'First load can take 10–15 seconds while the server warms up.',
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
      padding: '48px 24px',
      textAlign: 'center',
    }}>
      <div className="loading-spinner" />
      <div style={{ fontWeight: 600, fontSize: 14, color: '#1C1D22' }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: '#6B6C75', maxWidth: 380, lineHeight: 1.5 }}>
        {subtext}
      </div>
    </div>
  )
}

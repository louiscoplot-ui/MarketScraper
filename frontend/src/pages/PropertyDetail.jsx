// Property / lead detail (desk redesign · mock 03). Net-new internal
// page — the classic app links out to reiwa_url; in desk mode a row click
// opens this dossier instead. Rendered as an overlay (no router needed),
// wired to the listing already in memory. Fields with no endpoint yet
// (comparables, a numeric vendor score) show honest placeholders rather
// than fabricated numbers — the layout matches the mock, the data is real
// where it exists.
import { X } from 'lucide-react'

const STRIPE_HERO = 'repeating-linear-gradient(45deg,#cdd0d6 0 16px,#dde0e3 16px 32px)'
const STRIPE_MAP = 'repeating-linear-gradient(45deg,#ECEAE6 0 12px,#F3F1EE 12px 24px)'

const STATUS_META = {
  active: { label: 'Active', st: 'good' },
  under_offer: { label: 'Under Offer', st: 'watch' },
  sold: { label: 'Sold', st: 'info' },
  withdrawn: { label: 'Withdrawn', st: 'alert' },
}

export default function PropertyDetail({ listing, calcDOM, formatIsoDate, onClose }) {
  if (!listing) return null
  const l = listing
  const meta = STATUS_META[l.status] || { label: l.status || '—', st: 'off' }
  const dom = calcDOM ? calcDOM(l) : null
  const suburb = l.suburb_name || l.suburb || ''
  const facts = [
    l.bedrooms != null && `${l.bedrooms} bd`,
    l.bathrooms != null && `${l.bathrooms} ba`,
    l.parking != null && `${l.parking} car`,
    l.land_size && `${l.land_size}`,
  ].filter(Boolean).join('  ·  ')

  // Price & listing history from the dates we actually store.
  const history = [
    l.listing_date && { c: 'var(--status-good)', date: formatIsoDate ? (formatIsoDate(l.listing_date) || l.listing_date) : l.listing_date, event: 'Listed for sale', val: l.price_text || '' },
    l.withdrawn_date && { c: 'var(--status-alert)', date: formatIsoDate ? (formatIsoDate(l.withdrawn_date) || l.withdrawn_date) : l.withdrawn_date, event: 'Withdrawn from market', val: '' },
    l.sold_date && { c: 'var(--status-info)', date: formatIsoDate ? (formatIsoDate(l.sold_date) || l.sold_date) : l.sold_date, event: 'Sold', val: l.price_text || '' },
  ].filter(Boolean)

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', boxShadow: 'var(--shadow-card)' }
  const microLabel = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 12 }
  const panelTitle = { fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, marginBottom: 14, color: 'var(--text)' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '32px 16px' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 1080, background: 'var(--bg)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-pop)' }}>
        {/* hero */}
        <div style={{ height: 220, position: 'relative', background: STRIPE_HERO }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,rgba(12,10,9,0) 40%,rgba(12,10,9,.55) 100%)' }} />
          <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 14, right: 14, width: 32, height: 32, borderRadius: 8, border: 'none', background: 'rgba(255,255,255,.92)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
            <X size={16} />
          </button>
          <div style={{ position: 'absolute', top: 16, left: 20, display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.92)', borderRadius: 999, padding: '6px 14px' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--status-${meta.st})` }} />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: `var(--status-${meta.st}-text)` }}>{meta.label}</span>
            {dom != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: dom >= 60 ? 'var(--status-alert-text)' : 'var(--text-muted)', fontWeight: 600 }}>· {dom} DOM</span>}
          </div>
          <div style={{ position: 'absolute', bottom: 18, left: 22, color: '#fff' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.1em', color: 'rgba(255,255,255,.75)', marginBottom: 6 }}>Prospecting / {suburb} / {l.address}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 500, letterSpacing: '-0.01em' }}>{l.address}{suburb ? `, ${suburb}` : ''}</div>
          </div>
        </div>

        {/* body */}
        <div style={{ display: 'flex', gap: 20, padding: '22px 28px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* main */}
          <div style={{ flex: '1.55 1 340px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 34, letterSpacing: '-0.02em', color: 'var(--text)' }}>{l.price_text || '—'}</span>
              {facts && <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 14px', background: 'var(--surface)' }}>{facts}</span>}
            </div>

            <div style={card}>
              <div style={microLabel}>Summary</div>
              <p style={{ fontFamily: 'var(--font-display)', fontSize: 16, lineHeight: 1.65, color: '#3f3a37', margin: 0 }}>
                {l.note
                  ? l.note
                  : `${l.address}${suburb ? `, ${suburb}` : ''}. ${meta.label}${l.agency ? ` — marketed by ${l.agency}` : ''}.${dom != null && dom >= 60 ? ` On market ${dom} days — a lengthening campaign often signals a motivated vendor.` : ''}`}
              </p>
            </div>

            <div style={card}>
              <div style={panelTitle}>Price &amp; listing history</div>
              {history.length === 0 ? (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>No dated history recorded for this listing yet.</div>
              ) : history.map((h, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: h.c, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', width: 110, flexShrink: 0 }}>{h.date}</span>
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--text)', flex: 1 }}>{h.event}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{h.val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* aside */}
          <div style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <div style={card}>
              <div style={microLabel}>Listing agent</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{l.agent || '—'}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{l.agency || ''}</div>
              {l.reiwa_url && (
                <a href={l.reiwa_url} target="_blank" rel="noopener" style={{ display: 'inline-block', marginTop: 12, fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}>View original listing →</a>
              )}
            </div>

            {/* location map placeholder + stats */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ height: 128, position: 'relative', background: STRIPE_MAP }}>
                <span style={{ position: 'absolute', top: 10, left: 12, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: '#9a978f', background: 'rgba(255,255,255,.72)', borderRadius: 5, padding: '3px 8px' }}>Location · {suburb || '—'}</span>
                <span style={{ position: 'absolute', top: '52%', left: '50%', transform: 'translate(-50%,-50%)', width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', border: '3px solid #fff', boxShadow: '0 3px 10px rgba(12,10,9,.3)' }} />
              </div>
              <div style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
                <div style={{ flex: 1, padding: '11px 14px', borderRight: '1px solid var(--border)' }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600 }}>{l.land_size || '—'}</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>land</div></div>
                <div style={{ flex: 1, padding: '11px 14px', borderRight: '1px solid var(--border)' }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600 }}>{l.internal_size || '—'}</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>internal</div></div>
                <div style={{ flex: 1, padding: '11px 14px' }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600 }}>{dom != null ? dom : '—'}</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>days on mkt</div></div>
              </div>
            </div>

            <div style={card}>
              <div style={panelTitle}>Comparable sales</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Comparable sales appear here once the sold ledger covers {suburb || 'this suburb'}. Open the Market Report for current medians and recent sales.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

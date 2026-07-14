// Property dossier (validated design 10/07/2026) — ONE overlay for every
// entry point: table row, map pin card, Contact today. Layout: header band
// (status + address + price + facts), a one-line "why call now" narrative,
// then three columns — agent & note · property story timeline · market
// context (real mini-map + sold nearby). All data is local: the listing
// row itself plus the in-memory listings set for comparables. No endpoint.
import { X, ExternalLink } from 'lucide-react'
import DeskMap from '../components/DeskMap'

const STATUS_META = {
  active: { label: 'Active', st: 'good' },
  under_offer: { label: 'Under Offer', st: 'watch' },
  sold: { label: 'Sold', st: 'info' },
  withdrawn: { label: 'Withdrawn', st: 'alert' },
}

// The "so what" line — why this property deserves a call today. Honest:
// derived only from fields we actually have.
function narrative(l, meta, dom) {
  if (l.status === 'withdrawn') {
    return `Withdrawn${dom != null ? ` after ${dom} days` : ''} — didn't reach price. The classic re-list window opens in 3–9 months: worth a conversation before another agency has it.`
  }
  if (l.status === 'under_offer') {
    return 'Under offer — if the sale falls through, the vendor lands on the Fallen list with a short re-engagement window.'
  }
  if (l.status === 'sold') {
    return 'Sold — recent sales pull neighbouring vendors into the market. Prime doorknock anchor for the street.'
  }
  if (dom != null && dom >= 60) {
    return `On market ${dom} days — a lengthening campaign often signals a motivated vendor and a listing agreement nearing its end.`
  }
  return `${meta.label}${l.agency ? ` — marketed by ${l.agency}` : ''}.`
}

export default function PropertyDetail({ listing, listings = [], calcDOM, formatIsoDate, onClose }) {
  if (!listing) return null
  const l = listing
  const meta = STATUS_META[l.status] || { label: l.status || '—', st: 'off' }
  const dom = calcDOM ? calcDOM(l) : null
  const suburb = l.suburb_name || l.suburb || ''
  const fmtD = (d) => (formatIsoDate ? (formatIsoDate(d) || d) : d)
  const facts = [
    l.bedrooms != null && `${l.bedrooms} bd`,
    l.bathrooms != null && `${l.bathrooms} ba`,
    l.parking != null && `${l.parking} car`,
    l.land_size && `${l.land_size}`,
  ].filter(Boolean)

  // A price string is only worth showing if it looks like money — REIWA
  // fills the asking field with "Contact agent" / "Contact form" noise,
  // and western-suburb sales rarely disclose. Sold events show the real
  // sold_price, never the asking text.
  const looksPrice = (s) => /\$|\d{4,}/.test(String(s || ''))
  const soldPriceOf = (x) => { const sp = String(x.sold_price || '').trim(); return looksPrice(sp) ? sp : '' }

  // Address already carries "Suburb WA 6018" — don't append the suburb
  // again ("…Innaloo WA 6018, Innaloo"). Only add it when it's absent.
  const addrHasSuburb = suburb && String(l.address || '').toLowerCase().includes(suburb.toLowerCase())
  const fullAddress = addrHasSuburb ? l.address : `${l.address}${suburb ? `, ${suburb}` : ''}`

  // Property story — the dated events we actually store, oldest first.
  const story = [
    l.listing_date && { c: 'var(--status-good)', date: fmtD(l.listing_date), event: 'Listed for sale', val: looksPrice(l.price_text) ? l.price_text : '' },
    l.withdrawn_date && { c: 'var(--status-alert)', date: fmtD(l.withdrawn_date), event: 'Withdrawn from market', val: dom != null ? `after ${dom} days` : '' },
    l.sold_date && { c: 'var(--status-info)', date: fmtD(l.sold_date), event: 'Sold', val: soldPriceOf(l) },
  ].filter(Boolean)

  // Sold nearby — real comparables from the listings already in memory:
  // same suburb, sold, most recent first. No fabricated numbers.
  const eq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase()
  const comparables = (listings || [])
    .filter(x => x.status === 'sold' && eq(x.suburb_name || x.suburb, suburb) && x.id !== l.id)
    .sort((a, b) => String(b.sold_date || '').localeCompare(String(a.sold_date || '')))
    .slice(0, 4)
  // Active competition in the same suburb (excluding this one).
  const activeNearby = (listings || [])
    .filter(x => x.status === 'active' && eq(x.suburb_name || x.suburb, suburb) && x.id !== l.id).length

  // Comparable competition — count only genuinely similar active listings,
  // not the whole suburb: a 5-bed house doesn't compete with studio units.
  // Houses compare on beds/baths/land, apartments on beds/baths/internal,
  // land on land size. A criterion is applied only when BOTH listings carry
  // the value (REIWA data is sparse — requiring presence would zero the
  // count), so it gracefully degrades to a property-type match when sizes
  // are missing.
  const numOf = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null }
  const catOf = (x) => {
    const t = String(x.listing_type || '').toLowerCase()
    if (/land|lot/.test(t)) return 'land'
    if (/apartment|unit|studio|flat/.test(t)) return 'apartment'
    if (/house|villa|townhouse|duplex|terrace|home/.test(t)) return 'house'
    // No type on the row: infer from what we measure.
    if (x.internal_size && !x.land_size) return 'apartment'
    if (x.land_size) return 'house'
    return 'other'
  }
  const near = (a, b, tol) => (a == null || b == null) ? true : Math.abs(a - b) <= tol
  const withinPct = (a, b, pct) => (a == null || b == null) ? true : Math.abs(a - b) <= Math.max(a, b) * pct
  const subjCat = catOf(l)
  const subjLand = numOf(l.land_size)
  const subjInt = numOf(l.internal_size)
  const isSimilar = (x) => {
    if (catOf(x) !== subjCat) return false
    if (subjCat !== 'land') {
      if (!near(l.bedrooms, x.bedrooms, 1)) return false
      if (!near(l.bathrooms, x.bathrooms, 1)) return false
    }
    if (subjCat === 'apartment') return withinPct(subjInt, numOf(x.internal_size), 0.35)
    return withinPct(subjLand, numOf(x.land_size), 0.35)   // house & land compare land size
  }
  const similarActive = (listings || []).filter(x =>
    x.status === 'active' && eq(x.suburb_name || x.suburb, suburb) && x.id !== l.id && isSimilar(x)).length
  const compDims = subjCat === 'land' ? 'land size'
    : subjCat === 'apartment' ? 'beds, baths & internal size'
      : 'beds, baths & land size'

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-card)' }
  const mlabel = { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--text-faint)' }
  const chip = (bg, fg, text, border) => (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, borderRadius: 999, padding: '2px 9px', background: bg, color: fg, border: border ? `1px solid ${border}` : 'none', whiteSpace: 'nowrap' }}>{text}</span>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '32px 16px' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 980, background: 'var(--bg)', borderRadius: 18, overflow: 'hidden', boxShadow: 'var(--shadow-pop)' }}>

        {/* ── header band ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 24px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '-0.01em', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fullAddress}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
              {chip(`var(--status-${meta.st}-bg)`, `var(--status-${meta.st}-text)`, meta.label, `var(--status-${meta.st})`)}
              {dom != null && chip('var(--bg)', dom >= 60 ? 'var(--status-alert-text)' : 'var(--text-muted)', `${dom} DOM`, 'var(--border)')}
              {facts.map((f, i) => <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap' }}>{f}</span>)}
            </div>
          </div>
          {looksPrice(l.price_text) && <span style={{ fontFamily: 'var(--font-display)', fontSize: 26, letterSpacing: '-0.02em', color: 'var(--text)', flex: 'none' }}>{l.price_text}</span>}
          {/* Prominent REIWA link — no need to scroll the table right to
              reach the external listing once the dossier is open. */}
          {l.reiwa_url && (
            <a href={l.reiwa_url} target="_blank" rel="noopener" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-fg)', background: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 8, padding: '8px 13px', textDecoration: 'none' }}>
              View on REIWA <ExternalLink size={13} />
            </a>
          )}
          {/* Explicit color: the lucide X otherwise inherits the UA's black
              ButtonText, invisible on dark-preset surfaces. */}
          <button onClick={onClose} aria-label="Close" style={{ flex: 'none', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={15} />
          </button>
        </div>

        {/* ── narrative — why call now ── */}
        <div style={{ padding: '10px 24px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--accent)', fontWeight: 500 }}>
          {narrative(l, meta, dom)}
        </div>

        {/* ── body: 3 columns ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, padding: '16px 24px 20px' }}>

          {/* col 1 · agent & note */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <div style={{ ...card, padding: '13px 15px' }}>
              <div style={{ ...mlabel, marginBottom: 7 }}>Listing agent</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{l.agent || '—'}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{l.agency || ''}</div>
              {l.reiwa_url && (
                <a href={l.reiwa_url} target="_blank" rel="noopener" style={{ display: 'inline-block', marginTop: 10, fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>View on REIWA →</a>
              )}
            </div>
            {l.note && (
              <div style={{ ...card, padding: '13px 15px' }}>
                <div style={{ ...mlabel, marginBottom: 7 }}>Note</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--status-watch-text)', background: 'var(--status-watch-bg)', border: '1px solid var(--status-watch)', borderRadius: 8, padding: '8px 11px' }}>{l.note}</div>
              </div>
            )}
            <div style={{ ...card, padding: '13px 15px' }}>
              <div style={{ ...mlabel, marginBottom: 7 }}>Competition · {suburb || '—'}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--text)', lineHeight: 1 }}>{similarActive}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>comparable active listing{similarActive !== 1 ? 's' : ''} — similar {compDims}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 3 }}>{activeNearby} active in {suburb || 'the suburb'} overall</div>
            </div>
          </div>

          {/* col 2 · property story */}
          <div style={{ ...card, padding: '13px 15px', minWidth: 0 }}>
            <div style={{ ...mlabel, marginBottom: 10 }}>Property story</div>
            {story.length === 0 ? (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>No dated history recorded for this listing yet.</div>
            ) : (
              <div style={{ position: 'relative', paddingLeft: 19 }}>
                <div style={{ position: 'absolute', left: 5, top: 5, bottom: 5, width: 2, background: 'var(--border)' }} />
                {story.map((h, i) => (
                  <div key={i} style={{ position: 'relative', paddingBottom: i < story.length - 1 ? 14 : 0 }}>
                    <span style={{ position: 'absolute', left: -19, top: 3, width: 12, height: 12, borderRadius: '50%', background: h.c, border: '2.5px solid var(--surface)' }} />
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{h.date}</div>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text)' }}>
                      <strong>{h.event}</strong>{h.val ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}> — {h.val}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 14, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: 1 }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{l.land_size || '—'}</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)' }}>land</div></div>
              <div style={{ flex: 1 }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{l.internal_size || '—'}</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)' }}>internal</div></div>
              <div style={{ flex: 1 }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: dom != null && dom >= 60 ? 'var(--status-alert-text)' : 'var(--text)' }}>{dom != null ? dom : '—'}</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)' }}>days on market</div></div>
            </div>
          </div>

          {/* col 3 · market context */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <div style={{ ...card, overflow: 'hidden', height: 140, flex: 'none' }}>
              {/* Real map — exact pin for THIS address (free geocode, cached). */}
              <DeskMap items={[l]} minHeight={140} label={suburb || undefined} />
            </div>
            <div style={{ ...card, padding: '13px 15px', flex: 1 }}>
              <div style={{ ...mlabel, marginBottom: 8 }}>Sold nearby · {suburb || '—'}</div>
              {comparables.length === 0 ? (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  No confirmed sales in {suburb || 'this suburb'} in the current data. The Market Report has suburb medians.
                </div>
              ) : comparables.map((c, i) => {
                const sp = soldPriceOf(c)
                // Whole row is a REIWA link when we have one — even
                // undisclosed sales matter: REIWA sometimes back-fills the
                // sold price later, so keeping the link reachable is the point.
                const border = i < comparables.length - 1 ? '1px solid var(--border)' : 'none'
                const rowInner = (
                  <>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
                        {c.address}{c.reiwa_url && <ExternalLink size={11} style={{ flex: 'none', color: 'var(--text-faint)' }} />}
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-muted)' }}>{c.sold_date ? `sold ${fmtD(c.sold_date)}` : 'sold'}</div>
                    </div>
                    {/* Real sold price only; western-suburb sales rarely
                        disclose, so blank reads honestly as "undisclosed". */}
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: sp ? 'var(--text)' : 'var(--text-faint)', flex: 'none' }}>{sp || 'undisclosed'}</span>
                  </>
                )
                const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: border, textDecoration: 'none' }
                return c.reiwa_url ? (
                  <a key={c.id || i} href={c.reiwa_url} target="_blank" rel="noopener" title="Open on REIWA" style={{ ...rowStyle, cursor: 'pointer' }}>{rowInner}</a>
                ) : (
                  <div key={c.id || i} style={rowStyle}>{rowInner}</div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

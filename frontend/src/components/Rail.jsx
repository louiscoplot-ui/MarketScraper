// SuburbDesk vertical rail — "The Morning Desk" primary navigation.
// Replaces the classic top tab bar when desk mode is on. Ported
// faithfully from the design handoff (SuburbDeskRail.dc.html): 232px
// fixed column, ink-forest gradient, metallic 4-square mark, grouped
// nav (Workspace / Intelligence / System) with accent markers + mono
// count badges (Hot Vendors badge in the reserved rose), user block at
// the bottom, plus the tone switcher + a one-click return to classic.
//
// Colour = information: the 4 tone palettes below are copied verbatim
// from the handoff's palette(tone); nothing is invented here.
import { useMemo, useState } from 'react'
import { DESK_TONES, getDeskCustomColor, setDeskCustomColor } from '../lib/deskFlag'

// Tone palettes — verbatim from SuburbDeskRail.dc.html palette(tone).
const PALETTES = {
  ink:   { bg:'linear-gradient(178deg,#0E1A14 0%,#0C120E 55%,#0A0F0C 100%)', fg:'#F5F5F4', muted:'#8A938C', faint:'#565d57', line:'rgba(255,255,255,.06)', sbg:'rgba(255,255,255,.05)', sbd:'rgba(255,255,255,.08)', stext:'#6b746d', activeBg:'rgba(56,99,80,.30)', hover:'rgba(255,255,255,.055)', mark:'#7fbfa1', imark:'rgba(255,255,255,.20)', atext:'#EBF0EE', bon:'rgba(127,191,161,.20)', bonf:'#a6dabf', boff:'rgba(255,255,255,.07)', bofff:'#6b746d', hotb:'rgba(219,39,119,.20)', hotf:'#f0a8cc', uname:'#EBF0EE', usub:'#6b746d' },
  forest:{ bg:'linear-gradient(178deg,#123322 0%,#0E2418 55%,#09150E 100%)', fg:'#F2F7F3', muted:'#8FAE9C', faint:'#5f7a68', line:'rgba(255,255,255,.07)', sbg:'rgba(255,255,255,.06)', sbd:'rgba(255,255,255,.09)', stext:'#7a9585', activeBg:'rgba(127,191,161,.20)', hover:'rgba(255,255,255,.06)', mark:'#a6dabf', imark:'rgba(255,255,255,.22)', atext:'#EBF6EE', bon:'rgba(166,218,191,.22)', bonf:'#c6ecd4', boff:'rgba(255,255,255,.08)', bofff:'#7a9585', hotb:'rgba(240,168,204,.20)', hotf:'#f6c2da', uname:'#EBF6EE', usub:'#7a9585' },
  slate: { bg:'linear-gradient(178deg,#1B1F26 0%,#15181E 55%,#0F1116 100%)', fg:'#EDEEF0', muted:'#8B909A', faint:'#5A5F69', line:'rgba(255,255,255,.07)', sbg:'rgba(255,255,255,.05)', sbd:'rgba(255,255,255,.08)', stext:'#767b85', activeBg:'rgba(56,99,80,.34)', hover:'rgba(255,255,255,.05)', mark:'#7fbfa1', imark:'rgba(255,255,255,.20)', atext:'#EBF0EE', bon:'rgba(127,191,161,.20)', bonf:'#a6dabf', boff:'rgba(255,255,255,.07)', bofff:'#767b85', hotb:'rgba(219,39,119,.20)', hotf:'#f0a8cc', uname:'#EDEEF0', usub:'#767b85' },
  bone:  { bg:'#F4F3F0', fg:'#0C0A09', muted:'#78716C', faint:'#A8A29E', line:'#E7E5E4', sbg:'#FFFFFF', sbd:'#E7E5E4', stext:'#A8A29E', activeBg:'#EBF0EE', hover:'#ECEAE6', mark:'#386350', imark:'#C9C6C1', atext:'#0C0A09', bon:'rgba(56,99,80,.13)', bonf:'#2D5040', boff:'#EDEBE8', bofff:'#78716C', hotb:'rgba(219,39,119,.12)', hotf:'#9D174D', uname:'#0C0A09', usub:'#A8A29E' },
}

const MONO = "'JetBrains Mono', ui-monospace, monospace"
const UI = "'Inter', system-ui, sans-serif"

// ---------------------------------------------------------------------
// Custom tone — derive a full rail palette from ONE operator-picked
// background colour, with WCAG-AA text contrast guaranteed on any pick.
// All ratios are computed against BOTH ends of the generated gradient,
// so the worst-case end is what must pass.
// ---------------------------------------------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbToHex([r, g, b]) {
  const c = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
// WCAG 2.x relative luminance.
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const la = luminance(a); const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
// Linear mix of two hex colours: t=0 → a, t=1 → b.
function mixHex(a, b, t) {
  const ra = hexToRgb(a); const rb = hexToRgb(b)
  return rgbToHex(ra.map((v, i) => v + (rb[i] - v) * t))
}
// Pull `color` toward `toward` (the palette's max-contrast pole) until
// it clears `min` contrast against every bg in `bgs`. Binary search on
// the mix amount; falls back to the pole itself (always the best case).
function ensureContrast(color, bgs, min, toward) {
  const worst = (c) => Math.min(...bgs.map(bg => contrast(c, bg)))
  if (worst(color) >= min) return color
  let lo = 0; let hi = 1; let best = toward
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    const cand = mixHex(color, toward, mid)
    if (worst(cand) >= min) { best = cand; hi = mid } else { lo = mid }
  }
  return best
}
// rgba() helper over a hex pole — used for the non-text surfaces
// (separators, hover, chips) so they read as a tint of the text pole
// on any background.
function alphaOf(hex, a) {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

export function paletteFromColor(base) {
  // Text pole picked FIRST, against the flat base colour: max(white,
  // black) is mathematically ≥ 4.58:1 on any colour, so AA always has a
  // winner. THEN the gradient is built in the pole's favourable
  // direction (darker bottom under light text, lighter bottom under
  // dark text) so neither gradient end can dip below the base's ratio.
  const lightText = contrast('#FFFFFF', base) >= contrast('#000000', base)
  const pole = lightText ? '#FFFFFF' : '#000000'
  const bottom = mixHex(base, pole === '#FFFFFF' ? '#000000' : '#FFFFFF', 0.14)
  const bgs = [base, bottom]
  const fg = ensureContrast(lightText ? '#F7F7F5' : '#0C0A09', bgs, 4.5, pole)

  // Secondary text tokens — mixed toward the bg for hierarchy, then
  // pushed back toward the pole until they clear AA (4.6 leaves margin
  // for the translucent chip surfaces they sometimes sit on).
  const muted = ensureContrast(mixHex(fg, base, 0.35), bgs, 4.6, pole)
  const faint = ensureContrast(mixHex(fg, base, 0.5), bgs, 4.6, pole)

  // Brand accent — light green on dark rails, deep green on light ones;
  // must clear 3:1 (non-text UI) or it snaps toward the text pole.
  const accent = ensureContrast(lightText ? '#7fbfa1' : '#386350', bgs, 3, pole)
  const accentText = ensureContrast(lightText ? '#a6dabf' : '#2D5040', bgs, 4.6, pole)
  const hotText = ensureContrast(lightText ? '#f0a8cc' : '#9D174D', bgs, 4.6, pole)

  return {
    bg: `linear-gradient(178deg, ${base} 0%, ${bottom} 100%)`,
    fg,
    muted,
    faint,
    line: alphaOf(pole, lightText ? 0.08 : 0.1),
    sbg: alphaOf(pole, 0.05),
    sbd: alphaOf(pole, lightText ? 0.09 : 0.12),
    stext: muted,
    activeBg: alphaOf(accent === fg ? pole : accent, 0.22),
    hover: alphaOf(pole, 0.06),
    mark: accent,
    imark: alphaOf(pole, 0.2),
    atext: fg,
    bon: alphaOf(accent === fg ? pole : accent, 0.2),
    bonf: accentText,
    boff: alphaOf(pole, 0.07),
    bofff: muted,
    hotb: alphaOf(hotText, 0.18),
    hotf: hotText,
    uname: fg,
    usub: muted,
  }
}

// Metallic 4-square mark — the brand moment (gradient reserved for the
// logo, never the data UI). Matches brand/logo.svg geometry.
function MetalMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="SuburbDesk">
      <defs>
        <linearGradient id="sd-rail-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a6dabf" />
          <stop offset=".5" stopColor="#4f8067" />
          <stop offset="1" stopColor="#22402f" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="9" height="9" rx="2" fill="url(#sd-rail-mark)" />
      <rect x="13" y="2" width="9" height="9" rx="2" fill="url(#sd-rail-mark)" />
      <rect x="2" y="13" width="9" height="9" rx="2" fill="url(#sd-rail-mark)" />
      <rect x="13" y="13" width="9" height="9" rx="2" fill="url(#sd-rail-mark)" />
    </svg>
  )
}

// avatar initials from a name/email — falls back to "SD".
function initials(me) {
  const src = (me?.name || me?.email || '').trim()
  if (!src) return 'SD'
  const parts = src.split(/[\s@._-]+/).filter(Boolean)
  const a = parts[0]?.[0] || ''
  const b = parts.length > 1 ? parts[1][0] : ''
  return (a + b).toUpperCase() || 'SD'
}

export default function Rail({
  view, onNavigate, me, counts = {},
  tone, onTone, onExit,
}) {
  // Custom tone: full palette derived from the picked colour with AA
  // text contrast guaranteed (see paletteFromColor). Presets unchanged.
  const [customColor, setCustomColorState] = useState(getDeskCustomColor)
  const p = useMemo(
    () => (tone === 'custom' ? paletteFromColor(customColor) : (PALETTES[tone] || PALETTES.ink)),
    [tone, customColor]
  )
  const [hovered, setHovered] = useState(null)
  const pickCustom = (hex) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return
    setCustomColorState(hex)
    setDeskCustomColor(hex)
    onTone('custom')
  }

  const isAdmin = !!me && (me.role || '').toLowerCase() === 'admin'
  const hasRental = isAdmin || !!(me && me.rental_access)

  // App view <-> rail key. 'fallen' has no rail slot (reached from the
  // dashboard alert) so nothing highlights when the user is on it.
  const GROUPS = [
    { title: 'Workspace', items: [
      { view: 'today', label: 'Dashboard' },
      { view: 'listings', label: 'Prospecting', badge: counts.listings },
      { view: 'hot-vendors', label: 'Hot Vendors', badge: counts.hotVendors, hot: true },
      { view: 'pipeline', label: 'Pipeline' },
      { view: 'appraisals', label: 'Appraisals' },
    ]},
    { title: 'Intelligence', items: [
      { view: 'report', label: 'Market Report' },
      { view: 'signals', label: 'Signals', badge: counts.signals },
      ...(hasRental ? [{ view: 'rentals', label: 'Rental' }] : []),
    ]},
    { title: 'System', items: [
      { view: 'logs', label: 'History' },
      ...(isAdmin ? [{ view: 'admin', label: 'Admin' }] : []),
    ]},
  ]

  const hasBadge = (v) => v !== undefined && v !== null && v !== ''

  return (
    <aside
      className="rail"
      style={{
        width: 232, height: '100%', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', fontFamily: UI, background: p.bg,
        borderRight: `1px solid ${p.line}`,
      }}
    >
      {/* brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 18px 16px' }}>
        <MetalMark size={22} />
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.03em', color: p.fg }}>
          SuburbDesk
        </span>
      </div>

      {/* nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }} aria-label="Primary">
        {GROUPS.map(g => (
          <div key={g.title}>
            <div style={{
              padding: '12px 24px 6px', fontFamily: MONO, fontSize: 9.5,
              fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: p.faint,
            }}>
              {g.title}
            </div>
            {g.items.map(i => {
              const on = i.view === view
              const hot = hovered === i.view
              return (
                <div
                  key={i.view}
                  role="button"
                  tabIndex={0}
                  onClick={() => onNavigate(i.view)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(i.view) } }}
                  onMouseEnter={() => setHovered(i.view)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11,
                    padding: '8px 16px 8px 20px', margin: '1px 10px', borderRadius: 8,
                    cursor: 'pointer', position: 'relative', transition: 'background .12s',
                    background: on ? p.activeBg : (hot ? p.hover : 'transparent'),
                  }}
                >
                  {on && (
                    <span style={{
                      position: 'absolute', left: 0, top: 8, bottom: 8, width: 2.5,
                      borderRadius: '0 3px 3px 0', background: p.mark,
                    }} />
                  )}
                  <span style={{
                    width: 7, height: 7, borderRadius: 2, flexShrink: 0,
                    background: on ? p.mark : p.imark,
                    boxShadow: on ? `0 0 9px ${p.mark}99` : 'none',
                  }} />
                  <span style={{
                    fontFamily: UI, fontSize: 13, letterSpacing: '-0.005em',
                    fontWeight: on ? 600 : 500, color: on ? p.atext : p.muted,
                  }}>
                    {i.label}
                  </span>
                  {hasBadge(i.badge) && (
                    <span style={{
                      marginLeft: 'auto', fontFamily: MONO, fontSize: 9.5, fontWeight: 600,
                      padding: '1px 7px', borderRadius: 999, letterSpacing: 0,
                      background: i.hot ? p.hotb : (on ? p.bon : p.boff),
                      color: i.hot ? p.hotf : (on ? p.bonf : p.bofff),
                    }}>
                      {i.badge}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </nav>

      {/* tone switcher + return to classic — the "Tweaks" affordance. */}
      <div style={{ borderTop: `1px solid ${p.line}`, padding: '12px 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: p.faint }}>
            Tone
          </span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {DESK_TONES.map(t => {
              const swatch = { ink: '#0E1A14', forest: '#123322', slate: '#1B1F26', bone: '#F4F3F0' }[t]
              const sel = t === tone
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onTone(t)}
                  title={t}
                  aria-label={`Tone ${t}`}
                  style={{
                    width: 16, height: 16, borderRadius: 5, cursor: 'pointer', padding: 0,
                    background: swatch,
                    border: sel ? `1.5px solid ${p.mark}` : `1px solid ${p.sbd}`,
                    boxShadow: sel ? `0 0 0 2px ${p.mark}44` : 'none',
                  }}
                />
              )
            })}
            {/* Custom colour — native picker disguised as a 5th swatch.
                Text auto-adapts (light/dark) to the picked background via
                WCAG luminance so any colour stays AA-readable. */}
            <label
              title="Custom colour"
              aria-label="Custom rail colour"
              style={{
                width: 16, height: 16, borderRadius: 5, cursor: 'pointer',
                position: 'relative', overflow: 'hidden', display: 'inline-block',
                background: tone === 'custom'
                  ? customColor
                  : 'conic-gradient(#e05252,#e0b152,#7fbfa1,#5285e0,#b152e0,#e05252)',
                border: tone === 'custom' ? `1.5px solid ${p.mark}` : `1px solid ${p.sbd}`,
                boxShadow: tone === 'custom' ? `0 0 0 2px ${p.mark}44` : 'none',
              }}
            >
              <input
                type="color"
                value={customColor}
                onChange={e => pickCustom(e.target.value)}
                onClick={() => { if (tone !== 'custom') onTone('custom') }}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  opacity: 0, cursor: 'pointer', padding: 0, border: 'none',
                }}
              />
            </label>
          </div>
        </div>
        <button
          type="button"
          onClick={onExit}
          style={{
            width: '100%', textAlign: 'left', cursor: 'pointer',
            fontFamily: UI, fontSize: 11.5, color: p.muted,
            background: p.sbg, border: `1px solid ${p.sbd}`, borderRadius: 8,
            padding: '7px 11px',
          }}
        >
          ← Back to classic view
        </button>
      </div>

      {/* user */}
      <div style={{ borderTop: `1px solid ${p.line}`, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 32, height: 32, borderRadius: 9, background: 'linear-gradient(135deg,#4f8067,#2b4d3b)',
          color: '#EBF0EE', fontSize: 12, fontWeight: 600, display: 'flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: UI,
        }}>
          {initials(me)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: p.uname, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {me?.name || me?.email || 'Signed in'}
          </div>
          <div style={{ fontSize: 10.5, color: p.usub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {me?.agency || (isAdmin ? 'Admin' : 'Agent')}
          </div>
        </div>
      </div>
    </aside>
  )
}

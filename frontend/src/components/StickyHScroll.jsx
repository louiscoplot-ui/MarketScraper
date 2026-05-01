import { useEffect, useRef, useState } from 'react'

// Synced horizontal scrollbar pinned to the bottom of the viewport.
// The user wanted to scroll a wide table sideways without scrolling the
// whole page down to find the table's own native scrollbar. This bar:
//   - fixed at viewport bottom, matches the target's left/width
//   - synced two-way with the target's scrollLeft
//   - hides automatically when the target fits horizontally OR when the
//     target's native scrollbar is already in the viewport (no double bar)

export default function StickyHScroll({ targetRef }) {
  const barRef = useRef(null)
  const [innerWidth, setInnerWidth] = useState(0)
  const [box, setBox] = useState({ left: 0, width: 0, show: false })
  const syncingRef = useRef(null)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return

    const update = () => {
      const rect = target.getBoundingClientRect()
      const overflows = target.scrollWidth > target.clientWidth + 1
      const nativeBarVisible = rect.bottom <= window.innerHeight
      setInnerWidth(target.scrollWidth)
      setBox({
        left: Math.max(0, rect.left),
        width: rect.width,
        show: overflows && !nativeBarVisible,
      })
    }

    const onTargetScroll = () => {
      if (syncingRef.current === 'bar') return
      syncingRef.current = 'target'
      if (barRef.current) barRef.current.scrollLeft = target.scrollLeft
      requestAnimationFrame(() => { syncingRef.current = null })
    }
    const onBarScroll = () => {
      if (syncingRef.current === 'target') return
      syncingRef.current = 'bar'
      target.scrollLeft = barRef.current.scrollLeft
      requestAnimationFrame(() => { syncingRef.current = null })
    }

    update()
    target.addEventListener('scroll', onTargetScroll)
    const bar = barRef.current
    bar?.addEventListener('scroll', onBarScroll)
    window.addEventListener('resize', update)
    // Capture phase = catches scroll on any ancestor (e.g. App's content panel).
    window.addEventListener('scroll', update, true)

    let ro
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update)
      ro.observe(target)
    }

    return () => {
      target.removeEventListener('scroll', onTargetScroll)
      bar?.removeEventListener('scroll', onBarScroll)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      ro?.disconnect()
    }
  }, [targetRef])

  return (
    <div
      ref={barRef}
      className="sticky-h-scroll"
      style={{
        left: box.left,
        width: box.width,
        display: box.show ? 'block' : 'none',
      }}
    >
      <div style={{ width: innerWidth, height: 1 }} />
    </div>
  )
}

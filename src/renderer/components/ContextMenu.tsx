import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem = { separator: true } | { separator?: false; label: string; destructive?: boolean; disabled?: boolean; action: () => void }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  // Opened at the pointer, then nudged back inside the window: a menu near the bottom or the
  // right edge would otherwise be clipped, with its last items unreachable.
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const margin = 8
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    })
  }, [x, y, items])

  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose])

  return (
    <div ref={box} className="context-menu" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="separator" />
        ) : (
          <div
            key={i}
            className={`item ${item.destructive ? 'destructive' : ''} ${item.disabled ? 'disabled' : ''}`}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.action()
            }}
          >
            {item.label}
          </div>
        ),
      )}
    </div>
  )
}

import { useEffect } from 'react'

export type MenuItem = { separator: true } | { separator?: false; label: string; destructive?: boolean; action: () => void }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
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
    <div className="context-menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="separator" />
        ) : (
          <div
            key={i}
            className={`item ${item.destructive ? 'destructive' : ''}`}
            onClick={() => {
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

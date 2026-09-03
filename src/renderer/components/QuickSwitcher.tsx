import { useEffect, useMemo, useRef, useState } from 'react'
import type { SelectionTarget, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'

interface Item {
  label: string
  detail: string
  target: SelectionTarget
}

export function QuickSwitcher({ snapshot, onSelect, onClose }: { snapshot: Snapshot; onSelect: (t: SelectionTarget) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [{ label: 'Supervisor Agent', detail: 'master', target: { kind: 'master' } }]
    for (const p of snapshot.projects) all.push({ label: p.name, detail: p.path, target: { kind: 'project', id: p.id } })
    for (const s of snapshot.sessions) {
      if (s.id === 'master') continue
      const project = snapshot.projects.find((p) => p.id === s.projectId)?.name ?? 'unassigned'
      all.push({ label: s.displayName, detail: `${project} · ${s.kind} · ${isAlive(s) ? s.state : 'stopped'}`, target: { kind: 'session', id: s.id } })
    }
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((i) => i.label.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q))
  }, [snapshot, query])

  const choose = (item: Item | undefined) => {
    if (!item) return
    onSelect(item.target)
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          placeholder="Jump to project or session…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setCursor((c) => Math.min(items.length - 1, c + 1))
            else if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
            else if (e.key === 'Enter') choose(items[cursor])
            else if (e.key === 'Escape') onClose()
            else return
            e.preventDefault()
          }}
        />
        <ul>
          {items.slice(0, 12).map((item, i) => (
            <li key={`${item.label}-${i}`} className={i === cursor ? 'active' : ''} onMouseEnter={() => setCursor(i)} onClick={() => choose(item)}>
              <span className="label">{item.label}</span>
              <span className="muted small">{item.detail}</span>
            </li>
          ))}
          {items.length === 0 && <li className="muted">No matches</li>}
        </ul>
      </div>
    </div>
  )
}

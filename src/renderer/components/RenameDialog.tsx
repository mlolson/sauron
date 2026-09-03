import { useEffect, useRef, useState } from 'react'

export function RenameDialog({ initial, onSubmit, onClose }: { initial: string; onSubmit: (title: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Rename Session</h2>
        </header>
        <input
          ref={input}
          className="text"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
        />
        <p className="muted small">The tmux session is renamed too, so the title shows in <code>tmux ls</code>.</p>
        <div className="actions right">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            Rename
          </button>
        </div>
      </div>
    </div>
  )
}

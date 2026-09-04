import { useEffect, useRef, useState } from 'react'

/**
 * Asks for the branch a new worktree should be on. An empty answer means the default
 * `sauron/<id>` name, matching the New Session bar on the project page.
 */
export function WorktreeDialog({ title, action, onSubmit, onClose }: { title: string; action: string; onSubmit: (branch: string) => void; onClose: () => void }) {
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const submit = () => {
    onSubmit(value.trim())
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
        </header>
        <input
          ref={input}
          className="text"
          type="text"
          placeholder="branch name (default sauron/<id>)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
        />
        <p className="muted small">A new git worktree is created on this branch and the session runs there, so it cannot collide with work in the main checkout.</p>
        <div className="actions right">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            {action}
          </button>
        </div>
      </div>
    </div>
  )
}

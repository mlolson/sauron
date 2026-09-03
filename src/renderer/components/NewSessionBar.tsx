import { useEffect, useRef, useState } from 'react'
import type { AgentTool, Project, ToolPaths } from '@shared/types'

interface Props {
  project: Project
  toolPaths: ToolPaths | null
}

/** Title field plus a split button: New Terminal, with Claude and Codex as convenience choices. */
export function NewSessionBar({ project, toolPaths }: Props) {
  const [title, setTitle] = useState('')
  const [useWorktree, setUseWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const codexAvailable = Boolean(toolPaths?.codex)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const launch = (tool: AgentTool) => {
    setMenuOpen(false)
    void window.sauron.launchSession(project.id, tool, {
      title: title.trim() || undefined,
      worktreeBranch: useWorktree ? branch.trim() : undefined,
    })
    setTitle('')
  }

  return (
    <>
      <div className="launch-bar">
        <input
          type="text"
          placeholder="Session title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') launch('shell')
          }}
        />
        <div className="split-button" ref={menu}>
          <button className="primary" onClick={() => launch('shell')} title="Start a tmux terminal in this project">
            New Terminal
          </button>
          <button className="primary caret" onClick={() => setMenuOpen((v) => !v)} title="More">
            ▾
          </button>
          {menuOpen && (
            <div className="context-menu anchored">
              <div className="item" onClick={() => launch('shell')}>
                Terminal
              </div>
              <div className="item" onClick={() => launch('claude')}>
                Terminal running Claude
              </div>
              <div className={`item ${codexAvailable ? '' : 'disabled'}`} onClick={() => codexAvailable && launch('codex')} title={codexAvailable ? '' : 'codex was not found on PATH'}>
                Terminal running Codex
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="launch-options">
        <label>
          <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} />
          Run in a new git worktree
        </label>
        {useWorktree && <input type="text" placeholder="branch name (default sauron/<id>)" value={branch} onChange={(e) => setBranch(e.target.value)} />}
      </div>
    </>
  )
}

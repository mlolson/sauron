import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Project, SelectionTarget } from '@shared/types'
import { relativeTime } from '../time'

interface Props {
  project: Project
  path: string
  onSelect: (t: SelectionTarget) => void
}

export function DocumentView({ project, path, onSelect }: Props) {
  const [doc, setDoc] = useState<{ content: string; mtime: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    window.sauron
      .readDocument(project.id, path)
      .then((d) => {
        setDoc(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }
  useEffect(load, [project.id, path]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-read when the window regains focus or every 5 s while visible, so edits by agents show up.
  useEffect(() => {
    const t = setInterval(load, 5000)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [project.id, path]) // eslint-disable-line react-hooks/exhaustive-deps

  const html = useMemo(() => {
    if (!doc) return ''
    const isMarkdown = /\.(md|markdown)$/i.test(path)
    const raw = isMarkdown ? (marked.parse(doc.content, { gfm: true, breaks: false }) as string) : `<pre>${escapeHtml(doc.content)}</pre>`
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
  }, [doc, path])

  return (
    <div className="document-view">
      <header className="session-header">
        <div className="titles">
          <span className="title">{path.split('/').pop()}</span>
          <span className="subtitle">
            <button className="link" onClick={() => onSelect({ kind: 'project', id: project.id })}>
              {project.name}
            </button>{' '}
            / {path}
            {doc && ` · updated ${relativeTime(doc.mtime)}`}
          </span>
        </div>
        <div className="tabs" />
        <div className="actions">
          <button onClick={load}>Reload</button>
          <button onClick={() => window.sauron.revealInFinder(`${project.path}/${path}`)}>Reveal in Finder</button>
        </div>
      </header>
      <div className="document-body">
        {error && <p className="muted">Cannot read document: {error}</p>}
        {!error && doc && <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />}
        {!error && !doc && <p className="muted">Loading…</p>}
      </div>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

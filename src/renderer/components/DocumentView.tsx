import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { KeyDocument, Project, SelectionTarget } from '@shared/types'
import { relativeTime } from '@shared/time'

interface Props {
  project: Project
  path: string
  documents: KeyDocument[]
  onSelect: (t: SelectionTarget) => void
}

export function DocumentView({ project, path, documents, onSelect }: Props) {
  const [doc, setDoc] = useState<{ content: string; mtime: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const editing = draft !== null
  const dirty = editing && draft !== doc?.content
  const textarea = useRef<HTMLTextAreaElement>(null)

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

  // Switching documents abandons an edit; keeping a draft across files would apply it to the wrong one.
  useEffect(() => {
    setDraft(null)
    setSaveError(null)
  }, [project.id, path])

  const startEditing = () => {
    if (!doc) return
    setSaveError(null)
    setDraft(doc.content)
  }
  const stopEditing = () => {
    if (dirty && !confirm('Discard your unsaved changes?')) return
    setDraft(null)
    setSaveError(null)
  }

  /** Writes the draft and returns whether it landed, so a commit can wait for a good save. */
  const save = async (): Promise<boolean> => {
    if (draft === null) return false
    setSaving(true)
    setSaveError(null)
    try {
      const { mtime } = await window.sauron.writeDocument(project.id, path, draft, doc?.mtime ?? null)
      setDoc({ content: draft, mtime })
      return true
    } catch (e) {
      setSaveError((e as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveAndCommit = async (message: string) => {
    setCommitting(false)
    if (!(await save())) return
    try {
      await window.sauron.commitDocument(project.id, path, message)
      setDraft(null)
    } catch (e) {
      setSaveError((e as Error).message)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While editing, Escape leaves the editor rather than the document, so a stray press
      // cannot discard work silently.
      if (e.key !== 'Escape') return
      if (editing) stopEditing()
      else onSelect({ kind: 'project', id: project.id })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project.id, onSelect, editing, dirty]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-read when the window regains focus or every 5 s while visible, so edits by agents show up.
  // Suspended while editing: a reload would overwrite what is being typed.
  useEffect(() => {
    if (editing) return
    const t = setInterval(load, 5000)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [project.id, path, editing]) // eslint-disable-line react-hooks/exhaustive-deps

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
            {dirty && ' · unsaved changes'}
          </span>
        </div>
        <div className="tabs" />
        <div className="actions">
          {editing ? (
            <>
              <button disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="primary" disabled={saving} onClick={() => setCommitting(true)}>
                Save and commit…
              </button>
              <button title="Leave the editor (Esc)" onClick={stopEditing}>
                Done
              </button>
            </>
          ) : (
            <>
              <button disabled={!doc} onClick={startEditing}>
                Edit
              </button>
              <button onClick={load}>Reload</button>
              <button onClick={() => window.sauron.revealInFinder(`${project.path}/${path}`)}>Reveal in Finder</button>
              <button title="Back to the project (Esc)" onClick={() => onSelect({ kind: 'project', id: project.id })}>
                Close
              </button>
            </>
          )}
        </div>
      </header>
      <div className="document-split">
        <nav className="document-nav">
          <div className="section-title">Documents</div>
          {documents.map((d) => (
            <div
              key={d.path}
              className={`row ${d.path === path ? 'selected' : ''}`}
              title={d.path}
              onClick={() => onSelect({ kind: 'document', projectId: project.id, path: d.path })}
            >
              <span className="glyph">▤</span>
              <span className="label">
                <span className="name">{d.name}</span>
                {d.path.includes('/') && <span className="sub">{d.path.slice(0, d.path.lastIndexOf('/'))}</span>}
              </span>
            </div>
          ))}
          <button className="link add-doc" onClick={() => void window.sauron.addKeyDocumentDialog(project.id)}>
            + Add document…
          </button>
        </nav>
        <div className="document-body">
          {error && <p className="muted">Cannot read document: {error}</p>}
          {saveError && <p className="save-error">{saveError}</p>}
          {!error && editing && (
            <textarea
              ref={textarea}
              className="document-editor"
              spellCheck={false}
              value={draft ?? ''}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  void save()
                }
              }}
            />
          )}
          {!error && !editing && doc && <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />}
          {!error && !doc && <p className="muted">Loading…</p>}
        </div>
      </div>
      {committing && (
        <CommitDialog
          initial={`Update ${path.split('/').pop()}`}
          path={path}
          onSubmit={(message) => void saveAndCommit(message)}
          onClose={() => setCommitting(false)}
        />
      )}
    </div>
  )
}

/** Asks for a commit message. The save happens first, so this only ever commits what is on disk. */
function CommitDialog({ initial, path, onSubmit, onClose }: { initial: string; path: string; onSubmit: (message: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Commit Document</h2>
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
        <p className="muted small">
          Saves and commits <code>{path}</code> alone; anything else you have staged is left out.
        </p>
        <div className="actions right">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!value.trim()} onClick={submit}>
            Commit
          </button>
        </div>
      </div>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

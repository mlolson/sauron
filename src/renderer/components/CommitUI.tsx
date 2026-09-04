import { useState } from 'react'

/** Bits shared by the project page's commit list and the session Commits pane. */

export function diffLineKind(line: string): string {
  if (line.startsWith('diff --git')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition'
  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return 'meta'
  return ''
}

export function CopyHashButton({ hash, label = 'Copy hash to clipboard' }: { hash: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    window.sauron.copyToClipboard(hash)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <span className="copy-hash-wrap">
      <button onClick={copy}>{label}</button>
      {copied && <span className="copy-tooltip" role="status">Copied</span>}
    </span>
  )
}

/** Renders unified diff text. `null` means still loading; empty means a commit with no textual diff. */
export function DiffBody({ content }: { content: string | null }) {
  if (content === null) return <p className="muted">Loading diff…</p>
  if (!content) return <p className="muted">This commit has no textual diff.</p>
  return (
    <>
      {content.split('\n').map((line, index) => (
        <div key={index} className={`diff-line ${diffLineKind(line)}`}>
          {line || ' '}
        </div>
      ))}
    </>
  )
}

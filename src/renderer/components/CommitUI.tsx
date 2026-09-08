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

function useCopyFeedback(value: string) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    window.sauron.copyToClipboard(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return { copied, copy }
}

export function CopyHashButton({ hash, label = 'Copy hash to clipboard' }: { hash: string; label?: string }) {
  const { copied, copy } = useCopyFeedback(hash)
  return (
    <span className="copy-hash-wrap">
      <button onClick={copy}>{label}</button>
      {copied && <span className="copy-tooltip" role="status">Copied</span>}
    </span>
  )
}

/**
 * A branch name or path that copies itself when clicked. Used wherever one is shown, so the
 * behaviour is the same in a header chip, a sidebar row and a run list. The click does not
 * reach the row underneath.
 */
export function CopyLabel({ value, children, className = '', title }: { value: string; children?: React.ReactNode; className?: string; title?: string }) {
  const { copied, copy } = useCopyFeedback(value)
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    copy()
  }
  return (
    <span className={`copyable ${className}`} title={title ?? `${value} · click to copy`} onClick={handleClick}>
      {children ?? value}
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

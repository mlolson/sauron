import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriptEntry } from '@shared/transcript-types'

interface Props {
  sessionId: string
  readOnly: boolean
  /** Why it is read-only; defaults to the external-session explanation. */
  note?: string
}

export function TranscriptView({ sessionId, readOnly, note }: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setEntries([])
    setStatus('loading')
    const off = window.sauron.onTranscriptAppend(sessionId, (added) => {
      setEntries((prev) => [...prev, ...added])
      setTotal((t) => t + added.length)
    })
    // A run that has just started has no transcript file for a moment; keep looking rather
    // than reporting it missing for good.
    let retry: ReturnType<typeof setTimeout> | null = null
    const open = () => {
      void window.sauron.transcriptOpen(sessionId).then((page) => {
        if (cancelled) return
        if (!page) {
          setStatus('missing')
          retry = setTimeout(open, 2000)
          return
        }
        setEntries(page.entries)
        setTotal(page.total)
        setStatus('ready')
      })
    }
    open()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      off()
      void window.sauron.transcriptClose(sessionId)
    }
  }, [sessionId])

  // Follow the tail unless the user scrolled up.
  useEffect(() => {
    if (atBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [entries, atBottom])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [])

  const loadOlder = async () => {
    const first = entries[0]
    if (!first) return
    const el = scroller.current
    const before = el ? el.scrollHeight - el.scrollTop : 0
    const older = await window.sauron.transcriptLoadOlder(sessionId, first.index, 300)
    setEntries((prev) => [...older, ...prev])
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before
    })
  }

  const hasOlder = entries.length > 0 && entries[0]!.index > 0

  return (
    <div className="transcript">
      {readOnly && <div className="transcript-banner">{note ?? 'Read-only. This session was started outside Sauron; attach to it from the terminal where it runs.'}</div>}
      <div className="transcript-scroll" ref={scroller} onScroll={onScroll}>
        {status === 'missing' && <p className="muted center">No transcript file yet.</p>}
        {status === 'ready' && entries.length === 0 && <p className="muted center">Transcript is empty so far.</p>}
        {hasOlder && (
          <button className="load-older" onClick={() => void loadOlder()}>
            Load earlier ({entries[0]!.index} more)
          </button>
        )}
        {entries.map((e) => (
          <Entry key={e.index} entry={e} />
        ))}
      </div>
      {!atBottom && (
        <button className="jump" onClick={() => setAtBottom(true)}>
          ↓ Jump to bottom{total > entries.length ? '' : ''}
        </button>
      )}
    </div>
  )
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false)
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  switch (entry.kind) {
    case 'user':
      return (
        <div className="entry user">
          <div className="meta">You · {time}</div>
          <div className="body">{entry.text}</div>
        </div>
      )
    case 'assistant':
      return (
        <div className="entry assistant">
          <div className="meta">Agent · {time}</div>
          <div className="body">{entry.text}</div>
        </div>
      )
    case 'tool_call':
      return (
        <div className={`entry tool ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
          <div className="meta">
            <span className="chev">{open ? '▾' : '▸'}</span> <span className="tool-name">{entry.tool?.name ?? 'Tool'}</span> <span className="muted">{entry.tool?.summary}</span>
          </div>
          {open && <pre className="body">{entry.text}</pre>}
        </div>
      )
    case 'tool_result':
      return (
        <div className={`entry result ${entry.isError ? 'error' : ''} ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
          <div className="meta">
            <span className="chev">{open ? '▾' : '▸'}</span> {entry.isError ? 'Error' : 'Result'} <span className="muted">{firstLine(entry.text)}</span>
          </div>
          {open && <pre className="body">{entry.text.length > 20000 ? entry.text.slice(0, 20000) + '\n…' : entry.text}</pre>}
        </div>
      )
    default:
      return <div className="entry system">{entry.text}</div>
  }
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.length > 120 ? line.slice(0, 119) + '…' : line
}

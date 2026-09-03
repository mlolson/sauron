import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Entry {
  term: Terminal
  fit: FitAddon
  dispose: () => void
}

/** One xterm instance per session, kept across tab switches so we never re-attach. */
const terminals = new Map<string, Entry>()

function getOrCreate(sessionId: string): Entry {
  const existing = terminals.get(sessionId)
  if (existing) return existing

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    scrollback: 50_000,
    cursorBlink: true,
    macOptionIsMeta: true,
    allowProposedApi: true,
    theme: { background: '#000000' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const offData = window.sauron.onPtyData(sessionId, (data) => term.write(data))
  const offExit = window.sauron.onPtyExit(sessionId, () => {
    term.write('\r\n\x1b[2m[terminal detached]\x1b[0m\r\n')
  })
  const inputDisposable = term.onData((data) => window.sauron.ptyInput(sessionId, data))
  const resizeDisposable = term.onResize(({ cols, rows }) => window.sauron.ptyResize(sessionId, cols, rows))

  const entry: Entry = {
    term,
    fit,
    dispose: () => {
      offData()
      offExit()
      inputDisposable.dispose()
      resizeDisposable.dispose()
      term.dispose()
      terminals.delete(sessionId)
    },
  }
  terminals.set(sessionId, entry)
  return entry
}

export function disposeTerminal(sessionId: string): void {
  terminals.get(sessionId)?.dispose()
}

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = container.current
    if (!el) return
    const entry = getOrCreate(sessionId)
    const { term, fit } = entry
    if (!term.element) term.open(el)
    else el.appendChild(term.element)

    fit.fit()
    void window.sauron.ptyOpen(sessionId, term.cols, term.rows)
    term.focus()

    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(el)
    return () => {
      observer.disconnect()
      // Keep the terminal alive for the next mount; the pty stays open until detach/stop.
      if (term.element && term.element.parentElement === el) el.removeChild(term.element)
    }
  }, [sessionId])

  return <div className="terminal" ref={container} />
}

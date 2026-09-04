import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { overrideKeySequence } from '@shared/terminal-keys'
import { shouldFit, type PreviousFit } from '@shared/terminal-fit'

interface Entry {
  term: Terminal
  fit: FitAddon
  /** The grid we left on the previous fit, and when; used to spot an oscillation. */
  previous?: PreviousFit
  dispose: () => void
}

/** One xterm instance per session, kept across tab switches so we never re-attach. */
const terminals = new Map<string, Entry>()

/** Applies a proposed resize when it is a real one; see shouldFit for why some are refused. */
function fitIfNeeded(entry: Entry): void {
  const { term, fit, previous } = entry
  const proposed = fit.proposeDimensions()
  if (!shouldFit(proposed, { cols: term.cols, rows: term.rows }, previous, Date.now())) return
  entry.previous = { cols: term.cols, rows: term.rows, at: Date.now() }
  fit.fit()
}

export function applyTerminalPreferences(fontSize: number, scrollback: number): void {
  for (const entry of terminals.values()) {
    const { term } = entry
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
    if (term.options.scrollback !== scrollback) term.options.scrollback = scrollback
    // A font change legitimately re-grids, so forget any oscillation seen at the old size.
    entry.previous = undefined
    fitIfNeeded(entry)
  }
}

function getOrCreate(sessionId: string, fontSize: number, scrollback: number): Entry {
  const existing = terminals.get(sessionId)
  if (existing) return existing

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize,
    scrollback,
    cursorBlink: true,
    macOptionIsMeta: true,
    allowProposedApi: true,
    theme: { background: '#000000' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  term.attachCustomKeyEventHandler((event) => {
    const sequence = overrideKeySequence(event)
    if (sequence === null) return true
    // Handled here, so xterm must not also encode the key, and the helper textarea must not
    // swallow it as ordinary text input.
    event.preventDefault()
    window.sauron.ptyInput(sessionId, sequence)
    return false
  })

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

export function SessionTerminal({ sessionId, fontSize, scrollback }: { sessionId: string; fontSize: number; scrollback: number }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => applyTerminalPreferences(fontSize, scrollback), [fontSize, scrollback])

  useEffect(() => {
    const el = container.current
    if (!el) return
    const entry = getOrCreate(sessionId, fontSize, scrollback)
    const { term } = entry
    if (!term.element) term.open(el)
    else el.appendChild(term.element)

    fitIfNeeded(entry)
    void window.sauron.ptyOpen(sessionId, term.cols, term.rows)
    term.focus()

    // Measure on the next frame: resizing inside the observer's own callback is what provokes
    // "ResizeObserver loop" warnings, and it coalesces a burst of layout changes into one fit.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitIfNeeded(entry))
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      // Keep the terminal alive for the next mount; the pty stays open until detach/stop.
      if (term.element && term.element.parentElement === el) el.removeChild(term.element)
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps -- font changes are applied in place

  return <div className="terminal" ref={container} />
}

import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

/**
 * Mirrors console output to a log file (rotated once at ~5 MB) so problems in a launched app
 * can be inspected after the fact. Returns the log path.
 */
export function installFileLogging(file: string): string {
  mkdirSync(dirname(file), { recursive: true })
  try {
    if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`)
  } catch {
    // no file yet
  }
  const wrap = (level: 'log' | 'info' | 'warn' | 'error') => {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`)
      } catch {
        // never let logging break the app
      }
    }
  }
  wrap('log')
  wrap('info')
  wrap('warn')
  wrap('error')
  console.log('Sauron starting; log file', file)
  return file
}

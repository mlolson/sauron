import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { KeyDocument, Project } from '@shared/types'
import { SauronError } from '@shared/types'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target', '.build', 'coverage', '__pycache__'])

/** Markdown files at the project root or one level below, plus manual additions, minus removals. */
export async function listKeyDocuments(project: Project): Promise<KeyDocument[]> {
  const included = new Set(project.keyDocuments?.included ?? [])
  const excluded = new Set(project.keyDocuments?.excluded ?? [])
  const found = new Map<string, KeyDocument>()

  const consider = async (rel: string, source: KeyDocument['source']) => {
    if (excluded.has(rel) && source === 'default') return
    try {
      const s = await stat(join(project.path, rel))
      if (!s.isFile()) return
      found.set(rel, { path: rel, name: rel.split('/').pop() ?? rel, sizeBytes: s.size, mtime: s.mtime.toISOString(), source })
    } catch {
      // vanished; skip
    }
  }

  const scan = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await readdir(join(project.path, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const name = String(e.name)
      if (name.startsWith('.')) continue
      const rel = dir ? `${dir}/${name}` : name
      if (e.isDirectory()) {
        if (depth < 1 && !SKIP_DIRS.has(name)) await scan(rel, depth + 1)
      } else if (/\.(md|markdown)$/i.test(name)) {
        await consider(rel, 'default')
      }
    }
  }
  await scan('', 0)
  for (const rel of included) await consider(rel, 'added')

  return [...found.values()].sort((a, b) => {
    const da = a.path.split('/').length
    const db = b.path.split('/').length
    if (da !== db) return da - db
    // README first at each level, then alphabetical.
    const ra = /^readme/i.test(a.name) ? 0 : 1
    const rb = /^readme/i.test(b.name) ? 0 : 1
    if (ra !== rb) return ra - rb
    return a.path.localeCompare(b.path)
  })
}

/** Converts an absolute path inside the project to a project-relative one; rejects outsiders. */
export function relativeInside(project: Project, absolute: string): string {
  const root = resolve(project.path)
  const target = resolve(absolute)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.startsWith(sep) || resolve(root, rel) !== target) {
    throw new SauronError('invalid_state', `${absolute} is not inside ${project.path}.`)
  }
  return rel.split(sep).join('/')
}

/**
 * Writes a document, refusing when it changed since the editor loaded it. Agents edit these
 * files while they are open, so a blind write is a real way to lose their work.
 */
export async function writeDocument(project: Project, rel: string, content: string, expectedMtime: string | null): Promise<{ mtime: string }> {
  const abs = resolve(project.path, rel)
  relativeInside(project, abs)
  if (expectedMtime) {
    const current = await stat(abs).catch(() => null)
    if (current && current.mtime.toISOString() !== expectedMtime) {
      throw new SauronError('invalid_state', `${rel} changed on disk since you opened it. Reload to see the current version; your text stays in the editor.`)
    }
  }
  await writeFile(abs, content, 'utf8')
  const s = await stat(abs)
  return { mtime: s.mtime.toISOString() }
}

export async function readDocument(project: Project, rel: string): Promise<{ content: string; mtime: string }> {
  const abs = resolve(project.path, rel)
  relativeInside(project, abs)
  const [content, s] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
  return { content, mtime: s.mtime.toISOString() }
}

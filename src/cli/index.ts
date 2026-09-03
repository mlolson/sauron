/**
 * `sauron` command-line client. Talks to the running app over its Unix socket.
 *
 *   sauron ping
 *   sauron projects
 *   sauron projects add <dir>
 *   sauron sessions [--project <name|id>]
 *   sauron launch --project <name|id> [--tool shell|claude|codex] [--title <text>] [--prompt <text>] [--worktree [<branch>]]
 *   sauron rename --session <id> --title <text>
 *   sauron worktrees --project <name|id>
 *   sauron worktrees remove --project <name|id> --path <dir> [--force]
 *   sauron close --session <id>      (kill; agents stay resumable, plain terminals are forgotten)
 *   sauron stop --session <id>       (kill but keep the record)
 *   sauron send --session <id> --text <text>
 *   sauron status [get] --project <name|id>
 *   sauron status set --project <name|id> --summary <one sentence> [--update <bullet>]... [--todo <bullet>]... [--details <text>]
 *   sauron status refresh --project <name|id>
 *   sauron master                 (start or focus the supervisor agent)
 *   sauron select --project <name|id> | --session <id>
 *   sauron raw '<json>'
 *   sauron hook claude <Event>      (Claude Code hook: JSON payload on stdin)
 *   sauron hook codex '<json>'      (Codex notify: JSON payload as the last argument)
 * Hooks identify the session via SAURON_SESSION_ID, set by Sauron on launch.
 */
import { connect } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'

const socketPath = process.env.SAURON_SOCKET || join(homedir(), 'Library/Application Support/Sauron/sauron.sock')

const REPEATABLE = new Set(['update', 'todo'])

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string>; lists: Record<string, string[]> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const lists: Record<string, string[]> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      let value = 'true'
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        i++
      }
      if (REPEATABLE.has(key)) (lists[key] ??= []).push(value)
      else flags[key] = value
    } else {
      positional.push(a)
    }
  }
  return { positional, flags, lists }
}

function request(payload: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', (chunk: string) => (buffer += chunk))
    socket.once('end', () => {
      try {
        resolve(JSON.parse(buffer))
      } catch (e) {
        reject(new Error(`bad response: ${buffer}`))
      }
    })
    socket.once('error', (e) => reject(new Error(`cannot reach Sauron at ${socketPath}: ${e.message}`)))
  })
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function hookPayload(tool: string, positional: string[]): Promise<{ event: string; payload: unknown }> {
  if (tool === 'claude') {
    const raw = await readStdin()
    let payload: unknown = {}
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      payload = { raw }
    }
    const event = positional[2] ?? (payload && typeof payload === 'object' ? String((payload as { hook_event_name?: string }).hook_event_name ?? '') : '')
    return { event, payload }
  }
  // Codex appends the JSON payload as the final argument.
  const raw = positional[positional.length - 1] ?? ''
  let payload: Record<string, unknown> = {}
  try {
    payload = raw.trim().startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    payload = { raw }
  }
  return { event: String(payload.type ?? 'agent-turn-complete'), payload }
}

async function main(): Promise<void> {
  const { positional, flags, lists } = parseFlags(process.argv.slice(2))
  const [command, sub] = positional
  let payload: Record<string, unknown>
  switch (command) {
    case 'hook': {
      const tool = sub ?? ''
      const session = process.env.SAURON_SESSION_ID
      if (!session) {
        // Not launched by Sauron; nothing to report. Exit quietly so hooks never break a session.
        return
      }
      const hp = await hookPayload(tool, positional)
      try {
        const response = await request({ cmd: 'hook', tool, event: hp.event, session, payload: hp.payload })
        if (!response.ok) console.error('sauron hook:', response.error)
      } catch (e) {
        // Sauron is not running; the session continues unaffected.
        console.error('sauron hook:', (e as Error).message)
      }
      return
    }
    case 'ping':
      payload = { cmd: 'ping' }
      break
    case 'projects':
      payload = sub === 'add' ? { cmd: 'projects.add', path: positional[2] } : { cmd: 'projects.list' }
      break
    case 'sessions':
      payload = { cmd: 'sessions.list', project: flags.project }
      break
    case 'launch':
      payload = {
        cmd: 'sessions.launch',
        project: flags.project,
        tool: flags.tool,
        title: flags.title,
        prompt: flags.prompt,
        // --worktree alone means "new worktree, default branch"; --worktree <branch> names it.
        worktree: flags.worktree === undefined ? undefined : flags.worktree === 'true' ? '' : flags.worktree,
      }
      break
    case 'worktrees':
      payload =
        sub === 'remove'
          ? { cmd: 'worktrees.remove', project: flags.project, path: flags.path, force: flags.force === 'true' }
          : { cmd: 'worktrees.list', project: flags.project }
      break
    case 'stop':
      payload = { cmd: 'sessions.stop', session: flags.session }
      break
    case 'close':
      payload = { cmd: 'sessions.close', session: flags.session }
      break
    case 'hide':
      payload = { cmd: 'sessions.hide', session: flags.session }
      break
    case 'resume':
      payload = { cmd: 'sessions.resume', session: flags.session }
      break
    case 'rename':
      payload = { cmd: 'sessions.rename', session: flags.session, title: flags.title }
      break
    case 'send':
      payload = { cmd: 'sessions.send', session: flags.session, text: flags.text ?? positional.slice(1).join(' ') }
      break
    case 'status':
      if (sub === 'set') payload = { cmd: 'status.set', project: flags.project, summary: flags.summary, details: flags.details, updates: lists.update ?? [], todos: lists.todo ?? [] }
      else if (sub === 'refresh') payload = { cmd: 'status.refresh', project: flags.project }
      else payload = { cmd: 'status.get', project: flags.project }
      break
    case 'master':
      payload = { cmd: 'master.start' }
      break
    case 'select':
      payload = { cmd: 'select', project: flags.project, session: flags.session, document: flags.document }
      break
    case 'raw':
      payload = JSON.parse(sub ?? '{}')
      break
    default:
      console.error('usage: sauron <ping|projects|sessions|launch|stop|resume|send|status|master|select|worktrees|hook|raw> [options]')
      process.exit(2)
  }
  const response = await request(payload)
  if (!response.ok) {
    console.error('error:', response.error)
    process.exit(1)
  }
  console.log(JSON.stringify(response.result, null, 2))
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})

/**
 * `sauron` command-line client. Talks to the running app over its Unix socket.
 *
 *   sauron ping
 *   sauron projects
 *   sauron projects add <dir>
 *   sauron sessions [--project <name|id>]
 *   sauron launch --project <name|id> [--tool claude] [--prompt <text>]
 *   sauron stop --session <id>
 *   sauron select --project <name|id> | --session <id>
 *   sauron raw '<json>'
 */
import { connect } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'

const socketPath = process.env.SAURON_SOCKET || join(homedir(), 'Library/Application Support/Sauron/sauron.sock')

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
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

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2))
  const [command, sub] = positional
  let payload: Record<string, unknown>
  switch (command) {
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
      payload = { cmd: 'sessions.launch', project: flags.project, tool: flags.tool, prompt: flags.prompt }
      break
    case 'stop':
      payload = { cmd: 'sessions.stop', session: flags.session }
      break
    case 'resume':
      payload = { cmd: 'sessions.resume', session: flags.session }
      break
    case 'select':
      payload = { cmd: 'select', project: flags.project, session: flags.session }
      break
    case 'raw':
      payload = JSON.parse(sub ?? '{}')
      break
    default:
      console.error('usage: sauron <ping|projects|sessions|launch|stop|resume|select|raw> [options]')
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

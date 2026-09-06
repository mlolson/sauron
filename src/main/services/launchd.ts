import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './command'

/**
 * The one LaunchAgent Sauron installs: `sauron tick` every minute, which evaluates cron jobs.
 * launchd is the scheduler — it survives reboots and runs a missed tick after sleep — so no
 * daemon of Sauron's own has to be kept alive.
 */

export const TICK_LABEL = 'com.mattolson.sauron.tick'

export function tickPlist(sauronBin: string, logPath: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${TICK_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(sauronBin)}</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`
}

export function tickPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${TICK_LABEL}.plist`)
}

/**
 * Writes the plist if it changed and makes sure launchd has it loaded. Idempotent: a load
 * with nothing changed and the agent already running does nothing.
 */
export async function installTick(sauronBin: string, logPath: string): Promise<{ loaded: boolean; error: string | null }> {
  const path = tickPlistPath()
  const wanted = tickPlist(sauronBin, logPath)
  const current = await readFile(path, 'utf8').catch(() => null)
  const domain = `gui/${process.getuid?.() ?? 501}`
  const loaded = (await runCommand('launchctl', ['print', `${domain}/${TICK_LABEL}`])).code === 0
  if (current === wanted && loaded) return { loaded: true, error: null }
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  if (current !== wanted) await writeFile(path, wanted, 'utf8')
  // A changed plist has to be unloaded and loaded again; a missing one just loaded.
  if (loaded) await runCommand('launchctl', ['bootout', `${domain}/${TICK_LABEL}`])
  const boot = await runCommand('launchctl', ['bootstrap', domain, path])
  if (boot.code !== 0) return { loaded: false, error: `launchctl bootstrap: ${boot.stderr.trim() || `exit ${boot.code}`}` }
  return { loaded: true, error: null }
}

export async function uninstallTick(): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`
  await runCommand('launchctl', ['bootout', `${domain}/${TICK_LABEL}`])
}

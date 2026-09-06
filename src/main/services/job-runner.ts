import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { openSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AttributionStore } from './attribution-store'
import { dueCommitJobs, cooldownCutoff, dueCronJobs, dueIntervalJobs } from '@shared/triggers'
import { findExecutable } from './cli-resolver'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { join, resolve as resolvePath, isAbsolute } from 'node:path'
import { AppPaths, writeJsonAtomic } from './persistence'
import { JobStore } from './job-store'
import { WorktreeService } from './worktrees'
import { TmuxService } from './tmux'
import { resolveTools, sessionEnvironment } from './cli-resolver'
import { runCommand } from './command'
import { ensureClaudeTrusts } from './claude-config'
import { claudeHookSettings, codexNotifyConfig } from '@shared/hooks'
import { claudeTranscriptPath } from '@shared/transcripts'
import { expandArgs, expandJobPrompt, resolveProjectJobs, runBranchName, runOutcome, summarizeAgentOutput } from '@shared/jobs'
import { shellQuote, tmuxSessionName, TMUX_OPTION_PROJECT, TMUX_OPTION_SESSION, TMUX_OPTION_TITLE, TMUX_OPTION_TOOL } from '@shared/tmux-args'
import { defaultPreferences, SauronError } from '@shared/types'
import type { AgentDefinition, AppConfig, BackgroundAgentTemplate, BackgroundJob, JobRun, JobTrigger, Preferences, Project } from '@shared/types'
import { homedir } from 'node:os'

/**
 * Runs background jobs. This is the one code path that starts and finishes a run, and it is
 * driven from the CLI so that launchd, the post-commit hook, and the app all do exactly the
 * same thing — with the app open or closed. The app only observes the results.
 */

/** The userData directory the app uses, so the CLI reads the same config and stores. */
export function defaultRoot(): string {
  return process.env.SAURON_ROOT || join(homedir(), 'Library/Application Support/Sauron')
}

interface Loaded {
  paths: AppPaths
  config: AppConfig
  agents: AgentDefinition[]
  templates: BackgroundAgentTemplate[]
}

/** A project's background agents as they apply to it. */
function jobsOf(loaded: Loaded, project: Project): BackgroundJob[] {
  return resolveProjectJobs(project, loaded.templates)
}

/** What the trigger rules need to know about a project's jobs, read once per project. */
function triggerState(store: JobStore, projectId: string, jobs: BackgroundJob[]) {
  return {
    running: new Set(jobs.filter((j) => store.running(projectId, j.id)).map((j) => j.id)),
    lastRunAt: new Map(jobs.map((j) => [j.id, store.lastRunAt(projectId, j.id)]).filter((e): e is [string, string] => typeof e[1] === 'string')),
  }
}

async function load(root: string): Promise<Loaded> {
  const paths = new AppPaths(root)
  await paths.createLayout()
  const config = JSON.parse(await readFile(paths.configFile, 'utf8')) as AppConfig
  const saved = config.preferences?.agents ?? defaultPreferences.agents
  // A profile saved before background commands existed gets the built-in one for its id.
  const agents = saved.map((agent) => {
    const builtIn = defaultPreferences.agents.find((d) => d.id === agent.id)
    return agent.backgroundCommand || !builtIn?.backgroundCommand ? agent : { ...agent, backgroundCommand: builtIn.backgroundCommand }
  })
  return { paths, config, agents, templates: config.preferences?.backgroundAgents ?? [] }
}

function findJob(loaded: Loaded, projectId: string, jobId: string): { project: Project; job: BackgroundJob } {
  const project = loaded.config.projects.find((p) => p.id === projectId || p.name === projectId)
  if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}.`)
  const job = jobsOf(loaded, project).find((j) => j.id === jobId)
  if (!job) throw new SauronError('invalid_state', `Project ${project.name} has no background agent "${jobId}" attached.`)
  return { project, job }
}

/** Tells the app, if it is running, that run state changed. Silence when it is not. */
async function notifyApp(socketPath: string): Promise<void> {
  const { connect } = await import('node:net')
  await new Promise<void>((done) => {
    const socket = connect(socketPath)
    const finish = () => {
      socket.destroy()
      done()
    }
    socket.setTimeout(1500, finish)
    socket.on('connect', () => socket.write(JSON.stringify({ cmd: 'jobs.changed' }) + '\n'))
    socket.on('data', finish)
    socket.on('error', finish)
    socket.on('close', finish)
  })
}

/**
 * Starts a run: a fresh worktree on a fresh branch, the agent headless inside a tmux session,
 * and a wrapper that reports back through `sauron job finish` when the agent exits.
 */
export async function startRun(root: string, projectId: string, jobId: string, trigger: JobTrigger['kind']): Promise<JobRun> {
  const loaded = await load(root)
  const { paths, config, agents } = loaded
  const { project, job } = findJob(loaded, projectId, jobId)
  if (!job.enabled) throw new SauronError('invalid_state', `Job "${job.name}" is disabled.`)
  const profile = agents.find((a) => a.id === job.agentId)
  if (!profile?.backgroundCommand?.length) throw new SauronError('invalid_state', `Agent "${job.agentId}" has no background command configured.`)

  const store = new JobStore(paths.jobsDatabase)
  store.open()
  try {
    const running = store.running(project.id, job.id)
    if (running) throw new SauronError('invalid_state', `Job "${job.name}" is already running (started ${running.startedAt}).`)

    const overrides: Partial<Preferences['toolOverrides']> = config.preferences?.toolOverrides ?? {}
    const tools = await resolveTools(
      { claude: overrides.claude || undefined, codex: overrides.codex || undefined, tmux: overrides.tmux || undefined, git: overrides.git || undefined },
      agents,
    )
    if (!tools.git) throw new SauronError('executable_not_found', 'git was not found on PATH.')
    if (!tools.tmux) throw new SauronError('executable_not_found', 'tmux was not found on PATH.')
    const executable = tools.agents[profile.id]
    if (!executable) throw new SauronError('executable_not_found', `${profile.name} executable was not found.`)

    const now = new Date()
    const runId = randomUUID()
    const sessionId = randomUUID()
    const branch = runBranchName(job.id, now)
    const worktrees = new WorktreeService(tools.git, config.preferences?.worktreeBase || paths.worktreesDir)
    const worktreePath = await worktrees.create(project.path, project.name, branch)
    const base = await runCommand(tools.git, ['rev-parse', 'HEAD'], { cwd: worktreePath })
    if (base.code !== 0) throw new SauronError('command_failed', `git rev-parse: ${base.stderr.trim()}`)

    const promptPath = isAbsolute(job.promptFile) ? job.promptFile : resolvePath(paths.root, job.promptFile)
    const template = await readFile(promptPath, 'utf8')
    const prompt = expandJobPrompt(template, { projectName: project.name, projectPath: project.path, branch, jobName: job.name })

    const sauronBin = join(paths.binDir, 'sauron')
    const values = { prompt, cwd: worktreePath, sessionId, sauronBin }
    const integration: string[] = []
    if (profile.id === 'claude') {
      // Same integration as an interactive launch: a known session id so the transcript is
      // discoverable, hooks that report state, and trust for the new directory.
      await ensureClaudeTrusts(worktreePath)
      const settings = join(paths.sessionsDir, sessionId, 'claude-settings.json')
      await writeJsonAtomic(settings, claudeHookSettings(sauronBin))
      integration.push('--session-id', sessionId, '--settings', settings)
    } else if (profile.id === 'codex') {
      integration.push('-c', codexNotifyConfig(sauronBin))
    }
    const command = [executable, ...integration, ...expandArgs(profile.args, values), ...expandArgs(profile.backgroundCommand, values)]

    await mkdir(paths.jobsDir, { recursive: true })
    const logPath = join(paths.jobsDir, `${runId}.log`)
    const script = join(paths.jobsDir, `${runId}.sh`)
    // tee keeps the output visible to anyone attached while also keeping the log; PIPESTATUS
    // preserves the agent's exit code through the pipe. Every path reports back.
    await writeFile(script, [
      '#!/bin/bash',
      `cd ${shellQuote(worktreePath)} || exit 97`,
      `${command.map(shellQuote).join(' ')} 2>&1 | tee ${shellQuote(logPath)}`,
      'code=${PIPESTATUS[0]}',
      `${shellQuote(sauronBin)} job finish --run ${shellQuote(runId)} --exit "$code"`,
      'exit "$code"',
      '',
    ].join('\n'), 'utf8')
    await chmod(script, 0o755)

    const tmux = new TmuxService(tools.tmux, sessionEnvironment(tools.path))
    const tmuxName = tmuxSessionName(`bg-${job.id}`, sessionId)
    const run: JobRun = {
      id: runId,
      jobId: job.id,
      projectId: project.id,
      sessionId,
      tmuxName,
      branch,
      worktreePath,
      baseCommit: base.stdout.trim(),
      trigger,
      startedAt: now.toISOString(),
      finishedAt: null,
      status: 'running',
      summary: null,
      exitCode: null,
      logPath,
      commitCount: 0,
    }
    // Recorded before the agent starts: a run that exists only as a tmux session would work
    // unobserved and could never be reviewed. If the spawn fails the record says so.
    store.insert(run)
    try {
      await spawnAgent(tmux, tmuxName, script, worktreePath, sessionId, project.id, job.name, profile.id, paths, tools.path)
    } catch (error) {
      store.finish(runId, { status: 'failed', summary: `Could not start the agent: ${(error as Error).message}`, exitCode: -1, commitCount: 0, finishedAt: new Date().toISOString() })
      throw error
    }
    await notifyApp(paths.socketFile)
    return run
  } finally {
    store.close()
  }
}

async function spawnAgent(tmux: TmuxService, tmuxName: string, script: string, worktreePath: string, sessionId: string, projectId: string, jobName: string, toolId: string, paths: AppPaths, path: string): Promise<void> {
  await tmux.newSession({
    name: tmuxName,
    workingDir: worktreePath,
    environment: {
      PATH: `${paths.binDir}:${path}`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SAURON_SESSION_ID: sessionId,
      SAURON_SOCKET: paths.socketFile,
    },
    command: ['/bin/bash', script],
  })
  await tmux.setOption(tmuxName, TMUX_OPTION_SESSION, sessionId)
  await tmux.setOption(tmuxName, TMUX_OPTION_PROJECT, projectId)
  await tmux.setOption(tmuxName, TMUX_OPTION_TITLE, `${jobName} (run)`)
  await tmux.setOption(tmuxName, TMUX_OPTION_TOOL, toolId)
}

/**
 * Merges a reviewed run into its project's current branch with --no-ff, then removes the
 * run's worktree and branch. Shared by the app's Merge button and by auto-merge in the
 * runner, so the two cannot drift. Refuses, without touching anything, when the merge would
 * conflict or the main checkout has uncommitted changes.
 */
export async function mergeRunIntoProject(git: string, worktreeBase: string, project: Project, run: JobRun, jobName: string): Promise<{ merged: true } | { merged: false; reason: string }> {
  const dirty = await runCommand(git, ['status', '--porcelain'], { cwd: project.path })
  if (dirty.code === 0 && dirty.stdout.trim()) return { merged: false, reason: 'the main checkout has uncommitted changes' }
  const head = await runCommand(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.path })
  const current = head.code === 0 ? head.stdout.trim() : 'HEAD'
  const probe = await runCommand(git, ['merge-tree', '--write-tree', current, run.branch], { cwd: project.path })
  if (probe.code !== 0) return { merged: false, reason: `${run.branch} conflicts with ${current}` }
  const merge = await runCommand(git, ['merge', '--no-ff', '-m', `Merge background run: ${jobName}`, run.branch], { cwd: project.path })
  if (merge.code !== 0) return { merged: false, reason: `git merge: ${merge.stderr.trim() || merge.stdout.trim()}` }
  const worktrees = new WorktreeService(git, worktreeBase)
  await worktrees.remove(project.path, run.worktreePath, true).catch(() => undefined)
  await runCommand(git, ['branch', '-d', run.branch], { cwd: project.path })
  return { merged: true }
}

/** Records how a run ended. Called by the wrapper script when the agent exits. */
export async function finishRun(root: string, runId: string, exitCode: number): Promise<JobRun> {
  const loaded = await load(root)
  const { paths, config, agents } = loaded
  const store = new JobStore(paths.jobsDatabase)
  store.open()
  try {
    const run = store.get(runId)
    if (!run) throw new SauronError('invalid_state', `Unknown run ${runId}.`)
    const overrides: Partial<Preferences['toolOverrides']> = config.preferences?.toolOverrides ?? {}
    const tools = await resolveTools({ git: overrides.git || undefined }, agents)
    if (!tools.git) throw new SauronError('executable_not_found', 'git was not found on PATH.')

    const count = await runCommand(tools.git, ['rev-list', '--count', `${run.baseCommit}..HEAD`], { cwd: run.worktreePath })
    const commitCount = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0
    const output = await readFile(run.logPath, 'utf8').catch(() => '')
    const status = runOutcome(exitCode, commitCount)
    if (status === 'no_changes') {
      // Nothing to review, so nothing to keep: the worktree and branch go now.
      const worktrees = new WorktreeService(tools.git, config.preferences?.worktreeBase || paths.worktreesDir)
      await worktrees.remove(run.worktreePath.replace(/\/[^/]+$/, ''), run.worktreePath, true).catch(() => undefined)
      await runCommand(tools.git, ['branch', '-D', run.branch], { cwd: config.projects.find((p) => p.id === run.projectId)?.path ?? run.worktreePath })
    }
    let summary = summarizeAgentOutput(output) || null
    store.finish(runId, { status, summary, exitCode, commitCount, finishedAt: new Date().toISOString() })
    const project = config.projects.find((p) => p.id === run.projectId)
    const job = project ? jobsOf(loaded, project).find((j) => j.id === run.jobId) : undefined
    if (status === 'needs_review' && project && job?.autoMerge) {
      const result = await mergeRunIntoProject(tools.git, config.preferences?.worktreeBase || paths.worktreesDir, project, run, job.name)
      if (result.merged) {
        store.setStatus(runId, 'merged')
      } else {
        // Left for review, and the reviewer is told why it was not merged for them.
        summary = `${summary ?? ''}\n\n(Not merged automatically: ${result.reason}.)`.trim()
        store.finish(runId, { status, summary, exitCode, commitCount, finishedAt: new Date().toISOString() })
      }
    }
    await notifyApp(paths.socketFile)
    return store.get(runId)!
  } finally {
    store.close()
  }
}

/**
 * The project a directory belongs to, and whether it is the project's main checkout rather
 * than one of its worktrees. Resolved through git so a worktree anywhere maps back to its
 * repository; `git` is looked up on PATH, which inside a hook always has it.
 */
async function projectForDirectory(config: AppConfig, cwd: string): Promise<{ project: Project; isMainCheckout: boolean } | null> {
  const top = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd })
  const common = await runCommand('git', ['rev-parse', '--git-common-dir'], { cwd })
  if (top.code !== 0 || common.code !== 0) return null
  const mainRepo = await realpath(dirname(resolvePath(cwd, common.stdout.trim()))).catch(() => null)
  const toplevel = await realpath(top.stdout.trim()).catch(() => null)
  if (!mainRepo || !toplevel) return null
  for (const project of config.projects) {
    const path = await realpath(project.path).catch(() => null)
    if (path === mainRepo) return { project, isMainCheckout: toplevel === mainRepo }
  }
  return null
}

/**
 * The post-commit hook's work: attribute the commit, then start any commit-triggered jobs
 * that are due. Runs for every commit in a registered project, app or no app, and must be
 * quick and quiet — the commit has already happened and nothing here may disturb it.
 */
export async function handleCommit(root: string, input: { hash: string; cwd: string; session: string | null; socketPath: string }): Promise<{ started: string[] }> {
  const loaded = await load(root)
  const { paths, config } = loaded
  const located = await projectForDirectory(config, input.cwd)
  if (!located) return { started: [] }
  const { project, isMainCheckout } = located

  if (input.session) {
    // The app records attribution itself when it is running (and refreshes summaries on the
    // back of it); when it is not, write the row directly so nothing is lost.
    const recorded = await sendToApp(input.socketPath, { cmd: 'commits.record', session: input.session, cwd: input.cwd, hash: input.hash })
    if (!recorded) {
      const attribution = new AttributionStore(paths.attributionDatabase)
      attribution.open()
      try {
        attribution.set(project.id, input.hash, input.session)
      } finally {
        attribution.close()
      }
    }
  }

  // Triggers: only the main checkout, and never a background run's own commit — a cleanup
  // job that committed would otherwise trigger itself forever.
  if (!isMainCheckout) return { started: [] }
  const store = new JobStore(paths.jobsDatabase)
  store.open()
  try {
    if (input.session && store.isRunSession(input.session)) return { started: [] }
    const jobs = jobsOf(loaded, project)
    const now = new Date()
    const state = triggerState(store, project.id, jobs)
    const started: string[] = []
    for (const job of dueCommitJobs(jobs, state, now)) {
      if (job.trigger.kind !== 'commit') continue
      if (!store.claim(project.id, job.id, now.toISOString(), cooldownCutoff({ ...job, trigger: job.trigger }, now))) continue
      spawnRunner(paths, project.id, job.id, 'commit')
      started.push(job.id)
    }
    return { started }
  } finally {
    store.close()
  }
}

/**
 * Starts `sauron job run` detached so the hook returns at once. git sets GIT_DIR and friends
 * in a hook's environment, which would point every git call the runner makes at the wrong
 * repository; they are stripped. Output goes to a log beside the runs'.
 */
function spawnRunner(paths: AppPaths, projectId: string, jobId: string, trigger: JobTrigger['kind']): void {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_') && k !== 'SAURON_SESSION_ID') env[k] = v
  const log = openSync(join(paths.jobsDir, 'triggers.log'), 'a')
  const child = spawn(join(paths.binDir, 'sauron'), ['job', 'run', '--project', projectId, '--job', jobId, '--trigger', trigger], {
    detached: true,
    stdio: ['ignore', log, log],
    env,
  })
  child.unref()
}

async function sendToApp(socketPath: string, payload: Record<string, unknown>): Promise<boolean> {
  const { connect } = await import('node:net')
  return new Promise<boolean>((done) => {
    const socket = connect(socketPath)
    let ok = false
    const finish = () => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(1500, finish)
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', (data) => {
      try {
        ok = Boolean((JSON.parse(String(data)) as { ok?: unknown }).ok)
      } catch {
        ok = false
      }
      finish()
    })
    socket.on('error', finish)
    socket.on('close', finish)
  })
}

/**
 * One scheduler tick, run by launchd every minute. Starts each cron job whose most recent
 * scheduled minute has not had a run, claiming the slot in SQLite first so a slot starts at
 * most one run however many ticks see it. Cheap when nothing is due: a config read, a few
 * SQLite reads, and no shell.
 */
export async function tick(root: string, now = new Date()): Promise<{ started: string[]; skipped: string[] }> {
  const loaded = await load(root)
  const { paths, config } = loaded
  trimLog(join(paths.jobsDir, 'tick.log'))
  const store = new JobStore(paths.jobsDatabase)
  store.open()
  const started: string[] = []
  const skipped: string[] = []
  try {
    for (const project of config.projects) {
      if (project.archived) continue
      const jobs = jobsOf(loaded, project)
      const state = triggerState(store, project.id, jobs)
      // Cron: the claim's cutoff is the scheduled minute, so a slot starts at most one run.
      // Interval: the cutoff is now minus the spacing, so the claim enforces the spacing too.
      const due = [
        ...dueCronJobs(jobs, state, now).map(({ job, scheduledAt }) => ({ job, cutoff: scheduledAt })),
        ...dueIntervalJobs(jobs, state, now),
      ]
      for (const { job, cutoff } of due) {
        const scheduledAt = cutoff
        if (!store.claim(project.id, job.id, now.toISOString(), cutoff.toISOString())) continue
        if (job.skipIfUnchanged && !(await changedSinceLastRun(config, store, project, job.id))) {
          skipped.push(`${project.name}/${job.id}`)
          console.log(`${now.toISOString()} skipped ${project.name}/${job.id}: no commits since its last run`)
          continue
        }
        spawnRunner(paths, project.id, job.id, job.trigger.kind)
        started.push(`${project.name}/${job.id}`)
        console.log(`${now.toISOString()} started ${project.name}/${job.id} for ${scheduledAt.toISOString()}`)
      }
    }
  } finally {
    store.close()
  }
  return { started, skipped }
}

/**
 * Keeps the tick log bounded. Electron's runtime writes a line of stderr on every launch, one
 * a minute here, and launchd reopens the file for each tick, so truncating between ticks is
 * safe. The tail is kept so recent actions stay readable.
 */
function trimLog(path: string, maxBytes = 512 * 1024, keepBytes = 64 * 1024): void {
  try {
    if (statSync(path).size <= maxBytes) return
    const tail = readFileSync(path, 'utf8').slice(-keepBytes)
    writeFileSync(path, tail.slice(tail.indexOf('\n') + 1), 'utf8')
  } catch {
    // no log yet, or unreadable: nothing to trim
  }
}

/** Whether the main checkout's HEAD moved since the job's last run began. Never run: yes. */
async function changedSinceLastRun(config: AppConfig, store: JobStore, project: Project, jobId: string): Promise<boolean> {
  const last = store.forJob(project.id, jobId, 1)[0]
  if (!last) return true
  // launchd's PATH is minimal; find git the way the app does, without a login shell.
  const git = config.preferences?.toolOverrides?.git || findExecutable('git', `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin`)
  if (!git) return true
  const head = await runCommand(git, ['rev-parse', 'HEAD'], { cwd: project.path })
  return head.code !== 0 || head.stdout.trim() !== last.baseCommit
}

/** Where a Claude run's transcript will be, for the app to adopt. */
export function runTranscriptPath(run: JobRun, tool: string): string | null {
  return tool === 'claude' ? claudeTranscriptPath(homedir(), run.worktreePath, run.sessionId) : null
}

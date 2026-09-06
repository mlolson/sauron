import { randomUUID } from 'node:crypto'
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
import { expandArgs, expandJobPrompt, runBranchName, runOutcome, summarizeAgentOutput } from '@shared/jobs'
import { shellQuote, tmuxSessionName, TMUX_OPTION_PROJECT, TMUX_OPTION_SESSION, TMUX_OPTION_TITLE, TMUX_OPTION_TOOL } from '@shared/tmux-args'
import { defaultPreferences, SauronError } from '@shared/types'
import type { AgentDefinition, AppConfig, BackgroundJob, JobRun, JobTrigger, Preferences, Project } from '@shared/types'
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
  return { paths, config, agents }
}

function findJob(config: AppConfig, projectId: string, jobId: string): { project: Project; job: BackgroundJob } {
  const project = config.projects.find((p) => p.id === projectId || p.name === projectId)
  if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}.`)
  const job = project.backgroundJobs?.find((j) => j.id === jobId)
  if (!job) throw new SauronError('invalid_state', `Project ${project.name} has no background job "${jobId}".`)
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
  const { paths, config, agents } = await load(root)
  const { project, job } = findJob(config, projectId, jobId)
  if (!job.enabled) throw new SauronError('invalid_state', `Job "${job.name}" is disabled.`)
  const profile = agents.find((a) => a.id === job.agentId)
  if (!profile?.backgroundCommand?.length) throw new SauronError('invalid_state', `Agent "${job.agentId}" has no background command configured.`)

  const store = new JobStore(paths.jobsDatabase)
  store.open()
  try {
    const running = store.running(job.id)
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
    await tmux.newSession({
      name: tmuxName,
      workingDir: worktreePath,
      environment: {
        PATH: `${paths.binDir}:${tools.path}`,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        SAURON_SESSION_ID: sessionId,
        SAURON_SOCKET: paths.socketFile,
      },
      command: ['/bin/bash', script],
    })
    await tmux.setOption(tmuxName, TMUX_OPTION_SESSION, sessionId)
    await tmux.setOption(tmuxName, TMUX_OPTION_PROJECT, project.id)
    await tmux.setOption(tmuxName, TMUX_OPTION_TITLE, `${job.name} (run)`)
    await tmux.setOption(tmuxName, TMUX_OPTION_TOOL, profile.id)

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
    store.insert(run)
    await notifyApp(paths.socketFile)
    return run
  } finally {
    store.close()
  }
}

/** Records how a run ended. Called by the wrapper script when the agent exits. */
export async function finishRun(root: string, runId: string, exitCode: number): Promise<JobRun> {
  const { paths, config, agents } = await load(root)
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
    store.finish(runId, { status, summary: summarizeAgentOutput(output) || null, exitCode, commitCount, finishedAt: new Date().toISOString() })
    await notifyApp(paths.socketFile)
    return store.get(runId)!
  } finally {
    store.close()
  }
}

/** Where a Claude run's transcript will be, for the app to adopt. */
export function runTranscriptPath(run: JobRun, tool: string): string | null {
  return tool === 'claude' ? claudeTranscriptPath(homedir(), run.worktreePath, run.sessionId) : null
}

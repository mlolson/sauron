# Sauron

**One window for every coding agent you have running.**

Sauron is a macOS app for overseeing AI coding agents across your projects. If you run
Claude Code or Codex in more than one repository at a time, you know the failure mode:
sessions scattered across terminal tabs, no way to tell which one is waiting on you, no
memory of what each project was in the middle of, and no record of which agent made which
commit. Sauron replaces that sprawl with a single view.

Every project you add gets a live status summary, a list of the sessions running in it, and
its recent commits — each one attributed to the session that made it. Sessions run inside
tmux, so they outlive the app; you can attach to any of them from a plain terminal. A
persistent **supervisor agent** keeps the summaries current and can start or direct worker
sessions on your behalf.

Claude Code and Codex are built in. Any other interactive terminal agent (OpenCode, Pi, your
own) can be added as a profile in Preferences.

## Key features

**Project overview.** Each project shows a supervisor-written summary of where things stand,
its key documents (any Markdown at the root or one level down, plus files you add), its git
worktrees, and its recent commits. Documents open in a built-in viewer that doubles as an
editor: edit, save, or save-and-commit the file alone without touching anything else you
have staged. A save is refused if an agent changed the file underneath you.

**Sessions that survive.** Every session Sauron starts runs in a tmux session named
`sauron-<project>-<id>`. Quit the app, relaunch, and they are all still there. Copy the
attach command from the session header and drive the same session from iTerm or Terminal.

**Commit attribution.** A post-commit hook, installed into each project, records which
session made every commit — it fires only when git runs inside a Sauron session, so your own
commits are left alone. Each session in the sidebar shows its last commit; the **Commits**
pane shows a session's full history with a diff viewer, switchable to the whole project and
filterable by branch.

**Sessions you didn't start here.** Claude and Codex sessions launched from a terminal appear
automatically under their project, read-only with a live transcript. **Import** brings one
under Sauron as a managed session continuing a copy of the conversation.

**Fork and handoff.** Fork a Claude or Codex session into a new one that continues a copy of
its conversation. **Handoff** goes further: hand a session's work to a *different* agent.
Agents cannot read each other's session stores, so Sauron writes a briefing — the recent
conversation, the session's commits, the branch and working-tree state — and starts the new
agent with it. No model in the loop; it takes a fraction of a second.

**Worktrees.** Launch a session into a fresh git worktree on its own branch, so agents working
in parallel cannot step on each other. The session header shows which branch and checkout a
session is in, and updates within seconds when it changes.

**Supervisor agent.** A long-lived agent with its own generated home directory and
instructions. Chat with it, ask it to start or message workers, or click **Refresh** on a
project to have it rewrite the status summary. Summaries also refresh automatically after
commits. Right-click it to restart, pause summaries, or disable it entirely.

**Small things that matter.** Shift+Enter inserts a newline in the embedded terminal, as it
does in a native one. The sidebar collapses to a rail. Each session row shows how long since
it was active. A quick switcher (⌘K) jumps between sessions.

## Stack

Electron, TypeScript, React, xterm.js, node-pty, built with electron-vite. Sessions run
inside tmux; commit attribution lives in a SQLite database alongside the app's config.

## Building and running

Requires Node 22+, pnpm, and on the machine: `tmux`, `git`, `claude` (Codex optional).

```sh
pnpm install          # also rebuilds node-pty for Electron
pnpm dev              # hot-reloading development run
scripts/app.sh             # build and launch the unpackaged dev build, detached
scripts/app.sh --packaged  # build and launch dist/mac-arm64/Sauron.app (proper name and icon; slower)
scripts/install-launcher.sh  # installs `sauron-dev` on PATH and ~/Desktop/Sauron.app, both of which run scripts/app.sh
pnpm test             # Vitest
pnpm typecheck
pnpm package          # unsigned Sauron.app in dist/
```

## Using it

- **⌘O** add a project, **⌘,** preferences, **⌘K** quick switcher, **⌘⇧]** / **⌘⇧[** next and
  previous live session. Right-click projects, sessions, and the supervisor for actions.
- Add a project by dragging a git repository onto the window, pressing ⌘O, or from the shell:
  `open -a Sauron ~/code/my-repo` (packaged app) or `scripts/sauron projects add ~/code/my-repo`.
- The supervisor's home is `~/Library/Application Support/Sauron/master`; Sauron writes both
  `CLAUDE.md` and `AGENTS.md` there so agents of either convention receive its instructions.
- Logs: `~/Library/Logs/Sauron/main.log` (Preferences > Reveal Logs).
- `docs/QA.md` is the manual checklist; `scripts/smoke.sh` is the end-to-end check against a
  running app. `TODOS.md` tracks open items.

## The `sauron` CLI

`scripts/sauron` talks to the running app over `~/Library/Application Support/Sauron/sauron.sock`.
The supervisor agent uses the same commands to drive workers.

```sh
scripts/sauron ping
scripts/sauron projects [add <dir>]
scripts/sauron sessions [--project <name|id>]
scripts/sauron launch --project <name|id> [--tool claude|codex|shell|<profile>] [--prompt "..."] [--worktree [<branch>]]
scripts/sauron send --session <id> --text "..."
scripts/sauron stop | resume | close | hide --session <id>
scripts/sauron fork --session <id>
scripts/sauron handoff --session <id> --tool <profile>
scripts/sauron rename --session <id> --title "..."
scripts/sauron worktrees --project <name|id> [remove --path <dir> [--force]]
scripts/sauron status refresh --project <name|id>   # ask the supervisor to rewrite the summary
scripts/sauron status set --project <name|id> --summary "..." [--details "..."] [--update "..."] [--todo "..."]
scripts/sauron master                            # start the supervisor
scripts/sauron select --project <name|id> | --session <id> | --document <path>
```

Set `SAURON_TOOL_CLAUDE`, `SAURON_TOOL_CODEX`, `SAURON_TOOL_TMUX`, or `SAURON_TOOL_GIT` to override
a tool's path; the value `none` simulates a missing tool.

## Agent profiles

Preferences > Agent profiles lets you add any interactive CLI agent by giving it an id, name,
executable, and arguments. Arguments are stored as an array and support `{prompt}`, `{cwd}`,
`{sessionId}`, and `{sauronBin}` placeholders. If `{prompt}` is absent, an initial prompt is
appended as the final argument. Custom agents run in the same persistent tmux terminals as the
built-ins and can be handoff targets; transcript discovery, hooks, forking, and resume remain
built-in integrations for Claude and Codex.

An agent profile may define `forkCommand` as an argument array. It supports the same placeholders
plus `{sourceSessionId}`. Fork and Import only appear for sessions with a known CLI session id
whose profile has a non-empty fork command. Claude and Codex include fork commands by default.

Claude and Codex are themselves editable profiles. Their default profile arguments bypass
permission prompts; remove those arguments in Preferences if you want the CLIs to prompt normally.

The supervisor agent is selected separately in Preferences. Its extra arguments can select a
model (for example `--model opus` for a Claude profile).

Post-commit summary automation is configured with `supervisorProjectSummaryAfterCommit` and
`supervisorProjectSummaryAfterCommitCooldownMinutes` (default 5); the supervisor's context menu
toggles the same setting as **Pause summaries**. Refreshes are triggered only by commits the
post-commit hook reports from inside a Sauron session. `supervisorProjectSummaryPromptFile`
points to the Markdown prompt template (relative paths resolve beside `config.json`) and supports
`{projectName}`, `{projectId}`, `{projectPath}`, and `{previousSummaryUpdatedAt}` placeholders.

## How commit attribution works

When a project is added, Sauron installs a `post-commit` hook into it (an existing hook is kept
and chained to). The hook inherits the environment of whatever invoked git, so it sees
`SAURON_SESSION_ID` exactly when the commit came from a managed session, and reports the commit
to the app over the control socket; otherwise it does nothing. Every path in the hook exits 0,
so a Sauron problem can never fail a commit. Linked worktrees share the main checkout's hooks,
so one install covers every worktree Sauron creates. Removing a project removes the hook and
restores whatever it displaced.

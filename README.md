# Sauron

A macOS app for overseeing coding-agent sessions across your projects. Claude Code and Codex
are built in; additional terminal agents such as OpenCode or Pi can be added in Preferences.
See `docs/REQUIREMENTS.md` and `docs/IMPLEMENTATION_PLAN.md`.

## Stack

Electron, TypeScript, React, xterm.js, node-pty, built with electron-vite. Agent sessions run
inside tmux so they survive app restarts.

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
  previous live session. Right-click projects and sessions for actions.
- The **supervisor agent** (pinned at the top) is a persistent, configurable agent session with generated
  home under `~/Library/Application Support/Sauron/master`. Chat with it, ask it to start or direct
  workers, or click **Refresh** on a project to have it rewrite the status summary. Summaries also
  refresh automatically after commits.
- Every Sauron-managed session runs in tmux (`sauron-<project>-<id>`), so it survives app restarts
  and `tmux attach -t <name>` works from any terminal.
- Sessions you start yourself from a terminal show up read-only under their project with a live
  transcript.
- Logs: `~/Library/Logs/Sauron/main.log` (Preferences > Reveal Logs).
- `docs/QA.md` is the manual checklist; `scripts/smoke.sh` is the end-to-end check against a
  running app.

## Adding projects

Drag a git repository folder onto the window, press ⌘O, or:

```sh
open -a Sauron ~/code/my-repo       # packaged app
scripts/sauron projects add ~/code/my-repo   # any running instance, via the control socket
```

## The `sauron` CLI

`scripts/sauron` talks to the running app over `~/Library/Application Support/Sauron/sauron.sock`.

```sh
scripts/sauron ping
scripts/sauron projects
scripts/sauron sessions [--project <name|id>]
scripts/sauron launch --project <name|id> [--prompt "..."]
scripts/sauron stop --session <id>
scripts/sauron resume --session <id>
scripts/sauron select --project <name|id> | --session <id>
```

Set `SAURON_TOOL_CLAUDE`, `SAURON_TOOL_CODEX`, `SAURON_TOOL_TMUX`, or `SAURON_TOOL_GIT` to override
a tool's path; the value `none` simulates a missing tool.

Every Sauron-managed session is a tmux session named `sauron-<project>-<id>`; `tmux attach -t <name>`
works from any terminal.

## Agent profiles

Preferences > Agent profiles lets you add any interactive CLI agent by giving it an id, name,
executable, and arguments. Arguments are stored as an array and support `{prompt}`, `{cwd}`,
`{sessionId}`, and `{sauronBin}` placeholders. If `{prompt}` is absent, an initial prompt is
appended as the final argument. Custom agents run in the same persistent tmux terminals as the
built-ins; transcript discovery, hooks, forking, and resume remain built-in integrations for
Claude and Codex.

An agent profile may define `forkCommand` as an argument array. It supports the same placeholders
plus `{sourceSessionId}`. Fork only appears for sessions with a known CLI session id whose profile
has a non-empty fork command. Claude and Codex include fork commands by default.

Claude and Codex are themselves editable profiles. Their default profile arguments bypass
permission prompts; remove those arguments in Preferences if you want the CLIs to prompt normally.

The supervisor agent is selected separately in Preferences. Its extra arguments can select a
model (for example `--model opus` for a Claude profile). Sauron writes both `CLAUDE.md` and
`AGENTS.md` into the supervisor home so agents using either convention receive its instructions.

Post-commit summary automation is configured with `supervisorProjectSummaryAfterCommit` and
`supervisorProjectSummaryAfterCommitCooldownMinutes` (default 5). Refreshes are triggered only by
successful commits observed through Sauron's Git proxy. `supervisorProjectSummaryPromptFile`
points to the Markdown prompt template (relative paths resolve beside `config.json`) and supports
`{projectName}`, `{projectId}`, `{projectPath}`, and `{previousSummaryUpdatedAt}` placeholders.

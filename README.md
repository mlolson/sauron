# Sauron

A macOS app for overseeing Claude Code and Codex sessions across your projects.
See `docs/REQUIREMENTS.md` and `docs/IMPLEMENTATION_PLAN.md`.

## Stack

Electron, TypeScript, React, xterm.js, node-pty, built with electron-vite. Agent sessions run
inside tmux so they survive app restarts.

## Building and running

Requires Node 22+, pnpm, and on the machine: `tmux`, `git`, `claude` (Codex optional).

```sh
pnpm install          # also rebuilds node-pty for Electron
pnpm dev              # hot-reloading development run
scripts/app.sh        # build and launch detached (what `pnpm start` would do, via launchd)
pnpm test             # Vitest
pnpm typecheck
pnpm package          # unsigned Sauron.app in dist/
```

## Using it

- **⌘O** add a project, **⌘,** preferences, **⌘K** quick switcher, **⌘⇧]** / **⌘⇧[** next and
  previous live session. Right-click projects and sessions for actions.
- The **master agent** (pinned at the top) is a persistent Claude Code session with a generated
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

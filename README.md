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

Every Sauron-managed session is a tmux session named `sauron-<project>-<id>`; `tmux attach -t <name>`
works from any terminal.

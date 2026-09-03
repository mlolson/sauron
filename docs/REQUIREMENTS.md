# Sauron — Product Requirements Document

Version: 1.1 (v1 scope; stack changed to Electron)
Date: 2026-09-03
Owner: Matt Olson
Status: Draft, agreed in design Q&A

---

## 1. Overview

Sauron is a native macOS desktop application for overseeing AI coding agents across
multiple software projects. It gives a single place to see every project you are working
on, what state each is in, which Claude Code and Codex sessions are running there, and to
talk to those sessions directly. A persistent "master agent" acts as a coordinator that
keeps project summaries current and can direct worker sessions on your behalf.

### 1.1 Problem

Running several coding agents across several repositories quickly becomes hard to track.
Sessions live in scattered terminal windows, it is unclear which one is waiting for input,
and there is no overview of what state each project is in. Sauron replaces that sprawl
with one window.

### 1.2 Goals

- One list of all active projects with a short, current status summary for each.
- Launch, view, and interact with Claude Code and Codex sessions per project.
- See sessions started outside Sauron, not just those it launched.
- Know at a glance which sessions need attention, and be notified when one does.
- A coordinating master agent you can chat with, which maintains summaries and can
  launch or message worker sessions.
- Sessions survive Sauron restarts.

### 1.3 Non-goals for v1

- Code review features (local diff viewer, GitHub PR tracking). Planned for later.
- A per-repo status file such as `PROJECT_STATUS_UPDATE_ME.yaml`. Deferred.
- Code signing, notarization, or distribution to other users.
- Support for agents other than Claude Code and Codex.
- Structured (non-terminal) rendering of Sauron-launched sessions.
- Windows or Linux (Electron makes them possible later, but nothing is tested there).

---

## 2. Users and context

Single user: the developer running the app on their own Mac. They already use Claude Code
and Codex CLIs from the terminal and are comfortable with tmux and git worktrees. Sauron
must coexist with that workflow rather than replace it.

---

## 3. Platform and technical constraints

| Item | Decision |
|---|---|
| Platform | macOS 15 Sequoia and later |
| Language / UI | Electron, TypeScript, React |
| Build | Vite via electron-vite; pnpm; Vitest for tests |
| Terminal widget | xterm.js in the renderer, node-pty in the main process |
| Session persistence | tmux; every Sauron-managed session runs inside a tmux session |
| Distribution | Local, unsigned builds only |
| External CLIs | `claude` (Claude Code), `codex` (Codex CLI), `tmux`, `git` |
| App data | `~/Library/Application Support/Sauron/` |

The app does not bundle the CLIs. It locates them on `PATH` (resolving the user's login
shell environment) and reports clearly when one is missing.

---

## 4. Functional requirements

Requirement IDs are prefixed by area. "Must" items are v1 scope; "Should" items are v1 if
time permits; "Could" items are explicitly later.

### 4.1 Projects

**PRJ-1 (Must)** The user can add a project by choosing a directory via a file picker, by
dragging a folder onto the window, or via `open -a Sauron <dir>`. The directory must be a git repository (contain `.git`
or be inside a work tree); otherwise the add is rejected with an explanatory message.

**PRJ-2 (Must)** The project list is persisted in Sauron's own store and restored on
launch. Removing a project from Sauron never deletes anything on disk.

**PRJ-3 (Must)** Each project row shows:
- Project name (directory basename, editable display name is a Should).
- Full path.
- Current AI-generated status summary (see 4.5). If none exists yet, show a placeholder.
- Number of active sessions in that project.

**PRJ-4 (Must)** Selecting a project shows a detail view containing its sessions
(Sauron-managed and external), its worktrees, and the full status summary with its
timestamp.

**PRJ-5 (Should)** Projects can be reordered by drag, and pinned.

**PRJ-6 (Should)** A project row visually indicates when any of its sessions is waiting
for user input (see 4.6).

**PRJ-7 (Could)** Show git branch and dirty state in the row.

### 4.2 Sauron-managed sessions

**SES-1 (Must)** From a project, the user can start a new terminal with one click: a tmux
session running the login shell in the project directory (or a worktree, see 4.3). A dropdown
on the same button offers "running Claude" and "running Codex", which type the agent command
into that shell as a convenience; the terminal outlives the agent. The user may give the
session a title before starting it.

**SES-2 (Must)** Every Sauron-launched session runs inside a dedicated tmux session named
with a Sauron-specific prefix (e.g. `sauron-<project>-<short-id>`), so that:
- it keeps running if Sauron quits or crashes;
- the user can attach to it from any terminal with `tmux attach`;
- Sauron re-attaches to it on next launch.

**SES-3 (Must)** Each session is displayed in an embedded xterm.js terminal attached to
its tmux session through a node-pty process in the main process. The user can type into it exactly as they would in a terminal, including
answering permission prompts and using the CLIs' interactive features.

**SES-4 (Must)** On launch, Sauron enumerates existing tmux sessions with its prefix and
reconstructs the session list, associating each with its project from stored metadata.

**SES-5 (Must)** The user can stop a session. Stopping sends an interrupt and then kills
the tmux session after a grace period. Detaching (closing the view but leaving tmux
running) is a separate action.

**SES-6 (Must)** Sauron records per session: id, tool (claude/codex), project, worktree
path if any, tmux session name, creation time, and the underlying CLI session id once
known (needed for resume and for matching transcripts, see 4.4).

**SES-7 (Should)** An initial prompt can be supplied through the CLI and by the master agent.

**SES-8 (Must)** Sessions have an editable title (inline in the session header, or Rename in the
context menu). The title is persisted into tmux: the session is renamed and the title is stored
in a tmux user option, so it survives Sauron and shows in `tmux ls`.

**SES-9 (Could)** Launch dialog with model and permission-mode choices.

### 4.3 Git worktrees

**WT-1 (Must)** When launching a session, the user may choose to run it in a new git
worktree. Sauron creates the worktree under a Sauron-managed location (for example
`<repo>/.worktrees/<branch>` or `~/Library/Application Support/Sauron/worktrees/<project>/<branch>`),
on a new branch whose name the user can edit, defaulting to something like
`sauron/<short-id>`.

**WT-2 (Must)** The project detail view lists all worktrees of the repository (from
`git worktree list`), indicating which ones Sauron created and which sessions are using them.

**WT-3 (Must)** The user can remove a Sauron-created worktree. Removal is refused while a
session is running in it. Removal warns if the worktree has uncommitted changes or unpushed
commits and requires confirmation.

**WT-4 (Should)** Show each worktree's branch and ahead/behind counts relative to the main
branch.

**WT-5 (Could)** Merge or open a PR from a worktree branch. (Belongs with code review, later.)

### 4.4 External sessions

Sessions the user started in their own terminal, outside Sauron.

**EXT-1 (Must)** Sauron discovers Claude Code sessions by reading transcript files under
`~/.claude/projects/<encoded-project-path>/*.jsonl` and Codex sessions under
`~/.codex/sessions/`. Sessions are matched to a Sauron project by their working directory.

**EXT-2 (Must)** External sessions appear under their project, visually distinct from
Sauron-managed ones, with tool, start time, and last-activity time.

**EXT-3 (Must)** Selecting an external session shows a live transcript rendered from the
log file: user messages, assistant messages, and tool calls with a compact summary. The
view updates as the file grows.

**EXT-4 (Must)** External sessions are read-only. The UI makes clear that messages cannot
be sent to them from Sauron.

**EXT-5 (Must)** An external session is considered active if its transcript was modified
within a short window (e.g. 2 minutes) or its owning process can be found alive. Inactive
sessions older than a configurable age are collapsed under a "recent" group.

**EXT-6 (Should)** Sauron-managed sessions also have their transcript located (via the
CLI session id) so the same transcript view can be shown alongside the terminal.

**EXT-7 (Should)** Handle transcript format changes gracefully: unknown record types are
skipped, and a parse failure for one record does not hide the rest.

### 4.5 Master agent

A single, global, persistent Claude Code session owned by Sauron that acts as a
coordinator across all projects.

**MA-1 (Must)** Sauron maintains a home directory for the master agent at
`~/Library/Application Support/Sauron/master/`. It contains a Sauron-generated `CLAUDE.md`
describing: the list of projects with paths, where and how to write status summaries, how
to read other sessions' transcripts, and the `sauron` CLI (MA-6). Sauron regenerates this
file whenever the project list changes.

**MA-2 (Must)** The master agent runs as a Claude Code session in tmux, launched in its
home directory, and appears pinned at the top of the sidebar. The user interacts with it
through the same embedded terminal as any other session. If it is not running, Sauron
offers to start it; it is started automatically on app launch if it was running previously.

**MA-3 (Must)** The master agent writes one status summary per project to Sauron's store
(for example `~/Library/Application Support/Sauron/status/<project-id>.json`) with at
minimum: `summary` (short text suitable for a list row, roughly 1–3 sentences),
`details` (longer text, optional), and `updated_at`. Sauron watches this directory and
updates the UI when a file changes.

**MA-4 (Must)** Refresh triggers. Sauron asks the master agent to refresh a project's
summary when:
- the user clicks a refresh button on the project (or "refresh all");
- a new commit appears in the project repository (detected by watching `.git` refs / HEAD).

**MA-5 (Must)** A refresh is delivered by sending a prompt into the master agent's tmux
session. Sauron must not interrupt the agent mid-turn: refresh requests are queued and sent
only when the agent is idle (idle detection via Claude Code hooks, see 4.6). Multiple pending
refreshes for the same project collapse into one. Rapid commits are debounced.

**MA-6 (Must)** Sauron provides a small command-line tool, `sauron`, available on the
master agent's PATH, with at least:
- `sauron projects` — list projects (id, name, path).
- `sauron sessions [--project <id>]` — list running sessions.
- `sauron launch --project <id> --tool claude|codex [--worktree [<branch>]] [--prompt <text>]`
  — start a worker session, exactly as the UI button would.
- `sauron send --session <id> <text>` — inject a message into a running Sauron-managed
  session via tmux.
- `sauron status set --project <id> --summary <text> [--details <text>]` — write a
  summary (alternative to writing the JSON file directly).

The CLI talks to the running app (for example via a Unix domain socket or a file-based
queue that the app watches) so that state stays consistent with the UI.

**MA-7 (Must)** The summary prompt instructs the agent to consult, for the project:
recent git history and working-tree state, transcripts of other sessions in that project,
its previous summary, and repo docs such as README, CLAUDE.md, AGENTS.md, TODO.md.

**MA-8 (Should)** Refresh activity is visible: a project whose refresh is queued or in
progress shows an indicator.

**MA-9 (Could)** Allow the user to edit the master agent's CLAUDE.md preamble with custom
instructions that survive regeneration.

### 4.6 Attention and notifications

**ATT-1 (Must)** Sauron knows when a Sauron-managed Claude Code session is waiting for
input, has finished a turn, or has stopped. This is achieved by installing Claude Code
hooks (Notification, Stop, and related events) that report to Sauron, scoped so they only
fire for Sauron-launched sessions (for example via an environment variable or a
per-session settings file passed at launch).

**ATT-2 (Must)** The same for Codex, using its notify configuration, to the extent Codex
supports it. Where a tool provides no signal, Sauron falls back to terminal-output
heuristics (no output for N seconds after a prompt-like line) and labels the state as
inferred.

**ATT-3 (Must)** Sidebar badges: sessions waiting for input or stopped show a badge; the
project row shows the count of such sessions.

**ATT-4 (Must)** A macOS notification (Electron `Notification`) is posted when a session needs input or
finishes, unless the session is currently focused in the foreground window. Clicking the
notification focuses that session.

**ATT-5 (Should)** Per-session or global mute for notifications.

**ATT-6 (Could)** Menu bar item with the count of sessions awaiting the user.

### 4.7 Application shell

**APP-1 (Must)** Layout: a sidebar listing the master agent, then projects with their
sessions nested beneath; a main content area showing the selected item (project detail,
session terminal, or external transcript).

**APP-2 (Must)** Multiple session terminals may be open in tabs or a split within the
content area; at least tabs.

**APP-3 (Must)** On first launch, Sauron checks for `claude`, `codex`, `tmux`, and `git`
and shows a setup screen listing anything missing with install hints. Codex being missing
is not fatal; the Codex launch button is disabled instead.

**APP-4 (Must)** Preferences: paths to CLIs (override), worktree base location,
notification toggle, master agent auto-start.

**APP-5 (Should)** Keyboard navigation between sessions and a quick switcher.

**APP-6 (Should)** Light and dark appearance following the system.

---

## 5. Data model

Stored under `~/Library/Application Support/Sauron/`.

```
Sauron/
  config.json          # projects, preferences
  sessions.json        # Sauron-managed session metadata
  status/<project-id>.json
  master/
    CLAUDE.md          # generated
    .claude/settings.json   # hooks for the master session
  worktrees/           # default worktree base (configurable)
  bin/sauron           # CLI (or symlink to bundled binary)
```

Project
```
id: UUID
name: String
path: String            # absolute path to repo root
addedAt: Date
pinned: Bool
```

Session
```
id: UUID
projectId: UUID?        # nil for the master agent
tool: claude | codex
kind: managed | external
tmuxName: String?       # managed only
cliSessionId: String?   # Claude/Codex session id, once known
transcriptPath: String?
workingDir: String
worktreePath: String?
createdAt: Date
lastActivityAt: Date
state: running | waitingForInput | idle | stopped
stateSource: hook | inferred
```

Status
```
projectId: UUID
summary: String
details: String?
updatedAt: Date
source: master | manual
```

---

## 6. Key flows

**Add a project.** User drags `~/code/foo` onto the window. Sauron validates it is a git
repo, adds it, regenerates the master CLAUDE.md, and enqueues a summary refresh.

**Launch a worker.** User clicks "New Claude" on `foo`, ticks "in a worktree", accepts the
default branch name. Sauron runs `git worktree add`, creates tmux session
`sauron-foo-a1b2`, runs `claude` in the worktree with hook environment set, opens a
terminal tab attached to it, and records the session. When the hooks first fire, Sauron
learns the Claude session id and locates its transcript.

**Commit triggers refresh.** The worker commits. Sauron's watcher sees HEAD change,
debounces, checks the master agent is idle, and sends
"Refresh the status summary for project foo (id …)" into its tmux session. The agent reads
git log, transcripts, and docs, then writes `status/<id>.json`. Sauron reloads the row.

**Master launches a worker.** User tells the master agent "start a Codex session on bar to
fix the flaky test". The agent runs `sauron launch --project bar --tool codex --prompt "…"`.
The CLI asks the app to launch; the new session appears in the sidebar.

**Session needs input.** A worker hits a permission prompt. The Notification hook reports
it; the session badge appears, the project count increments, and a macOS notification is
posted. Clicking it focuses the terminal tab.

**Restart.** User quits Sauron. tmux sessions keep running. On relaunch Sauron lists
`sauron-*` tmux sessions, matches them to `sessions.json`, reattaches terminals, and marks
any recorded session whose tmux session is gone as stopped.

---

## 7. Non-functional requirements

- **Responsiveness.** Terminal input latency indistinguishable from a native terminal.
  Transcript views handle multi-megabyte JSONL files by tailing incrementally, not
  re-parsing the whole file on each change.
- **Robustness.** A crash in Sauron never loses agent work; tmux is the source of truth
  for process lifetime. Exceptions are surfaced, not swallowed.
- **Resource use.** Idle Sauron with ten projects and a handful of sessions should use
  negligible CPU. File watching uses FSEvents/DispatchSource rather than polling where
  possible.
- **Privacy.** All data stays local. Sauron makes no network calls of its own; only the
  agent CLIs do.
- **Cost awareness.** Summary refreshes consume model tokens. Triggers are debounced,
  collapsed, and never fired for projects with no change since the last summary.

---

## 8. Open questions

1. Exact Claude Code hook events and payloads to rely on for idle/waiting detection, and
   whether per-session hook scoping can be done with a `--settings` file rather than global
   settings edits.
2. Codex's notify capability in the installed version (0.152) and what states it can report.
3. Worktree base location default: inside the repo (`.worktrees/`, requires gitignore) or
   in Application Support.
4. Whether the `sauron` CLI should be a separate small binary target in the Xcode project or
   a script that talks to the app over a socket.
5. How the master agent should be resumed (`claude --resume <id>`) versus started fresh when
   its tmux session is gone.

---

## 9. Milestones

1. **Skeleton.** Xcode project, sidebar/detail layout, add/remove projects, persistence.
2. **Sessions.** tmux launch, xterm.js attach, stop/detach, reattach on restart.
3. **Worktrees.** Create on launch, list, remove with safety checks.
4. **External sessions.** Transcript discovery, live tail, read-only view.
5. **Attention.** Hooks, badges, notifications.
6. **Master agent.** Home dir, CLAUDE.md generation, status store, refresh triggers,
   `sauron` CLI.
7. **Polish.** Preferences, setup screen, keyboard navigation.

# Sauron — Technical Implementation Plan

Version: 1.0
Date: 2026-09-03
Companion to: `docs/REQUIREMENTS.md`

This document describes how Sauron v1 will be built: architecture, module boundaries,
key mechanisms, verified CLI integration points, and an ordered task list for the MVP.

---

## 1. Verified environment facts

Checked on the development machine on 2026-09-03. These drive several design choices.

| Tool | Version | Relevant capability |
|---|---|---|
| Claude Code | 2.1.259 | `--session-id <uuid>` preselects the session id. `--settings <file>` loads a per-session settings file (hooks live here). `--resume <id>` resumes. `-n/--name` sets a display name. Transcripts at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the encoded cwd replaces `/` and `.` with `-`. |
| Codex CLI | 0.152.0 | `-C <dir>` sets the working dir. `-c key=value` overrides any config key, including `notify`. `codex queue --thread <id> --message <text>` injects a message into an existing session. `codex resume <id>`. Rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl`; the first record is `session_meta` with `payload.cwd` and `payload.session_id`. |
| tmux | 3.6a | `new-session -d -s`, `send-keys`, `kill-session`, `list-sessions -F`, `pipe-pane`. |
| git | system | `worktree add/list/remove`, `rev-parse --show-toplevel`. |

Consequences:
- Sauron generates the Claude session id itself, so it knows the transcript path before the
  session even starts. No hook round-trip is needed to learn it.
- Hooks are installed per session through `--settings`, so Sauron never edits the user's
  global `~/.claude/settings.json`.
- For Codex, `notify` can be set per launch with `-c`, and message injection can use
  `codex queue` in addition to tmux `send-keys`.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Sauron.app (SwiftUI, macOS 15)                                 │
│                                                                │
│  UI layer            SidebarView  ProjectDetailView            │
│                      SessionTerminalView  TranscriptView       │
│                      PreferencesView  SetupView                │
│                                                                │
│  AppState (@Observable, main actor)                            │
│     projects, sessions, statuses, attention, masterAgent       │
│                                                                │
│  Services (actors / background)                                │
│     ProjectStore     SessionManager    TmuxService             │
│     WorktreeService  TranscriptIndexer TranscriptTailer        │
│     StatusStore      MasterAgentService RefreshScheduler       │
│     HookServer (UDS) NotificationService GitWatcher            │
│     CLIResolver      Persistence                               │
└──────────┬──────────────────────┬──────────────────────────────┘
           │ tmux CLI             │ Unix domain socket
           ▼                      ▼
   tmux server                sauron CLI  ◄── invoked by hooks and by the master agent
     ├─ sauron-master  → claude (home: App Support/Sauron/master)
     ├─ sauron-<p>-<id> → claude / codex in repo or worktree
     └─ ...
```

Principles:
- **tmux is the process owner.** Sauron never holds a child process for an agent. It only
  creates, attaches to, and kills tmux sessions. This is what makes restarts safe.
- **The terminal view is a client of tmux.** SwiftTerm spawns `tmux attach -t <name>` in
  its own PTY. Closing the view detaches; the agent keeps running.
- **One socket, one CLI.** Everything that needs to talk to the app from outside (hooks,
  the master agent, the user in a shell) goes through the `sauron` CLI, which speaks JSON
  over a Unix domain socket to the app. The app is the single writer of app state.
- **Files are the integration surface for the master agent.** It writes status JSON; Sauron
  watches the directory. No custom protocol is needed for the summary itself.

### 2.1 Targets

| Target | Kind | Purpose |
|---|---|---|
| `Sauron` | macOS app | The UI and all services. |
| `SauronCore` | Swift package (local) | Models, persistence, tmux/git wrappers, transcript parsers, socket protocol. Shared by app and CLI, unit-testable without UI. |
| `sauron` | Command-line tool | Thin client: parses args, sends a JSON request over the socket, prints the response. Built into the app bundle at `Contents/MacOS/sauron` and symlinked to `~/Library/Application Support/Sauron/bin/sauron`. |
| `SauronCoreTests` | Test bundle | Parser, encoder, and state-machine tests. |

Dependencies (SwiftPM): SwiftTerm. Nothing else in v1. JSON via `Codable`.

---

## 3. Key mechanisms

### 3.1 Launching a managed session

1. Generate `sessionId = UUID()`.
2. If a worktree was requested, `WorktreeService.create(repo:, branch:)` returns the path.
3. Write a per-session settings file at
   `App Support/Sauron/sessions/<sessionId>/claude-settings.json` containing the hooks in
   §3.3 (Claude only).
4. Build the command:
   - Claude: `claude --session-id <sessionId> --settings <file> --name <display>`
   - Codex: `codex -C <dir> -c 'notify=["<bin>/sauron","hook","codex","--session","<sessionId>"]'`
5. Create the tmux session:
   `tmux new-session -d -s sauron-<slug>-<short> -c <dir> -e SAURON_SESSION_ID=<id> -e SAURON_SOCKET=<path> '<command>'`
   The `-e` flags set environment for the shell so hooks and the agent can find the socket.
6. Persist a `Session` record and open a terminal tab that runs `tmux attach -t <name>`.
7. Transcript path is known immediately for Claude (§1). For Codex, `TranscriptIndexer`
   finds the rollout whose `session_meta.cwd` matches and whose timestamp is after launch.

Shell environment: `CLIResolver` runs `$SHELL -ilc 'echo $PATH'` once at startup to obtain
the user's real PATH, since GUI apps get a minimal environment. That PATH is passed into
tmux and used to locate `claude`, `codex`, `tmux`, and `git`.

### 3.2 Terminal view

`SessionTerminalView` wraps SwiftTerm's `LocalProcessTerminalView` in an
`NSViewRepresentable`. It runs `tmux attach -t <name>` with the resolved environment. On
view teardown it sends `tmux detach-client` rather than killing anything. Font, colors, and
scrollback are read from preferences. One terminal view instance per open tab is cached in
`AppState` so switching tabs does not re-attach.

tmux options set on each Sauron session so the embedded terminal behaves: `status off`,
`mouse on`, `history-limit 50000`, and `set-option destroy-unattached off`.

### 3.3 Attention detection

Claude Code hooks written into the per-session settings file:

```json
{
  "hooks": {
    "SessionStart":      [{"hooks":[{"type":"command","command":"sauron hook claude SessionStart"}]}],
    "UserPromptSubmit":  [{"hooks":[{"type":"command","command":"sauron hook claude UserPromptSubmit"}]}],
    "Notification":      [{"hooks":[{"type":"command","command":"sauron hook claude Notification"}]}],
    "Stop":              [{"hooks":[{"type":"command","command":"sauron hook claude Stop"}]}],
    "SessionEnd":        [{"hooks":[{"type":"command","command":"sauron hook claude SessionEnd"}]}]
  }
}
```

`sauron hook` reads the hook JSON from stdin, adds `SAURON_SESSION_ID` from the environment,
and forwards it to the app. State machine per session:

| Event | New state |
|---|---|
| SessionStart | idle |
| UserPromptSubmit | running |
| Notification (permission / idle prompt) | waitingForInput |
| Stop | idle (turn finished) — post notification if not focused |
| SessionEnd, or tmux session gone | stopped |

Codex: `notify` fires on `agent-turn-complete` with a JSON argument; map to idle and
notify. Codex has no permission-prompt event in the installed version, so waiting-for-input
for Codex is inferred: no PTY output for N seconds after a line matching an approval prompt
pattern (captured via `tmux pipe-pane` into a small ring buffer). Inferred states are
flagged `stateSource = inferred` in the UI.

External sessions have no hooks. Their state is derived from transcript mtime: modified in
the last 2 minutes means active, else idle; the last record type refines this (a trailing
assistant message means idle, a trailing user message means running).

### 3.4 Socket protocol

Unix domain socket at `App Support/Sauron/sauron.sock`, created by the app with mode 0600.
Newline-delimited JSON, one request and one response per connection.

```
{"cmd":"projects.list"}
{"cmd":"sessions.list","project":"<id>"}
{"cmd":"sessions.launch","project":"<id>","tool":"claude","worktree":{"branch":"x"},"prompt":"..."}
{"cmd":"sessions.send","session":"<id>","text":"..."}
{"cmd":"status.set","project":"<id>","summary":"...","details":"..."}
{"cmd":"hook","tool":"claude","event":"Stop","session":"<id>","payload":{...}}
```

Responses: `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. The app side uses
`NWListener` with a `NWEndpoint.unix` (Network framework), handled on a dedicated actor.

### 3.5 Transcript parsing

Two parsers in `SauronCore`, both streaming line-by-line and tolerant of unknown records:

- **ClaudeTranscriptParser.** Records with `type` in `user`, `assistant`, `summary`,
  and tool-related entries. Extracts role, text blocks, tool_use name and short input
  summary, tool_result status, timestamp, `sessionId`, `cwd`.
- **CodexRolloutParser.** `session_meta` for cwd/session id; `response_item` and
  `event_msg` records for messages, reasoning summaries, function calls and outputs.

`TranscriptTailer` keeps a file offset per transcript, uses a `DispatchSource` file-system
object source on the file (and on the directory for new files), and appends only new
records to an in-memory model capped at a configurable number of entries with the ability
to load older history on demand.

`TranscriptIndexer` scans `~/.claude/projects/` and `~/.codex/sessions/` at startup and on
directory change, reads only the first few records of each file to get cwd and session id,
and maps them to Sauron projects (a transcript belongs to a project if its cwd is the repo
root or a worktree of it, or any subdirectory).

### 3.6 Master agent

- Home: `App Support/Sauron/master/`. Sauron writes `CLAUDE.md` from a template with the
  project table, store paths, transcript locations, the `sauron` CLI reference, and the
  summary format. A user-editable `CLAUDE.local.md` is left untouched for custom
  instructions (Claude Code merges both).
- Launch: same path as a managed session, tmux name `sauron-master`, tool claude, with the
  same hooks. Session id is persisted so the master is resumed with `--resume` when its
  tmux session is gone but the app remembers it, and started fresh only if resume fails.
- `RefreshScheduler`: a queue of project ids. Enqueue collapses duplicates. A 30 second
  debounce follows each git change. Drain condition: master state is `idle`. Sending uses
  `tmux send-keys -t sauron-master -l '<prompt>'` followed by `Enter`. If the master is
  `stopped`, the queue is held and the UI shows "master agent not running".
- Git change detection: `GitWatcher` watches `<repo>/.git/HEAD`, `.git/refs/heads/`, and
  `.git/logs/HEAD` (and each worktree's `.git` file target) with `DispatchSource`. A change
  in the resolved HEAD commit hash enqueues a refresh.
- `StatusStore` watches `App Support/Sauron/status/` and decodes `<project-id>.json`.

### 3.7 Persistence

`config.json` and `sessions.json` written atomically (`Data.write(.atomic)`) through a
`Persistence` actor, debounced 250 ms after the last change. Schema carries a `version`
field for migrations.

### 3.8 Restart and reconciliation

On launch:
1. Load `sessions.json`.
2. `tmux list-sessions -F '#{session_name}'` filtered by `sauron-` prefix.
3. Records with a live tmux session: state `idle` until a hook says otherwise (hooks
   continue to fire since the settings file is still referenced).
4. Records without: mark `stopped`, keep for resume offer (Claude: `claude --resume <id>`,
   Codex: `codex resume <id>`).
5. tmux sessions with the prefix but no record: show as "unknown Sauron session" with
   attach and kill actions.

---

## 4. Error handling and logging

- All service errors are typed (`enum SauronError`) and surfaced to the UI as non-modal
  banners on the relevant project or session. Nothing is swallowed silently.
- `os.Logger` with subsystem `com.mattolson.sauron` and one category per service.
- External command wrapper (`Process` + pipes, async) captures stdout, stderr, and exit
  code; a non-zero exit becomes a thrown error carrying stderr.

---

## 5. Testing strategy

- **Unit (SauronCoreTests):** transcript parsers against fixture files copied from real
  sessions; hook state machine; socket request/response coding; tmux and git argument
  builders; cwd-to-project matching; refresh queue collapse and debounce.
- **Integration (manual, scripted):** a `scripts/smoke.sh` that creates a temp git repo,
  launches a Claude session through the `sauron` CLI, verifies the tmux session exists,
  sends a message, and checks the hook events arrive.
- **UI:** manual, guided by a checklist in `docs/QA.md` (to be written at milestone 7).

---

## 6. MVP task list

Ordered so that each milestone yields something usable. Task IDs are stable for reference
in commits and issues. Estimates are rough working days.

### Milestone 1 — Skeleton (≈2 d)

- [ ] **T1.1** Create the Xcode project: `Sauron` app target, macOS 15 deployment target,
      SwiftUI lifecycle, sandbox disabled (needed for tmux, sockets, arbitrary paths).
- [ ] **T1.2** Add local package `SauronCore` and test target; wire into the app.
- [ ] **T1.3** Define models: `Project`, `Session`, `SessionState`, `ProjectStatus`,
      `Preferences`. Codable, versioned.
- [ ] **T1.4** `Persistence` actor: atomic, debounced JSON read/write in App Support;
      creates the directory layout from §2 on first run.
- [ ] **T1.5** `CLIResolver`: resolve login-shell PATH; locate `claude`, `codex`, `tmux`,
      `git`; expose availability.
- [ ] **T1.6** `SetupView`: shown when a required tool is missing, with install hints.
- [ ] **T1.7** `AppState` (`@Observable`), `NavigationSplitView` shell: sidebar with
      master placeholder and projects; empty detail.
- [ ] **T1.8** Add project via `NSOpenPanel` and via drag-and-drop; validate with
      `git rev-parse --show-toplevel`; remove project with confirmation.
- [ ] **T1.9** `ProjectDetailView` with path, placeholder summary, empty sessions list.
- [ ] **T1.10** `ExternalCommand` async wrapper with typed errors and logging.

### Milestone 2 — Managed sessions (≈3 d)

- [ ] **T2.1** `TmuxService`: new-session, list-sessions, has-session, send-keys,
      kill-session, detach-client, set-option. Argument builders unit-tested.
- [ ] **T2.2** `SessionManager`: launch (Claude and Codex), stop, detach, record
      persistence, tmux name generation.
- [ ] **T2.3** Add SwiftTerm; `SessionTerminalView` running `tmux attach`; view caching
      per session; font and scrollback from preferences.
- [ ] **T2.4** Session tabs in the detail area; open, close (detach), switch.
- [ ] **T2.5** Sidebar: sessions nested under projects with tool icon and state dot.
- [ ] **T2.6** Startup reconciliation (§3.8), including "unknown Sauron session" rows.
- [ ] **T2.7** Resume offer for stopped sessions (`claude --resume`, `codex resume`).
- [ ] **T2.8** Optional initial prompt on launch (passed as the first CLI argument).

### Milestone 3 — Worktrees (≈1.5 d)

- [ ] **T3.1** `WorktreeService`: list (parse `git worktree list --porcelain`), add with
      new branch, remove, dirty and unpushed checks.
- [ ] **T3.2** Launch sheet: "run in a new worktree" toggle with editable branch name and
      base location from preferences.
- [ ] **T3.3** Worktrees section in `ProjectDetailView`: branch, Sauron-created flag,
      sessions using it, remove action with safety confirmation.
- [ ] **T3.4** Preference for worktree base location; default
      `App Support/Sauron/worktrees/<project>/`.

### Milestone 4 — External sessions (≈3 d)

- [ ] **T4.1** `ClaudeTranscriptParser` with fixtures and tests.
- [ ] **T4.2** `CodexRolloutParser` with fixtures and tests.
- [ ] **T4.3** `TranscriptIndexer`: scan both directories, header-only read, cwd-to-project
      matching including worktrees and subdirectories, directory watching for new files.
- [ ] **T4.4** `TranscriptTailer`: offset-based incremental reads, file watching, capped
      in-memory model, load-older.
- [ ] **T4.5** `TranscriptView`: message list with role styling, collapsible tool calls,
      auto-scroll with "jump to bottom", read-only banner.
- [ ] **T4.6** External sessions in the sidebar under their project, active/recent
      grouping by mtime, configurable recent-age cutoff.
- [ ] **T4.7** Link managed sessions to their transcripts and expose a "Transcript" tab
      beside the terminal.

### Milestone 5 — Attention and notifications (≈2 d)

- [ ] **T5.1** `sauron` CLI target: argument parsing, socket client, `hook` subcommand
      reading stdin. Bundle and symlink into `App Support/Sauron/bin`.
- [ ] **T5.2** `HookServer`: `NWListener` on the Unix socket, request routing, 0600 perms,
      stale socket cleanup on start.
- [ ] **T5.3** Per-session Claude settings file generation with the hooks from §3.3;
      Codex `notify` config via `-c`.
- [ ] **T5.4** Session state machine driven by hook events; `stateSource` tracking; Codex
      inferred waiting-for-input via `pipe-pane` heuristic.
- [ ] **T5.5** Sidebar badges on sessions and per-project counts.
- [ ] **T5.6** `NotificationService` with `UNUserNotificationCenter`: permission request,
      post on waiting/finished when not focused, click-to-focus routing.
- [ ] **T5.7** Global notification mute in preferences.

### Milestone 6 — Master agent (≈3 d)

- [ ] **T6.1** `StatusStore`: directory watch and decode of `status/<id>.json`; project row
      and detail bindings; `updated_at` shown relative.
- [ ] **T6.2** Master home directory and `CLAUDE.md` generation from a template; regenerate
      on project list change; leave `CLAUDE.local.md` alone.
- [ ] **T6.3** `MasterAgentService`: start (with resume), stop, pinned sidebar row, terminal
      tab, auto-start preference.
- [ ] **T6.4** Socket commands `projects.list`, `sessions.list`, `sessions.launch`,
      `sessions.send`, `status.set`, and matching `sauron` CLI subcommands.
- [ ] **T6.5** `GitWatcher` on HEAD and refs for every project and worktree; change
      detection by comparing resolved HEAD.
- [ ] **T6.6** `RefreshScheduler`: queue, collapse, debounce, idle-gated drain via
      `send-keys`; refresh and refresh-all buttons; in-progress indicator.
- [ ] **T6.7** Summary prompt template covering git history, transcripts, previous summary,
      and repo docs; JSON schema documented in `CLAUDE.md`.

### Milestone 7 — Polish (≈1.5 d)

- [ ] **T7.1** `PreferencesView`: CLI path overrides, worktree base, notifications, master
      auto-start, terminal font.
- [ ] **T7.2** Keyboard: next/previous session, quick switcher (⌘K style).
- [ ] **T7.3** Error banners for service failures; log viewer or "reveal logs" action.
- [ ] **T7.4** `scripts/smoke.sh` integration script and `docs/QA.md` manual checklist.
- [ ] **T7.5** App icon and README with build instructions.

Total ≈ 16 working days for the MVP.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hook event names or payloads change across Claude Code versions | Isolate mapping in one file; unknown events are logged, not fatal; `SessionStart` payload carries version for diagnostics. |
| Transcript formats change | Tolerant parsers, fixtures per known version, unknown records skipped. |
| GUI PATH does not include CLIs | Login-shell PATH resolution at startup plus manual overrides in preferences. |
| tmux `send-keys` delivers a prompt while the agent is mid-turn | Idle gating via hooks; refuse to send when state is `running`; the `sessions.send` command returns an error the master can act on. |
| SwiftTerm rendering or input quirks | Pin a known-good version; keep the terminal view thin so swapping libraries is contained. |
| Sandbox restrictions | App is not sandboxed in v1 (local use only). Revisit if distribution is ever wanted. |

---

## 8. Resolved open questions from the PRD

1. Hook scoping: per-session `--settings` file. Confirmed available.
2. Codex notify: available via `-c notify=[...]`; turn-complete only, prompts are inferred.
3. Worktree base: default in App Support, configurable. Keeps repos clean, no gitignore edits.
4. `sauron` CLI: separate command-line target in the Xcode project, socket client.
5. Master resume: persist its session id, `--resume` first, fresh start on failure.

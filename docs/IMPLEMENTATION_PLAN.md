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

## 6. MVP delivery plan: vertical slices

The MVP is built as a sequence of vertical slices. Each slice cuts through UI, state,
services, and persistence to deliver one end-to-end capability the user can exercise the
day it lands. A slice is complete only when its **Done when** criteria all hold on a real
build of the app. Slices are ordered by dependency; within a slice, tasks are listed in
suggested order. Estimates are rough working days.

Cross-cutting foundations (models, persistence, command wrapper, logging) are not a slice
of their own; each is introduced by the first slice that needs it, in the minimal form that
slice requires, and extended later.

---

### Slice 1 — Add a project and see it after restart (≈1.5 d)

The thinnest possible app: a window, a project list, and persistence.

Tasks
- [x] S1.1 Xcode project, `Sauron` app target, macOS 15, SwiftUI lifecycle, sandbox off.
- [x] S1.2 Local package `SauronCore` with a test target, linked into the app.
- [x] S1.3 `Project` model, `Persistence` actor writing `config.json` atomically to App
      Support with a `version` field; directory layout created on first run.
- [x] S1.4 `ExternalCommand` async wrapper (stdout, stderr, exit code, typed error).
- [x] S1.5 `AppState` and `NavigationSplitView` shell with an empty detail pane.
- [x] S1.6 Add project via `NSOpenPanel` and drag-and-drop; validate with
      `git rev-parse --show-toplevel`; reject non-repos with a message.
- [x] S1.7 Remove project with confirmation; project detail showing name and path.

Done when
- Dragging a git repo folder onto the window adds a row; dragging a non-git folder shows
  an error and adds nothing.
- Quit and relaunch: the same projects appear in the same order.
- Removing a project removes only the row; the directory on disk is untouched.
- A unit test round-trips `config.json` through the model.

---

### Slice 2 — Launch a Claude session and talk to it in the app (≈3 d)

Everything needed to start one agent and type into it. Claude only; Codex is a later slice.

Tasks
- [ ] S2.1 `CLIResolver`: login-shell PATH resolution; locate `claude`, `tmux`, `git`;
      `SetupView` shown when any is missing.
- [ ] S2.2 `Session` model and `sessions.json` persistence.
- [ ] S2.3 `TmuxService`: new-session, has-session, list-sessions, kill-session,
      detach-client, set-option; argument builders unit-tested.
- [ ] S2.4 `SessionManager.launchClaude(project:)`: generate session id, build the command
      with `--session-id` and `--name`, create the tmux session with Sauron options.
- [ ] S2.5 SwiftTerm dependency; `SessionTerminalView` running `tmux attach`; cached per
      session so tab switches do not re-attach.
- [ ] S2.6 Session tabs in the detail pane; sidebar rows nested under the project with a
      tool icon; "New Claude" button.
- [ ] S2.7 Stop (interrupt, grace period, kill) and Detach actions.
- [ ] S2.8 Startup reconciliation: match `sessions.json` to live `sauron-*` tmux sessions,
      mark missing ones stopped, list orphaned tmux sessions with attach and kill.
- [ ] S2.9 Resume a stopped session with `claude --resume <id>`.

Done when
- Clicking "New Claude" on a project opens a terminal tab with Claude Code running in the
  repo directory; typing a prompt and pressing Enter gets a response.
- `tmux ls` in a terminal shows the session, and `tmux attach` to it works from outside.
- Quit Sauron while the agent is mid-task; relaunch; the session is still listed and the
  terminal reattaches with the output intact.
- Kill the tmux session from a terminal; Sauron shows it as stopped and offers Resume,
  which starts a new tmux session continuing the same conversation.
- Launching Sauron on a machine without `claude` on PATH shows the setup screen instead of
  the main window.

---

### Slice 3 — Launch Codex too (≈1 d)

Tasks
- [ ] S3.1 `CLIResolver` locates `codex`; missing Codex disables the button, not the app.
- [ ] S3.2 `SessionManager.launchCodex(project:)` with `-C <dir>`; tool shown in sidebar.
- [ ] S3.3 Resume with `codex resume <id>` once the id is known (see Slice 6 for id
      discovery; until then resume is offered only when the id is recorded).
- [ ] S3.4 Optional initial prompt field on the launch control for both tools.

Done when
- "New Codex" opens a working Codex terminal in the repo directory.
- With Codex uninstalled or off PATH, the app runs normally and the Codex button is
  disabled with a tooltip.
- Entering an initial prompt makes the agent start working on it immediately after launch.

---

### Slice 4 — Run a session in its own worktree (≈1.5 d)

Tasks
- [ ] S4.1 `WorktreeService`: list via `git worktree list --porcelain`, add with a new
      branch, remove, dirty and unpushed checks.
- [ ] S4.2 Launch sheet with "run in a new worktree" toggle and editable branch name,
      default `sauron/<short-id>`; base location preference defaulting to
      `App Support/Sauron/worktrees/<project>/`.
- [ ] S4.3 Worktrees section in project detail: branch, Sauron-created flag, sessions
      using it, Remove action with confirmation when dirty or unpushed, refused while in use.
- [ ] S4.4 Session record carries `worktreePath`; sidebar shows the branch next to the
      session.

Done when
- Launching with the worktree toggle on creates a new branch and directory, and the agent's
  terminal shows it is in that directory (`pwd` in the session).
- The project's worktree list shows the new worktree and which session uses it.
- Remove is disabled while the session runs; after stopping, removing a worktree with
  uncommitted changes asks for confirmation, then `git worktree list` no longer shows it.
- Two sessions on the same project in two worktrees can edit the same file without
  interfering.

---

### Slice 5 — Know when a session needs you (≈2.5 d)

Introduces the `sauron` CLI and socket, because hooks need them.

Tasks
- [ ] S5.1 `sauron` command-line target: argument parsing, socket client, `hook`
      subcommand reading stdin; bundled and symlinked to `App Support/Sauron/bin`.
- [ ] S5.2 `HookServer` on a Unix socket via `NWListener`; 0600 perms; stale socket
      cleanup; request routing with `ok`/`error` responses.
- [ ] S5.3 Per-session Claude settings file with SessionStart, UserPromptSubmit,
      Notification, Stop, SessionEnd hooks; passed with `--settings`. Codex `notify` via
      `-c` pointing at `sauron hook codex`.
- [ ] S5.4 Session state machine (idle, running, waitingForInput, stopped) with
      `stateSource` hook or inferred; Codex waiting-for-input inferred via `pipe-pane`
      ring buffer and prompt-pattern timeout.
- [ ] S5.5 Sidebar state dot and badge on sessions; waiting count on the project row.
- [ ] S5.6 `NotificationService` with `UNUserNotificationCenter`: request permission, post
      on waiting or turn-finished when the session is not focused, click focuses the tab.
- [ ] S5.7 Global mute preference.

Done when
- Start a Claude session and ask it to run a command that needs permission: within a
  second the session shows a waiting badge, the project row count increments, and a macOS
  notification appears if the tab is not focused.
- Answer the prompt; the badge clears. When the turn finishes, a "finished" notification
  appears if unfocused, and none appears if the tab is focused.
- Clicking a notification brings Sauron forward with that session's tab selected.
- Codex turn completion produces the same finished state; an approval prompt is shown as
  waiting with an "inferred" marker.
- `sauron hook claude Stop < payload.json` from a shell updates the app state, proving the
  socket path works independently of the CLIs.
- Unit tests cover the state machine transitions and socket message coding.

---

### Slice 6 — See sessions you started in your own terminal (≈3 d)

Tasks
- [ ] S6.1 `ClaudeTranscriptParser` with fixture files and tests.
- [ ] S6.2 `CodexRolloutParser` with fixture files and tests; `session_meta` gives cwd and
      session id, which also completes Codex id discovery for Slice 3 resume.
- [ ] S6.3 `TranscriptIndexer`: scan both transcript roots, header-only reads, cwd-to-project
      matching including worktrees and subdirectories, directory watching for new files.
- [ ] S6.4 `TranscriptTailer`: per-file offset, `DispatchSource` watching, capped in-memory
      model, load-older.
- [ ] S6.5 `TranscriptView`: role-styled messages, collapsible tool calls, auto-scroll with
      jump-to-bottom, read-only banner for external sessions.
- [ ] S6.6 External sessions in the sidebar, visually distinct, grouped active vs recent by
      mtime with a configurable cutoff; state derived from mtime and last record.
- [ ] S6.7 Managed sessions get a Transcript tab beside the terminal using the same view.

Done when
- Start `claude` in a Sauron project from Terminal.app; within a few seconds it appears
  under that project marked external, and its transcript view shows the conversation
  updating live as you type in the terminal.
- Same for `codex`.
- A session started in a subdirectory or a worktree of the project is attributed to that
  project.
- Sessions older than the cutoff are collapsed under "recent"; the cutoff is adjustable.
- Opening the Transcript tab on a Sauron-managed session shows the same content as its
  terminal, structured.
- A transcript with a deliberately malformed line still renders every other record, and
  parser tests cover both formats.

---

### Slice 7 — Master agent chat that keeps project summaries current (≈3 d)

Tasks
- [ ] S7.1 `ProjectStatus` model; `StatusStore` watching `App Support/Sauron/status/` and
      decoding `<project-id>.json`; summary and relative `updated_at` on the project row and
      in detail; placeholder when absent.
- [ ] S7.2 Master home directory; `CLAUDE.md` generated from a template with the project
      table, store paths, transcript locations, CLI reference, and summary JSON schema;
      regenerated on project list change; `CLAUDE.local.md` preserved.
- [ ] S7.3 `MasterAgentService`: start with `--resume` of the persisted id, fresh start on
      failure; stop; pinned sidebar row with terminal tab; auto-start preference.
- [ ] S7.4 Socket commands and CLI subcommands `projects`, `sessions`, `launch`, `send`,
      `status set`; `send` refuses when the target is running.
- [ ] S7.5 Manual "Refresh summary" and "Refresh all" buttons; `RefreshScheduler` with
      collapse and idle-gated drain via `send-keys`; in-progress indicator on the row.
- [ ] S7.6 Summary prompt template covering git history, transcripts, previous summary,
      and repo docs.

Done when
- On first launch the master agent starts in its home directory and its terminal is
  reachable from the pinned sidebar row; you can chat with it.
- Clicking Refresh on a project results, without further input, in a summary appearing on
  that project's row with a fresh timestamp, and the JSON file exists in the status
  directory.
- Telling the master "start a Claude session on project X to do Y" produces a new managed
  session in the sidebar with Y as its initial prompt.
- Telling the master "tell session Z to stop and summarize" delivers that text into
  session Z's terminal.
- Quit and relaunch: the master resumes the same conversation (it remembers what you said
  before quitting).
- Adding a project regenerates `CLAUDE.md` and the master can list it via `sauron projects`.

---

### Slice 8 — Summaries refresh themselves on commit (≈1 d)

Tasks
- [ ] S8.1 `GitWatcher` on `.git/HEAD`, `refs/heads`, `logs/HEAD` for every project and
      Sauron worktree; change detected by comparing the resolved HEAD hash.
- [ ] S8.2 Debounce (30 s) and enqueue into `RefreshScheduler`; never enqueue when the
      HEAD hash matches the one recorded with the last summary.
- [ ] S8.3 "Refresh queued" state on the row while waiting for the master to go idle.

Done when
- Commit in a project from a terminal; within about a minute the row shows "refresh
  queued", then the summary updates and reflects the commit.
- Three commits within 30 seconds produce exactly one refresh.
- Committing while the master is mid-conversation queues the refresh and delivers it only
  after the master's turn ends, without corrupting the in-progress turn.
- No refresh fires on relaunch for projects whose HEAD is unchanged since their last
  summary.

---

### Slice 9 — Daily-driver polish (≈1.5 d)

Tasks
- [ ] S9.1 `PreferencesView`: CLI path overrides, worktree base, notifications, master
      auto-start, terminal font and scrollback.
- [ ] S9.2 Keyboard navigation between sessions and a ⌘K quick switcher.
- [ ] S9.3 Error banners for service failures on the affected project or session; "reveal
      logs" action.
- [ ] S9.4 `scripts/smoke.sh`: temp repo, launch through the CLI, verify tmux session,
      send a message, check hook events arrive. `docs/QA.md` manual checklist covering the
      Done criteria of every slice.
- [ ] S9.5 App icon and README with build instructions.

Done when
- Every preference takes effect without restarting the app.
- ⌘K, type part of a session or project name, Enter: that item is focused.
- Breaking a CLI path in preferences produces a visible banner on the next launch attempt,
  not a silent failure.
- `scripts/smoke.sh` passes on a clean checkout, and every item in `docs/QA.md` has been
  checked on a build from main.

---

### Summary

| Slice | Capability | Est. |
|---|---|---|
| 1 | Add a project, persisted | 1.5 d |
| 2 | Launch and chat with Claude, survives restart | 3 d |
| 3 | Launch Codex, initial prompt | 1 d |
| 4 | Sessions in worktrees | 1.5 d |
| 5 | Attention badges and notifications, `sauron` CLI | 2.5 d |
| 6 | External sessions with live transcripts | 3 d |
| 7 | Master agent chat and on-demand summaries | 3 d |
| 8 | Commit-triggered summaries | 1 d |
| 9 | Preferences, keyboard, smoke test, QA | 1.5 d |

Total ≈ 18 working days. Slices 1 and 2 together are the first usable build; slices 1
through 5 constitute a minimum daily driver; 6 through 8 complete the v1 requirements.

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

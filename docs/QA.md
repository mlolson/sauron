# Sauron manual QA checklist

Run on a build from `main` with `scripts/app.sh`. Each item maps to a slice's Done criteria in
`docs/IMPLEMENTATION_PLAN.md`. Automated coverage: `pnpm test` (unit) and `scripts/smoke.sh`
(end to end against the running app).

## Slice 1: projects
- [ ] Drag a git repo folder onto the window: a row appears.
- [ ] Drag a non-git folder: an error banner, nothing added.
- [ ] Quit and relaunch: same projects, same order.
- [ ] Remove a project: row gone, directory untouched.

## Slice 2: Claude sessions
- [ ] New Claude opens a terminal running Claude Code in the repo; typing a prompt gets a reply.
- [ ] `tmux ls` shows the session; `tmux attach -t <name>` works from Terminal.
- [ ] Quit Sauron mid-task, relaunch: session listed, terminal reattaches with output intact.
- [ ] `tmux kill-session` from outside: Sauron shows Stopped with Resume; Resume continues the conversation.
- [ ] `SAURON_TOOL_CLAUDE=none scripts/app.sh`: setup screen instead of the main window.

## Slice 3: Codex
- [ ] New Codex opens a working Codex terminal.
- [ ] `SAURON_TOOL_CODEX=none`: app runs, Codex button disabled with tooltip.
- [ ] Initial prompt field: the agent starts on it immediately.

## Slice 4: worktrees
- [ ] Launch with "Run in a new git worktree": agent's `pwd` is the worktree, branch is the new one.
- [ ] Worktrees card lists it, marked sauron and in use.
- [ ] Remove disabled while in use; after Stop, removing a dirty worktree asks first, then it is gone from `git worktree list`.

## Slice 5: attention
- [ ] A permission prompt in a Claude session: orange dot and project badge within a second; macOS notification when the tab is not focused.
- [ ] Answering the prompt clears the badge; turn end notifies only when unfocused.
- [ ] Clicking a notification focuses that session.
- [ ] Codex turn completion shows idle; an approval prompt shows waiting (inferred).
- [ ] `echo '{"message":"x"}' | SAURON_SESSION_ID=<id> ~/Library/Application\ Support/Sauron/bin/sauron hook claude Notification` flips the state.
- [ ] Bell button mutes and unmutes.

## Slice 6: external sessions
- [ ] Start `claude` from Terminal in a project dir: appears under the project marked ◇ within seconds; transcript updates live.
- [ ] Same for `codex`.
- [ ] A session started in a subdirectory or worktree is attributed to the project.
- [ ] Sessions older than the preference cutoff appear only in the project's External Sessions card.
- [ ] Transcript tab on a managed session shows the structured conversation.

## Slice 7: master agent
- [ ] On first launch the master starts, pinned at the top; you can chat with it.
- [ ] Refresh on a project produces a summary on the row and in the Status card with a fresh timestamp; `status/<id>.json` exists.
- [ ] "Start a Claude session on X to do Y" in the master chat creates a worker with that prompt.
- [ ] "Tell session Z to …" delivers text into Z's terminal.
- [ ] Quit and relaunch: the master remembers the previous conversation.
- [ ] Adding a project regenerates CLAUDE.md; `sauron projects` from the master lists it.

## Slice 8: commit-triggered refresh
- [ ] Commit in a project: row shows the spinner, then the summary updates within about a minute.
- [ ] Three commits within 30 seconds: one refresh.
- [ ] Commit while the master is mid-conversation: refresh waits for the turn to end.
- [ ] Relaunch with no new commits: no refresh fires.

## Slice 9: polish
- [ ] ⌘, opens Preferences; every change applies without restart (tool path, worktree base, notifications, auto-start, font size, scrollback).
- [ ] ⌘K, type part of a name, Enter: item focused. ⌘⇧] / ⌘⇧[ cycle live sessions.
- [ ] A wrong CLI path in Preferences produces a banner on the next launch attempt.
- [ ] Reveal Logs opens Finder at `~/Library/Logs/Sauron/main.log`.
- [ ] `scripts/smoke.sh` passes.

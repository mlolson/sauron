# Sauron — Project Summarizer and the `.sauron/` Status File

Version: 0.1 (proposed)
Date: 2026-09-07
Owner: Matt Olson
Status: Draft, decisions 1–4 agreed in conversation

---

## 1. Overview

Project status summaries today are produced by the supervisor agent: a single long-lived
interactive session that the app nudges after commits and on **Refresh**, and that writes the
result with `sauron status set` into a per-project JSON file under Application Support.

This moves summarisation onto the background-agent pipeline and moves the result into the
project itself:

- **Project summarizer** is a built-in background agent, attached to every project by
  default, triggered after commits with a cooldown, and runnable on demand. It runs with the
  app closed, like every background agent.
- The status lives at **`<project>/.sauron/status.json`**, ignored by git through
  `.git/info/exclude`, where any agent working in the project can read it.
- The **supervisor agent stays** as the thing you talk to and that dispatches workers. It no
  longer has the summarisation job, and it reads status from the project files like everyone
  else.

### 1.1 Goals

- Summaries refresh without the supervisor being enabled, running, or idle; and with the
  app closed.
- Status is a file in the project, readable by interactive agents, the summarizer, the
  supervisor, and the user.
- The summarizer is an ordinary background agent: same picker, same template pane, same
  trigger editor, same sidebar row, editable prompt, detachable per project.
- Background agents can run either in a fresh worktree or in the main checkout, per agent.

### 1.2 Non-goals

- Changing what the status contains. The summary / recent updates / todos / details shape
  and the Status card stay as they are.
- Committing status to the repository. It is per-machine working state, not history.
- Removing the supervisor.

---

## 2. Concepts

**Workspace** — where a background agent's run happens: `worktree` (a fresh worktree on a
run branch, output reviewed; today's only behaviour) or `main` (the project's main checkout,
no branch, nothing to review). Per template, overridable per attachment like the trigger.

**Project summarizer** — a built-in template, id `project-summarizer`, workspace `main`,
trigger "after commits, 5 minute cooldown", skip-if-unchanged on. Its prompt file ships with
Sauron and is editable like any template's.

**Status file** — `<project>/.sauron/status.json`, the `ProjectStatus` object as today plus
nothing new. Written through `sauron status set`, which validates and notifies the app, or
by hand; the app watches it either way.

---

## 3. Workspaces

### 3.1 Main-checkout runs

A `main` run starts a tmux session in the project's main checkout with the same headless
command, session id, hooks and log as a worktree run. Differences:

| | `worktree` | `main` |
|---|---|---|
| Branch / worktree | `sauron/bg/<id>/<ts>`, fresh worktree | none; the checkout as it is |
| Outcome | `no_changes`, `needs_review`, `failed`; auto-merge optional | `done` or `failed` |
| Review card | yes | no; the run appears in the sidebar group and its log is reachable |
| Concurrency | one run per job per project | the same, plus: not started while another `main` run of **any** job is in that checkout |

The run record gains `workspace`; `branch` and `worktreePath` are null for `main` runs.
`finishRun` counts no commits for them and never merges.

### 3.2 The safety framing

The background-agents doc's rule is "nothing an agent does reaches the main checkout without
review". A `main` run is the deliberate exception, and it is labelled as such in the template
editor: *runs directly in the project's checkout; whatever it changes is there at once, with
no review step; use for agents that only read the repository or write outside version
control.* It is off unless chosen. The summarizer's prompt confines it to reading the repo
and writing `.sauron/status.json` via the CLI.

### 3.3 Commit trigger and `main` runs

The hook already refuses to trigger on a commit made by a background run, so a `main` run
that did commit could not re-trigger itself. Nothing else changes; the hook does not care
where the run will happen.

---

## 4. The status file

### 4.1 Location and format

`<project>/.sauron/status.json`, the existing `ProjectStatus` JSON, pretty-printed. The
directory is created on demand. `.sauron/` is reserved for Sauron: the status file now, and
whatever per-project working files come later.

### 4.2 Ignore rule

On project add (and on load for projects that predate this), Sauron appends `.sauron/` to
`.git/info/exclude` if it is not already excluded. The repository's own `.gitignore` is not
touched, so adding a project never dirties it. A user who wants the rule shared can put it in
`.gitignore` themselves; `git check-ignore` is what Sauron tests, so either works.

### 4.3 Reading and writing

- **`sauron status get --project <id>`** reads the file. **`sauron status set …`** validates
  and writes it, then notifies the app. Both keep working with the app closed, resolving the
  project through `config.json`, the way `commit-hook` already does.
- **Worktrees:** `.sauron/` is ignored, so a linked worktree does not have it. The CLI
  resolves the project by id, not by cwd, so an agent in a worktree reads and writes the
  main checkout's file. For anyone reading the file directly, `git rev-parse
  --git-common-dir` gives the main checkout.
- **The app** watches every project's `.sauron/status.json` (the existing `StatusStore`
  watcher, pointed at project directories instead of one central directory) so hand edits,
  CLI writes with the app open, and summarizer runs with the app closed all show up.

### 4.4 Migration

On the first load after upgrade, each `status/<project id>.json` is moved into its project's
`.sauron/status.json`; files for projects no longer registered are left where they are. The
`status/` directory is no longer created.

---

## 5. The summarizer template

```json
{
  "id": "project-summarizer",
  "name": "Project summarizer",
  "agentId": "claude",
  "promptFile": "jobs/project-summarizer.md",
  "workspace": "main",
  "trigger": { "kind": "commit", "cooldownMinutes": 5 },
  "skipIfUnchanged": true,
  "builtIn": true
}
```

- **Built in:** created on load if absent, and re-created if deleted (so a project can
  always attach it). Everything but `id` and `builtIn` is editable; the prompt file is
  seeded from Sauron's default and then left alone, exactly like the supervisor's
  `summary-prompt.md` today. Deleting it from the template pane detaches it everywhere and
  it reappears unattached.
- **Attached by default:** to every project on add, and to existing projects on migration.
  Disable or detach per project as usual.
- **Prompt:** today's summary prompt with two changes: it works in the current directory
  rather than being told a path, and it uses `sauron status get`/`set` with the project id.
  Placeholders: `{projectName}`, `{projectId}`, `{previousSummaryUpdatedAt}` (from the status
  file, or "never").
- **Refresh** on the Status card becomes Run now for this job. The spinner on the project row
  reflects a running summarizer run.
- **Skip if unchanged** for a `main` job compares HEAD (not the run branch base) with the
  HEAD at the job's last run, so a nightly-style schedule on a quiet repo costs nothing.

---

## 6. The supervisor, afterwards

Kept, with a narrower job: the agent you chat with, that starts, messages and watches
workers, and that can answer "where is everything". Changes:

- Its instructions drop the summarisation duty and point it at `<project>/.sauron/status.json`
  (and `sauron status get`) for reading status. It may still `status set` if asked.
- The after-commit nudge, the refresh queue, "Pause summaries" / "Resume summaries", and the
  `supervisorProjectSummary*` preferences go away. The refresh queue's timeout, idle-gating
  and drain logic are deleted rather than kept around.
- **Restart / Enable / Disable** stay.

---

## 7. Configuration

`Preferences` grows nothing new beyond the template. The template gains `workspace` and
`builtIn`; `ProjectJob` gains an optional `workspace` override. Removed:
`supervisorProjectSummaryAfterCommit`, `supervisorProjectSummaryAfterCommitCooldownMinutes`,
`supervisorProjectSummaryPromptFile` (its file is renamed into `jobs/`).

---

## 8. Phasing

1. **Workspaces.** `workspace` on templates and attachments, `main` runs in the runner and
   `finishRun`, the `done` status, the editor label, one-`main`-run-per-checkout rule, the
   sidebar and project page showing `done` runs without a Review entry. Verified with a
   throwaway `main` agent that writes an untracked file.
2. **Status file.** `.sauron/status.json` read/write in the CLI without the app, the watcher
   over project directories, `.git/info/exclude` on add and on load, migration from
   `status/`. The supervisor keeps working unchanged through this phase, just against the
   new location.
3. **Project summarizer.** The built-in template, default attachment, prompt file, Refresh
   as Run now, spinner from run state; then the supervisor's summary duty, queue and
   preferences removed and its instructions rewritten.

---

## 9. Decisions

Agreed 2026-09-07:

1. **Runs may target the main checkout.** A per-agent workspace option, `worktree` or `main`,
   overridable per attachment.
2. **The supervisor stays** for chat and dispatch; only summarisation moves to a background
   agent named **Project summarizer**.
3. **Status stays JSON**, in `<project>/.sauron/status.json`, with the CLI as the validated
   write path and the app watching the file.
4. **`.git/info/exclude`**, not `.gitignore`, gets the `.sauron/` rule.

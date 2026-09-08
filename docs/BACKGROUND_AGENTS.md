# Sauron — Background Agents and the Review Queue

Version: 1.0 (all four phases shipped)
Date: 2026-09-05
Owner: Matt Olson
Status: Agreed

---

## 1. Overview

A background agent is an agent that runs a task for a project without anyone watching it:
code cleanup, documentation cleanup, a security review, dependency updates. It is
defined once, attached to projects with a trigger — every N hours or days, a cron
schedule, or "after a commit, with a cooldown" — and its output is a branch that the user reviews and either merges or discards.

Two properties shape the whole design:

- **Background agents run whether or not the Sauron app is open.** A nightly job must not
  depend on a GUI being in the foreground.
- **Nothing a background agent does reaches the main checkout without review.** Agents run
  unattended with permission prompts bypassed; the review step is the safety story.

### 1.1 Goals

- Configure background agents per project, in Preferences and from the project's context
  menu and overview page.
- Triggers: an interval (every N minutes/hours/days); a cron schedule; after a commit with a
  cooldown; run now.
- Runs happen with the app closed.
- Every run's output lands on its own branch in its own worktree.
- A review queue: see what a run produced, read the agent's summary, inspect commits and
  diffs, then merge or discard.
- Runs are visible alongside ordinary sessions, with transcripts and attributed commits.

### 1.2 Non-goals for v1

- Auto-merge by default. It exists as a per-job opt-in (§6.4), off unless switched on.
- A cross-project review inbox. Review lives on the project page.
- Notifications when a run finishes. Notifications are a separate, undesigned feature.
- Running background agents on another machine.

---

## 2. Concepts

**Background agent** — defined once: which agent profile, what prompt, a default trigger.

**Job** — a background agent attached to a project, with that project's trigger.

**Run** — one execution of a job: a worktree, a branch, a session, and a result.

**Review** — a run that finished with commits, awaiting a merge-or-discard decision.

A run is an ordinary Sauron session in every respect that matters — it lives in tmux, has
`SAURON_SESSION_ID` in its environment, its commits are attributed by the post-commit hook,
its transcript is discoverable — with two differences: the agent is started headless, and
the session records which job and run it belongs to.

---

## 3. Running the agent

### 3.1 Headless, not interactive

Interactive sessions type a prompt into an agent's TUI. Background runs use the agents'
non-interactive modes instead:

| Agent  | Command                                   | Notes                                     |
|--------|-------------------------------------------|-------------------------------------------|
| Claude | `claude -p <prompt> --output-format json` | Exits when done; JSON carries a summary.  |
| Codex  | `codex exec <prompt>`                     | Exits when done.                          |

Headless mode is what makes "finished" a real event: an exit code, a final message, and no
TUI left waiting for input. The agent profile model grows a `backgroundCommand` argument
array beside `forkCommand`, with the same placeholders (`{prompt}`, `{cwd}`, `{sessionId}`,
`{sauronBin}`). A profile without one cannot be used for background jobs; Claude and Codex
ship with defaults.

### 3.2 Always a worktree

Every run gets a fresh worktree on a fresh branch, `sauron/bg/<job-id>/<timestamp>`, cut
from the project's current branch at the moment the run starts. Never the main checkout,
never another session's worktree. This is isolation, but it is also what makes review cheap:
the unit of review is the branch, and the diff viewer and branch filter already exist.

### 3.3 Still in tmux

The headless command runs inside a tmux session named like any other Sauron session. That
buys, for free: attaching from a terminal to watch a run, the transcript view, commit
attribution through the existing hook, and the Commits pane. The session outlives the app.

---

## 4. Running with the app closed

### 4.1 No daemon

The obvious design — a long-lived `sauron-daemon` that schedules and spawns — is the wrong
one. It duplicates the app's session and worktree logic in a second process, the two then
share state files and race, and it is one more thing that has to be kept alive.

Instead:

- **launchd is the scheduler.** One LaunchAgent for all of Sauron, `StartInterval` of 60
  seconds, running `sauron tick`. A single plist rather than one per job, and real cron
  expressions rather than launchd's limited calendar intervals. launchd survives reboots and
  runs missed ticks after sleep.
- **The post-commit hook is the commit trigger.** It already fires on every commit, app or
  no app. It gains one responsibility: after reporting the commit, evaluate whether any
  commit-triggered job for that project is due.
- **"Run now"** invokes the same runner from the app.

### 4.2 The runner lives in the CLI

For the above to work with the app closed, the work — create a worktree, expand the agent
profile, spawn the tmux session, record the result — has to run from the `sauron` CLI, not
from the Electron main process. This is the substantive engineering in the feature. It is
extraction rather than rewriting: `git.ts`, `worktrees.ts`, and profile expansion are plain
Node modules today, and the CLI already runs under Electron's bundled Node.

**One code path does the work, and it is always the CLI.** The app never runs a job itself.
It observes run state and offers buttons that invoke the CLI. Without this rule the app and
launchd both decide to run things, and they race.

### 4.3 State

Run state is written by the CLI and read by the app, so it cannot live in `sessions.json`,
which the app owns and rewrites. It goes in SQLite beside the attribution store, where WAL
already handles two processes:

```
jobs_runs (
  id, job_id, project_id, session_id,
  branch, worktree_path,
  trigger,                -- 'cron' | 'commit' | 'manual'
  started_at, finished_at,
  status,                 -- running | no_changes | failed | needs_review | merged | discarded
  summary,                -- the agent's final message
  exit_code, log_path
)
job_state (job_id, last_run_at)   -- job_id is "<project id>/<agent id>": one row per attachment
```

The app reconciles runs into its session list on load and on change, the way it already
adopts tmux sessions and external transcripts it did not start.

---

## 5. Triggers

### 5.1 Cron

`sauron tick` evaluates each enabled cron job's expression against `job_state.last_run_at`
and starts any that are due. Full five-field cron syntax, parsed by Sauron, in local time.

A job is due when its most recent scheduled minute is later than its last run began. The
tick claims that minute in SQLite before starting anything, so a slot starts at most one run
however many ticks see it. Scheduled minutes are looked for up to 24 hours back, which is
how a tick that launchd runs after the machine wakes catches up on a slot missed during
sleep. A job that has **never** run looks back only one hour: without a record of when it
was configured, that stops a nightly job from firing the moment it is added at midday.

The app installs the LaunchAgent (`~/Library/LaunchAgents/com.mattolson.sauron.tick.plist`)
on every load, rewriting and reloading it only when its contents changed. Its output goes
to `jobs/tick.log`; the tick prints only when it starts or skips something, so the log is a
record of actions, though Electron's runtime adds one stderr line per tick.

### 5.2 After a commit

Evaluated by the post-commit hook. A commit counts only if:

- it is on the project's main checkout, not a review branch;
- it was **not made by a background run** — the attribution store knows which session made
  it, and without this check a cleanup job commits, triggers itself, and never stops;
- the job's cooldown has elapsed since its last run.

### 5.3 Rules for every trigger

- **One run per job at a time.** If a run is in progress the trigger is skipped, not queued.
- **Skip if unchanged** (per-job option, default on for cron): no run when the project has
  no commits since the job's last run. A nightly review of an untouched repository is pure
  token spend.
- A burst of commits produces one run, not several: the cooldown starts when the run does,
  and however short the cooldown, two runs of one job are never started within 60 seconds of
  each other. The hook claims the run in SQLite before spawning the runner, so two hooks
  racing on the same burst cannot both win.
- Commits made by hand count too. The hook runs the CLI for every commit in a registered
  project, not only those made inside a session; attribution is recorded only when there is
  a session to attribute to. When the app is closed the hook writes attribution directly.

---

## 6. The review queue

### 6.1 Outcomes

A run ends in one of four states:

| Status         | Meaning                                              | What the user sees            |
|----------------|------------------------------------------------------|-------------------------------|
| `no_changes`   | Agent finished without committing                    | Dismissed automatically       |
| `failed`       | Non-zero exit, or the agent never started            | Listed with its log           |
| `needs_review` | Commits on the branch                                | In the review queue           |
| `merged` / `discarded` | Decided                                      | History                       |

### 6.2 The review view

The existing Commits pane, opened with the run's branch pre-selected, plus a header carrying
the agent's own summary of what it did and the run's log. Actions:

- **Merge** — into the project's current branch. Pre-checked with `git merge-tree`, which
  computes the merge without touching the working tree. Clean: a `--no-ff` merge preserving
  the agent's commits, then the branch and worktree are removed. Conflicts: nothing is
  attempted; instead **Resolve in a session** opens an interactive agent in the run's
  worktree with the conflict described.
- **Discard** — branch and worktree removed. Confirmed.
- **Open** — start an interactive agent in the run's worktree to continue the work by hand.
- **Re-run** — a new run of the same job.

The main checkout may have moved between the run starting and the review; that is the
conflict case above, not a separate state.

### 6.4 Auto-merge, opted into per job

A job may be marked `autoMerge`. When such a run finishes with commits, the runner itself
attempts the merge — the same code the Merge button uses — and only if it is clean *and*
the main checkout has no uncommitted changes. Anything else leaves the run in Review with a
note saying why it was not merged. The job editor spells out the trade: the agent ran
unattended with permission prompts bypassed, so this is for jobs whose output you would
accept unread.

### 6.3 Where it appears

Each background agent has its own page, reached from its sidebar row or with `sauron select
--job`, listing every run of that agent on the project. A run awaiting a decision offers
**Review commits**, Merge, Open in session and Discard there; a finished run offers Re-run.
A badge on the agent's sidebar row counts its runs awaiting review, and the project's
sidebar row carries the total across its agents. Runs are not listed among the project's
sessions; a run's session opens on its transcript from the agent's page, so it can still be
watched while in progress.

---

## 7. Configuration

A background agent is defined **once**, in `preferences.backgroundAgents`, and **attached** to
any number of projects. Each attachment is enabled or disabled on its own and may override the
agent's default trigger; a template attached to two projects is two independent jobs with
their own run history and spacing. Editable in the app from **Add background agent…** on a
project (a picker over the defined agents, with **Create background agent…** for the CRUD
flow) and per project on its page (**Trigger…**, Enable/Disable, Detach).

```json
{
  "preferences": {
    "backgroundAgents": [
      {
        "id": "security-review",
        "name": "Security review",
        "agentId": "claude",
        "promptFile": "jobs/security-review.md",
        "trigger": { "kind": "interval", "every": 1, "unit": "days" },
        "skipIfUnchanged": true
      },
      {
        "id": "docs-cleanup",
        "name": "Documentation cleanup",
        "agentId": "codex",
        "promptFile": "jobs/docs-cleanup.md",
        "trigger": { "kind": "commit", "cooldownMinutes": 30 },
        "skipIfUnchanged": false
      }
    ]
  },
  "projects": [
    {
      "name": "sauron",
      "backgroundJobs": [
        { "template": "security-review", "enabled": true },
        { "template": "docs-cleanup", "enabled": true, "trigger": { "kind": "cron", "schedule": "0 3 * * 1-5" } }
      ]
    }
  ]
}
```

Triggers: `manual`; `interval` (every N minutes, hours or days, counted from when the last run
began, first run as soon as it is attached; evaluated by the tick); `cron` (a five-field
expression, for schedules an interval cannot say); `commit` (with a cooldown). Configs from
before agents were shared, with full job definitions inside projects, are hoisted into
templates on the next app load.

Prompts are Markdown files, like the supervisor's summary prompt, with the same placeholder
convention (`{projectName}`, `{projectPath}`, `{branch}`), so a long set of instructions is a
file rather than a JSON string. Relative paths resolve beside `config.json`.

---

## 8. Safety

- Background runs use the profile's normal arguments, which for Claude and Codex bypass
  permission prompts. The worktree bounds what they can touch in the repository, not what
  they can run. This is the same trust the user already extends to interactive sessions,
  applied unattended; the review queue is what makes it acceptable.
- The runner never operates on the main checkout. Merge is the only operation that does,
  and it is user-initiated.
- Loops are prevented structurally (§5.2), not by a rate limit.

---

## 9. Phasing

1. **Pipeline end to end, no scheduling.** Job model, the CLI runner, "Run now", runs as
   sessions, the Review section with Merge and Discard. This alone is useful: "run a
   security review on this project" becomes one click. — *Shipped.*
2. **Commit trigger**, evaluated by the hook, working with the app closed. — *Shipped;
   verified with the app running and with it closed.*
3. **Cron**, via the launchd tick. — *Shipped; skip-if-unchanged with it, verified: the
   tick started a job, skipped it the next minute with nothing changed, and started it
   again after a commit.*
4. Badges, re-run, and an opt-in auto-merge for specific jobs. — *Shipped: a badge on the
   project's sidebar row counts runs awaiting review; Re-run appears wherever a run is
   listed; auto-merge is per job and verified to land a clean run on main unattended, and to
   refuse a conflicting one and a dirty checkout.*

---

## 10. Decisions

Agreed 2026-09-05:

1. **launchd plus a CLI runner, no daemon.** Everything in §4 follows from it.
2. **Headless agents** (`claude -p`, `codex exec`), not a TUI with a typed prompt.
3. **Runs appear as sessions** in the sidebar, with a distinct glyph, not in a separate list.
4. **Merge is `--no-ff`**, preserving the agent's commits. Squash may become a per-job option
   later if reviews turn out to be noisy.
5. Phase 1 as written; nothing pulled forward.

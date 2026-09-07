# Sauron: An agentic terminal development environment, based on tmux

**About Sauron**
I really like the simplicity of running agents in the terminal, but I was having problems managing the complexity of running many of them across multiple projects. I decided to build something for my own use, custom tailored to exactly how I like to work. 

It's not quite and IDE, and it's not quite a terminal. I therefore call it a "terminal development environment". 

## Key design principles

* **Unopinionated**: Sauron doesn't provide any frameworks, skills, or other instructions for your agents. Agents run in regular tmux sessions, Sauron simply keeps track of them. Sauron is also not opinionated about which harness or inference provider you use. Anything that runs in a terminal is supported.

* **Organized around projects**: Agents are organized around the projects that they are working on. A background agent keeps an up to date summary of the status of each project, written into the project's own `.sauron/status.json`: recent updates, blockers, and TODO's. Come back to a project after a week or a month and immediately know where to pick it up.

* **Persistent sessions** Because sessions are running in tmux, they are persistent. You can quit the app or reboot your laptop and the sessions will still be there. 

* **Commit attribution and code review tools**: Sauron keeps track of the commits that each agent writes. Code review tools allow you to quickly review each agent's code output.

* **Seamless handoff between agents**: Fork agents and handoff work to another type of agent with a single click. Ran into your limit for Claude? Hand off to Codex and don't miss a beat. Helps avoid vendor lock-in.

* **Totally Customizable**: Add as many types of agents as you wish. Customize supervisor agent type and behavior. 




## Key features

**Built on tmux** 



**Built on tmux.** Every session Sauron starts runs in a tmux session. Quit the app, relaunch, and they are all still there. 

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

**Background agents.** Define an agent once (an agent profile, a prompt file, a default
trigger) and attach it to any project. Triggers: manual, every N minutes/hours/days, a cron
expression, or after commits with a cooldown. Runs happen with the app closed, in a fresh
worktree whose output waits in a review queue, or directly in the main checkout for agents
that only read the repository. See `docs/BACKGROUND_AGENTS.md`.

**Project summarizer.** A built-in background agent, attached to every project by default,
that rewrites the project's status after commits (5 minute cooldown) or on **Refresh**. The
status lives in `<project>/.sauron/status.json`, ignored by git through `.git/info/exclude`,
so any agent working in the checkout can read it. See `docs/PROJECT_SUMMARIZER.md`.

**Supervisor agent.** A long-lived agent with its own generated home directory and
instructions. Chat with it, ask it to start or message workers, or ask it about any project.
Right-click it to restart or disable it.


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
scripts/sauron status refresh --project <name|id>   # run the Project summarizer now
scripts/sauron status set --project <name|id> --summary "..." [--details "..."] [--update "..."] [--todo "..."]
scripts/sauron status get|set ...                # also work with the app closed, straight from the project's status file
scripts/sauron job run|list|merge|discard ...    # background agent runs; `sauron tick` is what launchd calls every minute
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

The Project summarizer's prompt is `jobs/project-summarizer.md` beside `config.json`, seeded on
first launch and then yours to edit. It supports `{projectName}`, `{projectId}`, `{projectPath}`,
`{branch}`, `{jobName}` and `{previousSummaryUpdatedAt}`. Its trigger and cooldown are edited like
any background agent's, globally in Preferences or per project with **Configure…**.

## How commit attribution works

When a project is added, Sauron installs a `post-commit` hook into it (an existing hook is kept
and chained to). The hook inherits the environment of whatever invoked git, so it sees
`SAURON_SESSION_ID` exactly when the commit came from a managed session, and reports the commit
to the app over the control socket; otherwise it does nothing. Every path in the hook exits 0,
so a Sauron problem can never fail a commit. Linked worktrees share the main checkout's hooks,
so one install covers every worktree Sauron creates. Removing a project removes the hook and
restores whatever it displaced.

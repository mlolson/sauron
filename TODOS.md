# TODOs

Open items, roughly in priority order. Check them off or delete them when done.

## Terminal

- [ ] **Shift+Enter does not insert a newline.** In a native terminal, Shift+Enter sends a
      newline to the running program (agents use it for multi-line input). In Sauron's embedded
      terminal it behaves like plain Enter, so multi-line prompts cannot be composed the way
      they can outside the app.

## Session page header

- [ ] **Refactor the header.**
  - Remove the Terminal / Transcript toggle.
  - Add a **Commits** view listing the commits made by this session (the attribution store
    already has them per session; see `lastCommitBySession` and `commitsForSession`).
  - Remove the session pills (the sibling-session switcher).
  - Add labels showing the session's **worktree** and **branch**.

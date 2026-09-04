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

## Known gaps

- [ ] **Transcript tab is empty for Codex forks.** A Codex fork's rollout holds only what was
      said after the fork; the history lives in the parent rollout named by `forked_from_id`.
      `readTranscriptEntries` follows that chain for handoffs, but the live `TranscriptTailer`
      still reads only the fork's own file. Prime the tailer with the inherited chain before it
      starts watching.
- [ ] **"Go to session" on a forgotten session.** Attribution rows outlive the session, so the
      commit list still offers the button and it navigates to nothing. Either hide it when the
      session no longer resolves, or keep showing the name from the store.
- [ ] **`removeProject` does not await hook removal.** `uninstallCommitHook` is fired without
      being awaited; it completes in practice, but a quit in that window would leave the
      post-commit hook behind in the removed project.

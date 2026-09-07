import type { JobWorkspace } from '@shared/types'

/** Where a background agent runs; the main-checkout choice is spelled out, since it skips review. */
export function WorkspaceSelect({ value, onChange, allowDefault, defaultValue }: {
  value: JobWorkspace | undefined
  onChange: (workspace: JobWorkspace | undefined) => void
  /** Offer "the agent's default" as a choice, for a per-project override. */
  allowDefault?: boolean
  defaultValue?: JobWorkspace
}) {
  return (
    <>
      <label className="pref-row">
        <span>Runs in</span>
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : (e.target.value as JobWorkspace))}>
          {allowDefault && <option value="">Agent's default ({defaultValue === 'main' ? 'main checkout' : 'a fresh worktree'})</option>}
          <option value="worktree">A fresh worktree, output reviewed</option>
          <option value="main">The main checkout, no review</option>
        </select>
      </label>
      {(value ?? defaultValue) === 'main' && (
        <p className="muted small">
          Runs directly in the project's checkout. Whatever it changes is there at once, with no review step, and nothing else can
          run in that checkout meanwhile. For agents that only read the repository or write outside version control.
        </p>
      )}
    </>
  )
}

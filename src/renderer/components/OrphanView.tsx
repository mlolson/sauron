import type { SelectionTarget } from '@shared/types'

export function OrphanView({ name, onSelect }: { name: string; onSelect: (t: SelectionTarget | null) => void }) {
  return (
    <div className="placeholder">
      <div className="big">?</div>
      <h2>{name}</h2>
      <p>This tmux session has Sauron's prefix but no record, probably from a lost sessions.json. Adopt it to attach, or kill it.</p>
      <div className="actions">
        <button className="primary" onClick={() => void window.sauron.adoptOrphan(name)}>
          Adopt
        </button>
        <button
          className="destructive"
          onClick={() => {
            void window.sauron.killOrphan(name)
            onSelect(null)
          }}
        >
          Kill
        </button>
      </div>
    </div>
  )
}

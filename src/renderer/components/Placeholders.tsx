export function EmptyDetail() {
  return (
    <div className="placeholder">
      <div className="big">◎</div>
      <h2>No Project Selected</h2>
      <p>Add a git repository to start tracking it, or drop a folder onto the window.</p>
      <div className="actions">
        <button className="primary" onClick={() => void window.sauron.addProjectDialog()}>
          Add Project…
        </button>
      </div>
    </div>
  )
}


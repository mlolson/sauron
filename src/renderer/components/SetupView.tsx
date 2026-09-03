import type { ToolPaths } from '@shared/types'
import { missingRequiredTools } from '@shared/types'

const hints: Record<string, string> = {
  claude: 'Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash',
  tmux: 'Install with Homebrew: brew install tmux',
  git: 'Install the Xcode Command Line Tools: xcode-select --install',
}

export function SetupView({ toolPaths }: { toolPaths: ToolPaths }) {
  return (
    <div className="setup">
      <h1>Sauron needs a few tools</h1>
      <p>These were not found on your login shell's PATH:</p>
      <ul>
        {missingRequiredTools(toolPaths).map((tool) => (
          <li key={tool}>
            <code>{tool}</code>
            <span className="muted">{hints[tool]}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">PATH searched:</p>
      <pre className="small">{toolPaths.path}</pre>
      <div className="actions">
        <button className="primary" onClick={() => void window.sauron.resolveTools()}>
          Check Again
        </button>
      </div>
    </div>
  )
}

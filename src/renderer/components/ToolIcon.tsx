import type { AgentTool } from '@shared/types'
import anthropic from '../assets/anthropic.png'
import { OpenAIMark } from './OpenAIMark'

/** Small brand mark for the tool a session is running; a prompt glyph for a plain shell. */
export function ToolIcon({ tool, className = '' }: { tool: AgentTool; className?: string }) {
  switch (tool) {
    case 'claude':
      return <img className={`tool-icon ${className}`} src={anthropic} alt="Claude" title="Claude Code" draggable={false} />
    case 'codex':
      return (
        <span className={`tool-icon-wrap ${className}`} title="Codex">
          <OpenAIMark className={className} />
        </span>
      )
    default:
      if (tool !== 'shell') return <span className={`tool-icon shell ${className}`} title={tool}>{tool.slice(0, 2).toUpperCase()}</span>
      return (
        <span className={`tool-icon shell ${className}`} title="Terminal">
          {'>_'}
        </span>
      )
  }
}

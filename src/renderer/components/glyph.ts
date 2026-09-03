import type { AgentTool } from '@shared/types'

export function toolGlyph(tool: AgentTool): string {
  return tool === 'claude' ? '✦' : tool === 'codex' ? '⌘' : '>_'
}

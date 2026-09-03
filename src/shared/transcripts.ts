/**
 * Claude Code stores transcripts under ~/.claude/projects/<encoded cwd>/<session id>.jsonl,
 * where every character that is not a letter or digit is replaced by "-".
 */
export function encodeClaudeProjectPath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${encodeClaudeProjectPath(cwd)}/${sessionId}.jsonl`
}

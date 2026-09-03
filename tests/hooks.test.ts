import { describe, expect, it } from 'vitest'
import { claudeHookSettings, codexNotifyConfig, looksLikeApprovalPrompt, transitionForHook } from '@shared/hooks'

describe('transitionForHook', () => {
  const t = (event: string, payload = {}, tool: 'claude' | 'codex' = 'claude') => transitionForHook({ tool, event, payload }, 'Claude 2')
  it('maps Claude events', () => {
    expect(t('SessionStart')?.state).toBe('idle')
    expect(t('UserPromptSubmit')?.state).toBe('running')
    expect(t('Notification', { message: 'Claude needs permission to run Bash' })).toEqual({
      state: 'waitingForInput',
      notify: { title: 'Claude 2 is waiting', body: 'Claude needs permission to run Bash' },
    })
    expect(t('Stop')?.state).toBe('idle')
    expect(t('Stop')?.notify?.title).toBe('Claude 2 finished')
    expect(t('SessionEnd')?.state).toBe('stopped')
    expect(t('PreToolUse')).toBeNull()
  })
  it('maps Codex turn completion', () => {
    const r = t('agent-turn-complete', { 'last-assistant-message': 'Done.' }, 'codex')
    expect(r?.state).toBe('idle')
    expect(r?.notify?.body).toBe('Done.')
    expect(t('something-else', {}, 'codex')).toBeNull()
  })
})

describe('looksLikeApprovalPrompt', () => {
  it('recognises approval prompts in the tail', () => {
    expect(looksLikeApprovalPrompt('lots of output\n\nAllow command "rm -rf build"? \n  Yes (y)  No (n)')).toBe(true)
    expect(looksLikeApprovalPrompt('Working...\n› Ask Codex to do anything')).toBe(false)
  })
})

describe('settings generation', () => {
  it('builds Claude hook settings pointing at the sauron binary', () => {
    const s = claudeHookSettings('/Users/me/Library/Application Support/Sauron/bin/sauron') as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'])
    expect(s.hooks.Stop![0]!.hooks[0]!.command).toBe(`'/Users/me/Library/Application Support/Sauron/bin/sauron' hook claude Stop`)
  })
  it('builds the Codex notify override', () => {
    expect(codexNotifyConfig('/x/sauron')).toBe('notify=["/x/sauron","hook","codex"]')
  })
})

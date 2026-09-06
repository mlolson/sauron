import { describe, expect, it } from 'vitest'
import { describeTrigger, expandArgs, expandJobPrompt, jobIdOfBranch, runBranchName, runOutcome, slugifyJobId, summarizeAgentOutput } from '../src/shared/jobs'

describe('run branches', () => {
  it('names branches by job and timestamp, and reads the job back', () => {
    const branch = runBranchName('security-review', new Date('2026-09-05T03:04:05.678Z'))
    expect(branch).toBe('sauron/bg/security-review/20260905-030405Z')
    expect(jobIdOfBranch(branch)).toBe('security-review')
    expect(jobIdOfBranch('main')).toBeNull()
    expect(jobIdOfBranch('sauron/abc123')).toBeNull()
  })
})

describe('prompts and arguments', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    const out = expandJobPrompt('Review {projectName} at {projectPath} on {branch} for {jobName}; keep {unknown}.', {
      projectName: 'sauron', projectPath: '/code/sauron', branch: 'sauron/bg/x/1', jobName: 'Security',
    })
    expect(out).toBe('Review sauron at /code/sauron on sauron/bg/x/1 for Security; keep {unknown}.')
  })

  it('expands agent arguments the same way the app does', () => {
    // Known placeholders expand, a known one with no value empties, and an unknown one stays visible.
    expect(expandArgs(['-p', '{prompt}', '--cwd', '{cwd}', '{sauronBin}', '{missing}'], { prompt: 'do it', cwd: '/w' })).toEqual(['-p', 'do it', '--cwd', '/w', '', '{missing}'])
  })
})

describe('outcomes', () => {
  it('classifies a finished run', () => {
    expect(runOutcome(1, 3)).toBe('failed')
    expect(runOutcome(0, 0)).toBe('no_changes')
    expect(runOutcome(0, 2)).toBe('needs_review')
  })
})

describe('summaries', () => {
  it("reads Claude's JSON result", () => {
    const out = 'noise\n' + JSON.stringify({ type: 'result', result: '  Fixed three typos.  ', cost_usd: 0.01 })
    expect(summarizeAgentOutput(out)).toBe('Fixed three typos.')
  })

  it('falls back to the last lines of plain output, and truncates', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const summary = summarizeAgentOutput(lines)
    expect(summary.split('\n')).toHaveLength(12)
    expect(summary.endsWith('line 29')).toBe(true)
    expect(summarizeAgentOutput('x'.repeat(5000), 100)).toHaveLength(101)
    expect(summarizeAgentOutput('   ')).toBe('')
  })
})

describe('ids and labels', () => {
  it('slugifies names into safe ids', () => {
    expect(slugifyJobId('Security Review!')).toBe('security-review')
    expect(slugifyJobId('   ')).toBe('job')
    expect(slugifyJobId('a'.repeat(60))).toHaveLength(40)
  })

  it('describes triggers', () => {
    const base = { id: 'j', name: 'J', enabled: true, agentId: 'claude', promptFile: 'p.md', skipIfUnchanged: true }
    expect(describeTrigger({ ...base, trigger: { kind: 'manual' } })).toBe('run manually')
    expect(describeTrigger({ ...base, trigger: { kind: 'cron', schedule: '0 3 * * *' } })).toBe('on schedule 0 3 * * *')
    expect(describeTrigger({ ...base, trigger: { kind: 'commit', cooldownMinutes: 30 } })).toBe('after commits, at most every 30 min')
  })
})

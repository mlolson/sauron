import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hooksDirectory, installPostCommitHook, postCommitScript, removePostCommitHook } from '../src/main/services/git-hooks'

const GIT = '/usr/bin/git'
let repo: string
const git = (...args: string[]) => execFileSync(GIT, ['-C', repo, ...args], { encoding: 'utf8' })

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sauron-hooks-'))
  git('init', '-q', '-b', 'main')
})
afterEach(() => rm(repo, { recursive: true, force: true }))

describe('post-commit hook', () => {
  it('installs, and is idempotent', async () => {
    await installPostCommitHook(GIT, repo, '/opt/sauron/bin/sauron')
    const hook = join(await hooksDirectory(GIT, repo), 'post-commit')
    expect(await readFile(hook, 'utf8')).toContain('/opt/sauron/bin/sauron')
    await installPostCommitHook(GIT, repo, '/opt/sauron/bin/sauron')
    expect(existsSync(`${hook}.pre-sauron`)).toBe(false)
  })

  it('preserves an existing hook and restores it on removal', async () => {
    const dir = await hooksDirectory(GIT, repo)
    const hook = join(dir, 'post-commit')
    await writeFile(hook, '#!/bin/sh\necho theirs\n', 'utf8')
    await chmod(hook, 0o755)

    await installPostCommitHook(GIT, repo, '/opt/sauron/bin/sauron')
    expect(await readFile(`${hook}.pre-sauron`, 'utf8')).toContain('echo theirs')
    expect(await readFile(hook, 'utf8')).toContain('post-commit.pre-sauron')

    await removePostCommitHook(GIT, repo)
    expect(await readFile(hook, 'utf8')).toContain('echo theirs')
    expect(existsSync(`${hook}.pre-sauron`)).toBe(false)
  })

  it('leaves a foreign hook alone on removal', async () => {
    const hook = join(await hooksDirectory(GIT, repo), 'post-commit')
    await writeFile(hook, '#!/bin/sh\necho theirs\n', 'utf8')
    await removePostCommitHook(GIT, repo)
    expect(await readFile(hook, 'utf8')).toContain('echo theirs')
  })

  it('reports every commit, with or without a session, and never fails the commit', async () => {
    const log = join(repo, 'calls.log')
    const fakeCli = join(repo, 'fake-sauron')
    await writeFile(fakeCli, `#!/bin/sh\necho "session=\${SAURON_SESSION_ID:-none} $@" >> ${JSON.stringify(log)}\nexit 1\n`, 'utf8')
    await chmod(fakeCli, 0o755)
    await installPostCommitHook(GIT, repo, fakeCli)

    // A commit made by hand still reaches the CLI: it may trigger a background job. The test
    // process may itself be inside a Sauron session, so the variable is cleared explicitly.
    const { SAURON_SESSION_ID: _unset, ...outside } = process.env
    execFileSync(GIT, ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'outside'], { env: outside })
    const first = git('rev-parse', 'HEAD').trim()
    expect(await readFile(log, 'utf8')).toContain(`session=none commit-hook --hash ${first}`)

    execFileSync(GIT, ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'inside'], {
      env: { ...process.env, SAURON_SESSION_ID: 'session-1' },
    })
    const head = git('rev-parse', 'HEAD').trim()
    // The CLI exited 1 both times and both commits still succeeded.
    expect(await readFile(log, 'utf8')).toContain(`session=session-1 commit-hook --hash ${head}`)
  })

  it('quotes paths containing spaces', () => {
    const script = postCommitScript('/Users/x/Application Support/bin/sauron', '/usr/bin/git')
    expect(script).toContain(`'/Users/x/Application Support/bin/sauron'`)
  })
})

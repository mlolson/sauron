import { realpath } from 'node:fs/promises'
import { runCommand } from './command'
import { SauronError } from '@shared/types'

/** Returns the repository root containing `dir`, or throws `not_a_git_repository`. */
export async function gitToplevel(git: string, dir: string): Promise<string> {
  const result = await runCommand(git, ['rev-parse', '--show-toplevel'], { cwd: dir }).catch(() => null)
  if (!result || result.code !== 0 || !result.stdout.trim()) {
    throw new SauronError('not_a_git_repository', `${dir} is not inside a git repository.`)
  }
  return realpath(result.stdout.trim())
}

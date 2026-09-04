/** Pure helpers for reading a git command line, shared and unit-tested. */

/** Global git options that consume the following argument, so the subcommand is not mistaken for one. */
const OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'])

/** The subcommand in a git argument list, skipping global options; null when there is none. */
export function gitSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('-')) return arg
    if (OPTIONS_WITH_VALUE.has(arg)) i++
  }
  return null
}

# Sauron

A macOS app for overseeing Claude Code and Codex sessions across your projects.
See `docs/REQUIREMENTS.md` and `docs/IMPLEMENTATION_PLAN.md`.

## Building

Requires macOS 15+ and the Xcode Command Line Tools (Swift 6.2). Full Xcode is optional;
`open Package.swift` works in Xcode if you have it.

```sh
scripts/build-app.sh          # builds build/Sauron.app (debug)
scripts/build-app.sh release
open build/Sauron.app
scripts/test.sh               # runs the SauronCore tests
```

`scripts/test.sh` exists because the Command Line Tools ship the Swift Testing framework
outside the default search path.

## Adding projects

Drag a git repository folder onto the window, use File > Add Project (⌘O), or:

```sh
open -a build/Sauron.app ~/code/my-repo
```

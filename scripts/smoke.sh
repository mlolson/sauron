#!/bin/sh
# End-to-end smoke test against a running Sauron instance.
# Creates a temp git repo, adds it, launches a Claude session, waits for hooks to report
# idle, sends a follow-up message, stops the session, removes the worktree and project.
set -eu
cd "$(dirname "$0")/.."
SAURON="${SAURON:-scripts/sauron}"
JQ="python3 -c"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

$SAURON ping >/dev/null 2>&1 || fail "Sauron is not running (scripts/app.sh first)"

REPO=$(mktemp -d /tmp/sauron-smoke.XXXXXX)
trap 'rm -rf "$REPO"' EXIT
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=s@s -c user.name=smoke commit -q --allow-empty -m init
say "temp repo $REPO"

$SAURON projects add "$REPO" >/dev/null
PID=$($SAURON projects | $JQ "import json,sys;print([p['id'] for p in json.load(sys.stdin) if p['path']=='$(cd "$REPO" && pwd -P)'][0])")
say "project $PID"

OUT=$($SAURON launch --project "$PID" --tool claude --worktree --prompt "Reply with exactly the word PONG and nothing else.")
SID=$(echo "$OUT" | $JQ "import json,sys;print(json.load(sys.stdin)['id'])")
TMUX=$(echo "$OUT" | $JQ "import json,sys;print(json.load(sys.stdin)['tmuxName'])")
say "session $SID in tmux $TMUX"
tmux has-session -t "=$TMUX:" || fail "tmux session missing"

say "waiting for hooks to report idle (Stop)"
for i in $(seq 1 60); do
  STATE=$($SAURON sessions --project "$PID" | $JQ "import json,sys;print([s['state'] for s in json.load(sys.stdin) if s['id']=='$SID'][0])")
  [ "$STATE" = "idle" ] && break
  sleep 2
done
[ "$STATE" = "idle" ] || fail "session never became idle via hooks (state=$STATE)"
say "idle via hooks"

$SAURON send --session "$SID" --text "Reply with exactly the word PING." >/dev/null
say "sent follow-up"
sleep 1
STATE=$($SAURON sessions --project "$PID" | $JQ "import json,sys;print([s['state'] for s in json.load(sys.stdin) if s['id']=='$SID'][0])")
say "state after send: $STATE"

WT=$($SAURON worktrees --project "$PID" | $JQ "import json,sys;print([w['path'] for w in json.load(sys.stdin) if w['isSauron']][0])")
say "worktree $WT"

$SAURON stop --session "$SID" >/dev/null
sleep 1
tmux has-session -t "=$TMUX:" 2>/dev/null && fail "tmux session still alive after stop"
say "stopped"

$SAURON worktrees remove --project "$PID" --path "$WT" --force >/dev/null
$SAURON raw "{\"cmd\":\"projects.remove\",\"project\":\"$PID\"}" >/dev/null
say "cleaned up"
printf '\033[1;32mSMOKE OK\033[0m\n'

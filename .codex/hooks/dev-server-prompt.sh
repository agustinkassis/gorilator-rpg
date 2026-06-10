#!/usr/bin/env bash
# SessionStart hook: front-load the two facts every session otherwise looks up —
# the PR/merge target branch (codex-workflow.json) and this worktree's
# deterministic dev ports (.claude/launch.json) — and nudge the agent to offer
# starting a dev server when none is running.
listening() { lsof -i ":$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }

root="$(cd "$(dirname "$0")/../.." && pwd)"
launch="$root/.claude/launch.json"

target=""
[ -f "$root/codex-workflow.json" ] &&
  target=$(sed -n 's/.*"targetBranch"[^"]*"\([^"]*\)".*/\1/p' "$root/codex-workflow.json" | head -1)
[ -z "$target" ] && target="main"

landing="" client="" server=""
if [ -f "$launch" ]; then
  landing=$(sed -n 's/.*--port \([0-9]*\).*/\1/p' "$launch" | head -1)
  client=$(sed -n 's/.*CLIENT_PORT=\([0-9]*\).*/\1/p' "$launch" | head -1)
  server=$(sed -n 's/.*GAME_SERVER_PORT=\([0-9]*\).*/\1/p' "$launch" | head -1)
fi
ports="landing :${landing:-?}, game client :${client:-5173}, game server :${server:-2567}"

ctx="Target branch (codex-workflow.json): ${target}. Worktree dev ports (.claude/launch.json; regen with pnpm wt:launch): ${ports}."

up=0
for port in 5173 2567 $landing $client $server; do
  [ -n "$port" ] && listening "$port" && up=1 && break
done

if [ "$up" = "1" ]; then
  printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s A dev server is already listening."}}\n' "$ctx"
else
  printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s No dev server is running for this worktree. Before starting work, ask the user (via the question UI) whether to start the GAME (run pnpm dev = Babylon client + Colyseus server) or the LANDING site (run pnpm landing), then launch the chosen one in the background. If the request clearly does not need a running app, you may skip this."}}\n' "$ctx"
fi

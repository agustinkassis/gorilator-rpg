#!/usr/bin/env bash
# SessionStart hook: when no dev server is running for this project, nudge the agent
# to offer to start one - the GAME (`pnpm dev` = client + Colyseus server) or the
# LANDING site (`pnpm landing`). Stays silent if a server is already up, so it
# never nags on resume.
listening() { lsof -i ":$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }

# Common dev ports: 5173 (game client / landing default), 5860 + 5861 (launch.json
# landing/game), 2567 (Colyseus game server).
for port in 5173 5860 5861 2567; do
  listening "$port" && exit 0 # already running -> say nothing
done

cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "No dev server is running for this worktree. Before starting work, ask the user (via the question UI) whether to start the GAME (run `pnpm dev` = Babylon client on port 5173 + Colyseus server) or the LANDING site (run `pnpm landing`), then launch the chosen one in the background. If the user's request clearly does not need a running app, you may skip this."}}
JSON

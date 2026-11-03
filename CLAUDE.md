# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start           # Run server (node src/server.js)
npm run prepare     # Set up Husky git hooks
npm test            # Integration tests (Linux/macOS; see AGENTS.md)
npm run lint        # Biome
```

Docker is the primary deployment method.

## Architecture

Containerized service that accepts task prompts via HTTP, uses Claude to identify the target repo, clones it, and spawns a worker Claude to implement the task autonomously.

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Orchestrator Claude                        │ │
│  │  - Has GITHUB_TOKEN                                     │ │
│  │  - Lists/searches repos via gh CLI                      │ │
│  │  - Clones target repo                                   │ │
│  │  - Spawns Worker Claude inside repo                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                          │                                   │
│                          ▼                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Worker Claude                              │ │
│  │  - Runs inside cloned repo                              │ │
│  │  - Picks up repo's .claude/, .mcp.json, skills          │ │
│  │  - Opens draft PR immediately                           │ │
│  │  - Commits and pushes after every change                │ │
│  │  - Uses subagents to preserve context                   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Key Files:**
- `src/server.js` - Express server, task orchestration, system prompts for orchestrator and worker
- `src/dashboard.html` - Vanilla JS monitoring UI with 5s auto-refresh

**Task actions:** each task in the dashboard has a `…` menu to archive or delete it. `PATCH /task/:id` with `{ "archived": true|false }` flags a task (archived tasks are hidden behind "Show archived" and left out of the counts); `DELETE /task/:id` removes it, stops its `claude` process if it is still running and deletes its log and work dir (clone). Branches and PRs are left alone.

**Task history:** `src/task-store.js` keeps the task list in `$DATA_DIR/tasks.json` (rewritten on every change) and logs go to `$DATA_DIR/logs/<id>.log`, so history, archive flags and logs survive restarts and redeploys. Clones stay in `WORK_DIR` (`/tmp/work`, not a volume) and are lost on redeploy. A task still `running` when the server stops can't resume (its `claude` process died), so on startup it is marked `failed` with errorType `interrupted`.

**Worker Constraints (defined in `getWorkerSystemPrompt`):**
- Never use `AskUserQuestion` (hangs forever)
- Aggressive subagent spawning for context management
- Commit and push after EVERY logical change - no batching
- On failure: commit current state, update PR with blockers, exit cleanly

**Error Detection:**
| errorType        | Meaning                               |
|------------------|---------------------------------------|
| auth_expired     | OAuth token expired, re-login on host |
| capacity_reached | Claude rate limited / at capacity     |
| timeout          | Task exceeded 1 hour                  |
| exit_code        | Process exited non-zero (check logs)  |
| interrupted      | Runner restarted mid-task (redeploy)  |

**Environment:**
- `GITHUB_TOKEN` - Needed for GitHub tasks (auto-detect when Gitea is not configured), repo/read:org/workflow scopes
- `GITEA_URL` / `GITEA_TOKEN` - Optional; enables `GET /api/repos` and the dashboard repo picker. `POST /task` accepts `repo: "owner/name"` to target a Gitea repo directly (orchestrator clones it, worker opens PR via Gitea API). Without `repo`, auto-detect searches Gitea, and the server resolves the cloned repo from its origin URL (`resolveGiteaRepoFromClone`) before starting the worker. Git credentials for `GITEA_URL` are configured at startup via a credential helper reading `$GITEA_TOKEN`
- `PORT` - Optional, defaults to 3000
- `SESSION_SECRET` - Optional. Dashboard logins persist across restarts/redeploys: `src/session-store.js` keeps sessions in `$DATA_DIR/sessions.json` and, when `SESSION_SECRET` is unset, a generated secret in `$DATA_DIR/session-secret` (`DATA_DIR` defaults to `/data`, a volume)
- Claude OAuth credentials mounted read-only at `/home/node/.claude/.credentials.json` (debug logs stay in container)

## Workflow, commits, tests and CI

@AGENTS.md

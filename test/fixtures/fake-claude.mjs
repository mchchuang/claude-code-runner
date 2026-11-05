// Stand-in for the `claude` CLI in tests. The server runs it through node-pty for the auto-detect orchestrator
// (prompt only) and the worker (with --append-system-prompt). It prints stream-json lines like the real CLI; the
// init event also echoes the arguments so tests can check them. Prompts containing FAIL_ORCHESTRATOR or FAIL_WORKER
// make that phase exit non-zero, OVER_BUDGET makes the worker stop like --max-budget-usd does, and
// HANG_ORCHESTRATOR / HANG_WORKER keep that phase running until it is killed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1] ?? '';
const prompt = arg('-p');
const systemPrompt = args.includes('--append-system-prompt') ? arg('--append-system-prompt') : null;
const emit = obj => console.log(JSON.stringify(obj));
const hang = () => setInterval(() => {}, 1000); // runs until the server kills it

emit({
  type: 'system', subtype: 'init', session_id: args.includes('--resume') ? arg('--resume') : randomUUID(),
  model: args.includes('--model') ? arg('--model') : 'fake-claude', tools: [], mcp_servers: [], argv: args
});

if (systemPrompt === null) {
  // Orchestrator: "clone" the repo by creating it with the right origin, like `git clone` would
  if (prompt.includes('FAIL_ORCHESTRATOR')) process.exit(1);
  if (prompt.includes('HANG_ORCHESTRATOR')) {
    hang();
  } else {
    const repoDir = path.join(process.cwd(), 'repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', repoDir]);
    execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', process.env.FAKE_AUTO_CLONE_URL]);
    emit({ type: 'result', subtype: 'success', result: 'Environment ready', duration_ms: 10, total_cost_usd: 0.01 });
  }
} else if (prompt.includes('HANG_WORKER')) {
  hang();
} else {
  // Worker: opens a "PR" and prints both the API URL and the web URL, like the real curl | jq step
  if (prompt.includes('FAIL_WORKER')) process.exit(2);
  if (prompt.includes('OVER_BUDGET')) {
    emit({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, duration_ms: 20, total_cost_usd: 2.5 });
    process.exit(1);
  }
  const fullName = systemPrompt.match(/\(repo (\S+), base branch/)?.[1] ?? 'unknown/unknown';
  const gitea = process.env.GITEA_URL.replace(/\/+$/, '');
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -X POST ${gitea}/api/v1/repos/${fullName}/pulls/7` } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${gitea}/${fullName}/pulls/7` }] } });
  emit({ type: 'result', subtype: 'success', result: `Opened ${gitea}/${fullName}/pulls/7`, duration_ms: 20, total_cost_usd: 0.02 });
}

// Stand-in for the `claude` CLI in tests. The server runs it twice per task through node-pty:
// the orchestrator (prompt only) and the worker (with --system-prompt). It prints stream-json lines like the
// real CLI. Prompts containing FAIL_ORCHESTRATOR or FAIL_WORKER make that phase exit non-zero; HANG_ORCHESTRATOR
// keeps the orchestrator running until it is killed.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1] ?? '';
const prompt = arg('-p');
const systemPrompt = args.includes('--system-prompt') ? arg('--system-prompt') : null;
const emit = obj => console.log(JSON.stringify(obj));

emit({ type: 'system', subtype: 'init', model: args.includes('--model') ? arg('--model') : 'fake-claude', tools: [], mcp_servers: [] });

if (systemPrompt === null) {
  // Orchestrator: "clone" the repo by creating it with the right origin, like `git clone` would
  if (prompt.includes('FAIL_ORCHESTRATOR')) process.exit(1);
  if (prompt.includes('HANG_ORCHESTRATOR')) {
    setInterval(() => {}, 1000); // runs until the server kills it
  } else {
    const cloneUrl = prompt.match(/^Clone URL: (\S+)$/m)?.[1] || process.env.FAKE_AUTO_CLONE_URL;
    const repoDir = path.join(process.cwd(), 'repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', repoDir]);
    execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', cloneUrl]);
    emit({ type: 'result', subtype: 'success', result: 'Environment ready', duration_ms: 10, total_cost_usd: 0.01 });
  }
} else {
  // Worker: opens a "PR" and prints both the API URL and the web URL, like the real curl | jq step
  if (prompt.includes('FAIL_WORKER')) process.exit(2);
  const fullName = systemPrompt.match(/\(repo (\S+), base branch/)?.[1] ?? 'unknown/unknown';
  const gitea = process.env.GITEA_URL.replace(/\/+$/, '');
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -X POST ${gitea}/api/v1/repos/${fullName}/pulls/7` } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${gitea}/${fullName}/pulls/7` }] } });
  emit({ type: 'result', subtype: 'success', result: `Opened ${gitea}/${fullName}/pulls/7`, duration_ms: 20, total_cost_usd: 0.02 });
}

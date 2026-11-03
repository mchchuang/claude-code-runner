// Dashboard tests: load the real src/dashboard.html into jsdom, run its inline script against a mocked fetch,
// and check both the pure helpers (escaping, time formatting, stream-json log parsing, timeline rendering) and
// the page <-> API flows (task list, task detail, composer, repo picker, API token dialog).
// Layout and styling (light/dark, narrow widths) are not covered here; those still need a look in a browser.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Strip external stylesheet/font links: jsdom doesn't fetch them, but keep the page offline regardless
const HTML = readFileSync(path.join(root, 'src', 'dashboard.html'), 'utf-8').replace(/<link [^>]*>/g, '');

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

const task = (over = {}) => ({
  id: 'abc12345', status: 'completed', prompt: 'Fix the thing', repo: 'martin/app', repo_url: 'https://git.test/martin/app',
  pr_url: null, started: new Date(Date.now() - 90_000).toISOString(), finished: new Date().toISOString(), ...over
});

/**
 * Boot the dashboard. `routes` maps "METHOD /path" (or "/path" for GET) to a handler returning
 * { status, body } or a plain body; unmatched requests get 404. Returns helpers to inspect the page.
 */
async function boot({ routes = {}, hash = '', storage = {}, confirm = true } = {}) {
  const calls = [];
  const navigations = [];
  const errors = [];
  const alerts = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => {
    if (/navigation/.test(e.message)) navigations.push(e.message);
    else errors.push(e);
  });
  virtualConsole.on('error', (...a) => errors.push(a));

  const defaults = {
    'GET /api/me': { username: 'martin' },
    'GET /api/repos': { enabled: false },
    'GET /tasks': [],
    'GET /token': { exists: false }
  };
  const table = { ...defaults };
  for (const [k, v] of Object.entries(routes)) table[k.includes(' ') ? k : `GET ${k}`] = v;

  const dom = new JSDOM(HTML, {
    url: `http://runner.test/${hash}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      window.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.confirm = msg => (typeof confirm === 'function' ? confirm(msg) : confirm);
      window.alert = msg => alerts.push(msg);
      // The page polls every 2s/5s; tests drive fetches explicitly instead
      window.setInterval = () => 0;
      window.clearInterval = () => {};
      window.fetch = async (url, opts = {}) => {
        const u = new URL(url, 'http://runner.test');
        const method = opts.method || 'GET';
        calls.push({ method, path: u.pathname + u.search, headers: opts.headers || {}, body: opts.body });
        let handler = table[`${method} ${u.pathname + u.search}`] ?? table[`${method} ${u.pathname}`];
        if (typeof handler === 'function') handler = await handler({ method, path: u.pathname, body: opts.body });
        if (handler === undefined) handler = { status: 404, body: { error: 'not found' } };
        const res = handler && typeof handler === 'object' && 'status' in handler && !Array.isArray(handler)
          ? handler : { status: 200, body: handler };
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          text: async () => text,
          json: async () => JSON.parse(text)
        };
      };
    }
  });
  await settle();
  const { window } = dom;
  const doc = window.document;
  return {
    window, doc, calls, navigations, errors, alerts, table,
    $: id => doc.getElementById(id),
    run: code => window.eval(code),
    text: id => doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    close: () => window.close()
  };
}

// ---------- Pure helpers ----------

describe('helpers', async () => {
  const page = await boot();
  const { run } = page;

  test('esc escapes HTML-significant characters and tolerates null/undefined/numbers', () => {
    assert.equal(run(`esc('<a href="x">&</a>')`), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.equal(run('esc(null)'), '');
    assert.equal(run('esc(undefined)'), '');
    assert.equal(run('esc(0)'), '0');
  });

  test('safeUrl only passes http(s) URLs', () => {
    assert.equal(run(`safeUrl('https://x.test/a')`), 'https://x.test/a');
    assert.equal(run(`safeUrl('http://x.test')`), 'http://x.test');
    assert.equal(run(`safeUrl('javascript:alert(1)')`), null);
    assert.equal(run(`safeUrl(' https://x.test')`), null);
    assert.equal(run(`safeUrl('')`), null);
    assert.equal(run('safeUrl(null)'), null);
  });

  test('md renders emphasis, inline code and line breaks, and leaves plain text alone', () => {
    const md = s => run(`md(${JSON.stringify(s)})`);
    assert.equal(md('**Repo:** martin/app\n**Branch:** `feat/x`'),
      '<p><strong>Repo:</strong> martin/app<br><strong>Branch:</strong> <code>feat/x</code></p>');
    assert.equal(md('*a* _b_ __c__ ~~d~~'), '<p><em>a</em> <em>b</em> <strong>c</strong> <del>d</del></p>');
    // Not emphasis: snake_case, spaced asterisks, unclosed markers, markers inside code
    assert.equal(md('foo_bar_baz 2 * 3 * 4 **open'), '<p>foo_bar_baz 2 * 3 * 4 **open</p>');
    assert.equal(md('`**x**` and `a_b_c`'), '<p><code>**x**</code> and <code>a_b_c</code></p>');
    assert.equal(md('one\n\ntwo'), '<p>one</p><p>two</p>');
    assert.equal(md(''), '');
    assert.equal(md(null), '');
    assert.equal(md('  \n\n '), '');
    assert.equal(md('a\r\nb'), '<p>a<br>b</p>');
  });

  test('md escapes HTML everywhere and only links http(s) URLs', () => {
    const md = s => run(`md(${JSON.stringify(s)})`);
    assert.equal(md('<img src=x onerror=alert(1)> **<b>**'), '<p>&lt;img src=x onerror=alert(1)&gt; <strong>&lt;b&gt;</strong></p>');
    assert.equal(md('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
    assert.equal(md('[PR #4](https://git.test/pr/4?a=1&b=2)'),
      '<p><a href="https://git.test/pr/4?a=1&amp;b=2" target="_blank" rel="noopener">PR #4</a></p>');
    // Bare URLs link, without trailing punctuation or surrounding quotes
    assert.equal(md('See https://git.test/pr/1. Or "https://q.test/x_y"!'),
      '<p>See <a href="https://git.test/pr/1" target="_blank" rel="noopener">https://git.test/pr/1</a>. '
      + 'Or &quot;<a href="https://q.test/x_y" target="_blank" rel="noopener">https://q.test/x_y</a>&quot;!</p>');
    assert.equal(md('**https://git.test/a**'),
      '<p><strong><a href="https://git.test/a" target="_blank" rel="noopener">https://git.test/a</a></strong></p>');
    assert.equal(md('```\n<script>x</script>\n```'), '<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre>');
    assert.equal(md('a \u0000 0\u0000 b'), '<p>a  0 b</p>');
  });

  test('md renders headings, rules, quotes and fenced code', () => {
    const md = s => run(`md(${JSON.stringify(s)})`);
    assert.equal(md('# One\n## Two ##\n#### Four\n###### Six'), '<h3>One</h3><h4>Two</h4><h6>Four</h6><h6>Six</h6>');
    assert.equal(md('#5 is not a heading'), '<p>#5 is not a heading</p>');
    assert.equal(md('a\n---\nb\n***'), '<p>a</p><hr><p>b</p><hr>');
    assert.equal(md('> quoted\n> **more**\n\nafter'), '<blockquote><p>quoted<br><strong>more</strong></p></blockquote><p>after</p>');
    assert.equal(md('```js\nconst a = 1;\n\n  b();\n```\ntext'),
      '<pre><code class="lang-js">const a = 1;\n\n  b();</code></pre><p>text</p>');
    // An unclosed fence runs to the end
    assert.equal(md('~~~\nopen'), '<pre><code>open</code></pre>');
  });

  test('md renders bulleted, numbered, nested and task lists', () => {
    const md = s => run(`md(${JSON.stringify(s)})`);
    assert.equal(md('- **Repo:** a\n* b\n+ c'), '<ul><li><strong>Repo:</strong> a</li><li>b</li><li>c</li></ul>');
    assert.equal(md('Intro:\n1. one\n2. two\n   - nested\n   - more\n3. three\n\nAfter'),
      '<p>Intro:</p><ol><li>one</li><li>two<ul><li>nested</li><li>more</li></ul></li><li>three</li></ol><p>After</p>');
    assert.equal(md('3) c\n4) d'), '<ol start="3"><li>c</li><li>d</li></ol>');
    assert.equal(md('- wraps\n  onto two\n- [ ] todo\n- [x] done'),
      '<ul><li>wraps<br>onto two</li><li><input type="checkbox" disabled> todo</li>'
      + '<li><input type="checkbox" disabled checked> done</li></ul>');
    // Loose items stay in one list; a different marker type starts a new list
    assert.equal(md('- a\n\n- b\n1. c'), '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
    assert.equal(md('- item\n\n  ```\n  code\n  ```'), '<ul><li>item<pre><code>code</code></pre></li></ul>');
  });

  test('md renders tables with alignment and missing cells', () => {
    const md = s => run(`md(${JSON.stringify(s)})`);
    assert.equal(md('| File | Lines |\n|:---|---:|\n| `a.js` | 3 |\n| b \\| c |\n\nafter'),
      '<div class="table-wrap"><table><thead><tr><th>File</th><th style="text-align:right">Lines</th></tr></thead>'
      + '<tbody><tr><td><code>a.js</code></td><td style="text-align:right">3</td></tr>'
      + '<tr><td>b | c</td><td style="text-align:right"></td></tr></tbody></table></div><p>after</p>');
    // A pipe without a separator row is just text
    assert.equal(md('a | b'), '<p>a | b</p>');
    assert.equal(md('| a | b |\n|:-:|---|\n| x |'),
      '<div class="table-wrap"><table><thead><tr><th style="text-align:center">a</th><th>b</th></tr></thead>'
      + '<tbody><tr><td style="text-align:center">x</td><td></td></tr></tbody></table></div>');
  });

  test('ago buckets at minute, hour and day boundaries; future times are "just now"', () => {
    const at = s => run(`ago(new Date(Date.now() - ${s * 1000}).toISOString())`);
    assert.equal(at(0), 'just now');
    assert.equal(at(59), 'just now');
    assert.equal(at(60), '1m ago');
    assert.equal(at(3599), '59m ago');
    assert.equal(at(3600), '1h ago');
    assert.equal(at(86399), '23h ago');
    assert.equal(at(86400), '1d ago');
    assert.equal(at(-500), 'just now');
  });

  test('span formats seconds, minutes and hours', () => {
    assert.equal(run('span(0)'), '0s');
    assert.equal(run('span(59400)'), '59s');
    assert.equal(run('span(60000)'), '1m 0s');
    assert.equal(run('span(3599000)'), '59m 59s');
    assert.equal(run('span(3600000)'), '1h 0m');
    assert.equal(run('span(3661000)'), '1h 1m');
  });

  test('toolSummary picks what was searched, edited or run', () => {
    const ts = input => JSON.parse(run(`JSON.stringify(toolSummary(${JSON.stringify({ input })}))`));
    assert.deepEqual(ts({ pattern: 'TODO', path: 'src' }), { what: 'TODO', cmd: 'src' });
    assert.deepEqual(ts({ pattern: '*.js', glob: '**' }), { what: '*.js', cmd: '**' });
    assert.deepEqual(ts({ file_path: '/w/repo/src/server.js' }), { what: 'src/server.js', cmd: '' });
    assert.deepEqual(ts({ description: 'Run tests', command: 'npm test' }), { what: 'Run tests', cmd: 'npm test' });
    assert.deepEqual(ts({ description: 'Edit', file_path: '/a/b/c' }), { what: 'Edit', cmd: '/a/b/c' });
    assert.deepEqual(ts({ url: 'https://x.test' }), { what: 'https://x.test', cmd: '' });
    assert.deepEqual(ts({ subagent_type: 'Explore' }), { what: 'Explore', cmd: '' });
    assert.deepEqual(ts({}), { what: '', cmd: '' });
    assert.deepEqual(JSON.parse(run('JSON.stringify(toolSummary({}))')), { what: '', cmd: '' });
  });

  test('resultText flattens content blocks', () => {
    assert.equal(run(`resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'other' }])`), 'a\n[image]\n');
    assert.equal(run(`resultText('plain')`), 'plain');
    assert.equal(run('resultText(null)'), '');
    assert.equal(run('resultText([])'), '');
  });

  page.close();
});

// ---------- Log parsing and timeline ----------

const j = o => JSON.stringify(o);
const LOG = [
  'Task ID: abc12345',
  'Prompt: should be ignored, it is above the first phase',
  '',
  '=== ORCHESTRATOR PHASE ===',
  j({ type: 'system', subtype: 'init', model: 'claude-test' }),
  j({ type: 'assistant', message: { content: [{ type: 'text', text: '  Looking for the repo  ' }, { type: 'text', text: '   ' }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Clone', command: 'git clone x' } }] } }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Cloning…' }] } }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'stray' }] } }),
  'plain text line',
  '{not json',
  j({ type: 'result', subtype: 'success', result: 'Cloned', duration_ms: 65000, total_cost_usd: 0.123 }),
  '=== ORCHESTRATOR COMPLETE ===',
  '=== NOSUCH COMPLETE ===',
  '=== WORKER PHASE ===',
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/a/b/c.js' } }] } }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'ENOENT' }] }] } }),
  j({ type: 'assistant', message: {} }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: '<script>' } }] } })
].join('\n');

describe('parseLog', async () => {
  const page = await boot();
  const phases = JSON.parse(page.run(`JSON.stringify(parseLog(${j(LOG)}))`));
  page.close();

  test('splits phases, marks completed ones and ignores the header and unknown COMPLETE markers', () => {
    assert.deepEqual(phases.map(p => [p.key, p.done]), [['ORCHESTRATOR', true], ['WORKER', false]]);
  });

  test('collects model, trimmed assistant text, tools with results, notes and the result', () => {
    const [o] = phases;
    assert.equal(o.model, 'claude-test');
    assert.deepEqual(o.items.map(i => i.kind), ['say', 'tool', 'note', 'note']);
    assert.equal(o.items[0].text, 'Looking for the repo');
    assert.deepEqual(o.items[1], { kind: 'tool', id: 't1', name: 'Bash', what: 'Clone', cmd: 'git clone x', out: 'Cloning…', bad: false });
    assert.equal(o.items[2].text, 'plain text line');
    assert.equal(o.items[3].text, '{not json');
    assert.deepEqual(o.result, { bad: false, text: 'Cloned', ms: 65000, cost: 0.123 });
  });

  test('flags failed tool results and leaves pending tools without output', () => {
    const [, w] = phases;
    assert.equal(w.items[0].bad, true);
    assert.equal(w.items[0].out, 'ENOENT');
    assert.equal(w.items[0].what, 'b/c.js');
    assert.equal(w.items[1].out, null);
    assert.equal(w.result, undefined);
  });

  test('treats error subtypes and is_error results as failures', async () => {
    const p = await boot();
    const bad = log => p.run(`parseLog(${j(log)})[0].result.bad`);
    assert.equal(bad(`=== WORKER PHASE ===\n${j({ type: 'result', subtype: 'error_max_turns' })}`), true);
    assert.equal(bad(`=== WORKER PHASE ===\n${j({ type: 'result', subtype: 'success', is_error: true })}`), true);
    assert.equal(bad(`=== WORKER PHASE ===\n${j({ type: 'result' })}`), false);
    assert.equal(p.run(`parseLog('').length`), 0);
    assert.equal(p.run(`parseLog('only a header\\n{"type":"assistant"}').length`), 0);
    p.close();
  });
});

describe('renderTimeline', async () => {
  const page = await boot();
  const render = (log, t) => {
    const div = page.doc.createElement('div');
    div.innerHTML = page.run(`renderTimeline(parseLog(${j(log)}), ${j(t ?? null)})`);
    return div;
  };

  test('shows a waiting note before any phase starts', () => {
    assert.match(render('', { status: 'running' }).textContent, /Waiting for Claude to start/);
  });

  test('labels finished, in-progress and failed phases', () => {
    const running = render(LOG, { status: 'running' });
    const states = [...running.querySelectorAll('.phase')].map(s => s.querySelector('.state')?.textContent ?? '');
    assert.deepEqual(states, ['Finished', 'In progress']);
    assert.deepEqual([...running.querySelectorAll('.phase h2')].map(h => h.textContent), ['Set up', 'Work']);
    // Only the last step of the live phase pulses
    const live = running.querySelectorAll('.step.live');
    assert.equal(live.length, 1);
    assert.match(live[0].textContent, /Grep/);

    const failed = render(LOG, { status: 'failed' });
    assert.deepEqual([...failed.querySelectorAll('.state')].map(s => s.textContent), ['Finished', 'Failed']);
    assert.equal(failed.querySelectorAll('.step.live').length, 0);

    // A completed task whose last phase never logged COMPLETE gets no state rather than "Failed"
    assert.deepEqual([...render(LOG, { status: 'completed' }).querySelectorAll('.state')].map(s => s.textContent), ['Finished']);
  });

  test('a failed result marks its phase failed even when the task is still running', () => {
    const log = `=== WORKER PHASE ===\n${j({ type: 'result', subtype: 'error_during_execution', result: 'boom' })}`;
    const div = render(log, { status: 'running' });
    assert.equal(div.querySelector('.state').textContent, 'Failed');
    assert.ok(div.querySelector('.outcome.bad'));
  });

  test('renders outcome text, duration, cost and model', () => {
    const meta = render(LOG, { status: 'completed' }).querySelector('.outcome-meta').textContent.replace(/\s+/g, ' ').trim();
    assert.equal(meta, 'Took 1m 5s Cost $0.12 claude-test');
    const zero = render(`=== WORKER PHASE ===\n${j({ type: 'result', total_cost_usd: 0 })}`, { status: 'completed' });
    assert.match(zero.querySelector('.outcome-meta').textContent, /Cost \$0\.00/);
    assert.doesNotMatch(zero.querySelector('.outcome-meta').textContent, /Took/);
  });

  test("Claude's messages and the result render as Markdown", () => {
    const log = [
      '=== WORKER PHASE ===',
      j({ type: 'assistant', message: { content: [{ type: 'text', text: '- **Repo:** martin/app\n- <i>x</i>' }] } }),
      j({ type: 'result', result: '## Done\nOpened https://git.test/pr/1' })
    ].join('\n');
    const div = render(log, { status: 'completed' });
    const say = div.querySelector('.say-text');
    assert.equal(say.querySelector('li strong').textContent, 'Repo:');
    assert.equal(say.querySelector('i'), null);
    assert.match(say.textContent, /<i>x<\/i>/);
    assert.doesNotMatch(say.textContent, /\*\*/);
    const out = div.querySelector('.outcome-text');
    assert.equal(out.querySelector('h4').textContent, 'Done');
    assert.equal(out.querySelector('a').getAttribute('href'), 'https://git.test/pr/1');
  });

  test('tool output is escaped, expandable only when present, and truncated at 20000 chars', () => {
    const big = 'x'.repeat(20_001);
    const log = [
      '=== WORKER PHASE ===',
      j({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: '<b>cmd</b>' } },
        { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'quiet' } },
        { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'big' } }
      ] } }),
      j({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'a', content: '<img src=x onerror=alert(1)>' },
        { type: 'tool_result', tool_use_id: 'b', content: '   ' },
        { type: 'tool_result', tool_use_id: 'c', content: big }
      ] } })
    ].join('\n');
    const div = render(log, { status: 'completed' });
    const [a, b, c] = div.querySelectorAll('details.tool');
    assert.equal(div.querySelector('img'), null);
    assert.equal(div.querySelector('b'), null);
    assert.equal(a.querySelector('pre').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(a.querySelector('.tool-cmd').textContent, '<b>cmd</b>');
    assert.equal(b.querySelector('pre'), null);
    assert.equal(b.querySelector('summary').getAttribute('tabindex'), '-1');
    assert.equal(c.querySelector('pre').textContent, `${'x'.repeat(20_000)}\n…`);
  });

  test('unknown phases fall back to the lowercased key', () => {
    assert.equal(render('=== REVIEW PHASE ===', { status: 'running' }).querySelector('h2').textContent, 'review');
  });

  page.close();
});

// ---------- Page <-> API ----------

describe('task list', () => {
  test('shows an empty state and the signed-in user', async () => {
    const p = await boot();
    assert.match(p.text('tasks'), /No tasks yet/);
    assert.equal(p.text('username'), 'martin');
    assert.equal(p.text('counts'), '0 done');
    assert.deepEqual(p.errors, []);
    p.close();
  });

  test('counts statuses and renders each task with escaped content', async () => {
    const tasks = [
      task({ id: 'r1', status: 'running', finished: null, prompt: '<img src=x onerror=alert(1)>\nsecond line' }),
      task({ id: 'q1', status: 'queued', repo: null, finished: null }),
      task({ id: 'c1', pr_url: 'https://git.test/pr/1' }),
      task({ id: 'f1', status: 'failed' }),
      task({ id: 'f2', status: 'failed' })
    ];
    const p = await boot({ routes: { '/tasks': tasks } });
    assert.deepEqual([...p.doc.querySelectorAll('#counts span')].map(s => s.textContent), ['2 running', '1 done', '2 failed']);
    const items = p.doc.querySelectorAll('#tasks .task');
    assert.equal(items.length, 5);
    assert.equal(p.doc.querySelector('#tasks img'), null);
    assert.equal(items[0].querySelector('.task-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(items[1].querySelector('.repo').textContent, 'Repo not picked yet');
    assert.match(items[2].textContent, /PR open/);
    assert.doesNotMatch(items[3].textContent, /PR open/);
    assert.equal(items[0].querySelector('.dot').title, 'Running');
    p.close();
  });

  test('hides the failed count when nothing failed', async () => {
    const p = await boot({ routes: { '/tasks': [task()] } });
    assert.equal(p.doc.querySelectorAll('#counts span').length, 1);
    assert.equal(p.text('counts'), '1 done');
    p.close();
  });

  test('a 401 sends the browser to /login', async () => {
    const p = await boot({ routes: { '/tasks': { status: 401, body: {} } } });
    assert.ok(p.navigations.length >= 1);
    p.close();
  });

  test('sends the stored API token as a bearer token', async () => {
    const p = await boot({ storage: { api_token: 'tok-123' } });
    assert.equal(p.$('api-token').value, 'tok-123');
    assert.ok(p.calls.length > 0);
    for (const c of p.calls) assert.equal(c.headers.Authorization, 'Bearer tok-123');
    const q = await boot();
    for (const c of q.calls) assert.equal(c.headers.Authorization, undefined);
    p.close();
    q.close();
  });
});

describe('task actions menu', () => {
  const menu = p => p.$('task-menu');
  const items = p => [...menu(p).querySelectorAll('button')].map(b => b.textContent.trim());
  const more = (p, id) => p.doc.querySelector(`#tasks .more[data-id="${id}"]`);

  test('every task row has a ... button that opens a menu with Archive and Delete', async () => {
    const p = await boot({ routes: { '/tasks': [task({ id: 'a1' }), task({ id: 'a2', archived: true })] } });
    p.run('toggleArchived()');
    assert.equal(p.doc.querySelectorAll('#tasks .task-row .more').length, 2);
    assert.ok(menu(p).hidden);
    more(p, 'a1').click();
    assert.ok(!menu(p).hidden);
    assert.equal(more(p, 'a1').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(items(p), ['Archive', 'Delete…']);
    assert.equal(p.doc.activeElement, menu(p).querySelector('button'), 'focus moves into the menu');
    more(p, 'a2').click();
    assert.deepEqual(items(p), ['Unarchive', 'Delete…'], 'archived tasks offer Unarchive');
    assert.equal(more(p, 'a1').getAttribute('aria-expanded'), 'false');
    assert.equal(p.calls.filter(c => c.method !== 'GET').length, 0, 'opening the menu calls nothing');
    assert.equal(p.$('detail-head'), null, 'the ... button does not open the task');
    p.close();
  });

  test('the menu closes on a second click, an outside click and Escape (without closing the open task)', async () => {
    const p = await boot({ hash: '#a1', routes: { '/tasks': [task({ id: 'a1' })], '/task/a1/logs': '' } });
    more(p, 'a1').click();
    more(p, 'a1').click();
    assert.ok(menu(p).hidden, 'toggled closed');
    more(p, 'a1').click();
    p.doc.body.click();
    assert.ok(menu(p).hidden, 'outside click');
    more(p, 'a1').click();
    p.doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.ok(menu(p).hidden, 'Escape');
    assert.ok(p.$('detail-head'), 'the first Escape only closes the menu');
    assert.equal(p.doc.activeElement, more(p, 'a1'), 'focus returns to the ... button');
    p.close();
  });

  test('the menu stays open across the 5s list refresh', async () => {
    const p = await boot({ routes: { '/tasks': [task({ id: 'a1' })] } });
    more(p, 'a1').click();
    await p.run('fetchTasks()');
    assert.ok(!menu(p).hidden);
    assert.equal(more(p, 'a1').getAttribute('aria-expanded'), 'true');
    p.close();
  });

  test('archiving hides the task behind "Show archived", out of the counts; unarchiving brings it back', async () => {
    const tasks = [task({ id: 'a1' }), task({ id: 'a2' })];
    const p = await boot({
      routes: {
        '/tasks': () => tasks,
        'PATCH /task/a1': ({ body }) => { Object.assign(tasks[0], JSON.parse(body)); return { status: 200, body: tasks[0] }; }
      }
    });
    more(p, 'a1').click();
    menu(p).querySelector('[data-action="archive"]').click();
    await settle();
    const patch = p.calls.find(c => c.method === 'PATCH');
    assert.equal(patch.path, '/task/a1');
    assert.deepEqual(JSON.parse(patch.body), { archived: true });
    assert.ok(menu(p).hidden);
    assert.equal(p.doc.querySelectorAll('#tasks .task-row').length, 1);
    assert.equal(p.text('counts'), '1 done');
    assert.equal(p.$('toggle-archived').textContent, 'Show archived (1)');

    p.$('toggle-archived').click();
    const rows = p.doc.querySelectorAll('#tasks .task-row');
    assert.equal(rows.length, 2);
    assert.ok(rows[0].classList.contains('archived'));
    assert.match(rows[0].textContent, /Archived/);
    assert.equal(p.$('toggle-archived').textContent, 'Hide archived');

    more(p, 'a1').click();
    menu(p).querySelector('[data-action="archive"]').click();
    await settle();
    assert.deepEqual(JSON.parse(p.calls.filter(c => c.method === 'PATCH')[1].body), { archived: false });
    assert.equal(p.$('toggle-archived'), null, 'no toggle once nothing is archived');
    assert.equal(p.text('counts'), '2 done');
    assert.deepEqual(p.alerts, []);
    p.close();
  });

  test('when every task is archived the list says so instead of the first-run empty state', async () => {
    const p = await boot({ routes: { '/tasks': [task({ archived: true })] } });
    assert.match(p.text('tasks'), /No active tasks\.\s*Show archived \(1\)/);
    p.close();
  });

  test('the open task shows it is archived, and its header has the same menu', async () => {
    const p = await boot({ hash: '#a1', routes: { '/tasks': [task({ id: 'a1', archived: true })], '/task/a1/logs': '' } });
    const head = p.$('detail-head');
    assert.match(head.querySelector('.head-row').textContent, /Archived/);
    head.querySelector('.more').click();
    assert.deepEqual(items(p), ['Unarchive', 'Delete…']);
    p.close();
  });

  test('a failed archive is reported and changes nothing', async () => {
    const p = await boot({ routes: { '/tasks': [task({ id: 'a1' })], 'PATCH /task/a1': { status: 500, body: { error: 'disk <full>' } } } });
    more(p, 'a1').click();
    menu(p).querySelector('[data-action="archive"]').click();
    await settle();
    assert.deepEqual(p.alerts, ["Couldn't archive the task: disk <full>"]);
    assert.equal(p.doc.querySelectorAll('#tasks .task-row').length, 1);
    p.close();
  });

  test('deleting asks first, then removes the task and closes it if it was open', async () => {
    const confirms = [];
    let answer = false;
    const p = await boot({
      hash: '#a1',
      confirm: msg => { confirms.push(msg); return answer; },
      routes: { '/tasks': [task({ id: 'a1' }), task({ id: 'a2' })], '/task/a1/logs': '', 'DELETE /task/a1': { ok: true } }
    });
    more(p, 'a1').click();
    menu(p).querySelector('[data-action="delete"]').click();
    await settle();
    assert.match(confirms[0], /can't be undone/);
    assert.equal(p.calls.filter(c => c.method === 'DELETE').length, 0, 'cancelled');
    assert.ok(p.$('detail-head'));

    answer = true;
    more(p, 'a1').click();
    menu(p).querySelector('[data-action="delete"]').click();
    await settle();
    assert.equal(p.calls.find(c => c.method === 'DELETE').path, '/task/a1');
    assert.equal(p.doc.querySelectorAll('#tasks .task-row').length, 1);
    assert.equal(more(p, 'a1'), null);
    assert.equal(p.$('detail-head'), null, 'the deleted task is closed');
    assert.equal(p.window.location.hash, '');
    assert.equal(p.text('counts'), '1 done');
    p.close();
  });

  test('deleting a running task warns that it will be stopped; deleting another task leaves the open one', async () => {
    const confirms = [];
    const p = await boot({
      hash: '#a2',
      confirm: msg => { confirms.push(msg); return true; },
      routes: { '/tasks': [task({ id: 'a1', status: 'running', finished: null }), task({ id: 'a2' })], '/task/a2/logs': '', 'DELETE /task/a1': { ok: true } }
    });
    more(p, 'a1').click();
    menu(p).querySelector('[data-action="delete"]').click();
    await settle();
    assert.match(confirms[0], /still running: Claude will be stopped/);
    assert.equal(p.text('counts'), '1 done', 'running count gone');
    assert.ok(p.$('detail-head'), 'the open task stays open');
    p.close();
  });

  test('a task already gone on the server is still removed; other delete errors are reported', async () => {
    const p = await boot({
      routes: {
        '/tasks': [task({ id: 'a1' }), task({ id: 'a2' })],
        'DELETE /task/a1': { status: 404, body: { error: 'Not found' } },
        'DELETE /task/a2': { status: 500, body: {} }
      }
    });
    more(p, 'a1').click();
    menu(p).querySelector('[data-action="delete"]').click();
    await settle();
    assert.equal(more(p, 'a1'), null);
    more(p, 'a2').click();
    menu(p).querySelector('[data-action="delete"]').click();
    await settle();
    assert.deepEqual(p.alerts, ["Couldn't delete the task: HTTP 500"]);
    assert.ok(more(p, 'a2'));
    p.close();
  });
});

describe('task detail', () => {
  test('opening a task renders its header and timeline and updates the URL hash', async () => {
    const t = task({ status: 'failed', errorType: 'auth_expired', error: 'token <expired>', pr_url: 'https://git.test/pr/7', prompt: 'Title\n\nMore detail' });
    const p = await boot({ routes: { '/tasks': [t], '/task/abc12345/logs': LOG } });
    p.run(`selectTask('abc12345')`);
    await settle();
    assert.equal(p.window.location.hash, '#abc12345');
    assert.ok(p.doc.body.classList.contains('show-detail'));
    assert.equal(p.doc.querySelector('#tasks .task').getAttribute('aria-current'), 'true');
    const head = p.$('detail-head');
    assert.equal(head.querySelector('h1').textContent, 'Title');
    assert.equal(head.querySelector('.prompt-more').textContent, 'More detail');
    assert.equal(head.querySelector('a.btn.primary').href, 'https://git.test/pr/7');
    assert.equal(head.querySelector('.facts a').href, 'https://git.test/martin/app');
    assert.equal(head.querySelector('code').textContent, 'claude/abc12345');
    assert.match(head.querySelector('.problem').textContent, /login on the server has expired/);
    assert.match(head.querySelector('.problem').textContent, /token <expired>/);
    assert.match(head.textContent, /Took\s*1m 30s/);
    assert.equal(p.doc.querySelectorAll('#timeline .phase').length, 2);
    p.close();
  });

  test('the whole top part (status, PR button, title, repo, branch, timing) stays pinned', async () => {
    const t = task({ pr_url: 'https://git.test/pr/7', prompt: 'Title\nMore detail' });
    const p = await boot({ routes: { '/tasks': [t], '/task/abc12345/logs': LOG } });
    p.run(`selectTask('abc12345')`);
    await settle();
    const top = p.$('detail-head').querySelector('.detail-top');
    assert.ok(top.querySelector('.head-row .status'));
    assert.ok(top.querySelector('a.btn.primary'));
    assert.equal(top.querySelector('h1').textContent, 'Title');
    assert.ok(top.querySelector('.prompt-more'));
    const facts = top.querySelector('.facts').textContent;
    for (const label of ['Repo', 'Branch', 'Started', 'Took']) assert.match(facts, new RegExp(label));
    const css = p.window.getComputedStyle(top);
    assert.equal(css.position, 'sticky');
    assert.equal(css.top, '0px');
    // The row itself is no longer sticky on its own; the whole block is.
    assert.notEqual(p.window.getComputedStyle(top.querySelector('.head-row')).position, 'sticky');
    // A long prompt scrolls inside its box instead of making the pinned part tall.
    assert.equal(p.window.getComputedStyle(top.querySelector('.prompt-more')).overflowY, 'auto');
    // A sticky box can't leave its parent's box: #detail-head must not generate one, so the
    // block is bounded by .detail-inner (which also holds the timeline) and stays pinned.
    assert.equal(p.window.getComputedStyle(p.$('detail-head')).display, 'contents');
    assert.ok(p.$('detail-head').parentElement.contains(p.$('timeline')));
    p.close();
  });

  test('the failure box sits below the pinned top part, not inside it', async () => {
    const t = task({ status: 'failed', errorType: 'timeout' });
    const p = await boot({ routes: { '/tasks': [t], '/task/abc12345/logs': LOG } });
    p.run(`selectTask('abc12345')`);
    await settle();
    const head = p.$('detail-head');
    assert.ok(head.querySelector('.problem'));
    assert.equal(head.querySelector('.detail-top .problem'), null);
    p.close();
  });

  test('does not link unsafe PR or repo URLs and handles an unpicked repo and unknown errors', async () => {
    const t = task({ status: 'failed', errorType: 'weird', pr_url: 'javascript:alert(1)', repo_url: 'javascript:alert(2)', finished: null });
    const p = await boot({ routes: { '/tasks': [t], '/task/abc12345/logs': '' } });
    p.run(`selectTask('abc12345')`);
    await settle();
    const head = p.$('detail-head');
    assert.equal(head.querySelector('a'), null);
    assert.match(head.textContent, /martin\/app/);
    assert.match(head.querySelector('.problem').textContent, /The task failed\./);
    assert.match(head.textContent, /Running for/);
    p.run(`tasks[0].repo = null; renderHeader()`);
    assert.match(p.$('detail-head').textContent, /Picked from prompt/);
    p.close();
  });

  test('a task that no longer exists says so, in the header and when its logs 404', async () => {
    const p = await boot();
    p.run(`selectTask('gone')`);
    await settle();
    assert.match(p.text('detail-head'), /no longer exists/);
    assert.match(p.text('timeline'), /Couldn't load this run: This task no longer exists\./);
    p.close();
  });

  test('an existing task whose log 404s says the log is gone, not the task', async () => {
    const p = await boot({ routes: { '/tasks': [task()], '/task/abc12345/logs': { status: 404, body: '{}' } } });
    p.run(`selectTask('abc12345')`);
    await settle();
    assert.match(p.text('timeline'), /Couldn't load this run: Its log is no longer available\./);
    p.close();
  });

  test('a task cut short by a restart explains what happened', async () => {
    const t = task({ status: 'failed', errorType: 'interrupted', error: 'The runner restarted while this task was running.' });
    const p = await boot({ routes: { '/tasks': [t], '/task/abc12345/logs': LOG } });
    p.run(`selectTask('abc12345')`);
    await settle();
    const problem = p.$('detail-head').querySelector('.problem').textContent;
    assert.match(problem, /runner restarted \(for example a redeploy\)/);
    assert.doesNotMatch(problem, /The task failed\./);
    p.close();
  });

  test('other log errors show the HTTP status', async () => {
    const p = await boot({ routes: { '/tasks': [task()], '/task/abc12345/logs': { status: 500, body: 'x' } } });
    p.run(`selectTask('abc12345')`);
    await settle();
    assert.match(p.text('timeline'), /HTTP 500/);
    p.close();
  });

  test('finished runs load logs once; running runs keep polling and keep open tools open', async () => {
    let log = LOG;
    const p = await boot({ routes: { '/tasks': [task({ status: 'running', finished: null })], '/task/abc12345/logs': () => log } });
    const logCalls = () => p.calls.filter(c => c.path === '/task/abc12345/logs').length;
    p.run(`selectTask('abc12345')`);
    await settle();
    assert.equal(logCalls(), 1);
    p.doc.querySelector('details.tool[data-id="t1"]').setAttribute('open', '');
    log += `\n${j({ type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] } })}`;
    await p.run('fetchLogs(false)');
    assert.equal(logCalls(), 2);
    assert.match(p.text('timeline'), /more/);
    assert.ok(p.doc.querySelector('details.tool[data-id="t1"]').hasAttribute('open'));

    p.run(`tasks[0].status = 'completed'`);
    await p.run('fetchLogs(false)');
    assert.equal(logCalls(), 2);
    p.close();
  });

  test('a URL hash opens that task on load; Escape and the back button close it', async () => {
    const p = await boot({ hash: '#abc12345', routes: { '/tasks': [task()], '/task/abc12345/logs': LOG } });
    assert.ok(p.$('detail-head'));
    p.doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(p.$('detail-head'), null);
    assert.equal(p.window.location.hash, '');
    assert.match(p.text('detail'), /Pick a task/);
    assert.ok(!p.doc.body.classList.contains('show-detail'));

    p.run(`selectTask('abc12345')`);
    p.doc.querySelector('.back').click();
    assert.equal(p.$('detail-head'), null);
    p.close();
  });

  test('Escape inside the prompt box does not close the task', async () => {
    const p = await boot({ hash: '#abc12345', routes: { '/tasks': [task()], '/task/abc12345/logs': LOG } });
    p.$('prompt').focus();
    p.doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.ok(p.$('detail-head'));
    p.close();
  });
});

describe('composer', () => {
  const posts = p => p.calls.filter(c => c.method === 'POST' && c.path === '/task');

  test('an empty prompt does not start a task', async () => {
    const p = await boot();
    p.$('prompt').value = '   ';
    await p.run('submitTask()');
    assert.equal(posts(p).length, 0);
    assert.equal(p.doc.activeElement, p.$('prompt'));
    p.close();
  });

  test('starts a task, clears the prompt and opens it', async () => {
    const tasks = [];
    const p = await boot({
      routes: {
        '/tasks': () => tasks,
        'POST /task': ({ body }) => { tasks.push(task({ id: 'new1', prompt: JSON.parse(body).prompt, status: 'queued' })); return { id: 'new1' }; },
        '/task/new1/logs': ''
      }
    });
    p.$('prompt').value = '  Add a README  ';
    await p.run('submitTask()');
    await settle();
    assert.deepEqual(JSON.parse(posts(p)[0].body), { prompt: 'Add a README' });
    assert.equal(p.$('prompt').value, '');
    assert.equal(p.window.location.hash, '#new1');
    assert.equal(p.$('submit-btn').disabled, false);
    assert.equal(p.$('submit-btn').textContent, 'Run task');
    p.close();
  });

  test('Ctrl+Enter and Cmd+Enter submit; plain Enter does not', async () => {
    const p = await boot({ routes: { 'POST /task': { error: 'nope' } } });
    p.$('prompt').value = 'x';
    const key = init => p.$('prompt').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', ...init }));
    key({});
    await settle();
    assert.equal(posts(p).length, 0);
    key({ ctrlKey: true });
    await settle();
    key({ metaKey: true });
    await settle();
    assert.equal(posts(p).length, 2);
    p.close();
  });

  test('server errors are shown and the button is re-enabled', async () => {
    const p = await boot({ routes: { 'POST /task': { status: 400, body: { error: 'Missing <prompt>' } } } });
    p.$('prompt').value = 'x';
    await p.run('submitTask()');
    assert.equal(p.text('repo-hint'), "Couldn't start the task: Missing <prompt>");
    assert.equal(p.doc.querySelector('#repo-hint prompt'), null);
    assert.ok(p.$('repo-hint').classList.contains('error'));
    assert.equal(p.$('submit-btn').disabled, false);
    assert.equal(p.$('prompt').value, 'x');

    p.table['POST /task'] = {};
    await p.run('submitTask()');
    assert.match(p.text('repo-hint'), /didn't start the task/);
    p.close();
  });
});

describe('repo picker', () => {
  const repos = [
    { full_name: 'martin/app', description: 'The <app>', private: true, archived: false, default_branch: 'main', html_url: 'https://git.test/martin/app' },
    { full_name: 'martin/api', description: '', private: false, archived: true, default_branch: 'dev', html_url: 'javascript:x' },
    { full_name: 'org/site', description: null, private: false, archived: false, default_branch: 'main', html_url: 'https://git.test/org/site' }
  ];

  test('without Gitea the picker stays hidden', async () => {
    const p = await boot();
    assert.equal(p.$('repo-row').hidden, true);
    assert.equal(p.text('repo-hint'), 'Claude picks the repo from your prompt.');
    p.close();
  });

  test('lists repos and restores the last picked one', async () => {
    const p = await boot({ routes: { '/api/repos': { enabled: true, repos } }, storage: { selected_repo: 'martin/app' } });
    assert.equal(p.$('repo-row').hidden, false);
    const opts = [...p.doc.querySelectorAll('#repo-options option')].map(o => [o.value, o.textContent]);
    assert.deepEqual(opts, [['martin/app', 'The <app>, private'], ['martin/api', 'archived'], ['org/site', '']]);
    assert.equal(p.$('repo').value, 'martin/app');
    assert.match(p.text('repo-hint'), /Branches from main, view repo/);
    assert.equal(p.doc.querySelector('#repo-hint a').href, 'https://git.test/martin/app');
    p.close();
  });

  test('hints follow what is typed and only real picks are remembered', async () => {
    const p = await boot({ routes: { '/api/repos': { enabled: true, repos } } });
    const type = v => { p.$('repo').value = v; p.run('onRepoInput()'); return p.text('repo-hint'); };
    assert.equal(p.text('repo-hint'), 'Claude picks one of your 3 repos from the prompt.');
    assert.equal(type('martin/a'), '2 matching repos. Pick one from the list.');
    assert.equal(type('SITE'), '1 matching repo. Pick one from the list.');
    assert.equal(p.$('repo-hint').classList.contains('error'), false);
    assert.equal(type('nope'), 'No repo matches.');
    assert.ok(p.$('repo-hint').classList.contains('error'));
    assert.equal(p.window.localStorage.getItem('selected_repo'), null);
    assert.equal(type('martin/api'), 'Branches from dev');
    assert.equal(p.doc.querySelector('#repo-hint a'), null);
    assert.equal(p.window.localStorage.getItem('selected_repo'), 'martin/api');
    type('');
    assert.equal(p.window.localStorage.getItem('selected_repo'), null);
    p.close();
  });

  test('submitting an unknown repo is blocked; a known one is sent', async () => {
    const p = await boot({ routes: { '/api/repos': { enabled: true, repos }, 'POST /task': { error: 'x' } } });
    p.$('prompt').value = 'Do it';
    p.$('repo').value = 'martin/nope';
    await p.run('submitTask()');
    assert.equal(p.calls.filter(c => c.method === 'POST').length, 0);
    assert.match(p.text('repo-hint'), /isn't one of your Gitea repos/);
    p.$('repo').value = '<img src=x>';
    await p.run('submitTask()');
    assert.equal(p.doc.querySelector('#repo-hint img'), null);
    assert.match(p.text('repo-hint'), /^<img src=x> isn't one of your Gitea repos/);
    p.$('repo').value = ' org/site ';
    await p.run('submitTask()');
    assert.deepEqual(JSON.parse(p.calls.find(c => c.method === 'POST').body), { prompt: 'Do it', repo: 'org/site' });
    p.close();
  });

  test('repo load errors are shown escaped, and reload asks for a refresh', async () => {
    const p = await boot({ routes: { '/api/repos': { enabled: true, error: '<b>down</b>' } } });
    assert.equal(p.text('repo-hint'), "Couldn't load your Gitea repos: <b>down</b>");
    assert.equal(p.doc.querySelector('#repo-hint b'), null);
    assert.ok(p.$('repo-hint').classList.contains('error'));
    p.table['GET /api/repos'] = { enabled: true, repos };
    p.doc.querySelector('[aria-label="Reload repos"]').click();
    await settle();
    assert.ok(p.calls.some(c => c.path === '/api/repos?refresh=1'));
    assert.equal(p.doc.querySelectorAll('#repo-options option').length, 3);
    p.close();
  });

  test('a broken repos response is reported', async () => {
    const p = await boot({ routes: { '/api/repos': { status: 502, body: 'Bad gateway' } } });
    assert.match(p.text('repo-hint'), /^Couldn't load your Gitea repos: /);
    p.close();
  });
});

describe('API token dialog', () => {
  test('shows the token state when opened', async () => {
    const p = await boot({ routes: { '/token': { exists: true, masked: 'abcd…<x>' } } });
    p.run('openSettings()');
    await settle();
    assert.equal(p.$('settings').open, true);
    assert.equal(p.$('token-status').querySelector('code').textContent, 'abcd…<x>');
    assert.equal(p.$('revoke-btn').hidden, false);
    p.table['GET /token'] = { exists: false };
    await p.run('fetchTokenStatus()');
    assert.match(p.text('token-status'), /No token yet/);
    assert.equal(p.$('revoke-btn').hidden, true);
    p.close();
  });

  test('generating a token shows it once and uses it for this browser', async () => {
    const p = await boot({ routes: { 'POST /token/generate': { token: 'secret-1' } } });
    await p.run('generateToken()');
    assert.equal(p.$('new-token').hidden, false);
    assert.equal(p.text('new-token-value'), 'secret-1');
    assert.equal(p.$('api-token').value, 'secret-1');
    assert.equal(p.window.localStorage.getItem('api_token'), 'secret-1');
    await p.run('fetchTasks()');
    assert.equal(p.calls.at(-1).headers.Authorization, 'Bearer secret-1');
    p.close();
  });

  test('cancelling the confirm does nothing', async () => {
    const p = await boot({ confirm: false });
    await p.run('generateToken()');
    await p.run('revokeToken()');
    assert.equal(p.calls.filter(c => c.method !== 'GET').length, 0);
    p.close();
  });

  test('revoking clears the stored token', async () => {
    const p = await boot({ storage: { api_token: 'old' }, routes: { 'DELETE /token': {} } });
    await p.run('revokeToken()');
    assert.ok(p.calls.some(c => c.method === 'DELETE' && c.path === '/token'));
    assert.equal(p.$('api-token').value, '');
    assert.equal(p.window.localStorage.getItem('api_token'), null);
    await settle();
    p.close();
  });

  test('copy falls back to a manual hint without clipboard access', async () => {
    const p = await boot();
    await p.run('copyToken()');
    assert.equal(p.text('copy-btn'), 'Select and copy it manually');
    p.close();
  });

  test('editing the token field stores it', async () => {
    const p = await boot();
    p.$('api-token').value = 'typed';
    p.$('api-token').dispatchEvent(new p.window.Event('change'));
    assert.equal(p.window.localStorage.getItem('api_token'), 'typed');
    p.close();
  });
});

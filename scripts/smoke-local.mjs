/**
 * Check that a Bot can work with files on this computer: write a file in its
 * workspace, read it back, and report.
 *
 *   node scripts/smoke-local.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const jar = new Map();
const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function call(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(jar.size ? { cookie: cookie() } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: text }; }
}

const step = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` - ${extra}` : ''}`);

const login = await call('/api/auth/dev', { method: 'POST', body: { email: `local-${Date.now()}@test.local`, name: 'Local' } });
step('signed in', login.status === 200);

const bot = (await call('/api/bots', { method: 'POST', body: { name: 'File Bot', instructions: 'You work with files on the user\'s computer.' } })).json?.bot;

await call(`/api/bots/${bot.id}/messages`, {
  method: 'POST',
  body: {
    text:
      'Do this with your tools: use local_write_file to write the file "notes/hello.txt" in your workspace with the exact content "written by the bot". ' +
      'Then use local_read_file to read "notes/hello.txt" back. Tell me the exact content you read.',
  },
});

let approved = 0;
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const rows = (await call(`/api/bots/${bot.id}/rows`)).json?.rows ?? [];
  for (const card of rows.filter((r) => r.kind === 'card' && r.body?.card === 'approval' && r.body?.status === 'pending')) {
    const res = await call(`/api/approvals/${card.body.approvalId}`, { method: 'POST', body: { decision: 'allow' } });
    if (res.status === 200) approved++;
  }
  const calls = rows.filter((r) => r.kind === 'tool-call');
  const msgs = rows.filter((r) => r.kind === 'message' && r.body?.role === 'assistant' && !r.body.streaming);
  if (calls.some((c) => c.body.name === 'local_read_file') && msgs.length) break;
}

const rows = (await call(`/api/bots/${bot.id}/rows`)).json?.rows ?? [];
for (const r of rows) {
  if (r.kind === 'tool-call') console.log(`   [tool] ${r.body.name} ${JSON.stringify(r.body.args ?? {}).slice(0, 100)} -> ${r.body.status}`);
  if (r.kind === 'message') console.log(`   [${r.body.role}] ${String(r.body.text ?? '').slice(0, 180)}`);
  if (r.kind === 'notice') console.log(`   [notice] ${String(r.body.text ?? '').slice(0, 180)}`);
}

const usedWrite = rows.some((r) => r.kind === 'tool-call' && r.body.name === 'local_write_file' && r.body.status === 'done');
const usedRead = rows.some((r) => r.kind === 'tool-call' && r.body.name === 'local_read_file' && r.body.status === 'done');
step('bot wrote a file on this computer', usedWrite);
step('bot read the file back', usedRead);
step('the write asked the user first', approved > 0, `${approved} approval(s)`);

// The file must exist on disk under the user's workspace.
const { readdirSync, readFileSync, existsSync } = await import('node:fs');
const wsRoot = new URL('../data/workspaces/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const found = [];
for (const dir of readdirSync(wsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const p = `${wsRoot}${dir.name}/notes/hello.txt`;
  if (existsSync(p)) found.push(readFileSync(p, 'utf8'));
}
step('the file is on disk', found.length > 0, found.map((f) => JSON.stringify(f)).join(', '));

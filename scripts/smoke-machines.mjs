/**
 * Check the multi-machine path: a Bot finds another machine and runs a command
 * on it through the machine agent.
 *
 *   node scripts/smoke-machines.mjs [baseUrl] [machineName]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const machine = process.argv[3] ?? 'Test-Box';
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

await call('/api/auth/dev', { method: 'POST', body: { email: `machines-${Date.now()}@test.local`, name: 'Machines' } });

const machines = (await call('/api/machines')).json?.machines ?? [];
step('hub sees the machine agent', machines.length > 0, machines.map((m) => `${m.name}(${m.online ? 'online' : 'offline'})`).join(', '));

const bot = (await call('/api/bots', { method: 'POST', body: { name: 'Runner', instructions: 'You are a test bot. Follow instructions exactly and use your tools.' } })).json?.bot;

await call(`/api/bots/${bot.id}/messages`, {
  method: 'POST',
  body: {
    text:
      `Use the machine_list tool to see the available machines. Then use machine_run on the machine named "${machine}" ` +
      `to run the command "echo hello-from-the-other-machine". Report the exact output you got.`,
  },
});

let sawTool = false;
let approved = 0;
let reply = '';
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const rows = (await call(`/api/bots/${bot.id}/rows`)).json?.rows ?? [];
  const calls = rows.filter((r) => r.kind === 'tool-call');
  if (calls.length) sawTool = true;

  // Approve anything the bot is waiting on.
  for (const card of rows.filter((r) => r.kind === 'card' && r.body?.card === 'approval' && r.body?.status === 'pending')) {
    const res = await call(`/api/approvals/${card.body.approvalId}`, { method: 'POST', body: { decision: 'allow' } });
    if (res.status === 200) approved++;
  }

  const msgs = rows.filter((r) => r.kind === 'message' && r.body?.role === 'assistant' && !r.body.streaming);
  const last = msgs[msgs.length - 1];
  // Wait until the turn is finished: a tool ran and the final message came after it.
  if (last && calls.length && msgs.length >= calls.length) { reply = String(last.body.text ?? ''); if (/hello-from-the-other-machine/i.test(reply)) break; }
}

for (const r of (await call(`/api/bots/${bot.id}/rows`)).json?.rows ?? []) {
  if (r.kind === 'tool-call') console.log(`   [tool] ${r.body.name} -> ${r.body.status} ${r.body.summary ? JSON.stringify(r.body.summary).slice(0, 120) : ''}`);
  if (r.kind === 'message') console.log(`   [${r.body.role}] ${String(r.body.text ?? '').slice(0, 220)}`);
  if (r.kind === 'notice') console.log(`   [notice] ${String(r.body.text ?? '').slice(0, 220)}`);
}

step('bot called a tool', sawTool);
step('approval was requested and granted', approved > 0, `${approved} approval(s)`);
// The tool result is the source of truth; the model's wording varies.
const finalRows = (await call(`/api/bots/${bot.id}/rows`)).json?.rows ?? [];
const runRow = finalRows.find((r) => r.kind === 'tool-call' && r.body?.name === 'machine_run');
step('machine_run finished on the remote machine', runRow?.body?.status === 'done', JSON.stringify(runRow?.body?.summary ?? ''));
step('the reply mentions the remote output', /hello-from-the-other-machine/i.test(reply), reply.slice(0, 160));

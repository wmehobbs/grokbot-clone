/**
 * Check the Chief of Staff: it hires a specialist, hands it work, and reports back.
 *
 *   node scripts/smoke-team.mjs [baseUrl]
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

await call('/api/auth/dev', { method: 'POST', body: { email: `team-${Date.now()}@test.local`, name: 'Chief' } });

const chief = (await call('/api/bots', {
  method: 'POST',
  body: {
    name: 'Chief of Staff',
    label: 'Chief of Staff',
    description: 'Runs the team.',
    instructions: 'You are the Chief of Staff. Use manage_team to hire specialists and give them work, then report what happened in one place.',
    isPrimary: true,
  },
})).json?.bot;
step('chief of staff created', !!chief, chief?.id);

await call(`/api/bots/${chief.id}/messages`, {
  method: 'POST',
  body: {
    text:
      'Do this with your tools: 1) hire a researcher named Ada (role: researcher). 2) use manage_team with action=assign to ask Ada to write one sentence about her specialty. ' +
      '3) report back what Ada said and what the team now looks like.',
  },
});

let approved = 0;
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const rows = (await call(`/api/bots/${chief.id}/rows`)).json?.rows ?? [];
  for (const card of rows.filter((r) => r.kind === 'card' && r.body?.card === 'approval' && r.body?.status === 'pending')) {
    const res = await call(`/api/approvals/${card.body.approvalId}`, { method: 'POST', body: { decision: 'allow' } });
    if (res.status === 200) approved++;
  }
  const msgs = rows.filter((r) => r.kind === 'message' && r.body?.role === 'assistant' && !r.body.streaming);
  const calls = rows.filter((r) => r.kind === 'tool-call');
  if (calls.length >= 2 && msgs.length >= calls.length) {
    const last = String(msgs[msgs.length - 1]?.body?.text ?? '');
    if (/Ada/i.test(last)) break;
  }
}

const rows = (await call(`/api/bots/${chief.id}/rows`)).json?.rows ?? [];
for (const r of rows) {
  if (r.kind === 'tool-call') console.log(`   [tool] ${r.body.name} ${JSON.stringify(r.body.args ?? {}).slice(0, 110)} -> ${r.body.status}`);
  if (r.kind === 'message') console.log(`   [${r.body.role}] ${String(r.body.text ?? '').slice(0, 200)}`);
  if (r.kind === 'notice') console.log(`   [notice] ${String(r.body.text ?? '').slice(0, 200)}`);
}

const bots = (await call('/api/bots')).json?.bots ?? [];
const ada = bots.find((b) => b.name === 'Ada');
step('chief hired a specialist', !!ada, ada ? `${ada.name} / ${ada.label}` : 'no bot named Ada');
step('specialist has a role', ada?.label === 'Researcher', ada?.label);
step('team tools needed no approval', approved === 0, `${approved} approval(s) raised`);
const msgs = rows.filter((r) => r.kind === 'message' && r.body?.role === 'assistant').map((r) => String(r.body.text ?? '')).join(' ');
step('chief reported back', /Ada/i.test(msgs), msgs.slice(0, 160));

/**
 * End-to-end smoke test: sign in (dev), create a Bot, send a message, wait for
 * the reply, and print what happened. Run with the server up:
 *
 *   node scripts/smoke.mjs [baseUrl]
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
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 400); }
  return { status: res.status, json };
}

const step = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` - ${extra}` : ''}`);

// 1. sign in
const login = await call('/api/auth/dev', { method: 'POST', body: { email: `smoke-${Date.now()}@test.local`, name: 'Smoke' } });
step('dev sign-in', login.status === 200 || login.status === 201, `status ${login.status}`);

// 2. create a bot
const created = await call('/api/bots', { method: 'POST', body: { name: 'Scout', label: 'Test bot', description: 'smoke test', instructions: 'You are a test bot. Answer briefly.' } });
const botId = created.json?.bot?.id;
step('create bot', !!botId, botId ?? JSON.stringify(created.json).slice(0, 200));

// 3. send a message
const sent = await call(`/api/bots/${botId}/messages`, { method: 'POST', body: { text: 'Reply with exactly the word: ready' } });
step('send message', sent.status === 200, `status ${sent.status}`);

// 4. wait for the assistant reply
let reply = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const rows = await call(`/api/bots/${botId}/rows`);
  const list = rows.json?.rows ?? [];
  const msg = list.filter((r) => r.kind === 'message' && r.body?.role === 'assistant').pop();
  if (msg && !msg.body.streaming) { reply = msg; break; }
}
step('assistant replied', !!reply, reply ? JSON.stringify(reply.body).slice(0, 300) : 'no reply within 60s');

if (reply) {
  const text = String(reply.body.text ?? '');
  step('reply is real (not an error notice)', !/went wrong|no provider/i.test(text), text.slice(0, 120));
}

// 5. print the transcript for inspection
const rows = await call(`/api/bots/${botId}/rows`);
for (const r of rows.json?.rows ?? []) {
  if (r.kind === 'message') console.log(`   [${r.body.role}] ${String(r.body.text ?? '').slice(0, 200)}`);
  else if (r.kind === 'notice') console.log(`   [notice] ${String(r.body.text ?? '').slice(0, 200)}`);
}

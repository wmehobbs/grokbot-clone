/**
 * Check that each Bot can run on its own provider: one Bot on the account
 * default (MiniMax), another on a different one (the offline mock).
 *
 *   node scripts/smoke-providers.mjs [baseUrl]
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

await call('/api/auth/dev', { method: 'POST', body: { email: `providers-${Date.now()}@test.local`, name: 'Providers' } });

const catalog = await call('/api/providers');
const ids = (catalog.json?.providers ?? []).map((p) => p.id);
step('providers endpoint lists providers', ids.length > 0, ids.join(', '));
step('mock provider available for testing', ids.includes('mock'));

async function ask(bot, text) {
  await call(`/api/bots/${bot}/messages`, { method: 'POST', body: { text } });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await call(`/api/bots/${bot}/rows`);
    const msg = (rows.json?.rows ?? []).filter((r) => r.kind === 'message' && r.body?.role === 'assistant' && !r.body.streaming).pop();
    if (msg) return String(msg.body.text ?? '');
  }
  return '';
}

const minimaxBot = (await call('/api/bots', { method: 'POST', body: { name: 'Minimax Bot' } })).json?.bot;
const mockBot = (await call('/api/bots', { method: 'POST', body: { name: 'Mock Bot' } })).json?.bot;

await call(`/api/bots/${mockBot.id}`, { method: 'PATCH', body: { provider: 'mock', model: 'mock' } });

const a = await ask(minimaxBot.id, 'Reply with exactly the word: alpha');
const b = await ask(mockBot.id, 'Reply with exactly the word: alpha');

step('default bot answered through the default provider', a.trim().length > 0, a.slice(0, 80));
step('mock bot answered through its own provider', /Mock provider reply/i.test(b), b.slice(0, 80));
step('the two bots used different providers', a.trim() !== b.trim());

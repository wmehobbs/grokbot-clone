import { Hono } from 'hono';
import {
  awaitJob,
  enqueueJob,
  finishJob,
  listMachines,
  machineAuthed,
  machineById,
  pendingJobs,
  registerMachine,
  registrationAllowed,
  touchMachine,
  unregisterMachine,
} from './machines.js';

/**
 * The machine protocol.
 *
 * A machine agent on the user's other computer registers once with the shared
 * MACHINE_TOKEN, gets its own token, then polls for jobs and posts results.
 * The agent only ever dials the server, so no inbound ports are needed.
 */
export const machinesApi = new Hono();

const token = (c: any) => c.req.header('x-machine-token') ?? '';

machinesApi.post('/register', async (c) => {
  const secret = token(c);
  if (!registrationAllowed(secret)) return c.json({ error: 'Bad machine token. Check MACHINE_TOKEN on the server.' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const { id, token: agentToken } = registerMachine(String(body.name ?? 'Machine'), String(body.platform ?? ''), Array.isArray(body.capabilities) ? body.capabilities : []);
  return c.json({ id, token: agentToken });
});

machinesApi.post('/:id/poll', (c) => {
  const id = c.req.param('id');
  if (!machineAuthed(id, token(c))) return c.json({ error: 'unauthorized' }, 401);
  touchMachine(id);
  return c.json({ jobs: pendingJobs(id) });
});

machinesApi.post('/:id/heartbeat', (c) => {
  const id = c.req.param('id');
  if (!machineAuthed(id, token(c))) return c.json({ error: 'unauthorized' }, 401);
  touchMachine(id);
  return c.json({ ok: true });
});

machinesApi.post('/:id/jobs/:jobId/result', async (c) => {
  const id = c.req.param('id');
  if (!machineAuthed(id, token(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  finishJob(c.req.param('jobId'), id, String(body.output ?? ''), body.error ? String(body.error) : null);
  return c.json({ ok: true });
});

/** The user's machines (signed in). */
machinesApi.get('/', (c) => c.json({ machines: listMachines() }));

machinesApi.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!machineAuthed(id, token(c))) return c.json({ error: 'unauthorized' }, 401);
  unregisterMachine(id);
  return c.json({ ok: true });
});

export { awaitJob, enqueueJob, machineById };

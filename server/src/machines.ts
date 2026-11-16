import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';

/**
 * The user's other computers.
 *
 * A machine agent (see machine-agent/) runs on each of them and polls this
 * server for work. Nothing has to be reachable from the internet: the agent
 * dials in, registers, and picks up jobs. That makes "move the work to my
 * laptop" a normal tool call rather than a networking project.
 */

export interface MachineRow {
  id: string;
  name: string;
  platform: string;
  capabilities: string;
  status: string;
  last_seen_at: number | null;
  created_at: number;
}

export interface MachineJob {
  id: string;
  machine_id: string;
  kind: 'exec' | 'read_file' | 'write_file' | 'list_dir';
  payload: string;
  state: 'pending' | 'running' | 'done' | 'error' | 'expired';
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The shared secret an agent uses the first time it registers. */
export function registrationAllowed(token: string | undefined): boolean {
  if (!env.machineToken) return false;
  return safeEqual(env.machineToken, token ?? '');
}

export function registerMachine(name: string, platform: string, capabilities: string[]): { id: string; token: string } {
  const id = newId('mch');
  const token = randomBytes(24).toString('hex');
  const label = String(name || 'Machine').slice(0, 60);
  // A machine that reconnects replaces its old registration instead of piling up.
  for (const old of db.prepare('SELECT id FROM machines WHERE name=?').all(label) as any[]) {
    unregisterMachine(old.id);
  }
  db.prepare('INSERT INTO machines(id,name,platform,capabilities,token_hash,status,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
    id,
    label,
    String(platform || '').slice(0, 120),
    JSON.stringify(capabilities ?? []),
    hashToken(token),
    'online',
    now(),
    now(),
  );
  return { id, token };
}

export function machineById(id: string): MachineRow | undefined {
  return db.prepare('SELECT id,name,platform,capabilities,status,last_seen_at,created_at FROM machines WHERE id=?').get(id) as any;
}

export function listMachines(): (MachineRow & { capabilitiesList: string[]; online: boolean })[] {
  const rows = db.prepare('SELECT id,name,platform,capabilities,status,last_seen_at,created_at FROM machines ORDER BY created_at ASC').all() as any[];
  const nowMs = now();
  return rows.map((r) => {
    let caps: string[] = [];
    try { caps = JSON.parse(r.capabilities ?? '[]'); } catch { caps = []; }
    return { ...r, capabilitiesList: caps, online: !!r.last_seen_at && nowMs - r.last_seen_at < 60_000 };
  });
}

/** Check the per-machine token an agent uses for every call after registering. */
export function machineAuthed(machineId: string, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare('SELECT token_hash FROM machines WHERE id=?').get(machineId) as any;
  if (!row) return false;
  return safeEqual(row.token_hash, hashToken(token));
}

export function touchMachine(machineId: string, status = 'online') {
  db.prepare('UPDATE machines SET status=?, last_seen_at=? WHERE id=?').run(status, now(), machineId);
}

export function unregisterMachine(machineId: string) {
  db.prepare('DELETE FROM machines WHERE id=?').run(machineId);
  db.prepare('DELETE FROM machine_jobs WHERE machine_id=?').run(machineId);
}

// ---------- jobs ----------

export function enqueueJob(machineId: string, kind: MachineJob['kind'], payload: any): MachineJob {
  const id = newId('job');
  db.prepare('INSERT INTO machine_jobs(id,machine_id,kind,payload,state,created_at) VALUES (?,?,?,?,?,?)').run(id, machineId, kind, JSON.stringify(payload ?? {}), 'pending', now());
  return { id, machine_id: machineId, kind, payload: JSON.stringify(payload ?? {}), state: 'pending', result: null, error: null, created_at: now(), finished_at: null };
}

/** Jobs waiting for the agent to pick up. */
export function pendingJobs(machineId: string, limit = 4): MachineJob[] {
  const rows = db.prepare("SELECT * FROM machine_jobs WHERE machine_id=? AND state='pending' ORDER BY created_at ASC LIMIT ?").all(machineId, limit) as any[];
  for (const r of rows) db.prepare("UPDATE machine_jobs SET state='running' WHERE id=?").run(r.id);
  return rows as MachineJob[];
}

export function finishJob(jobId: string, machineId: string, result: string, error: string | null) {
  db.prepare('UPDATE machine_jobs SET state=?, result=?, error=?, finished_at=? WHERE id=? AND machine_id=?').run(error ? 'error' : 'done', result ?? '', error, now(), jobId, machineId);
}

/** Wait for a job to finish. The agent polls, so this is how long we give it. */
export async function awaitJob(jobId: string, timeoutMs = 120_000): Promise<MachineJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = db.prepare('SELECT * FROM machine_jobs WHERE id=?').get(jobId) as any as MachineJob | undefined;
    if (!job) throw new Error('job disappeared');
    if (job.state === 'done' || job.state === 'error') return job;
    if (Date.now() > deadline) {
      db.prepare("UPDATE machine_jobs SET state='expired', finished_at=? WHERE id=?").run(now(), jobId);
      throw new Error(`the machine did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

export function machineText(m: MachineRow & { online: boolean; capabilitiesList: string[] }) {
  const caps = m.capabilitiesList.length ? m.capabilitiesList.join(', ') : 'shell, files';
  return `${m.name} [${m.platform || 'unknown'}] - ${m.online ? 'online' : 'offline'} - can: ${caps}`;
}

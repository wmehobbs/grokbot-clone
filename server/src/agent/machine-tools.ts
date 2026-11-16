import { awaitJob, enqueueJob, listMachines, machineText } from '../machines.js';
import type { ActivityKind } from '../types.js';

/**
 * Tools that send work to the user's other computers.
 *
 * The Chief of Staff can hand a task to "the laptop" or "the desktop" and the
 * agent on that machine runs it. The agent polls the server for work, so this
 * works on a home network or over Tailscale without opening any ports.
 */
export interface MachineTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  needsApproval?: boolean;
  impl: (args: any, ctx: { userId: string; botId: string }) => Promise<{ output: string | any[]; summary?: string; endTurn?: boolean }>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function findMachine(userId: string, name: string) {
  const machines = listMachines();
  const needle = String(name ?? '').trim().toLowerCase();
  const matches = machines.filter((m) => m.name.toLowerCase() === needle || m.id.toLowerCase() === needle);
  // Prefer a machine that is actually online.
  return matches.find((m) => m.online) ?? matches[0];
}

export function machineTools(): MachineTool[] {
  return [
    {
      name: 'machine_list',
      description: "List the user's other computers that are connected to this server, and whether they are online.",
      parameters: obj({}),
      activity: 'running_commands',
      label: 'Looking at the machines',
      impl: async () => {
        const machines = listMachines();
        if (!machines.length) return { output: 'No other machines are connected. Start the machine agent on one to add it.', summary: 'No machines' };
        return { output: machines.map(machineText).join('\n'), summary: `${machines.length} machines` };
      },
    },
    {
      name: 'machine_run',
      description:
        "Run a shell command on one of the user's other computers. Use machine_list to see the names. The command runs on that machine with that machine's permissions.",
      parameters: obj({ machine: { type: 'string' }, command: { type: 'string' }, cwd: { type: 'string' }, timeout_seconds: { type: 'integer' } }, ['machine', 'command']),
      activity: 'running_commands',
      label: 'Running on another machine',
      needsApproval: true,
      impl: async (a) => {
        const m = findMachine('', String(a.machine ?? ''));
        if (!m) return { output: `No machine named "${a.machine}". Use machine_list to see the connected machines.`, summary: 'No such machine' };
        if (!m.online) return { output: `${m.name} is offline. Is its agent running?`, summary: 'Machine offline' };
        const job = enqueueJob(m.id, 'exec', { command: String(a.command ?? ''), cwd: a.cwd ? String(a.cwd) : undefined, timeoutSeconds: Number(a.timeout_seconds ?? 120) });
        const done = await awaitJob(job.id, 180_000);
        if (done.state === 'error') return { output: `The command failed on ${m.name}:\n${done.error ?? 'unknown error'}`, summary: 'Command failed' };
        return { output: `${done.result}`, summary: `Ran on ${m.name}` };
      },
    },
    {
      name: 'machine_read_file',
      description: "Read a file from one of the user's other computers.",
      parameters: obj({ machine: { type: 'string' }, path: { type: 'string' } }, ['machine', 'path']),
      activity: 'reading_web',
      label: 'Reading a file on another machine',
      impl: async (a) => {
        const m = findMachine('', String(a.machine ?? ''));
        if (!m) return { output: `No machine named "${a.machine}".`, summary: 'No such machine' };
        if (!m.online) return { output: `${m.name} is offline.`, summary: 'Machine offline' };
        const job = enqueueJob(m.id, 'read_file', { path: String(a.path ?? '') });
        const done = await awaitJob(job.id, 120_000);
        if (done.state === 'error') return { output: `Could not read the file on ${m.name}:\n${done.error ?? 'unknown error'}`, summary: 'Read failed' };
        return { output: String(done.result ?? ''), summary: `Read from ${m.name}` };
      },
    },
    {
      name: 'machine_write_file',
      description: "Write a file on one of the user's other computers.",
      parameters: obj({ machine: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }, ['machine', 'path', 'content']),
      activity: 'drafting_file',
      label: 'Writing on another machine',
      needsApproval: true,
      impl: async (a) => {
        const m = findMachine('', String(a.machine ?? ''));
        if (!m) return { output: `No machine named "${a.machine}".`, summary: 'No such machine' };
        if (!m.online) return { output: `${m.name} is offline.`, summary: 'Machine offline' };
        const job = enqueueJob(m.id, 'write_file', { path: String(a.path ?? ''), content: String(a.content ?? '') });
        const done = await awaitJob(job.id, 120_000);
        if (done.state === 'error') return { output: `Could not write the file on ${m.name}:\n${done.error ?? 'unknown error'}`, summary: 'Write failed' };
        return { output: String(done.result ?? 'written'), summary: `Wrote on ${m.name}` };
      },
    },
  ];
}

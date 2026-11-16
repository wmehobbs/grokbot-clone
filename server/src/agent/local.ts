import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from '../env.js';
import type { ActivityKind } from '../types.js';

/**
 * Tools that act on the machine this server runs on.
 *
 * Every path is resolved against the Bot's own workspace and then checked against
 * the roots the user allowed (LOCAL_ROOTS). Anything outside is refused, so a Bot
 * cannot wander into the rest of the disk. Shell commands always ask first.
 */

export interface LocalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  /** Ask the user before running this tool. */
  needsApproval?: boolean;
  impl: (args: any, ctx: { userId: string; botId: string }) => Promise<{ output: string | any[]; summary?: string; endTurn?: boolean }>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const MAX_READ = 200_000;
const MAX_OUTPUT = 30_000;

export function workspaceRoot(userId: string): string {
  return path.join(path.dirname(env.dbPath), 'workspaces', userId);
}

/** Folders a Bot may touch: the ones the user allowed plus its own workspace. */
export function allowedRoots(userId: string): string[] {
  const roots = new Set<string>();
  for (const r of env.localRoots) {
    try {
      roots.add(path.resolve(r));
    } catch {
      /* ignore a bad entry */
    }
  }
  roots.add(path.resolve(workspaceRoot(userId)));
  return [...roots];
}

/** Resolve a user-supplied path to an absolute path inside an allowed root. */
export function resolveLocalPath(userId: string, input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('A path is required.');
  const roots = allowedRoots(userId);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot(userId), raw);
  const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(`Path "${raw}" is outside the folders this Bot may use. Allowed: ${roots.join(', ')}.`);
  }
  return abs;
}

/** Make sure the Bot's own workspace exists (commands and writes need it). */
export function ensureWorkspace(userId: string): string {
  const dir = workspaceRoot(userId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the folder will be reported when it is used */
  }
  return dir;
}

async function statSafe(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function truncate(text: string, max = MAX_OUTPUT) {
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

export function localTools(): LocalTool[] {
  return [
    {
      name: 'local_workspace',
      description: 'Show the folder this Bot works in on this computer and the folders it may read and write.',
      parameters: obj({}),
      activity: 'running_commands',
      label: 'Looking at the workspace',
      impl: async (_a, ctx) => ({
        output: `Your workspace folder: ${ensureWorkspace(ctx.userId)}\nAllowed folders:\n${allowedRoots(ctx.userId).map((r) => `- ${r}`).join('\n')}`,
        summary: 'Workspace',
      }),
    },
    {
      name: 'local_read_file',
      description: 'Read a text file from this computer. Paths may be absolute or relative to your workspace folder.',
      parameters: obj({ path: { type: 'string' }, start_line: { type: 'integer' }, limit: { type: 'integer' } }, ['path']),
      activity: 'reading_web',
      label: 'Reading a file',
      impl: async (a, ctx) => {
        ensureWorkspace(ctx.userId);
        const file = resolveLocalPath(ctx.userId, a.path);
        const st = await statSafe(file);
        if (!st) return { output: `No such file: ${file}`, summary: 'Missing file' };
        if (st.isDirectory()) return { output: `${file} is a folder. Use local_list_dir to see inside it.`, summary: 'Is a folder' };
        const raw = await fsp.readFile(file, 'utf8');
        const start = Math.max(1, Number(a.start_line ?? 1));
        const limit = Math.max(1, Number(a.limit ?? 400));
        const lines = raw.split(/\r?\n/);
        const slice = lines.slice(start - 1, start - 1 + limit).join('\n');
        const more = lines.length > start - 1 + limit ? `\n[${lines.length - start + 1 - limit} more lines]` : '';
        return { output: truncate(`${file} (${lines.length} lines)\n${slice}${more}`), summary: `Read ${path.basename(file)}` };
      },
    },
    {
      name: 'local_write_file',
      description: 'Create or change a text file on this computer. Ask the user before overwriting something important.',
      parameters: obj({ path: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['write', 'append'] } }, ['path', 'content']),
      activity: 'drafting_file',
      label: 'Writing a file',
      needsApproval: true,
      impl: async (a, ctx) => {
        ensureWorkspace(ctx.userId);
        const file = resolveLocalPath(ctx.userId, a.path);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const content = String(a.content ?? '');
        if (a.mode === 'append') await fsp.appendFile(file, content, 'utf8');
        else await fsp.writeFile(file, content, 'utf8');
        const st = await statSafe(file);
        return { output: `Wrote ${st?.size ?? content.length} bytes to ${file}`, summary: `Wrote ${path.basename(file)}` };
      },
    },
    {
      name: 'local_list_dir',
      description: 'List the files and folders in a folder on this computer.',
      parameters: obj({ path: { type: 'string' }, recursive: { type: 'boolean' } }, ['path']),
      activity: 'running_commands',
      label: 'Listing files',
      impl: async (a, ctx) => {
        ensureWorkspace(ctx.userId);
        const dir = resolveLocalPath(ctx.userId, a.path ?? '.');
        const st = await statSafe(dir);
        if (!st?.isDirectory()) return { output: `Not a folder: ${dir}`, summary: 'Not a folder' };
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        const lines: string[] = [];
        for (const e of entries.slice(0, 500)) {
          const full = path.join(dir, e.name);
          let size = '';
          if (e.isFile()) {
            const s = await statSafe(full);
            size = ` (${s?.size ?? 0} bytes)`;
          }
          lines.push(`${e.isDirectory() ? 'dir ' : 'file'}${size}  ${e.name}`);
        }
        return { output: truncate(`${dir}\n${lines.join('\n') || '(empty)'}`), summary: `Listed ${entries.length} entries` };
      },
    },
    {
      name: 'local_search',
      description: 'Search files on this computer for text. Returns matching file names and lines.',
      parameters: obj({ query: { type: 'string' }, path: { type: 'string' }, extension: { type: 'string' }, max_results: { type: 'integer' } }, ['query']),
      activity: 'running_commands',
      label: 'Searching files',
      impl: async (a, ctx) => {
        ensureWorkspace(ctx.userId);
        const root = resolveLocalPath(ctx.userId, a.path ?? '.');
        const query = String(a.query ?? '');
        const max = Math.min(Number(a.max_results ?? 60), 400);
        const ext = a.extension ? String(a.extension).replace(/^\./, '').toLowerCase() : '';
        const needle = query.toLowerCase();
        const hits: string[] = [];
        let scanned = 0;
        const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'AppData', '$RECYCLE.BIN', 'System Volume Information']);
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (hits.length >= max || depth > 8) return;
          let entries: fs.Dirent[];
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (hits.length >= max) return;
            if (skip.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              await walk(full, depth + 1);
            } else if (e.isFile()) {
              if (ext && !e.name.toLowerCase().endsWith(`.${ext}`)) continue;
              const st = await statSafe(full);
              if (!st || st.size > 2_000_000) continue;
              scanned++;
              if (scanned > 4000) return;
              let text: string;
              try {
                text = await fsp.readFile(full, 'utf8');
              } catch {
                continue;
              }
              if (text.includes('\u0000')) continue; // binary
              const lines = text.split(/\r?\n/);
              for (let i = 0; i < lines.length && hits.length < max; i++) {
                if (lines[i].toLowerCase().includes(needle)) hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              }
            }
          }
        };
        await walk(root, 0);
        return { output: truncate(hits.length ? hits.join('\n') : `No matches for "${query}" under ${root}`, 40_000), summary: `${hits.length} matches` };
      },
    },
    {
      name: 'local_shell',
      description: 'Run a shell command on this computer (the machine the server runs on). The user is asked to approve it first.',
      parameters: obj({ command: { type: 'string' }, cwd: { type: 'string' }, timeout_seconds: { type: 'integer' } }, ['command']),
      activity: 'running_commands',
      label: 'Running a command',
      needsApproval: true,
      impl: async (a, ctx) => {
        ensureWorkspace(ctx.userId);
        const cwd = resolveLocalPath(ctx.userId, a.cwd ?? '.');
        const timeout = Math.min(Number(a.timeout_seconds ?? 60), 600) * 1000;
        const command = String(a.command ?? '');
        const result = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
          const child = spawn(command, { cwd, shell: true, windowsHide: true });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => {
            out += d.toString();
          });
          child.stderr.on('data', (d) => {
            err += d.toString();
          });
          const timer = setTimeout(() => {
            child.kill();
            resolve({ code: -1, out, err: err + `\n[timed out after ${timeout / 1000}s]` });
          }, timeout);
          child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, out, err: err + e.message });
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, out, err });
          });
        });
        const body = [result.out && `stdout:\n${result.out}`, result.err && `stderr:\n${result.err}`, `exit code: ${result.code}`].filter(Boolean).join('\n');
        return { output: truncate(body), summary: result.code === 0 ? 'Command finished' : `Exit ${result.code}` };
      },
    },
  ];
}

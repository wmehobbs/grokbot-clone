import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { ensureWorkspace, workspaceRoot } from './local.js';
import type { ActivityKind } from '../types.js';

/**
 * Moving work between computers through the cloud.
 *
 * If CLOUD_ROOT points at a synced folder (Google Drive for Desktop, OneDrive,
 * Dropbox, a Syncthing folder, or a network share), a Bot can push its workspace
 * up and pull it down again. That is what makes "continue this on my laptop"
 * work: the state travels through the cloud folder, not through a copy of the
 * database.
 */
export interface CloudTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  needsApproval?: boolean;
  impl: (args: any, ctx: { userId: string; botId: string }) => Promise<{ output: string | any[]; summary?: string; endTurn?: boolean }>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function cloudRoot(): string | undefined {
  const r = env.cloudRoot;
  return r ? path.resolve(r) : undefined;
}

/** Copy a tree, skipping anything bigger than the limit. */
async function copyTree(from: string, to: string, limit = 50_000_000): Promise<{ copied: string[]; skipped: string[] }> {
  const copied: string[] = [];
  const skipped: string[] = [];
  const walk = async (src: string, dest: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    await fsp.mkdir(dest, { recursive: true });
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const s = path.join(src, e.name);
      const d = path.join(dest, e.name);
      if (e.isDirectory()) await walk(s, d);
      else {
        const st = await fsp.stat(s).catch(() => null);
        if (!st) continue;
        if (st.size > limit) { skipped.push(s); continue; }
        await fsp.copyFile(s, d);
        copied.push(d);
      }
    }
  };
  await walk(from, to);
  return { copied, skipped };
}

export function cloudTools(): CloudTool[] {
  return [
    {
      name: 'cloud_sync',
      description:
        'Move your work between computers through the cloud folder. "push" copies this workspace up to the cloud folder, "pull" copies what is in the cloud folder down into this workspace, "list" shows what the cloud folder holds. Use this when work has to continue on another computer.',
      parameters: obj({ action: { type: 'string', enum: ['push', 'pull', 'list', 'status'] } }, ['action']),
      activity: 'running_commands',
      label: 'Syncing with the cloud',
      impl: async (a, ctx) => {
        const root = cloudRoot();
        if (!root) {
          return {
            output:
              'No cloud folder is set up on this server. Set CLOUD_ROOT in .env to a synced folder (for Google Drive for Desktop, the usual path is G:\\My Drive\\Guild) and restart the server.',
            summary: 'No cloud folder',
          };
        }
        if (!fs.existsSync(root)) {
          return { output: `The cloud folder ${root} does not exist on this machine yet. Create it, or check CLOUD_ROOT.`, summary: 'Cloud folder missing' };
        }
        const action = String(a.action ?? 'status');
        const ws = ensureWorkspace(ctx.userId);

        if (action === 'status') {
          return { output: `Cloud folder: ${root}\nThis workspace: ${ws}\nThe cloud folder is ${fs.existsSync(root) ? 'ready' : 'missing'}.`, summary: 'Cloud status' };
        }

        if (action === 'list') {
          const entries = await fsp.readdir(root, { withFileTypes: true });
          return { output: entries.length ? entries.map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`).join('\n') : '(empty)', summary: `${entries.length} entries` };
        }

        if (action === 'push') {
          const target = path.join(root, path.basename(ws) || 'workspace');
          const { copied, skipped } = await copyTree(ws, target);
          return {
            output: `Copied ${copied.length} file(s) to ${target}${skipped.length ? ` (${skipped.length} too large, skipped)` : ''}. They will appear on the other computer after it syncs.`,
            summary: `Pushed ${copied.length} files`,
          };
        }

        // pull
        const source = path.join(root, path.basename(ws) || 'workspace');
        if (!fs.existsSync(source)) {
          return { output: `Nothing to pull: ${source} does not exist yet on this machine.`, summary: 'Nothing to pull' };
        }
        const { copied, skipped } = await copyTree(source, ws);
        return {
          output: `Pulled ${copied.length} file(s) into ${ws}${skipped.length ? ` (${skipped.length} too large, skipped)` : ''}.`,
          summary: `Pulled ${copied.length} files`,
        };
      },
    },
  ];
}

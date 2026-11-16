import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { appendRow, getBotRow, listBots } from '../store.js';
import type { ActivityKind } from '../types.js';

/**
 * Team management: the Chief of Staff's toolbox.
 *
 * A Bot that is the user's primary Bot can see the roster, spawn specialists,
 * hand them work, inspect what they are doing and retire them. This is what
 * turns a set of separate Bots into a team with one point of control.
 */

export interface TeamToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
}

export interface TeamTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  needsApproval?: boolean;
  impl: (args: any, ctx: TeamToolCtx) => Promise<{ output: string | any[]; summary?: string; endTurn?: boolean }>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const SHAPES = ['blob', 'square', 'circle', 'triangle', 'hexagon', 'diamond', 'star', 'pill', 'ghost', 'robot', 'cat', 'dog', 'owl'];
const COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'red', 'teal', 'yellow', 'white', 'black'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return list[h % list.length] ?? (list[0] as T);
}

export function botByName(userId: string, name: string) {
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?) AND COALESCE(hidden,0)=0').get(userId, name.trim()) as any;
}

/** Create a Bot row. Shared by the API and by the Chief of Staff. */
export function createBotRow(userId: string, spec: {
  name: string;
  label?: string;
  description?: string;
  instructions?: string;
  avatarShape?: string;
  avatarColor?: string;
  mode?: string;
  isPrimary?: boolean;
  provider?: string;
  model?: string;
}) {
  const id = newId('bot');
  const shape = spec.avatarShape && SHAPES.includes(spec.avatarShape) ? spec.avatarShape : hashPick(id, SHAPES);
  const color = spec.avatarColor && COLORS.includes(spec.avatarColor) ? spec.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  const t = now();
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,provider,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    userId,
    String(spec.name ?? '').trim().slice(0, 60) || 'New Bot',
    spec.label ?? '',
    spec.description ?? '',
    spec.instructions ?? '',
    shape,
    color,
    spec.mode === 'teammate' ? 'teammate' : 'personal',
    spec.isPrimary ? 1 : 0,
    spec.provider ?? '',
    spec.model ?? '',
    t,
    t,
  );
  return id;
}

/** The roles a Chief of Staff can hire. */
export const ROLE_TEMPLATES: { key: string; label: string; brief: string; instructions: string }[] = [
  {
    key: 'researcher',
    label: 'Researcher',
    brief: 'Finds and verifies information, and writes up what it found with sources.',
    instructions: 'Research facts carefully, cite the source of every claim, and say clearly when something is uncertain.',
  },
  {
    key: 'writer',
    label: 'Writer',
    brief: 'Turns rough material into clear, finished writing.',
    instructions: 'Write clean, publishable prose. Match the voice the user wants. Cut filler.',
  },
  {
    key: 'analyst',
    label: 'Analyst',
    brief: 'Works with numbers: data, spreadsheets, metrics and trends.',
    instructions: 'Show the numbers, explain what they mean, and say where the data is thin.',
  },
  {
    key: 'engineer',
    label: 'Engineer',
    brief: 'Writes and fixes code, runs it, and checks it works.',
    instructions: 'Make the smallest change that solves the problem, run it, and report what you verified.',
  },
  {
    key: 'ops',
    label: 'Operations',
    brief: 'Keeps the machinery running: schedules, routines, reminders and follow-ups.',
    instructions: 'Own the follow-through. Track what was promised and when.',
  },
  {
    key: 'chief_of_staff',
    label: 'Chief of Staff',
    brief: 'Runs the team: breaks work down, delegates it, and reports back to the user.',
    instructions:
      'You are the Chief of Staff. Break the user\'s goals into work, hire or assign the right Bot for each part, and keep the whole picture. Report status in one place, and flag anything blocked.',
  },
];

function rosterText(userId: string, excludeBotId?: string): string {
  const bots = listBots(userId).filter((b) => b.id !== excludeBotId);
  if (!bots.length) return 'There are no other Bots on the team yet.';
  return bots
    .map((b) => {
      const bits = [`- ${b.name}`];
      if (b.label) bits.push(`(${b.label})`);
      if (b.isPrimary) bits.push('[primary]');
      if (b.unread) bits.push(`[${b.unread} unread]`);
      if (b.lastPreview) bits.push(`last: ${b.lastPreview.replace(/\s+/g, ' ').slice(0, 90)}`);
      return bits.join(' ');
    })
    .join('\n');
}

export function teamTools(): TeamTool[] {
  return [
    {
      name: 'manage_team',
      description:
        'Run your team: list Bots, hire a new specialist, hand a Bot a task, check on what a Bot is doing, change a Bot\'s role, or retire a Bot. Only the user\'s primary Bot should use this.',
      parameters: obj(
        {
          action: { type: 'string', enum: ['list', 'spawn', 'assign', 'inspect', 'set_role', 'retire'] },
          bot_name: { type: 'string' },
          role: { type: 'string', description: 'Role key for a new Bot, e.g. researcher, writer, analyst, engineer, ops.' },
          name: { type: 'string', description: 'Name for a new Bot.' },
          task: { type: 'string', description: 'The work to hand over.' },
          instructions: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
        ['action'],
      ),
      activity: 'messaging_named',
      label: 'Managing the team',
      impl: async (a, ctx) => {
        const action = String(a.action ?? 'list');

        if (action === 'list') {
          const roles = ROLE_TEMPLATES.map((r) => `- ${r.key}: ${r.brief}`).join('\n');
          return {
            output: `Your team:\n${rosterText(ctx.userId, ctx.botId)}\n\nRoles you can hire:\n${roles}`,
            summary: 'Listed the team',
          };
        }

        if (action === 'spawn') {
          const template = ROLE_TEMPLATES.find((r) => r.key === String(a.role ?? '').toLowerCase());
          const name = String(a.name ?? template?.label ?? 'New Bot').trim().slice(0, 60);
          if (db.prepare('SELECT 1 FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(ctx.userId, name)) {
            return { output: `A Bot named ${name} already exists. Give it a different name.`, summary: 'Name taken' };
          }
          const instructions = String(a.instructions ?? template?.instructions ?? '');
          const id = createBotRow(ctx.userId, {
            name,
            label: template?.label ?? String(a.role ?? ''),
            description: template?.brief ?? '',
            instructions,
            mode: 'teammate',
            provider: a.provider ? String(a.provider) : '',
            model: a.model ? String(a.model) : '',
          });
          const bot = getBotRow(id);
          return {
            output: `Hired ${bot?.name}${template ? ` (${template.label})` : ''}. Their instructions:\n${instructions}\n\nYou can hand them work now with manage_team action=assign.`,
            summary: `Hired ${bot?.name}`,
          };
        }

        const target = a.bot_name ? botByName(ctx.userId, String(a.bot_name)) : null;
        if (!target) return { output: `No Bot named "${a.bot_name}" on the team.`, summary: 'No such Bot' };
        if (target.id === ctx.botId) return { output: 'That is you.', summary: 'That is you' };

        if (action === 'assign') {
          const task = String(a.task ?? '').trim();
          if (!task) return { output: 'Say what the task is (task).', summary: 'No task given' };
          ctx.enqueueBotMessage(ctx.botId, target.id, task, ctx.depth + 1);
          return {
            output: `Handed the task to ${target.name}. They will reply to you and you should report back to the user.`,
            summary: `Assigned work to ${target.name}`,
          };
        }

        if (action === 'inspect') {
          const rows = db
            .prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event') ORDER BY seq DESC LIMIT 6")
            .all(target.id, target.generation) as any[];
          const recent = rows
            .map((r) => {
              const b = JSON.parse(r.body);
              if (b.type === 'message') return `${b.role}: ${String(b.text ?? '').slice(0, 160)}`;
              if (b.type === 'card') return `[card ${b.card}${b.status ? `:${b.status}` : ''}] ${b.title ?? b.question ?? ''}`;
              return `[${b.type}] ${String(b.text ?? '').slice(0, 160)}`;
            })
            .join('\n');
          const tasks = db.prepare('SELECT title, state FROM tasks WHERE bot_id=? ORDER BY updated_at DESC LIMIT 5').all(target.id) as any[];
          return {
            output: `${target.name}${target.label ? ` (${target.label})` : ''}\n${target.description ? `${target.description}\n` : ''}unread: ${target.unread}\nrecent:\n${recent || '(nothing yet)'}${tasks.length ? `\ntasks:\n${tasks.map((t) => `- ${t.title} [${t.state}]`).join('\n')}` : ''}`,
            summary: `Checked on ${target.name}`,
          };
        }

        if (action === 'set_role') {
          const patch: string[] = [];
          if (a.instructions !== undefined) {
            db.prepare('UPDATE bots SET instructions=?, updated_at=? WHERE id=?').run(String(a.instructions ?? ''), now(), target.id);
            patch.push('instructions');
          }
          if (a.role !== undefined) {
            db.prepare('UPDATE bots SET label=?, updated_at=? WHERE id=?').run(String(a.role), now(), target.id);
            patch.push('role');
          }
          return { output: `Updated ${target.name}: ${patch.join(', ') || 'nothing'}.`, summary: `Updated ${target.name}` };
        }

        if (action === 'retire') {
          db.prepare('DELETE FROM bots WHERE id=?').run(target.id);
          return { output: `Retired ${target.name}.`, summary: `Retired ${target.name}` };
        }

        return { output: `Unknown action "${action}". Use list, spawn, assign, inspect, set_role or retire.`, summary: 'Unknown action' };
      },
    },
    {
      name: 'team_digest',
      description: "A one-screen status of the whole team: who is doing what, what is waiting, and what needs the user.",
      parameters: obj({}),
      activity: 'thinking',
      label: 'Reading the team',
      impl: async (_a, ctx) => {
        const bots = listBots(ctx.userId);
        const lines: string[] = [];
        for (const b of bots) {
          const tasks = db.prepare("SELECT title FROM tasks WHERE bot_id=? AND state='working'").all(b.id) as any[];
          const pending = db.prepare("SELECT COUNT(*) n FROM approvals WHERE bot_id=? AND status='pending'").get(b.id) as any;
          const parts = [`${b.name}${b.label ? ` (${b.label})` : ''}`];
          if (b.unread) parts.push(`${b.unread} unread`);
          if (tasks.length) parts.push(`working on: ${tasks.map((t) => t.title).join('; ')}`);
          if (pending.n) parts.push(`${pending.n} waiting for the user`);
          if (b.lastPreview) parts.push(`last said: ${b.lastPreview.replace(/\s+/g, ' ').slice(0, 100)}`);
          lines.push(`- ${parts.join(' - ')}`);
        }
        const needsUser = db
          .prepare("SELECT a.id, b.name FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE b.user_id=? AND a.status='pending'")
          .all(ctx.userId) as any[];
        return {
          output: `${lines.join('\n') || 'No Bots yet.'}${needsUser.length ? `\n\nWaiting on the user: ${needsUser.map((n) => n.name).join(', ')}` : ''}`,
          summary: 'Team digest',
        };
      },
    },
  ];
}

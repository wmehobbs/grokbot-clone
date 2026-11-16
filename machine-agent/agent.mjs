#!/usr/bin/env node
/**
 * Guild machine agent.
 *
 * Run this on every computer you want your bots to be able to work on.
 * It registers with the server, then polls for jobs and runs them locally.
 * The agent only dials out, so nothing needs to be exposed on the network.
 *
 *   node machine-agent/agent.mjs
 *
 * Configuration (environment or a .env file next to this script):
 *   HUB_URL       where the server is, e.g. http://192.168.1.20:8787
 *   MACHINE_NAME  what to call this machine, e.g. "Laptop"
 *   MACHINE_TOKEN the shared secret from the server's .env (MACHINE_TOKEN=...)
 *   LOCAL_ROOTS   folders this agent may read and write, separated by ';'
 *                 (default: the user's home folder)
 *
 * The agent sandboxes itself: a job can only touch LOCAL_ROOTS.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- tiny .env loader ----------
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));
loadEnv(path.join(process.cwd(), '.env'));
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env is fine */
  }
}

const HUB_URL = (process.env.HUB_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MACHINE_NAME = process.env.MACHINE_NAME ?? os.hostname();
const MACHINE_TOKEN = process.env.MACHINE_TOKEN ?? '';
const LOCAL_ROOTS = (process.env.LOCAL_ROOTS ?? os.homedir())
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(s));

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const MAX_OUTPUT = 60_000;

// The allowed folders have to exist: a command that runs in a missing folder fails to start.
for (const root of LOCAL_ROOTS) {
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    console.error(`[agent] cannot use folder "${root}": ${e.message}`);
  }
}

if (!MACHINE_TOKEN) {
  console.error('MACHINE_TOKEN is required. Copy it from the server .env (MACHINE_TOKEN=...).');
  process.exit(1);
}

// ---------- sandbox ----------
function resolvePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('a path is required');
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(LOCAL_ROOTS[0], raw);
  const ok = LOCAL_ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`path "${raw}" is outside this machine's allowed folders: ${LOCAL_ROOTS.join(', ')}`);
  return abs;
}

// ---------- jobs ----------
async function runJob(job) {
  const payload = safeParse(job.payload);
  switch (job.kind) {
    case 'exec': {
      const cwd = payload.cwd ? resolvePath(payload.cwd) : LOCAL_ROOTS[0];
      const timeout = Math.min(Number(payload.timeoutSeconds ?? 120), 900) * 1000;
      return new Promise((resolve) => {
        const child = spawn(String(payload.command ?? ''), { cwd, shell: true, windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        const timer = setTimeout(() => {
          child.kill();
          resolve(`stdout:\n${out}\nstderr:\n${err}\n[timed out]`);
        }, timeout);
        child.on('error', (e) => { clearTimeout(timer); resolve(`failed to start: ${e.message}`); });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(`stdout:\n${out}\nstderr:\n${err}\nexit code: ${code}`);
        });
      });
    }
    case 'read_file': {
      const file = resolvePath(payload.path);
      const text = await fsp.readFile(file, 'utf8');
      return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n...[truncated]` : text;
    }
    case 'write_file': {
      const file = resolvePath(payload.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, String(payload.content ?? ''), 'utf8');
      return `wrote ${file}`;
    }
    case 'list_dir': {
      const dir = resolvePath(payload.path ?? '.');
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`).join('\n');
    }
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

function safeParse(text) {
  try { return JSON.parse(text ?? '{}'); } catch { return {}; }
}

// ---------- register and poll ----------
let machineId = '';
let agentToken = '';

async function api(path, init = {}) {
  const res = await fetch(`${HUB_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-machine-token': agentToken || MACHINE_TOKEN, ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(json?.error ?? `hub returned ${res.status}`);
  return json;
}

async function register() {
  const res = await api('/api/machines/register', {
    method: 'POST',
    body: {
      name: MACHINE_NAME,
      platform: `${os.platform()} ${os.arch()}${os.release() ? ` (${os.release()})` : ''}`,
      capabilities: ['exec', 'read_file', 'write_file', 'list_dir'],
    },
  });
  machineId = res.id;
  agentToken = res.token;
  console.log(`[agent] registered as "${MACHINE_NAME}" (${machineId})`);
  console.log(`[agent] allowed folders: ${LOCAL_ROOTS.join(', ')}`);
}

async function poll() {
  const res = await api(`/api/machines/${machineId}/poll`, { method: 'POST', body: {} });
  for (const job of res.jobs ?? []) {
    console.log(`[agent] job ${job.id} (${job.kind})`);
    try {
      const output = await runJob(job);
      await api(`/api/machines/${machineId}/jobs/${job.id}/result`, { method: 'POST', body: { output } });
    } catch (e) {
      await api(`/api/machines/${machineId}/jobs/${job.id}/result`, { method: 'POST', body: { error: String(e?.message ?? e) } });
    }
  }
}

async function main() {
  for (;;) {
    try {
      if (!machineId) await register();
      await poll();
    } catch (e) {
      console.error(`[agent] ${e?.message ?? e}`);
      // The server may have restarted and lost our registration, or not be up yet.
      if (machineId) {
        try { await register(); } catch { /* keep retrying */ }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

process.on('unhandledRejection', (e) => console.error(`[agent] ${e?.message ?? e}`));
process.on('uncaughtException', (e) => console.error(`[agent] ${e?.message ?? e}`));

process.on('SIGINT', () => {
  console.log('\n[agent] stopping');
  process.exit(0);
});

main();

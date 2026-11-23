#!/usr/bin/env node
// Tulikettu watcher: fetches all data, decides whether to push a notification (ntfy.sh),
// and writes the FMI snapshot the web app reads. Runs every ~10 min in GitHub Actions.
//
//   node watcher.mjs [--dry] [--state .state/state.json] [--site _site] [--force-daily]
//   env: NTFY_TOPIC (required unless --dry), NTFY_SERVER (default https://ntfy.sh),
//        APP_URL (link opened from the notification), NASA_KEY (optional, default DEMO_KEY)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as C from './core.js';
import { decide, runCycle } from './notify.js';
export { decide };

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const DRY = flag('--dry');
const STATE = opt('--state', '.state/state.json');
const SITE_DIR = opt('--site', null);
const TOPIC = process.env.NTFY_TOPIC;
const SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const APP_URL = process.env.APP_URL || '';

const MIN = 60e3, HOUR = 3600e3;

async function loadState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return { sent: {}, seen: {} }; }
}
async function saveState(s) {
  await mkdir(dirname(STATE), { recursive: true });
  // forget old "seen" ids after 10 days
  for (const [k, t] of Object.entries(s.seen)) if (Date.now() - t > 10 * 864e5) delete s.seen[k];
  await writeFile(STATE, JSON.stringify(s, null, 1));
}

async function push(msg) {
  const body = { topic: TOPIC, title: msg.title, message: msg.message, priority: msg.priority ?? 3, tags: msg.tags ?? [] };
  if (APP_URL) body.click = APP_URL;
  if (DRY || !TOPIC) { console.log('\n── PUSH (dry) ──\n' + JSON.stringify(body, null, 1)); return; }
  const r = await fetch(SERVER, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
  console.log('pushed:', msg.title);
}

async function writeSnapshot() {
  if (!SITE_DIR) return;
  const get = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const [r, rx] = await Promise.all([get(C.FMI_R_URL), get(C.FMI_RX_URL)]);
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(`${SITE_DIR}/fmi.json`, JSON.stringify({ t: new Date().toISOString(), r, rx }));
}

async function main() {
  const now = new Date();
  const state = await loadState();

  // If the Cloudflare Worker (every minute) is healthy, it owns notifications; this run only publishes Pages.
  const workerUrl = process.env.WORKER_URL;
  let workerAlive = false;
  if (workerUrl) {
    try {
      const h = await (await fetch(workerUrl.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(10000) })).json();
      workerAlive = now - new Date(h.lastRun) < 8 * MIN && h.pushOk === true;
      console.log('worker last run', h.lastRun, 'pushOk', h.pushOk, workerAlive ? '→ healthy, GitHub stays quiet' : '→ GitHub sends');
    } catch (e) { console.log('worker health check failed:', e.message); }
  }
  const [{ msgs: all }] = await Promise.all([
    runCycle({ state, now, nasaKey: process.env.NASA_KEY || 'DEMO_KEY', forceDaily: flag('--force-daily') }),
    writeSnapshot(),
  ]);
  const msgs = workerAlive && !DRY ? [] : all;
  if (workerAlive && all.length) console.log('suppressed (worker handles):', all.map(m => m.title));
  for (const m of msgs) await push(m);
  if (!msgs.length) console.log('no notifications');
  if (!DRY) await saveState(state);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e => { console.error(e); process.exit(1); });

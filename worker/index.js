// Tulikettu Cloudflare Worker: runs the watch cycle every minute (cron) and serves
//   /fmi.json  – FMI R-index + RX nowcast with CORS (FMI itself sends no CORS headers)
//   /health    – last run time + current score (GitHub fallback uses this to stay quiet)
// Secrets: NTFY_TOPIC, APP_URL, NTFY_TOKEN (ntfy.sh account token – anonymous publishing from shared
// Cloudflare IPs hits ntfy's per-IP daily quota), optional NASA_KEY. KV binding: KV.
// Without NTFY_TOKEN, or when pushes fail, /health reports pushOk=false and GitHub Actions sends instead.
import { runCycle, pushNtfy } from '../notify.js';
import { FMI_R_URL, FMI_RX_URL } from '../core.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
const json = (obj, maxAge = 30) => new Response(JSON.stringify(obj), { headers: { ...CORS, 'Cache-Control': `public, max-age=${maxAge}` } });

async function cycle(env) {
  const now = new Date();
  const raw = await env.KV.get('state');
  const state = raw ? JSON.parse(raw) : {};
  const { data, msgs } = await runCycle({ state, now, nasaKey: env.NASA_KEY || 'DEMO_KEY', light: true, log: false });
  const sent = [];
  const hbPrev = await env.KV.get('health', 'json');
  let pushOk = env.NTFY_TOKEN ? (hbPrev?.pushOk ?? true) : false;
  if (env.NTFY_TOKEN) {
    for (const m of msgs) {
      try { await pushNtfy(m, { topic: env.NTFY_TOPIC, appUrl: env.APP_URL, token: env.NTFY_TOKEN }); sent.push(m.title); pushOk = true; }
      catch (e) { console.error('push failed', e.message); pushOk = false; }
    }
  }
  // KV free tier allows 1000 writes/day: write state only when it changed, heartbeat every ~4 min.
  const next = JSON.stringify(state);
  if (next !== raw) await env.KV.put('state', next);
  const hb = hbPrev;
  if (sent.length || !hb || hb.pushOk !== pushOk || now - new Date(hb.lastRun) >= 4 * 60e3) {
    await env.KV.put('health', JSON.stringify({
      lastRun: now.toISOString(), pushOk, sent: sent.length ? sent : hb?.sent || [], lastSent: sent.length ? now.toISOString() : hb?.lastSent || null,
      errors: data.errors,
    }));
  }
  if (sent.length) console.log('sent', sent);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cycle(env));
  },
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET' } });
    if (pathname === '/fmi.json') {
      const get = u => fetch(u, { cf: { cacheTtl: 60 } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const [r, rx] = await Promise.all([get(FMI_R_URL), get(FMI_RX_URL)]);
      return json({ t: new Date().toISOString(), r, rx }, 60);
    }
    if (pathname === '/health') return json((await env.KV.get('health', 'json')) || { lastRun: null }, 10);
    return new Response('🦊 Tulikettu worker – /health, /fmi.json', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

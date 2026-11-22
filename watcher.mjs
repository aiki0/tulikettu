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

const pct = x => (x == null ? '?' : Math.round(x * 100) + ' %');
const cloudTxt = c => (c == null ? 'pilvisyys ei tiedossa' : `pilviä ${100 - Math.round(c * 100)} %`);

function moonLine(n) {
  const m = n.moon;
  const ev = m.events.map(e => `${e.rising ? 'nousee' : 'laskee'} ${C.hhmm(e.t)}`).join(', ');
  return `Kuu ${Math.round(m.fraction * 100)} % (${m.name})${ev ? ', ' + ev : m.upAtStart ? ', taivaalla koko yön' : ', ei nouse'}`;
}

export function nightSummary(n, nc, isTonight) {
  const lines = [];
  lines.push(`Paras hetki ${C.hhmm(n.from)}–${C.hhmm(n.to)}, huippu klo ${C.hh(n.peak.t)} (indeksi ${n.peak.score}/100).`);
  lines.push(`Revontulten näkymisen mahdollisuus yön aikana: ${n.chance} %.`);
  lines.push(`Kp-ennuste max ${n.maxKp.toFixed(1)} · ${n.weatherKnown ? cloudTxt(n.meanClear) + ' (keskim.)' : 'sääennuste ei vielä ulotu'}.`);
  lines.push(moonLine(n) + '.');
  lines.push(`Pimeää ${C.hhmm(n.darkStart)}–${C.hhmm(n.darkEnd)}.`);
  return lines.join('\n');
}

async function main() {
  const now = new Date();
  const state = await loadState();
  state.sent ||= {}; state.seen ||= {};
  const since = k => now - (state.sent[k] || 0);

  // NASA's DEMO_KEY is rate limited per IP, so CMEs are fetched at most hourly and cached in state.
  const cmeFresh = state.cmeCache && now - state.cmeCache.t < HOUR;
  const [data] = await Promise.all([
    C.fetchAll(fetch, { nasaKey: process.env.NASA_KEY || 'DEMO_KEY', skip: cmeFresh ? ['cmes'] : [] }),
    writeSnapshot(),
  ]);
  if (data.cmes) state.cmeCache = { t: +now, list: data.cmes };
  else if (state.cmeCache) data.cmes = state.cmeCache.list.map(c => ({ ...c, arrival: new Date(c.arrival), launched: c.launched && new Date(c.launched), modelled: new Date(c.modelled) }));
  if (Object.keys(data.errors).length) console.warn('fetch errors:', data.errors);
  const { nc, nights, certain, escape } = C.analyse(data, now);
  const L = C.local(now);
  console.log(`[${C.hhmm(now)}] score ${nc.score} (${nc.label}) act ${pct(nc.act)} clear ${pct(nc.clear)} dark ${nc.dark.toFixed(2)} src ${nc.source}`
    + (nc.fmi ? ` R ${nc.fmi.R}/${nc.fmi.lower}/${nc.fmi.higher}` : '') + ` Bz ${nc.bz?.toFixed(1)} v ${nc.speed}`);

  const msgs = [];

  // 1) Aurora happening now
  const live = certain.find(c => c.level === 'live');
  const liveCloudy = certain.find(c => c.level === 'live-cloudy');
  if (live) {
    const escalated = live.strong && !state.lastLiveStrong;
    if (since('live') > 75 * MIN || escalated) {
      msgs.push({
        key: 'live', priority: live.strong ? 5 : 4, tags: ['fox_face', 'sparkles'],
        title: live.strong ? '🦊 Revontulet NYT – lähes varmasti!' : '🦊 Revontulia todennäköisesti nyt',
        message: `${live.text}\nTaivas ${pct(nc.clear)} selkeä · Kuu ${Math.round(nc.moonFrac * 100)} % ${nc.moonAlt > 0 ? `korkeudella ${Math.round(nc.moonAlt)}°` : 'laskenut'}.`,
      });
    }
    state.lastLiveStrong = !!live.strong;
  } else {
    state.lastLiveStrong = false;
    if (liveCloudy && since('escape') > 2 * HOUR) {
      const best = escape.find(s => s.id !== 'yllasjarvi' && s.clear >= 0.6 && s.km <= 90);
      if (best) msgs.push({
        key: 'escape', priority: 4, tags: ['fox_face', 'car'],
        title: `🦊 Revontulet pilvien yllä – ${best.name} on selkeä`,
        message: `${liveCloudy.text}\n${best.name} (~${best.km} km) taivas ${pct(best.clear)} selkeä. ${best.tip}`,
      });
    }
  }

  // 2) Substorm likely soon (solar wind loading)
  const soon = certain.find(c => c.level === 'soon');
  if (soon && !live && (nc.clear ?? 0) >= 0.4 && since('soon') > 2 * HOUR) {
    msgs.push({ key: 'soon', priority: 4, tags: ['fox_face', 'hourglass'], title: '🦊 ' + soon.title, message: soon.text });
  }

  // 3) Good conditions by forecast even without live confirmation
  if (!live && !soon && nc.score >= 50 && nc.dark > 0.6 && since('good') > 2.5 * HOUR && since('live') > HOUR) {
    msgs.push({
      key: 'good', priority: 3, tags: ['fox_face'],
      title: `🦊 Hyvä hetki katsoa taivaalle (${nc.score}/100)`,
      message: `Kp ${nc.kpNow.toFixed(1)}, taivas ${pct(nc.clear)} selkeä, ${nc.moonAlt > 0 ? `kuu ${Math.round(nc.moonFrac * 100)} % taivaalla` : 'kuu ei häiritse'}. Mene pimeään paikkaan ja katso pohjoiseen.`,
    });
  }

  // 4) New NOAA watches / warnings (storm heads-up), once each
  for (const a of data.alerts || []) {
    const important = (a.kind === 'WATCH' && a.g) || (/WARNING/.test(a.kind) && a.k >= 5) || (a.kind === 'ALERT' && (a.k >= 6 || a.g >= 2));
    if (!important || state.seen['alert:' + a.id] || now - a.t > 12 * HOUR) continue;
    state.seen['alert:' + a.id] = +now;
    const days = a.days.filter(d => d.level !== 'None').map(d => `${C.dayLabel(d.date)} ${d.level}`).join(', ');
    msgs.push({ key: null, priority: 4, tags: ['sun_with_face', 'warning'], title: '☀️ ' + a.fi, message: `NOAA SWPC ${C.dayLabel(a.t)} klo ${C.hhmm(a.t)}.${days ? ' Ennuste: ' + days + '.' : ''} Seuraa Tulikettua – jos taivas on selkeä, tämä on iso mahdollisuus.` });
  }

  // 5) CME heading for Earth (new, or arrival moved > 3 h)
  for (const c of data.cmes || []) {
    if (c.arrival < now) continue;
    const k = 'cme:' + c.id, prev = state.seen[k + ':arr'];
    if (state.seen[k] && prev && Math.abs(prev - c.arrival) < 3 * HOUR) continue;
    state.seen[k] = +now; state.seen[k + ':arr'] = +c.arrival;
    msgs.push({
      key: null, priority: 4, tags: ['sun_with_face', 'rocket'],
      title: `☀️ Aurinkomyrsky matkalla: osuma ${C.dayLabel(c.arrival)} n. klo ${C.hhmm(c.arrival)}`,
      message: `${c.glancing ? 'Sivuosuma' : 'Suora osuma'}${c.kpHigh != null ? `, NASA:n mallin Kp ${c.kpLow === c.kpHigh ? c.kpHigh : c.kpLow + '–' + c.kpHigh}` : ''}${c.speed ? `, nopeus ${c.speed} km/s` : ''}. Saapumisaika ±7 h.`,
    });
  }

  // 6) Daily briefing at 15–16 local (it's dark from ~15:30 in late November)
  const today = `${L.y}-${L.mo}-${L.d}`;
  if ((L.h >= 15 && state.daily !== today) || flag('--force-daily')) {
    state.daily = today;
    const n = nights.find(x => now < x.darkEnd) || nights[0];
    const next = nights.filter(x => x !== n && x.date > n.date).slice(0, 2);
    const extra = certain.filter(c => ['storm', 'cme'].includes(c.level)).map(c => '⚡ ' + c.title).join('\n');
    msgs.push({
      key: null, priority: n.chance >= 75 && (n.meanClear ?? 0) > 0.5 ? 4 : 3, tags: ['fox_face', 'crescent_moon'],
      title: `🦊 Tämä yö: ${n.chance} % · paras ${C.hhmm(n.from)}–${C.hhmm(n.to)}`,
      message: nightSummary(n, nc, true) + (extra ? '\n' + extra : '')
        + (next.length ? '\n\nSeuraavat: ' + next.map(x => `${C.dayLabel(x.date)} ${x.chance} % (${C.hh(x.peak.t)})`).join(' · ') : ''),
    });
  }

  for (const m of msgs) {
    await push(m);
    if (m.key) state.sent[m.key] = +now;
  }
  if (!msgs.length) console.log('no notifications');
  if (!DRY) await saveState(state);
}

main().catch(e => { console.error(e); process.exit(1); });

// Notification decisions, shared by watcher.mjs (GitHub Actions) and worker/index.js (Cloudflare).
// Pure: takes data + mutable state, returns ntfy messages.
import * as C from './core.js';

const MIN = 60e3, HOUR = 3600e3;
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

/** Decision step: which notifications to send for this data, updating `state`. */
export function decide(data, state, now = new Date(), { forceDaily = false, log = true } = {}) {
  state.sent ||= {}; state.seen ||= {};
  const since = k => now - (state.sent[k] || 0);
  const { nc, nights, certain, escape } = C.analyse(data, now);
  const L = C.local(now);
  if (log) console.log(`[${C.hhmm(now)}] score ${nc.score} (${nc.label}) act ${pct(nc.act)} clear ${pct(nc.clear)} dark ${nc.dark.toFixed(2)} src ${nc.source}`
    + (nc.fmi ? ` R ${nc.fmi.R}/${nc.fmi.lower}/${nc.fmi.higher}` : '') + ` Bz ${nc.bz?.toFixed(1)} v ${nc.speed}`);

  const msgs = [];

  // 1) Aurora happening now
  const live = certain.find(c => c.level === 'live');
  const liveCloudy = certain.find(c => c.level === 'live-cloudy');
  if (live) {
    const escalated = live.strong && !state.lastLiveStrong;
    if (since('live') > 75 * MIN || escalated) {
      // A repeat within the same show is a gentle "still going" reminder, not another alarm.
      const repeat = !escalated && since('live') < 4 * HOUR;
      msgs.push({
        key: 'live', priority: repeat ? 3 : live.strong ? 5 : 4, tags: ['fox_face', 'sparkles'],
        title: repeat ? `🦊 Revontulet jatkuvat${live.strong ? ' voimakkaina' : ''}` : live.strong ? '🦊 Revontulet NYT – lähes varmasti!' : '🦊 Revontulia todennäköisesti nyt',
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
  if (soon && !live && (nc.clear ?? 0) >= 0.4 && since('soon') > (soon.id === 'cmesouth' ? HOUR : 2 * HOUR)) {
    msgs.push({ key: 'soon', priority: 4, tags: ['fox_face', 'hourglass'], title: '🦊 ' + soon.title, message: soon.text });
  }

  // 2b) CME shock detected at L1 → Earth impact within ~30–60 min (once per shock)
  const shock = certain.find(c => c.level === 'shock');
  if (shock && !state.seen[shock.id]) {
    state.seen[shock.id] = +now;
    msgs.push({ key: null, priority: 5, tags: ['sun_with_face', 'rotating_light'], title: '☀️ ' + shock.title, message: shock.text });
  }

  // 2c) CME arrival window open → tell once that L1 is being watched
  const cw = certain.find(c => c.level === 'cmewatch');
  if (cw && !state.seen[cw.id]) {
    state.seen[cw.id] = +now;
    msgs.push({ key: null, priority: 3, tags: ['satellite', 'eyes'], title: '🛰️ ' + cw.title, message: cw.text });
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
      message: `${c.glancing ? 'Sivuosuma' : 'Suora osuma'}${c.kpHigh != null ? `, NASA:n mallin Kp ${c.kpLow === c.kpHigh ? c.kpHigh : c.kpLow + '–' + c.kpHigh}` : ''}${c.speed ? `, nopeus ${c.speed} km/s` : ''}. Saapumisikkuna ${C.hhmm(C.cmeWindow(c).from)}–${C.hhmm(C.cmeWindow(c).to)} – tarkka hetki selviää vasta L1-satelliitilta ~30–60 min ennen.`,
    });
  }

  // 6) Daily briefing at 15–16 local (it's dark from ~15:30 in late November)
  const today = `${L.y}-${L.mo}-${L.d}`;
  if ((L.h >= 15 && state.daily !== today) || forceDaily) {
    state.daily = today;
    const n = nights.find(x => now < x.darkEnd) || nights[0];
    const next = nights.filter(x => x !== n && x.date > n.date).slice(0, 2);
    const extra = certain.filter(c => ['storm', 'cme', 'cmewatch'].includes(c.level)).map(c => '⚡ ' + c.title).join('\n');
    msgs.push({
      key: null, priority: n.chance >= 75 && (n.meanClear ?? 0) > 0.5 ? 4 : 3, tags: ['fox_face', 'crescent_moon'],
      title: `🦊 Tämä yö: ${n.chance} % · paras ${C.hhmm(n.from)}–${C.hhmm(n.to)}`,
      message: nightSummary(n, nc, true) + (extra ? '\n' + extra : '')
        + (next.length ? '\n\nSeuraavat: ' + next.map(x => `${C.dayLabel(x.date)} ${x.chance} % (${C.hh(x.peak.t)})`).join(' · ') : ''),
    });
  }

  for (const m of msgs) if (m.key) state.sent[m.key] = +now;
  return msgs;
}


const reviveCmes = list => list.map(c => ({ ...c, arrival: new Date(c.arrival), launched: c.launched && new Date(c.launched), modelled: c.modelled && new Date(c.modelled) }));
const reviveClouds = cl => Object.fromEntries(Object.entries(cl).map(([k, v]) => [k, v.map(r => ({ ...r, t: new Date(r.t) }))]));

/**
 * One watch cycle: fetch (respecting caches kept in `state`), decide, return messages.
 * light=true (Cloudflare Worker): partial solar-wind fetch, skip the heavy OVATION/WFS/outlook feeds,
 * refresh clouds every 30 min — keeps CPU per run within the free tier.
 */
export async function runCycle({ fetchImpl = fetch, state, now = new Date(), nasaKey = 'DEMO_KEY', light = false, forceDaily = false, log = true }) {
  state.sent ||= {}; state.seen ||= {};
  const skip = [];
  if (state.cmeCache && now - state.cmeCache.t < HOUR) skip.push('cmes'); // NASA DEMO_KEY is rate limited
  if (light) {
    skip.push('ovation', 'mag', 'outlook');
    if (state.cloudCache && now - state.cloudCache.t < 30 * MIN) skip.push('clouds');
  }
  const data = await C.fetchAll(fetchImpl, { nasaKey, skip, partialWind: light });
  if (data.cmes) state.cmeCache = { t: +now, list: data.cmes };
  else if (state.cmeCache) data.cmes = reviveCmes(state.cmeCache.list);
  // Cloud forecast changes slowly: reuse the last one for up to 3 h if a fetch fails or is skipped.
  if (data.clouds) state.cloudCache = { t: +now, clouds: data.clouds };
  else if (state.cloudCache && now - state.cloudCache.t < 3 * HOUR) data.clouds = reviveClouds(state.cloudCache.clouds);
  if (log && Object.keys(data.errors).length) console.warn('fetch errors:', data.errors);
  const msgs = decide(data, state, now, { forceDaily, log });
  return { data, msgs };
}

/** Send one message to ntfy. */
export async function pushNtfy(msg, { topic, server = 'https://ntfy.sh', appUrl = '', token = '', fetchImpl = fetch }) {
  const body = { topic, title: msg.title, message: msg.message, priority: msg.priority ?? 3, tags: msg.tags ?? [] };
  if (appUrl) body.click = appUrl;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetchImpl(server, { method: 'POST', body: JSON.stringify(body), headers });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
}

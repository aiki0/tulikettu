import * as C from './core.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = x => (x == null ? '–' : Math.round(x * 100) + ' %');
const REFRESH_MS = 5 * 60e3;
let S = { data: null, an: null, sel: null, intensity: 0.25, loading: false };

// ───────── fetch with small cache for rate-limited / slow-changing sources ─────────
const CACHE_TTL = [[/api\.nasa\.gov/, 60 * 60e3], [/27-day-outlook/, 3 * 3600e3]];
async function cachedFetch(url, opts) {
  const rule = CACHE_TTL.find(([re]) => re.test(url));
  if (!rule) return fetch(url, opts);
  const key = 'tk:' + url.replace(/api_key=[^&]+/, '');
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.t < rule[1]) return new Response(hit.body, { status: 200 });
  } catch {}
  const r = await fetch(url, opts);
  if (r.ok) { const body = await r.text(); try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), body })); } catch {} return new Response(body, { status: 200 }); }
  const stale = JSON.parse(localStorage.getItem(key) || 'null');
  if (stale) return new Response(stale.body, { status: 200 });
  return r;
}

// ───────── aurora sky (canvas) ─────────
function sky() {
  const cv = $('#sky'), ctx = cv.getContext('2d');
  const SCALE = 0.25;
  let w, h, t0 = performance.now();
  const resize = () => { w = cv.width = Math.ceil(innerWidth * SCALE); h = cv.height = Math.ceil(innerHeight * SCALE); };
  resize(); addEventListener('resize', resize);
  const ribbons = [
    { hue: 150, y: 0.22, amp: 0.07, f: 1.7, sp: 0.06, ph: 0 },
    { hue: 170, y: 0.30, amp: 0.05, f: 2.3, sp: -0.05, ph: 2 },
    { hue: 285, y: 0.14, amp: 0.06, f: 1.3, sp: 0.04, ph: 4 },
    { hue: 140, y: 0.38, amp: 0.04, f: 3.1, sp: 0.08, ph: 1 },
  ];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(now) {
    const t = (now - t0) / 1000;
    const I = 0.18 + S.intensity * 0.95; // brightness follows the score
    ctx.globalCompositeOperation = 'source-over';
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#040814'); bg.addColorStop(0.6, '#07122a'); bg.addColorStop(1, '#050a14');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ribbons.forEach((r, k) => {
      if (k === 3 && S.intensity < 0.45) return;
      for (let x = 0; x <= w; x += 1) {
        const u = x / w;
        const yc = h * (r.y + r.amp * Math.sin(u * r.f * 6.28 + t * r.sp * 6 + r.ph) + 0.025 * Math.sin(u * 17 + t * 0.9 + k));
        const flick = 0.55 + 0.45 * Math.sin(u * 40 + t * 1.7 + k * 3) * Math.sin(u * 13 - t * 0.6);
        const tall = h * (0.12 + 0.18 * I) * (0.7 + 0.3 * Math.sin(u * 5 + t * 0.3 + k));
        const a = Math.max(0, 0.09 * I * flick);
        const g = ctx.createLinearGradient(0, yc - tall, 0, yc + h * 0.02);
        g.addColorStop(0, `hsla(${r.hue + 120},90%,60%,0)`);
        g.addColorStop(0.55, `hsla(${r.hue + 40},90%,60%,${a * 0.5})`);
        g.addColorStop(0.9, `hsla(${r.hue},95%,58%,${a})`);
        g.addColorStop(1, `hsla(${r.hue},95%,58%,0)`);
        ctx.fillStyle = g; ctx.fillRect(x, yc - tall, 1.2, tall + h * 0.02);
      }
    });
    if (!reduce && !document.hidden) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !reduce) requestAnimationFrame(frame); });
}

// ───────── rendering ─────────
const MOON_EMOJI = p => ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][Math.round((((p % 1) + 1) % 1) * 8) % 8];
const scoreColor = s => s >= 60 ? '#c06bff' : s >= 40 ? '#3be3ff' : s >= 20 ? '#22f5a0' : 'rgba(34,245,160,.45)';

function renderHero(nc) {
  $('#score').textContent = nc.score;
  $('#ring').style.strokeDashoffset = 527.8 * (1 - nc.score / 100);
  const lab = $('#label');
  lab.textContent = nc.label;
  lab.classList.toggle('go', nc.score >= 50);
  S.intensity = Math.max(0.12, nc.act * (0.4 + 0.6 * nc.dark));
  const chips = [];
  const chip = (k, v, cls = '') => chips.push(`<span class="chip ${cls}"><span class="k">${k}</span><b>${v}</b></span>`);
  if (nc.fmi) chip(`R ${esc(nc.fmi.name)}`, `${nc.fmi.R}<span class="k"> / ${nc.fmi.lower}</span>`, nc.fmi.level !== 'low' ? 'good' : '');
  else if (nc.magNT != null) chip('Magnetometri', `${Math.round(nc.magNT)} nT`);
  chip('Kp', nc.kpNow.toFixed(1), nc.kpNow >= 3 ? 'good' : '');
  if (nc.clear != null) chip('Pilvet', pct(1 - nc.clear), nc.clear >= 0.7 ? 'good' : nc.clear < 0.35 ? 'bad' : '');
  if (nc.bz != null) chip('Bz', (nc.bz > 0 ? '+' : '') + nc.bz.toFixed(1), nc.bz < -3 ? 'good' : '');
  if (nc.speed) chip('Tuuli', Math.round(nc.speed) + ' km/s', nc.speed > 500 ? 'good' : '');
  chip(MOON_EMOJI(nc.moonPhase), nc.moonAlt > 0 ? `${Math.round(nc.moonFrac * 100)} % ↑${Math.round(nc.moonAlt)}°` : 'laskenut', nc.moonAlt > 15 && nc.moonFrac > 0.5 ? 'bad' : '');
  if (nc.dark < 1) chip('☀︎', nc.dark === 0 ? 'valoisaa' : 'hämärää');
  $('#chips').innerHTML = chips.join('');
}

function renderCertain(list) {
  const icon = { cmewatch: '🛰️', shock: '🚨', live: '✨', 'live-cloudy': '☁️', soon: '⏳', storm: '⚡', cme: '☀️' };
  $('#certain').innerHTML = list.map(c => `<div class="banner ${c.level}" data-icon="${icon[c.level] || '✨'}"><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></div>`).join('');
}

function renderTonight(n, nc) {
  if (!n) { $('#tonight-lead').textContent = 'Ei pimeitä tunteja ennustejaksolla.'; return; }
  const peakTxt = `<b>${C.hhmm(n.from)}–${C.hhmm(n.to)}</b>`;
  $('#tonight-lead').innerHTML = `Paras ikkuna ${peakTxt}, huippu klo <b>${C.hh(n.peak.t)}</b>. Mahdollisuus nähdä revontulia yön aikana <b>${n.chance} %</b>`
    + (n.weatherKnown ? `, taivas keskimäärin <b>${pct(n.meanClear)}</b> selkeä.` : '.');

  const hrs = n.hours;
  const W = 360, H = 190, top = 14, base = 160, padL = 4, padR = 4;
  const bw = (W - padL - padR) / hrs.length;
  const x = i => padL + i * bw;
  let svg = `<defs><linearGradient id="gb" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#22f5a0"/><stop offset=".6" stop-color="#3be3ff"/><stop offset="1" stop-color="#c06bff"/></linearGradient>
  <linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(170,185,210,.5)"/><stop offset="1" stop-color="rgba(170,185,210,.05)"/></linearGradient></defs>`;
  // daylight / twilight shading
  hrs.forEach((r, i) => { if (r.dark < 1) svg += `<rect x="${x(i)}" y="${top}" width="${bw + .5}" height="${base - top}" fill="rgba(70,110,170,${0.32 * (1 - r.dark)})"/>`; });
  // best window
  const ia = hrs.findIndex(r => r.t.getTime() === n.from.getTime());
  const ib = hrs.findIndex(r => r.t.getTime() === n.to.getTime() - 3600e3);
  if (ia >= 0 && ib >= 0) svg += `<rect x="${x(ia)}" y="${top - 10}" width="${(ib - ia + 1) * bw}" height="3" rx="1.5" fill="#22f5a0" opacity=".9"/>`;
  if (S.sel != null && hrs[S.sel]) svg += `<rect class="sel" x="${x(S.sel)}" y="${top}" width="${bw}" height="${base - top}"/>`;
  // clouds hanging from the top
  let cp = `M${x(0)},${top}`;
  hrs.forEach((r, i) => { const c = r.cloud ?? 0; cp += ` L${x(i) + bw / 2},${top + (base - top) * 0.55 * c / 100}`; });
  cp += ` L${x(hrs.length - 1) + bw},${top} Z`;
  if (hrs.some(r => r.cloud != null)) svg += `<path d="${cp}" fill="url(#gc)"/>`;
  // bars
  hrs.forEach((r, i) => {
    const hgt = (base - top) * r.score / 100;
    svg += `<rect class="bar" x="${x(i) + bw * 0.18}" y="${base - hgt}" width="${bw * 0.64}" height="${Math.max(hgt, r.dark > 0 ? 1.5 : 0)}" rx="${Math.min(3, bw * 0.3)}" fill="url(#gb)" opacity="${r.past ? 0.25 : r.weatherKnown ? 1 : 0.45}"/>`;
  });
  // moon up line
  hrs.forEach((r, i) => { if (r.moonAlt > 0) svg += `<rect x="${x(i)}" y="${base + 4}" width="${bw + .3}" height="3" fill="#ffd86b" opacity="${0.35 + 0.65 * r.moonFrac * Math.min(1, r.moonAlt / 25)}"/>`; });
  // now marker
  const now = Date.now();
  const ni = hrs.findIndex(r => now >= r.t && now < r.t.getTime() + 3600e3);
  if (ni >= 0) { const nx = x(ni) + bw * ((now - hrs[ni].t) / 3600e3); svg += `<line x1="${nx}" x2="${nx}" y1="${top - 4}" y2="${base + 8}" stroke="#fff" stroke-dasharray="2 3" opacity=".7"/><text x="${nx + 3}" y="${base - 2 - (base - top) * 0.9}" style="fill:#fff">nyt</text>`; }
  // labels
  hrs.forEach((r, i) => { const l = C.local(r.t); if (l.h % 3 === 0) svg += `<text x="${x(i) + bw / 2}" y="${H - 8}" text-anchor="middle">${String(l.h).padStart(2, '0')}</text>`; });
  hrs.forEach((r, i) => { svg += `<rect class="hit" data-i="${i}" x="${x(i)}" y="0" width="${bw}" height="${H}"/>`; });
  const el = $('#chart');
  el.innerHTML = svg;
  el.onclick = e => { const i = e.target.dataset?.i; if (i != null) { S.sel = +i; renderTonight(n, nc); hourDetail(hrs[+i]); } };

  // sun & moon timeline
  const from = new Date(hrs[0].t), to = new Date(hrs[hrs.length - 1].t.getTime() + 3600e3);
  const items = [];
  for (const e of C.crossings(d => C.sunPos(d), from, to, -12)) items.push([e.t, e.rising ? 'Hämärä alkaa' : 'Pimeää (nautt. hämärä loppuu)']);
  for (const e of C.crossings(d => C.moonPos(d), from, to, 0)) items.push([e.t, e.rising ? `${MOON_EMOJI(n.moon.phase)} Kuu nousee` : `${MOON_EMOJI(n.moon.phase)} Kuu laskee`]);
  items.sort((a, b) => a[0] - b[0]);
  $('#sun-moon').innerHTML = items.map(([t, s]) => `<span><b>${C.hhmm(t)}</b> ${s}</span>`).join('')
    + `<span>${MOON_EMOJI(n.moon.phase)} <b>${Math.round(n.moon.fraction * 100)} %</b> ${n.moon.name}${!n.moon.events.length ? (n.moon.upAtStart ? ', taivaalla koko yön' : ', ei taivaalla') : ''}</span>`;
}

function hourDetail(r) {
  const l = C.local(r.t);
  const bits = [
    `Kp ${r.kp.toFixed(1)}`,
    r.cloud != null ? `pilviä ${Math.round(r.cloud)} %` : 'pilvisyys ei vielä tiedossa',
    r.temp != null ? `${Math.round(r.temp)} °C` : null,
    r.wind != null ? `tuuli ${Math.round(r.wind)} m/s` : null,
    r.moonAlt > 0 ? `kuu ${Math.round(r.moonFrac * 100)} % korkeudella ${Math.round(r.moonAlt)}°` : 'kuu horisontin alla',
    r.dark < 1 ? (r.dark === 0 ? 'valoisaa' : 'hämärää') : 'täysin pimeää',
  ].filter(Boolean);
  $('#hour-detail').innerHTML = `<b>Klo ${String(l.h).padStart(2, '0')}–${String((l.h + 1) % 24).padStart(2, '0')}</b> · indeksi <b>${r.score}</b> · näkymisen todennäköisyys <b>${r.prob} %</b><br>${bits.join(' · ')}`;
}

function renderNights(ns) {
  const list = ns.slice(0, 4);
  const best = list.reduce((a, b) => (b.chance > (a?.chance ?? -1) ? b : a), null);
  $('#nights').innerHTML = list.map((n, i) => `
    <div class="night ${n === best && list.length > 1 ? 'best' : ''}">
      <div class="d">${i === 0 ? 'Tänä yönä' : C.dayLabel(n.date, true)}</div>
      <div class="pct">${n.chance}<small> %</small></div>
      <div class="meter"><i style="width:${n.chance}%"></i></div>
      <div class="row"><span>Paras</span><b>${C.hh(n.from)}–${C.hh(n.to)}</b></div>
      <div class="row"><span>Kp max</span><b>${n.maxKp.toFixed(1)}</b></div>
      <div class="row"><span>Selkeää</span><b>${n.weatherKnown ? pct(n.meanClear) : '?'}</b></div>
      <div class="row"><span>Kuu</span><b>${MOON_EMOJI(n.moon.phase)} ${Math.round(n.moon.upHours)} h</b></div>
    </div>`).join('');
}

function renderOutlook(o) {
  if (!o?.length) { $('#outlook').innerHTML = '<span class="muted small">Ei saatavilla.</span>'; return; }
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const col = kp => kp >= 5 ? '#c06bff' : kp >= 4 ? '#3be3ff' : kp >= 3 ? '#22f5a0' : 'rgba(34,245,160,.35)';
  $('#outlook').innerHTML = o.filter(d => d.date >= today).slice(0, 21).map(d =>
    `<div class="od"><i style="background:${col(d.kp)}">${d.kp}</i>${d.date.getUTCDate()}.${d.date.getUTCMonth() + 1}.</div>`).join('')
    + '<div class="small" style="grid-column:1/-1;margin-top:4px">Suurin odotettu Kp per vuorokausi. Auringon 27 päivän pyörähdys toistaa usein samat purkausalueet.</div>';
}

function renderStorms(data, an) {
  const out = [];
  for (const c of (data.cmes || []).filter(c => C.cmeWindow(c).to > Date.now())) {
    out.push(`<div class="storm"><div class="t"><span class="tag c">CME</span>Osuma ${C.dayLabel(c.arrival)} n. klo ${C.hhmm(c.arrival)}</div>
      <div class="m">${c.glancing ? 'Sivuosuma' : 'Suora osuma'}${c.kpHigh != null ? ` · Kp-malli ${c.kpLow === c.kpHigh ? c.kpHigh : c.kpLow + '–' + c.kpHigh}` : ''}${c.speed ? ` · ${c.speed} km/s` : ''}${c.launched ? ` · purkautui ${C.dayLabel(c.launched)}` : ''}<br>Ikkuna ${C.dayLabel(C.cmeWindow(c).from)} ${C.hhmm(C.cmeWindow(c).from)} – ${C.dayLabel(C.cmeWindow(c).to)} ${C.hhmm(C.cmeWindow(c).to)}${c === an.nc.cme ? ' · <b style="color:#3be3ff">ikkuna auki – L1-valvonta päällä</b>' : ''}</div></div>`);
  }
  const seen = new Set();
  for (const a of (data.alerts || []).filter(a => a.kind !== 'SUMMARY' && (Date.now() - a.t < 48 * 3600e3 || (a.until && a.until > Date.now()) || a.days.some(d => d.date.getTime() + 864e5 > Date.now())))) {
    if (seen.has(a.fi)) continue; seen.add(a.fi);
    const tag = a.g ? `<span class="tag g">G${a.g}</span>` : a.k ? `<span class="tag k">K${a.k}</span>` : '';
    const days = a.days.filter(d => d.level !== 'None').map(d => `${C.dayLabel(d.date)} ${d.level}`).join(', ');
    out.push(`<div class="storm"><div class="t">${tag}${esc(a.fi)}</div><div class="m">NOAA ${C.dayLabel(a.t)} ${C.hhmm(a.t)}${days ? ' · ' + days : ''}${a.until ? ` · voimassa ${C.dayLabel(a.until)} ${C.hhmm(a.until)} asti` : ''}</div></div>`);
    if (seen.size >= 4) break;
  }
  const kpPeak = (data.kp || []).filter(r => r.kind === 'predicted').reduce((a, b) => (b.kp > (a?.kp ?? -1) ? b : a), null);
  const head = kpPeak ? `<p class="lead small">NOAA:n 3 vrk ennusteen suurin Kp <b>${kpPeak.kp.toFixed(1)}</b> (${C.dayLabel(kpPeak.t)} klo ${C.hh(kpPeak.t)}–${C.hh(new Date(kpPeak.t.getTime() + 3 * 3600e3))}).</p>` : '';
  $('#storm-list').innerHTML = head + (out.length ? out.join('')
    : `<div class="calm"><span>🌞</span><div>Ei Maata kohti matkaavia koronan massapurkauksia eikä myrskyvaroituksia. Ylläksellä revontulia näkyy silti usein – vyöhyke on suoraan yläpuolella.</div></div>`);
}

function spark(series, key, { min, max, zero } = {}) {
  if (!series?.length) return '';
  const vals = series.map(p => p[key]);
  const lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
  const W = 160, H = 34, t0 = series[0].t.getTime(), t1 = series[series.length - 1].t.getTime() || t0 + 1;
  const X = t => ((t - t0) / Math.max(1, t1 - t0)) * W, Y = v => H - 2 - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - 4);
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${X(p.t.getTime()).toFixed(1)},${Y(p[key]).toFixed(1)}`).join('');
  const z = zero != null && lo < zero && hi > zero ? `<line x1="0" x2="${W}" y1="${Y(zero)}" y2="${Y(zero)}" stroke="rgba(255,255,255,.2)" stroke-dasharray="2 3"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${z}<path d="${d}" fill="none" stroke="#3be3ff" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderSpace(data, nc) {
  const m = data.wind?.mag?.slice(-120), w = data.wind?.wind?.slice(-120);
  const bzMin = m?.length ? Math.min(-6, ...m.map(p => p.bz)) : -6, bzMax = m?.length ? Math.max(6, ...m.map(p => p.bz)) : 6;
  const cells = [
    `<div class="metric"><div class="k">Bz (2 h) · L1</div><div class="v">${nc.bzNow != null ? (nc.bzNow > 0 ? '+' : '') + nc.bzNow.toFixed(1) : '–'}<small>nT</small></div>
      <div class="h">${nc.bz == null ? '' : nc.bz < -3 ? 'Etelään – energiaa kertyy ⚡' : nc.bz < 0 ? 'Lievästi etelään' : 'Pohjoiseen – rauhallista'}</div>${spark(m, 'bz', { min: bzMin, max: bzMax, zero: 0 })}</div>`,
    `<div class="metric"><div class="k">Aurinkotuuli</div><div class="v">${nc.speed ? Math.round(nc.speed) : '–'}<small>km/s</small></div>
      <div class="h">${nc.density != null ? `tiheys ${nc.density.toFixed(1)} /cm³` : ''}${nc.leadMin ? ` · osuu Maahan ~${nc.leadMin} min` : ''}</div>${spark(w, 'v')}</div>`,
    `<div class="metric"><div class="k">Kp nyt</div><div class="v">${nc.kpNow.toFixed(1)}</div><div class="h">NOAA, arvio 1 min välein</div></div>`,
    `<div class="metric"><div class="k">OVATION</div><div class="v">${nc.ovNorth ?? '–'}<small>%</small></div><div class="h">revontulitodennäköisyys pohjoisessa ~30–90 min päähän</div></div>`,
  ];
  $('#space').innerHTML = cells.join('');

  const st = data.fmi ? ['KEV', 'KIL', 'IVA', 'MUO', 'PEL'].map(k => data.fmi[k]).filter(Boolean) : [];
  if (st.length) {
    const lvl = { low: 'matala', medium: 'kohtalainen', high: 'suuri' };
    $('#stations').innerHTML = st.map(s => {
      const max = Math.max(s.higher * 1.15, s.R);
      const col = s.level === 'high' ? 'linear-gradient(90deg,#3be3ff,#c06bff)' : s.level === 'medium' ? 'linear-gradient(90deg,#22f5a0,#3be3ff)' : 'rgba(143,163,191,.5)';
      return `<div class="station"><div class="n"><b>${esc(s.name)}</b>${s.code === 'MUO' ? ' ★' : ''}<br><small>${lvl[s.level]}</small></div>
        <div class="track"><div class="fill" style="width:${Math.min(100, 100 * s.R / max)}%;background:${col}"></div>
        <div class="lim" style="left:${100 * s.lower / max}%"></div><div class="lim" style="left:${100 * s.higher / max}%"></div></div>
        <div class="r">${s.R}</div></div>`;
    }).join('') + `<div class="small">Viivat = Ilmatieteen laitoksen rajat kohtalaiselle ja suurelle todennäköisyydelle. ★ Muonio on lähin asema (~50 km). Päivitetty ${C.hhmm(st[0].t)}.</div>`;
  } else if (data.mag && Object.keys(data.mag).length) {
    const s = Object.values(data.mag);
    $('#stations').innerHTML = s.map(x => `<div class="station"><div class="n"><b>${esc(x.name)}</b></div><div class="track"><div class="fill" style="width:${Math.min(100, x.range60 / 3)}%;background:linear-gradient(90deg,#22f5a0,#3be3ff)"></div></div><div class="r">${Math.round(x.range60)} nT</div></div>`).join('')
      + `<div class="small">Magnetometrin vaihteluväli tunnin aikana (avoin data, n. 1 h viiveellä – R-indeksin pikadata ei ollut saatavilla).</div>`;
  } else $('#stations').innerHTML = '<div class="small">Ei magnetometridataa.</div>';
}

function renderEscape(data, an) {
  const n = an.nights[0];
  const peakT = n ? new Date(n.peak.t.getTime() + 30 * 60e3) : new Date();
  const later = C.cloudEscape(data, peakT);
  const rows = an.escape.map(s => ({ ...s, later: later.find(x => x.id === s.id) }));
  const pill = (c, label) => {
    if (c == null) return `<div class="pill" style="background:rgba(255,255,255,.05)">–<small>${label}</small></div>`;
    const v = Math.round(c * 100), hue = 330 - 180 * c;
    return `<div class="pill" style="background:hsla(${hue},80%,60%,.16);color:hsl(${hue},90%,72%)">${v} %<small>${label}</small></div>`;
  };
  $('#escape').innerHTML = rows.map(s => `<div class="spot"><div><div class="nm">${esc(s.name)} <span class="km">${s.id === 'yllasjarvi' ? '· täällä' : `· ~${s.km} km`}</span></div><div class="tip">${esc(s.tip)}</div></div>
    ${pill(s.clear, 'nyt')}${pill(s.later?.clear, n ? 'klo ' + C.hh(n.peak.t) : '')}</div>`).join('')
    || '<div class="small">Pilviennustetta ei saatu.</div>';
}

function renderTips(nc, n) {
  $('#tips').innerHTML = C.photoTips(nc, n).map(t => `<dt>${esc(t.k)}</dt><dd>${esc(t.v)}</dd>`).join('');
}

function renderNotify() {
  const hashTopic = new URLSearchParams(location.hash.slice(1)).get('t');
  if (hashTopic) localStorage.setItem('tk:topic', hashTopic);
  const topic = localStorage.getItem('tk:topic');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let html = '';
  if (topic) {
    html += `<p class="lead small">Taustavahti tarkistaa tilanteen ~10 min välein myös silloin, kun sovellus on kiinni, ja lähettää ilmoituksen puhelimeen <b>ntfy</b>-sovelluksen kautta:</p>
      <ol class="steps"><li>Asenna <b>ntfy</b> App Storesta (ilmainen).</li><li>Napauta alta “Tilaa ilmoitukset” – tai lisää sovelluksessa tilaus aiheella <code>${esc(topic)}</code>.</li><li>Valmista! Saat: revontulet nyt, purkaus tulossa, myrskyvaroitukset, CME-osumat ja päivän katsauksen klo 15.</li></ol>
      <div class="notify-row"><a class="btn" href="ntfy://ntfy.sh/${encodeURIComponent(topic)}">🦊 Tilaa ilmoitukset</a><a class="btn alt" href="https://ntfy.sh/${encodeURIComponent(topic)}" target="_blank" rel="noopener">Avaa selaimessa</a></div>`;
  } else {
    html += `<p class="lead small">Taustailmoitukset puhelimeen tulevat ntfy-sovelluksen kautta – avaa sovellus linkillä, jossa on tilauskoodi (<code>#t=…</code>).</p>`;
  }
  if (perm !== 'unsupported') {
    html += `<p class="small" style="margin-top:14px">${perm === 'granted' ? '✅ Selainilmoitukset päällä, kun sovellus on auki.' : 'Halutessasi myös selainilmoitukset, kun sovellus on auki' + (standalone ? '' : ' (iPhonessa: Jaa → Lisää Koti-valikkoon ensin)') + '.'}</p>`;
    if (perm === 'default') html += `<div class="notify-row"><button class="btn alt" id="perm">Salli selainilmoitukset</button></div>`;
  }
  $('#notify').innerHTML = html;
  $('#perm')?.addEventListener('click', async () => { await Notification.requestPermission(); renderNotify(); });
}

async function localNotify(list) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const seen = JSON.parse(sessionStorage.getItem('tk:notified') || '{}');
  for (const c of list) {
    const k = c.level + '|' + c.title;
    if (seen[k] && Date.now() - seen[k] < 90 * 60e3) continue;
    seen[k] = Date.now();
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: c.text, icon: 'icon-180.png', tag: c.level };
    if (reg) reg.showNotification('🦊 ' + c.title, opts); else new Notification('🦊 ' + c.title, opts);
  }
  sessionStorage.setItem('tk:notified', JSON.stringify(seen));
}

function render() {
  const { data, an } = S;
  const { nc } = an;
  renderHero(nc);
  renderCertain(an.certain);
  const tonight = an.nights.find(n => Date.now() < n.darkEnd) || an.nights[0];
  renderTonight(tonight, nc);
  if (S.sel == null && tonight) {
    const ni = tonight.hours.findIndex(r => Date.now() >= r.t && Date.now() < r.t.getTime() + 3600e3);
    hourDetail(tonight.hours[ni >= 0 && tonight.hours[ni].dark > 0 ? ni : tonight.hours.indexOf(tonight.peak)]);
  }
  renderNights(an.nights.filter(n => n.darkEnd > Date.now()));
  renderOutlook(data.outlook);
  renderStorms(data, an);
  renderSpace(data, nc);
  renderEscape(data, an);
  renderTips(nc, tonight);
  const errs = Object.keys(data.errors);
  $('#updated').textContent = `päivitetty ${C.hhmm(data.fetched)}` + (errs.length ? ` · ${errs.length} lähde ei vastannut` : '');
  localNotify(an.certain.filter(c => ['shock', 'live', 'soon', 'storm', 'cme'].includes(c.level)));
}

async function load() {
  if (S.loading) return;
  S.loading = true;
  $('#refresh').innerHTML = `<span id="updated">${$('#updated')?.textContent || ''}</span> <span class="spin">⟳</span>`;
  try {
    const data = await C.fetchAll(cachedFetch, { fmiSnapshot: './fmi.json' });
    if (data.fmi && !Object.keys(data.fmi).length) data.fmi = null;
    S.data = data; S.an = C.analyse(data);
    render();
  } catch (e) {
    console.error(e);
    $('#label').textContent = 'Datan haku epäonnistui';
  } finally {
    S.loading = false;
    $('#refresh').innerHTML = `<span id="updated">${S.data ? 'päivitetty ' + C.hhmm(S.data.fetched) : 'yritä uudelleen'}</span> ⟳`;
  }
}

function tick() { $('#clock').textContent = `${C.dayLabel(new Date())} klo ${C.hhmm(new Date())}`; }

sky();
tick(); setInterval(tick, 30e3);
renderNotify();
$('#refresh').addEventListener('click', load);
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data && Date.now() - S.data.fetched > 2 * 60e3) load(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Tulikettu – revontulivahti Ylläsjärvelle.
// Shared logic: runs both in the browser (app.js) and in Node (watcher.mjs).
// No dependencies. All data sources are public, CORS-enabled APIs.

export const SITE = { name: 'Ylläsjärvi', lat: 67.551, lon: 24.222, tz: 'Europe/Helsinki' };

// Places within a short drive for "pilvipako" (chasing a clear sky).
export const SPOTS = [
  { id: 'yllasjarvi', name: 'Ylläsjärvi', lat: 67.551, lon: 24.222, tip: 'Järven jäältä avautuu esteetön näkymä pohjoiseen.' },
  { id: 'akaslompolo', name: 'Äkäslompolo', lat: 67.604, lon: 24.150, tip: 'Äkäsjärven jää kylän pohjoispuolella, vähän valosaastetta.' },
  { id: 'kolari', name: 'Kolari', lat: 67.330, lon: 23.790, tip: 'Tornionjoen rannat etelän kautta.' },
  { id: 'pallas', name: 'Pallas', lat: 68.046, lon: 24.063, tip: 'Tunturien välissä, lähes pimeää.' },
  { id: 'muonio', name: 'Muonio', lat: 67.958, lon: 23.680, tip: 'Jerisjärven ja Muonionjoen suunnat.' },
  { id: 'levi', name: 'Levi / Sirkka', lat: 67.802, lon: 24.808, tip: 'Immeljärven jää Sirkan eteläpuolella.' },
  { id: 'kittila', name: 'Kittilä', lat: 67.660, lon: 24.910, tip: 'Ounasjoen rannat.' },
  { id: 'hetta', name: 'Hetta', lat: 68.383, lon: 23.630, tip: 'Ounasjärven jää, hyvin pimeää.' },
  { id: 'pello', name: 'Pello', lat: 66.774, lon: 23.966, tip: 'Etelämpänä — vain kun pohjoinen on pilvessä.' },
];

const UA_FETCH_TIMEOUT = 20000;

// ───────────────────────── helpers ─────────────────────────

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

function interp(table, x) {
  // table: [[x, y], ...] sorted by x
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return table[table.length - 1][1];
}

export function haversineKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SITE.tz, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
/** Local (Helsinki) wall-clock parts of a Date. */
export function local(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: p.weekday };
}
const WD_FI = { Mon: 'ma', Tue: 'ti', Wed: 'ke', Thu: 'to', Fri: 'pe', Sat: 'la', Sun: 'su' };
const WD_FI_LONG = { Mon: 'maanantai', Tue: 'tiistai', Wed: 'keskiviikko', Thu: 'torstai', Fri: 'perjantai', Sat: 'lauantai', Sun: 'sunnuntai' };
export const hhmm = d => { const l = local(d); return `${String(l.h).padStart(2, '0')}.${String(l.mi).padStart(2, '0')}`; };
export const hh = d => String(local(d).h).padStart(2, '0');
export const dayLabel = (d, long = false) => { const l = local(d); return `${(long ? WD_FI_LONG : WD_FI)[l.wd]} ${l.d}.${l.mo}.`; };

/** UTC offset (ms) of Helsinki at a given instant. */
function tzOffsetMs(date) {
  const l = local(date);
  const asUtc = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}
/** Date for a Helsinki wall-clock time. */
export function atLocal(y, mo, d, h, mi = 0) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return new Date(guess.getTime() - tzOffsetMs(guess));
}

async function getJSON(url, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UA_FETCH_TIMEOUT);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function getText(url, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UA_FETCH_TIMEOUT);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ───────────────────────── astronomy (after SunCalc, V. Agafonkin, BSD) ─────────────────────────

const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, obl = rad * 23.4397;
const toDays = date => date.valueOf() / dayMs - 0.5 + J1970 - J2000;
const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(obl) - Math.tan(b) * Math.sin(obl), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(obl) + Math.cos(b) * Math.sin(obl) * Math.sin(l));
const azimuthOf = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitudeOf = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}
function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.229350 * d);
  const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F), dist = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist };
}
/** Sun altitude/azimuth in degrees (azimuth from north, clockwise). */
export function sunPos(date, lat = SITE.lat, lon = SITE.lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(date), c = sunCoords(d), H = siderealTime(d, lw) - c.ra;
  return { alt: altitudeOf(H, phi, c.dec) / rad, az: (azimuthOf(H, phi, c.dec) / rad + 180) % 360 };
}
export function moonPos(date, lat = SITE.lat, lon = SITE.lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(date), c = moonCoords(d), H = siderealTime(d, lw) - c.ra;
  let h = altitudeOf(H, phi, c.dec);
  const hr = h < 0 ? 0 : h;
  h += 0.0002967 / Math.tan(hr + 0.00312536 / (hr + 0.08901179)); // refraction
  return { alt: h / rad, az: (azimuthOf(H, phi, c.dec) / rad + 180) % 360 };
}
/** fraction 0..1 lit, phase 0=new .5=full */
export function moonIllum(date) {
  const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI };
}
export function moonPhaseName(phase) {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.03 || p > 0.97) return 'uusikuu';
  if (p < 0.22) return 'kasvava sirppi';
  if (p < 0.28) return 'ensimmäinen neljännes';
  if (p < 0.47) return 'kasvava kuu';
  if (p < 0.53) return 'täysikuu';
  if (p < 0.72) return 'vähenevä kuu';
  if (p < 0.78) return 'viimeinen neljännes';
  return 'vähenevä sirppi';
}
/** Scan [from,to] in 5-min steps for altitude crossings of a body. */
export function crossings(fn, from, to, thresholdDeg) {
  const out = [];
  let prev = fn(from).alt - thresholdDeg;
  for (let t = from.getTime() + 300000; t <= to.getTime(); t += 300000) {
    const cur = fn(new Date(t)).alt - thresholdDeg;
    if ((prev < 0) !== (cur < 0)) out.push({ t: new Date(t - 150000), rising: cur > 0 });
    prev = cur;
  }
  return out;
}

// ───────────────────────── data fetchers ─────────────────────────

const NOAA = 'https://services.swpc.noaa.gov';

export async function fetchKpForecast(f) {
  const rows = await getJSON(`${NOAA}/products/noaa-planetary-k-index-forecast.json`, f);
  return rows.map(r => ({ t: new Date(r.time_tag + 'Z'), kp: +r.kp, kind: r.observed, scale: r.noaa_scale }))
    .filter(r => !isNaN(r.kp));
}

export async function fetchKpNow(f) {
  const rows = await getJSON(`${NOAA}/json/planetary_k_index_1m.json`, f);
  const last = rows[rows.length - 1];
  return { t: new Date(last.time_tag + 'Z'), kp: +last.estimated_kp };
}

export async function fetchSolarWind(f) {
  const [mag, wind] = await Promise.all([
    getJSON(`${NOAA}/json/rtsw/rtsw_mag_1m.json`, f),
    getJSON(`${NOAA}/json/rtsw/rtsw_wind_1m.json`, f),
  ]);
  const since = Date.now() - 3 * 3600e3;
  const m = mag.filter(x => x.active && x.bz_gsm != null)
    .map(x => ({ t: new Date(x.time_tag + 'Z'), bz: +x.bz_gsm, bt: +x.bt }))
    .filter(x => x.t.getTime() >= since).sort((a, b) => a.t - b.t);
  const w = wind.filter(x => x.active && x.proton_speed != null)
    .map(x => ({ t: new Date(x.time_tag + 'Z'), v: +x.proton_speed, n: +x.proton_density }))
    .filter(x => x.t.getTime() >= since).sort((a, b) => a.t - b.t);
  return { mag: m, wind: w };
}

export async function fetchOvation(f) {
  const j = await getJSON(`${NOAA}/json/ovation_aurora_latest.json`, f);
  let here = 0, north = 0;
  for (const [lon, lat, v] of j.coordinates) {
    if (lon === Math.round(SITE.lon) && lat === Math.round(SITE.lat)) here = v;
    // Aurora up to ~4° of latitude to the north is visible above the northern horizon.
    if (lon >= 20 && lon <= 28 && lat >= 67 && lat <= 72) north = Math.max(north, v);
  }
  return { t: new Date(j['Forecast Time']), observed: new Date(j['Observation Time']), here, north };
}

export async function fetchAlerts(f) {
  const rows = await getJSON(`${NOAA}/products/alerts.json`, f);
  const since = Date.now() - 3 * 864e5;
  return rows.map(r => ({ id: r.product_id + '|' + r.issue_datetime, code: r.product_id, t: new Date(r.issue_datetime.replace(' ', 'T') + 'Z'), msg: r.message }))
    .filter(r => r.t.getTime() >= since)
    .map(parseAlert).filter(Boolean)
    .sort((a, b) => b.t - a.t);
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseAlert(a) {
  const m = a.msg;
  const headline = (m.match(/\n((?:ALERT|WATCH|WARNING|EXTENDED WARNING|SUMMARY|CANCEL[^:]*):[^\r\n]+)/) || [])[1];
  if (!headline) return null;
  const kind = headline.split(':')[0].trim();
  // Only geomagnetic-relevant products matter for aurora.
  if (!/geomagnetic|k-index|cme|sudden impulse|magnetic/i.test(headline + m.slice(0, 400))) return null;
  const g = (headline.match(/Category\s+G(\d)/i) || m.match(/G(\d)\s*\(/) || [])[1];
  const k = (headline.match(/K-index of (\d)/i) || [])[1];
  // Date lines in WATCH products: "Nov 24:  G1 (Minor)"
  const days = [...m.matchAll(/\b([A-Z][a-z]{2})\s+(\d{1,2}):\s+(G\d|None)/g)].map(x => ({
    date: new Date(Date.UTC(new Date(a.t).getUTCFullYear(), MONTHS[x[1]], +x[2])), level: x[3],
  }));
  const validUntil = (m.match(/(?:Now )?Valid Until:\s*(\d{4}) (\w{3}) (\d{1,2}) (\d{2})(\d{2}) UTC/) || []);
  return {
    ...a, kind, headline: headline.trim(), g: g ? +g : null, k: k ? +k : null, days,
    until: validUntil.length ? new Date(Date.UTC(+validUntil[1], MONTHS[validUntil[2]], +validUntil[3], +validUntil[4], +validUntil[5])) : null,
    fi: translateAlert(kind, headline, g, k),
  };
}
function translateAlert(kind, headline, g, k) {
  const kindFi = { ALERT: 'Hälytys', WATCH: 'Ennakkovaroitus', WARNING: 'Varoitus', 'EXTENDED WARNING': 'Jatkettu varoitus', SUMMARY: 'Yhteenveto' }[kind] || kind;
  if (/sudden impulse/i.test(headline)) return `${kindFi}: magneettikentän äkillinen isku – aurinkotuulen shokki saapui`;
  if (/Storm Category G\d Predicted/i.test(headline)) return `${kindFi}: geomagneettinen myrsky G${g} ennustettu`;
  if (/K-index of (\d)/i.test(headline)) return `${kindFi}: K-indeksi ${k}${/expected/i.test(headline) ? ' odotettavissa' : ' saavutettu'}`;
  if (/Geomagnetic Storm/i.test(headline)) return `${kindFi}: geomagneettinen myrsky${g ? ' G' + g : ''}`;
  return `${kindFi}: ${headline.replace(/^[^:]+:\s*/, '')}`;
}

export async function fetch27Day(f) {
  const txt = await getText(`${NOAA}/text/27-day-outlook.txt`, f);
  return [...txt.matchAll(/^(\d{4}) (\w{3}) (\d{2})\s+(\d+)\s+(\d+)\s+(\d+)/gm)].map(x => ({
    date: new Date(Date.UTC(+x[1], MONTHS[x[2]], +x[3])), flux: +x[4], ap: +x[5], kp: +x[6],
  }));
}

/** CMEs with a modelled Earth impact (NASA DONKI WSA-Enlil runs). */
export async function fetchCMEs(f, apiKey = 'DEMO_KEY') {
  const end = new Date(), start = new Date(Date.now() - 7 * 864e5);
  const iso = d => d.toISOString().slice(0, 10);
  const sims = await getJSON(`https://api.nasa.gov/DONKI/WSAEnlilSimulations?startDate=${iso(start)}&endDate=${iso(end)}&api_key=${apiKey}`, f);
  const byCme = new Map();
  for (const s of sims || []) {
    if (!s.estimatedShockArrivalTime) continue;
    const arrival = new Date(s.estimatedShockArrivalTime);
    const cme = s.cmeInputs?.[0];
    const id = cme?.CMEID || s.simulationID;
    const prev = byCme.get(id);
    const rec = {
      id, arrival, glancing: !!s.isEarthGB, minor: !!s.isEarthMinorImpact,
      ...(() => { const k = [s.kp_18, s.kp_90, s.kp_135, s.kp_180].filter(x => x != null);
        return { kpLow: k.length ? Math.min(...k) : null, kpHigh: k.length ? Math.max(...k) : null }; })(),
      speed: cme?.speed ?? null, launched: cme?.cmeStartTime ? new Date(cme.cmeStartTime) : null,
      modelled: new Date(s.modelCompletionTime), link: s.link,
    };
    if (!prev || rec.modelled > prev.modelled) byCme.set(id, rec);
  }
  return [...byCme.values()]
    .filter(c => c.arrival.getTime() > Date.now() - 36 * 3600e3)
    .sort((a, b) => a.arrival - b.arrival);
}

const FMI_STATIONS = [
  { code: 'MUO', name: 'Muonio', lat: 68.0224, lon: 23.5201 },
  { code: 'PEL', name: 'Pello', lat: 66.9042, lon: 24.0798 },
  { code: 'IVA', name: 'Ivalo', lat: 68.559, lon: 27.289 },
  { code: 'KIL', name: 'Kilpisjärvi', lat: 69.058, lon: 20.7747 },
];
/** FMI magnetometers (X component, 1-min). Returns per-station series and trailing-hour activity in nT. */
export async function fetchMagnetometer(f) {
  const start = new Date(Date.now() - 3 * 3600e3);
  start.setUTCSeconds(0, 0);
  const url = 'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature'
    + '&storedquery_id=fmi::observations::magnetometer::simple&bbox=20,66.5,28,69.5'
    + `&starttime=${start.toISOString().replace('.000', '')}&parameters=MAGNX_PT1M_AVG&timestep=1`;
  const xml = await getText(url, f);
  const series = {};
  const re = /<gml:pos>([\d.]+)\s+([\d.]+)\s*<\/gml:pos>[\s\S]*?<BsWfs:Time>([^<]+)<\/BsWfs:Time>[\s\S]*?<BsWfs:ParameterValue>([^<]+)<\/BsWfs:ParameterValue>/g;
  for (const m of xml.matchAll(re)) {
    const lat = +m[1], lon = +m[2], v = parseFloat(m[4]);
    if (isNaN(v)) continue;
    const st = FMI_STATIONS.find(s => Math.abs(s.lat - lat) < 0.05 && Math.abs(s.lon - lon) < 0.05);
    if (!st) continue;
    (series[st.code] ||= []).push({ t: new Date(m[3]), x: v });
  }
  const stations = {};
  for (const st of FMI_STATIONS) {
    const s = (series[st.code] || []).sort((a, b) => a.t - b.t);
    if (!s.length) continue;
    const last = s[s.length - 1].t.getTime();
    const hour = s.filter(p => p.t.getTime() > last - 3600e3).map(p => p.x);
    const q = s.filter(p => p.t.getTime() > last - 15 * 60e3).map(p => p.x);
    stations[st.code] = {
      ...st, series: s, last: new Date(last),
      range60: Math.max(...hour) - Math.min(...hour),
      range15: Math.max(...q) - Math.min(...q),
    };
  }
  return stations;
}

/**
 * FMI's official auroral activity: R-index per station (updated every 5 min, station-specific
 * thresholds for medium/high aurora probability) and RX next-hour nowcast.
 * These files are not CORS-enabled, so the browser reads a snapshot published by watcher.mjs
 * (`snapshotUrl`), while Node reads FMI directly.
 */
export const FMI_R_URL = 'https://space.fmi.fi/MIRACLE/RWC/data/r_index_latest_en.json';
export const FMI_RX_URL = 'https://space.fmi.fi/MIRACLE/RWC/data/RX_latest_en.json';
export async function fetchFmiR(f, snapshotUrl) {
  let r, rx;
  if (snapshotUrl) ({ r, rx } = await getJSON(snapshotUrl + '?' + Math.floor(Date.now() / 60000), f));
  else [r, rx] = await Promise.all([getJSON(FMI_R_URL, f), getJSON(FMI_RX_URL, f).catch(() => null)]);
  const out = {};
  for (const [code, v] of Object.entries(r?.data || {})) {
    if (v['R-index'] == null) continue;
    const x = rx?.data?.[code];
    out[code] = {
      code, name: v.Station, t: new Date(v.Time.replace(' ', 'T')), R: v['R-index'],
      lower: v['Limit value lower'], higher: v['Limit value higher'],
      level: v['R-index'] >= v['Limit value higher'] ? 'high' : v['R-index'] >= v['Limit value lower'] ? 'medium' : 'low',
      rx: x?.RX?.value ?? null, rxMin: x?.RXmin?.value ?? null, rxMax: x?.RXmax?.value ?? null,
    };
  }
  return out;
}

/** R-index relative to FMI's station thresholds → probability aurora is overhead now. */
export function rToActivity(s) {
  if (!s) return null;
  if (s.R < s.lower) return 0.05 + 0.5 * clamp(s.R / s.lower);
  return 0.6 + 0.38 * clamp((s.R - s.lower) / (s.higher - s.lower));
}

/** Hourly cloud forecast for SITE + SPOTS (MET Nordic → ECMWF seamless). */
export async function fetchClouds(f) {
  const pts = SPOTS;
  const url = 'https://api.open-meteo.com/v1/forecast?'
    + `latitude=${pts.map(p => p.lat).join(',')}&longitude=${pts.map(p => p.lon).join(',')}`
    + '&hourly=cloud_cover,temperature_2m,wind_speed_10m'
    + '&models=metno_seamless&timeformat=unixtime&forecast_days=4&past_hours=3&wind_speed_unit=ms';
  const arr = await getJSON(url, f);
  const list = Array.isArray(arr) ? arr : [arr];
  const out = {};
  list.forEach((loc, i) => {
    const h = loc.hourly;
    out[pts[i].id] = h.time.map((t, k) => ({
      t: new Date(t * 1000),
      total: h.cloud_cover[k],
      temp: h.temperature_2m[k], wind: h.wind_speed_10m[k],
    })).filter(r => r.total != null);
  });
  return out;
}

/** Fetch everything; individual failures become null so the app degrades gracefully. */
export async function fetchAll(f = fetch, { nasaKey, fmiSnapshot, skip = [] } = {}) {
  const jobs = {
    fmi: fetchFmiR(f, fmiSnapshot),
    kp: fetchKpForecast(f), kpNow: fetchKpNow(f), wind: fetchSolarWind(f), ovation: fetchOvation(f),
    alerts: fetchAlerts(f), outlook: fetch27Day(f), cmes: fetchCMEs(f, nasaKey), mag: fetchMagnetometer(f),
    clouds: fetchClouds(f),
  };
  for (const k of skip) delete jobs[k];
  const keys = Object.keys(jobs);
  const res = await Promise.allSettled(Object.values(jobs));
  const data = { fetched: new Date(), errors: {} };
  res.forEach((r, i) => {
    data[keys[i]] = r.status === 'fulfilled' ? r.value : null;
    if (r.status === 'rejected') data.errors[keys[i]] = String(r.reason?.message || r.reason);
  });
  return data;
}

// ───────────────────────── model ─────────────────────────

/**
 * Chance that aurora is overhead/visible from Ylläs (geomagnetic lat ≈ 64.5°) given Kp,
 * ignoring clouds/daylight. The auroral oval sits over Finnish Lapland even at low Kp:
 * FMI: aurora is seen on ~3 of 4 clear dark nights in Lapland.
 */
export const kpToActivity = kp => interp([[0, 0.28], [1, 0.42], [2, 0.6], [3, 0.76], [4, 0.87], [5, 0.94], [6, 0.97], [9, 0.99]], kp);

/** Aurora is most frequent around magnetic midnight, ~23–24 local time in Finland. */
export function timeOfNightFactor(date, kp = 2) {
  const l = local(date);
  let dh = l.h + l.mi / 60 - 23.5;
  if (dh < -12) dh += 24; if (dh > 12) dh -= 24;
  const width = 2.6 + Math.max(0, kp - 3) * 0.5; // storms spread over the whole night
  return 0.45 + 0.55 * Math.exp(-(dh * dh) / (2 * width * width));
}

/** Magnetometer trailing-hour range (nT) → probability aurora is overhead right now. */
export const magToActivity = nT => interp([[0, 0.05], [20, 0.25], [50, 0.55], [100, 0.8], [200, 0.94], [400, 0.99]], nT);

export function darknessFactor(sunAlt) {
  if (sunAlt > -4) return 0;
  if (sunAlt > -8) return lerp(0, 0.45, (-4 - sunAlt) / 4);
  if (sunAlt > -12) return lerp(0.45, 0.85, (-8 - sunAlt) / 4);
  if (sunAlt > -16) return lerp(0.85, 1, (-12 - sunAlt) / 4);
  return 1;
}

/** Bright moon high in the sky washes out faint aurora (strong aurora still shines through). */
export function moonFactor(moonAlt, fraction) {
  if (moonAlt <= 0) return 1;
  return 1 - 0.4 * fraction * clamp(Math.sin(moonAlt * rad) * 2.2);
}

/** Share of sky clear. (metno_seamless mixes models for cloud layers, so only total cover is used.) */
export function clearness(c) {
  if (!c || c.total == null) return null;
  return clamp(1 - c.total / 100);
}

function kpAt(kp, t) {
  if (!kp?.length) return 2;
  let best = kp[0];
  for (const r of kp) if (r.t <= t) best = r;
  return best.kp;
}

function cloudAt(series, t) {
  if (!series?.length) return null;
  let best = null, bd = Infinity;
  for (const r of series) { const d = Math.abs(r.t - t); if (d < bd) { bd = d; best = r; } }
  return bd <= 90 * 60e3 ? best : null;
}

/** Real-time picture: what's happening right now and in the next ~hour. */
export function nowcast(data, now = new Date()) {
  const kpNow = data.kpNow?.kp ?? kpAt(data.kp, now);
  const muo = data.mag?.MUO || data.mag?.PEL || null;
  const fmi = data.fmi?.MUO || data.fmi?.PEL || null;
  const fmiFresh = fmi && now - fmi.t < 30 * 60e3;
  const magNT = muo?.range60 ?? null;
  const fresh = muo && now - muo.last < 40 * 60e3;
  const wind = data.wind;
  const recentMag = wind?.mag?.filter(x => now - x.t < 30 * 60e3) || [];
  const bz = recentMag.length ? recentMag.reduce((s, x) => s + x.bz, 0) / recentMag.length : null;
  const bzNow = wind?.mag?.length ? wind.mag[wind.mag.length - 1].bz : null;
  const speed = wind?.wind?.length ? wind.wind[wind.wind.length - 1].v : null;
  const density = wind?.wind?.length ? wind.wind[wind.wind.length - 1].n : null;
  const southMinutes = (() => { // consecutive minutes Bz < -3 up to now
    if (!wind?.mag?.length) return 0;
    let n = 0; for (let i = wind.mag.length - 1; i >= 0 && wind.mag[i].bz < -3; i--) n++; return n;
  })();

  // L1 (1.5 million km sunward): solar wind measured there reaches Earth after ~1.5e6/v seconds.
  const leadMin = speed ? Math.round(1.5e6 / speed / 60) : null;
  const cme = activeCme(data.cmes, now);
  // Inside a predicted CME window we use a more sensitive detector (slow glancing CMEs barely jump in speed).
  const shock = detectShock(wind?.wind, now) || (cme ? detectCmeEdge(wind, now) : null);
  const strongSouthMinutes = (() => {
    if (!wind?.mag?.length) return 0;
    let n = 0; for (let i = wind.mag.length - 1; i >= 0 && wind.mag[i].bz <= -5; i--) n++; return n;
  })();

  const ov = data.ovation;
  const ovAct = ov ? clamp(ov.north / 45) : null;
  const kpAct = kpToActivity(kpNow) * timeOfNightFactor(now, kpNow);
  const model = 0.6 * kpAct + 0.4 * (ovAct ?? kpAct);
  let act, source;
  if (fmiFresh) { act = Math.max(rToActivity(fmi), 0.7 * model); source = 'fmi'; }
  else if (fresh && magNT != null) { act = Math.max(magToActivity(magNT), 0.8 * model); source = 'mag'; }
  else { act = model; source = 'model'; }

  // Coupling: southward Bz × speed → energy loading; substorm likely within ~30–90 min.
  const coupling = bz != null && speed ? Math.max(0, -bz) * speed / 1000 : 0; // mV/m-ish
  const loading = clamp((coupling - 1) / 4); // 0 at ~1 mV/m, 1 at ~5 mV/m
  let soon = clamp(act + loading * 0.35 * (1 - act));
  if (fmiFresh && fmi.rxMax != null) soon = Math.max(soon * 0.8, rToActivity({ ...fmi, R: fmi.rxMax }) * 0.9);

  const sun = sunPos(now), moon = moonPos(now), mi = moonIllum(now);
  const cl = clearness(cloudAt(data.clouds?.yllasjarvi, now));
  const dark = darknessFactor(sun.alt), mf = moonFactor(moon.alt, mi.fraction);
  const clear = cl ?? 0.5;
  const visible = act * clear * dark;
  const score = Math.round(100 * visible * (0.75 + 0.25 * mf));
  return {
    t: now, kpNow, source, fmi: fmiFresh ? fmi : null, magNT, magStation: muo?.name, magFresh: !!fresh, range15: muo?.range15 ?? null,
    bz, bzNow, speed, density, southMinutes, strongSouthMinutes, leadMin, shock, cme, coupling, loading,
    ovHere: ov?.here ?? null, ovNorth: ov?.north ?? null,
    act, soon, clear: cl, dark, sunAlt: sun.alt, moonAlt: moon.alt, moonAz: moon.az, moonFrac: mi.fraction, moonPhase: mi.phase, mf,
    score, label: scoreLabel(score, dark),
  };
}

/**
 * CME shock / sudden solar wind jump at L1: speed up ≥ 60 km/s and density ×1.8 (or ≥ 15 /cm³)
 * within ~10 min, seen in the last 90 min. Returns arrival estimate at Earth.
 */
export function detectShock(wind, now = new Date()) {
  if (!wind?.length) return null;
  const recent = wind.filter(p => now - p.t < 90 * 60e3);
  for (let i = recent.length - 1; i >= 0; i--) {
    const p = recent[i];
    const before = wind.filter(q => p.t - q.t >= 8 * 60e3 && p.t - q.t <= 20 * 60e3);
    if (before.length < 3) continue;
    const v0 = before.reduce((s, q) => s + q.v, 0) / before.length;
    const n0 = before.reduce((s, q) => s + q.n, 0) / before.length;
    const after = recent.filter(q => q.t >= p.t && q.t - p.t <= 5 * 60e3);
    if (after.length < 2) continue;
    const v1 = after.reduce((s, q) => s + q.v, 0) / after.length;
    const n1 = after.reduce((s, q) => s + q.n, 0) / after.length;
    if (v1 - v0 >= 60 && (n1 >= 1.8 * n0 || n1 >= 15)) {
      const arrival = new Date(p.t.getTime() + 1.5e6 / v1 * 1000);
      return { t: p.t, v0: Math.round(v0), v1: Math.round(v1), n0: +n0.toFixed(1), n1: +n1.toFixed(1), arrival };
    }
  }
  return null;
}

/**
 * Uncertainty window of a modelled CME arrival. Glancing blows are fuzzier, and slow CMEs
 * (< 500 km/s) tend to arrive later than WSA-Enlil predicts, so the window leans late.
 */
export function cmeWindow(c) {
  const H = 3600e3;
  const slow = c.speed != null && c.speed < 500;
  const before = (c.glancing ? 10 : 7) * H, after = (c.glancing ? 18 : 10) * H + (slow ? 4 * H : 0);
  return { from: new Date(c.arrival.getTime() - before), to: new Date(c.arrival.getTime() + after) };
}
export function activeCme(cmes, now = new Date()) {
  return (cmes || []).find(c => { const w = cmeWindow(c); return now >= w.from && now <= w.to; }) || null;
}

/**
 * Sensitive CME-edge detector for use inside a predicted arrival window: last 10 min vs the
 * 30–90 min baseline — density ×2 (≥ 6 /cm³), total field ×1.7 (≥ 8 nT) or speed +40 km/s.
 */
export function detectCmeEdge(wind, now = new Date()) {
  const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
  const win = (arr, a, b) => (arr || []).filter(p => now - p.t >= a * 60e3 && now - p.t < b * 60e3);
  const w1 = win(wind?.wind, 0, 10), w0 = win(wind?.wind, 30, 90);
  const m1 = win(wind?.mag, 0, 10), m0 = win(wind?.mag, 30, 90);
  const reasons = [];
  let v1 = null, n0, n1, b0, b1, v0;
  if (w1.length >= 3 && w0.length >= 10) {
    v0 = avg(w0, 'v'); v1 = avg(w1, 'v'); n0 = avg(w0, 'n'); n1 = avg(w1, 'n');
    if (n1 >= 2 * n0 && n1 >= 6) reasons.push(`tiheys ${n0.toFixed(1)}→${n1.toFixed(1)} /cm³`);
    if (v1 - v0 >= 40) reasons.push(`nopeus ${Math.round(v0)}→${Math.round(v1)} km/s`);
  }
  if (m1.length >= 3 && m0.length >= 10) {
    b0 = avg(m0, 'bt'); b1 = avg(m1, 'bt');
    if (b1 >= 1.7 * b0 && b1 >= 8) reasons.push(`magneettikenttä ${b0.toFixed(1)}→${b1.toFixed(1)} nT`);
  }
  if (!reasons.length) return null;
  const v = v1 || 400;
  const t = new Date(now.getTime() - 10 * 60e3);
  return { t, edge: true, reasons, v1: Math.round(v), arrival: new Date(t.getTime() + 1.5e6 / v * 1000) };
}

export function scoreLabel(score, dark = 1) {
  if (dark === 0) return 'Päivänvaloa';
  if (score >= 70) return 'MENE ULOS!';
  if (score >= 50) return 'Hyvät mahdollisuudet';
  if (score >= 30) return 'Mahdollista';
  if (score >= 15) return 'Heikkoa';
  return 'Hiljaista';
}

/** Hour-by-hour forecast for the next `hours` hours. */
export function hourly(data, now = new Date(), hours = 84, nc = null) {
  const out = [];
  // Start from the most recent local noon so "tonight" always shows the whole night.
  const L = local(now);
  let start = atLocal(L.y, L.mo, L.d, 12);
  if (start > now) start = atLocal(L.y, L.mo, L.d - 1, 12);
  const nowHour = Math.floor(now.getTime() / 3600e3) * 3600e3;
  hours += Math.round((nowHour - start.getTime()) / 3600e3);
  for (let i = 0; i <= hours; i++) {
    const t = new Date(start.getTime() + i * 3600e3);
    const mid = new Date(t.getTime() + 30 * 60e3);
    const kp = kpAt(data.kp, mid);
    let act = kpToActivity(kp) * timeOfNightFactor(mid, kp);
    const ahead = Math.round((t.getTime() - nowHour) / 3600e3);
    // Blend real-time knowledge into the next ~3 hours.
    if (nc && ahead >= 0 && ahead <= 3) {
      const w = [0.85, 0.6, 0.35, 0.15][ahead];
      act = w * nc.soon + (1 - w) * act;
    }
    const sun = sunPos(mid), moon = moonPos(mid), mi = moonIllum(mid);
    const c = cloudAt(data.clouds?.yllasjarvi, mid);
    const cl = clearness(c);
    const dark = darknessFactor(sun.alt);
    const mf = moonFactor(moon.alt, mi.fraction);
    const clear = cl ?? 0.55; // unknown weather beyond model range → climatology-ish
    const visible = act * clear * dark;
    out.push({
      t, kp, act, cloud: c?.total ?? null, clear: cl, temp: c?.temp ?? null, wind: c?.wind ?? null,
      sunAlt: sun.alt, moonAlt: moon.alt, moonFrac: mi.fraction, dark, mf,
      prob: Math.round(100 * visible), score: Math.round(100 * visible * (0.75 + 0.25 * mf)),
      weatherKnown: cl != null, past: t.getTime() + 3600e3 <= now.getTime(),
    });
  }
  return out;
}

/** Group hourly rows into nights (noon→noon local) and find each night's best window. */
export function nights(rows) {
  const groups = new Map();
  for (const r of rows) {
    const l = local(r.t);
    // night belongs to the evening date: hours 0–11 belong to previous day
    const key = l.h < 12 ? atLocal(l.y, l.mo, l.d - 1, 12).getTime() : atLocal(l.y, l.mo, l.d, 12).getTime();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const res = [];
  for (const [key, hrs] of groups) {
    const darkAll = hrs.filter(h => h.dark > 0.3);
    const darkHrs = darkAll.filter(h => !h.past); // chance/peak only from the hours still ahead
    if (!darkHrs.length) continue;
    const peak = darkHrs.reduce((a, b) => (b.score > a.score ? b : a));
    // Best window: contiguous hours around peak with score ≥ 70% of peak.
    const idx = hrs.indexOf(peak);
    let a = idx, b = idx;
    const thr = Math.max(peak.score * 0.7, 8);
    while (a > 0 && !hrs[a - 1].past && hrs[a - 1].score >= thr) a--;
    while (b < hrs.length - 1 && hrs[b + 1].score >= thr) b++;
    const maxKp = Math.max(...darkHrs.map(h => h.kp));
    const avgClear = darkHrs.filter(h => h.clear != null);
    const darkStart = darkAll[0].t, darkEnd = new Date(darkHrs[darkHrs.length - 1].t.getTime() + 3600e3);
    // Any-time-of-night chance: 1 − Π(1 − p_h) with heavy correlation → use a softened combination.
    const pNight = 1 - darkHrs.reduce((acc, h) => acc * (1 - h.prob / 100) ** 0.35, 1);
    res.push({
      date: new Date(key), hours: hrs, peak, from: hrs[a].t, to: new Date(hrs[b].t.getTime() + 3600e3),
      maxKp, darkStart, darkEnd, weatherKnown: darkHrs.some(h => h.weatherKnown),
      meanClear: avgClear.length ? avgClear.reduce((s, h) => s + h.clear, 0) / avgClear.length : null,
      chance: Math.round(100 * pNight), moon: moonSummary(darkStart, darkEnd),
    });
  }
  return res;
}

export function moonSummary(from, to) {
  const mid = new Date((from.getTime() + to.getTime()) / 2);
  const mi = moonIllum(mid);
  const ev = crossings(d => moonPos(d), from, to, 0);
  const upAtStart = moonPos(from).alt > 0;
  let upHours = 0; for (let t = from.getTime(); t < to.getTime(); t += 1800e3) if (moonPos(new Date(t)).alt > 0) upHours += 0.5;
  return { fraction: mi.fraction, phase: mi.phase, name: moonPhaseName(mi.phase), events: ev, upAtStart, upHours };
}

/** "Certainty" signals: when we can say with confidence that aurora is coming / happening. */
export function certainty(data, nc, nightsList, now = new Date()) {
  const out = [];
  const clearNow = nc.clear != null && nc.clear >= 0.5;
  const live = nc.fmi ? (nc.fmi.level !== 'low') : (nc.magFresh && nc.magNT >= 120);
  if (live && nc.dark > 0.4) {
    const high = nc.fmi ? nc.fmi.level === 'high' : nc.magNT >= 200;
    const what = nc.fmi
      ? `Ilmatieteen laitoksen ${nc.fmi.name}n R-indeksi on ${nc.fmi.R} (raja ${high ? nc.fmi.higher : nc.fmi.lower}) – ${high ? 'suuri' : 'kohtalainen'} todennäköisyys revontulille juuri nyt.`
      : `${nc.magStation}n magnetometri näyttää ${Math.round(nc.magNT)} nT aktiivisuutta tunnin sisällä.`;
    out.push({
      level: clearNow ? 'live' : 'live-cloudy', strong: high,
      title: clearNow ? (high ? 'Revontulet ovat taivaalla NYT – lähes varmasti' : 'Revontulia todennäköisesti taivaalla nyt') : 'Revontulet loimuavat pilvien yllä',
      text: `${what} ${clearNow ? (nc.moonAlt > 10 && nc.moonFrac > 0.5 ? 'Kuu valaisee, joten etsi pimeä paikka ja katso pohjoiseen.' : 'Taivas on riittävän selkeä. Ulos!') : 'Pilviä on — katso Pilvipako-osio.'}`,
    });
  } else if (nc.dark > 0.4 && nc.loading >= 0.5 && nc.southMinutes >= 15) {
    out.push({
      level: 'soon', title: 'Purkaus todennäköinen pian',
      text: `Aurinkotuulen magneettikenttä on ollut etelään (Bz ${nc.bz.toFixed(1)} nT) ${nc.southMinutes} min nopeudella ${Math.round(nc.speed)} km/s. Energiaa kertyy – revontulten purkaus on todennäköinen 20–60 minuutin sisällä.`,
    });
  }
  if (nc.shock) {
    const mins = Math.round((nc.shock.arrival - now) / 60e3);
    const jump = nc.shock.edge ? nc.shock.reasons.join(', ') : `nopeus ${nc.shock.v0}→${nc.shock.v1} km/s, tiheys ${nc.shock.n0}→${nc.shock.n1} /cm³`;
    out.push({
      level: 'shock', id: 'shock:' + (nc.cme?.id || nc.shock.t.toISOString().slice(0, 13)),
      title: mins > 0 ? `${nc.shock.edge ? 'CME:n reuna' : 'Aurinkomyrskyn shokki'} saapui L1:lle – osuu Maahan ~${mins} min päästä` : `${nc.shock.edge ? 'CME:n reuna' : 'Aurinkomyrskyn shokki'} osui juuri Maahan`,
      text: `SOLAR-1-satelliitti L1-pisteessä mittasi hypyn: ${jump} (klo ${hhmm(nc.shock.t)}). Arvioitu osuma klo ${hhmm(nc.shock.arrival)}, revontulet näkyvät tyypillisesti 30–60 min kuluttua. Ratkaisevaa on Bz: jos se kääntyy etelään (negatiiviseksi), revontulet voivat räjähtää koko taivaalle.`,
    });
  }
  if (nc.cme && !nc.shock) {
    const w = cmeWindow(nc.cme);
    out.push({
      level: 'cmewatch', id: 'cmewatch:' + nc.cme.id,
      title: `CME voi saapua milloin tahansa – ikkuna ${dayLabel(w.from)} ${hhmm(w.from)} – ${dayLabel(w.to)} ${hhmm(w.to)}`,
      text: `${nc.cme.glancing ? 'Hidas sivuosuma' : 'Osuma'}${nc.cme.speed ? ` (~${nc.cme.speed} km/s)` : ''}: NASA:n malli ${hhmm(nc.cme.arrival)}, mutta tällaisen saapumisaika on hyvin epävarma – se voi myös ohittaa Maan. Tulikettu vahtii L1-satelliittia 10 min välein ja ilmoittaa heti, kun tiheys hyppää tai Bz kääntyy etelään (silloin 30–60 min aikaa).`,
    });
  }
  if (nc.cme && nc.strongSouthMinutes >= 10 && nc.dark > 0.3 && !out.some(o => o.level === 'soon')) {
    out.push({
      level: 'soon', id: 'cmesouth',
      title: 'Bz kääntyi etelään CME-ikkunassa',
      text: `Aurinkotuulen Bz on ollut ${nc.strongSouthMinutes} min alle −5 nT (nyt ${nc.bzNow?.toFixed(1)} nT). Energiaa virtaa magnetosfääriin – revontulia todennäköisesti 30–60 min sisällä.`,
    });
  }
  const tonight = nightsList[0];
  const watches = (data.alerts || []).filter(a => a.kind === 'WATCH' && a.g);
  for (const w of watches) {
    const day = w.days.find(d => d.level !== 'None' && d.date.getTime() + 864e5 > now.getTime());
    if (day) out.push({ level: 'storm', title: `Geomagneettinen myrsky ${day.level} ennustettu`, text: `NOAA:n ennakkovaroitus ${dayLabel(day.date)} (UTC). Myrskyn aikana revontulet ovat Ylläksellä käytännössä varmat, jos taivas on selkeä – usein koko taivaan värikkäinä koronoina.` });
  }
  for (const c of data.cmes || []) {
    if (cmeWindow(c).to < now || c === nc.cme) continue;
    out.push({
      level: 'cme', title: `Koronan massapurkaus osuu Maahan ${dayLabel(c.arrival)} n. klo ${hhmm(c.arrival)}`,
      text: `NASA:n WSA-Enlil-malli: ${c.glancing ? 'sivuosuma' : 'suora osuma'}${c.kpHigh != null ? `, Kp-ennuste ${c.kpLow === c.kpHigh ? c.kpHigh : c.kpLow + '–' + c.kpHigh}` : ''}. Saapumisikkuna ${hhmm(cmeWindow(c).from)}–${hhmm(cmeWindow(c).to)} (${c.glancing ? 'sivuosuma, epävarma' : 'tyypillinen virhe ±7 h'}).`,
    });
  }
  if (tonight && tonight.maxKp >= 5 && (tonight.meanClear ?? 0) >= 0.5) {
    out.push({ level: 'storm', title: 'Myrskyöö tulossa', text: `Kp-ennuste ${tonight.maxKp.toFixed(1)} tänä yönä ja taivas lupaa olla selkeä – tämä on se yö.` });
  }
  return out;
}

export function photoTips(nc, night) {
  const strong = (nc?.magNT ?? 0) > 150 || (night?.maxKp ?? 0) >= 5;
  const moonUp = nc?.moonAlt > 0 && nc?.moonFrac > 0.4;
  return [
    { k: 'Puhelin', v: 'Yötila + jalusta tai lumikinokseen nojaten → 10–30 s valotus (iPhonessa paina pitkään yötilan säätöä). Tarkennus äärettömään.' },
    { k: 'Kamera', v: `f/1.8–2.8, ISO ${moonUp ? '800–1600' : '1600–3200'}, ${strong ? '1–4 s (nopeat liikkeet terävinä)' : '6–12 s'}, käsitarkennus kirkkaaseen tähteen.` },
    { k: 'Akut', v: 'Pakkasella akku hyytyy nopeasti – pidä vara-akku ja puhelin sisätaskussa.' },
    { k: 'Silmät', v: 'Anna silmien tottua pimeään 15–20 min. Käytä punaista valoa, älä katso näyttöä täysillä kirkkauksilla.' },
    { k: 'Suunta', v: 'Hiljaisina öinä revontulet alkavat usein pohjoistaivaalta matalalta kaarena; aktiivisina öinä koko taivas ja jopa etelä.' },
  ];
}

/** Clear-sky ranking of nearby spots for a given time. */
export function cloudEscape(data, t = new Date()) {
  if (!data.clouds) return [];
  return SPOTS.map(s => {
    const c = cloudAt(data.clouds[s.id], t);
    return { ...s, km: Math.round(haversineKm(SITE, s) * 1.25), cloud: c?.total ?? null, clear: clearness(c) };
  }).filter(s => s.clear != null).sort((a, b) => b.clear - a.clear || a.km - b.km);
}

export function analyse(data, now = new Date()) {
  const nc = nowcast(data, now);
  const rows = hourly(data, now, 84, nc);
  const ns = nights(rows);
  return { nc, rows, nights: ns, certain: certainty(data, nc, ns, now), escape: cloudEscape(data, now) };
}

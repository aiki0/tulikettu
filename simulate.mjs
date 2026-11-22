#!/usr/bin/env node
// Simulates a storm night with synthetic data and prints the notifications the watcher would send.
//   node simulate.mjs
import * as C from './core.js';
import { decide } from './watcher.mjs';

const day = (h, m = 0) => C.atLocal(2026, 11, 23, h, m);
const H = 3600e3, MIN = 60e3;

// Scenario timeline (local time, Monday 23.11.)
const EDGE = day(18, 40);           // CME edge reaches L1
const SOUTH = day(18, 55);          // Bz turns south
const cloudsAt = (spot, t) => {     // clouds roll in over Ylläs at 22:00, Pallas stays clear
  if (spot === 'pallas' || spot === 'hetta') return 5;
  return t >= day(22) ? 90 : 25;
};
const rAt = t => t < day(19, 25) ? 30 : t < day(20) ? 140 : t < day(21, 30) ? 360 : 230;

function dataAt(now) {
  const wind = [], mag = [];
  for (let t = now - 3 * H; t <= now; t += MIN) {
    const after = t >= EDGE.getTime();
    wind.push({ t: new Date(t), v: after ? 430 : 335, n: after ? 11 : 1.2 });
    mag.push({ t: new Date(t), bt: after ? 14 : 3.4, bz: t >= SOUTH.getTime() ? -9 : after ? 3 : 1.8 });
  }
  const clouds = {};
  for (const s of C.SPOTS) clouds[s.id] = Array.from({ length: 80 }, (_, i) => {
    const t = new Date(day(12).getTime() + i * H);
    return { t, total: cloudsAt(s.id, t), temp: -14, wind: 2 };
  });
  return {
    fetched: now, errors: {},
    kp: Array.from({ length: 30 }, (_, i) => ({ t: new Date(Date.UTC(2026, 10, 22) + i * 3 * H), kp: now >= SOUTH ? 5.33 : 3.67, kind: 'predicted' })),
    kpNow: { kp: now >= day(19, 30) ? 5.33 : 2.3 },
    wind: { wind, mag },
    ovation: { here: now >= SOUTH ? 45 : 12, north: now >= SOUTH ? 60 : 14 },
    fmi: { MUO: { code: 'MUO', name: 'Muonio', t: new Date(now - 4 * MIN), R: rAt(now), lower: 75, higher: 300,
      level: rAt(now) >= 300 ? 'high' : rAt(now) >= 75 ? 'medium' : 'low', rxMax: rAt(now) } },
    alerts: [], outlook: [],
    cmes: [{ id: '2026-11-19T08:09:00-CME-001', arrival: new Date('2026-11-23T00:00:00Z'), glancing: true, speed: 364, kpLow: 2, kpHigh: 4 }],
    mag: null, clouds,
  };
}

// Pretend the morning already happened: CME was announced, watch mode was announced.
const state = { sent: {}, seen: { 'cme:2026-11-19T08:09:00-CME-001': 1, 'cme:2026-11-19T08:09:00-CME-001:arr': +new Date('2026-11-23T00:00:00Z'), 'cmewatch:2026-11-19T08:09:00-CME-001': 1 } };
const P = { 5: 'KIIREELLINEN', 4: 'korkea', 3: 'normaali' };
for (let t = day(15).getTime(); t <= day(23, 50).getTime(); t += 10 * MIN) {
  const now = new Date(t);
  for (const m of decide(dataAt(now), state, now, { log: false })) {
    console.log(`\n┌─ ${C.hhmm(now)}  [${P[m.priority] || m.priority}]\n│ ${m.title}\n│ ${m.message.replace(/\n/g, '\n│ ')}\n└─`);
  }
}

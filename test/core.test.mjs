import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';

test('sun altitude at Ylläsjärvi local noon on 23 Nov is ~2°', () => {
  const alt = C.sunPos(C.atLocal(2026, 11, 23, 12)).alt;
  assert.ok(alt > 1 && alt < 3.5, `alt ${alt}`);
});

test('atLocal round-trips Helsinki wall clock (winter and summer time)', () => {
  for (const [mo, h] of [[1, 22], [7, 3]]) {
    const l = C.local(C.atLocal(2026, mo, 15, h, 30));
    assert.deepEqual([l.mo, l.d, l.h, l.mi], [mo, 15, h, 30]);
  }
});

test('full moon ~Nov 24 2026', () => {
  assert.ok(C.moonIllum(new Date('2026-11-24T12:00Z')).fraction > 0.97);
});

test('activity rises with Kp, R-index and darkness', () => {
  assert.ok(C.kpToActivity(5) > C.kpToActivity(2));
  assert.ok(C.rToActivity({ R: 320, lower: 75, higher: 300 }) > 0.95);
  assert.ok(C.rToActivity({ R: 20, lower: 75, higher: 300 }) < 0.3);
  assert.equal(C.darknessFactor(0), 0);
  assert.equal(C.darknessFactor(-20), 1);
  assert.ok(C.timeOfNightFactor(C.atLocal(2026, 11, 23, 23, 30)) > C.timeOfNightFactor(C.atLocal(2026, 11, 23, 17)));
});

test('analyse works on synthetic data and flags a live, clear, dark storm', () => {
  const now = C.atLocal(2026, 11, 26, 22, 30); // moon low-ish, dark
  const kp = Array.from({ length: 24 }, (_, i) => ({ t: new Date(now.getTime() - 24 * 3600e3 + i * 3 * 3600e3), kp: 6, kind: 'predicted' }));
  const clouds = { yllasjarvi: Array.from({ length: 96 }, (_, i) => ({ t: new Date(now.getTime() - 12 * 3600e3 + i * 3600e3), total: 5 })) };
  const fmi = { MUO: { code: 'MUO', name: 'Muonio', t: new Date(now.getTime() - 5 * 60e3), R: 420, lower: 75, higher: 300, level: 'high', rxMax: 300 } };
  const a = C.analyse({ kp, clouds, fmi, kpNow: { kp: 6 }, alerts: [], cmes: [] }, now);
  assert.ok(a.nc.score >= 70, `score ${a.nc.score}`);
  assert.equal(a.nc.label, 'MENE ULOS!');
  assert.ok(a.certain.some(c => c.level === 'live' && c.strong));
  assert.ok(a.nights[0].chance > 90);
  assert.ok(a.nights[0].from >= C.atLocal(2026, 11, 26, 22) || a.nights[0].from <= now);
});

test('alert parser understands a NOAA watch', () => {
  // exercised through the exported fetcher with a fake fetch
  const msg = 'Space Weather Message Code: WATA20\r\nSerial Number: 1\r\nIssue Time: 2026 Nov 23 1200 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G2 Predicted\r\n\r\nHighest Storm Level Predicted by Day:\r\nNov 24:  G2 (Moderate)   Nov 25:  G1 (Minor)   Nov 26:  None (Below G1)\r\n';
  const fake = async () => ({ ok: true, json: async () => [{ product_id: 'A20F', issue_datetime: new Date().toISOString().replace('T', ' ').slice(0, 23), message: msg }] });
  return C.fetchAlerts(fake).then(list => {
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'WATCH');
    assert.equal(list[0].g, 2);
    assert.match(list[0].fi, /G2 ennustettu/);
    assert.deepEqual(list[0].days.map(d => d.level), ['G2', 'G1', 'None']);
  });
});

test('detects a CME shock at L1 and estimates Earth arrival', () => {
  const now = new Date('2026-11-25T20:00:00Z');
  const wind = Array.from({ length: 60 }, (_, i) => {
    const t = new Date(now.getTime() - (59 - i) * 60e3);
    return i < 45 ? { t, v: 380, n: 4 } : { t, v: 620, n: 22 };
  });
  const s = C.detectShock(wind, now);
  assert.ok(s, 'shock found');
  const mins = (s.arrival - s.t) / 60e3;
  assert.ok(mins > 35 && mins < 45, `lead ${mins}`);
  assert.equal(C.detectShock(wind.map(p => ({ ...p, v: 380, n: 4 })), now), null);
});

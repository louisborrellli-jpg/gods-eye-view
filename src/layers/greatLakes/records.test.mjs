import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GREAT_LAKES_STATIONS,
  parseWaterLevelReading,
  formatLevelMeters,
  createGreatLakesOverlayEntry,
} from './records.js';

const STATION = Object.freeze({
  id: '9044020',
  name: 'Gibraltar',
  state: 'MI',
  lat: 42.090862,
  lng: -83.186,
});

test('station table is complete, unique, and geographically sane', () => {
  assert.equal(GREAT_LAKES_STATIONS.length, 52);
  const ids = new Set(GREAT_LAKES_STATIONS.map((s) => s.id));
  assert.equal(ids.size, 52, 'station ids are unique');
  for (const s of GREAT_LAKES_STATIONS) {
    assert.match(s.id, /^\d{7}$/, `${s.id} is a 7-digit CO-OPS id`);
    assert.ok(s.name && typeof s.name === 'string');
    // Great Lakes basin: North America, upper-right quadrant of the globe.
    assert.ok(s.lat > 40 && s.lat < 49, `${s.name} latitude`);
    assert.ok(s.lng > -93 && s.lng < -75, `${s.name} longitude`);
  }
});

test('parseWaterLevelReading: a live reading becomes a metric record', () => {
  const payload = {
    metadata: { id: '9044020', name: 'Gibraltar' },
    data: [{ t: '2026-10-21 05:36', v: '174.437', s: '0.0', q: 'p' }],
  };
  const rec = parseWaterLevelReading(payload, STATION);
  assert.equal(rec.id, '9044020');
  assert.equal(rec.name, 'Gibraltar');
  assert.equal(rec.state, 'MI');
  assert.equal(rec.level, 174.437);
  assert.equal(rec.datum, 'IGLD');
  assert.equal(rec.time, '2026-10-21T05:36:00Z', 'GMT stamp becomes an instant');
  assert.equal(rec.lat, STATION.lat);
  assert.equal(rec.lng, STATION.lng);
});

test('parseWaterLevelReading: error / empty / non-numeric payloads are skipped', () => {
  assert.equal(
    parseWaterLevelReading({ error: { message: 'No data' } }, STATION),
    null,
  );
  assert.equal(parseWaterLevelReading({ data: [] }, STATION), null);
  assert.equal(parseWaterLevelReading({}, STATION), null);
  assert.equal(
    parseWaterLevelReading({ data: [{ t: '2026-10-21 05:36', v: '' }] }, STATION),
    null,
    'a blank value is not a reading',
  );
});

test('parseWaterLevelReading: a reading with an unparseable stamp keeps a null time', () => {
  const rec = parseWaterLevelReading(
    { data: [{ t: 'whenever', v: '176.4' }] },
    STATION,
  );
  assert.equal(rec.level, 176.4);
  assert.equal(rec.time, null);
});

test('formatLevelMeters shows one decimal with a unit', () => {
  assert.equal(formatLevelMeters(174.437), '174.4 m');
  assert.equal(formatLevelMeters(183), '183.0 m');
});

test('overlay entry is a non-interactive ambient label', () => {
  const entry = createGreatLakesOverlayEntry({
    id: '9044020',
    position: { x: 1, y: 2, z: 3 },
    title: 'Gibraltar · 174.4 m',
    priority: 1,
  });
  assert.equal(entry.variant, 'label');
  assert.equal(entry.interactive, false);
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.title, 'Gibraltar · 174.4 m');
  assert.equal(entry.id, '9044020');
});

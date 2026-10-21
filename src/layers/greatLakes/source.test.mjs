import assert from 'node:assert/strict';
import test from 'node:test';

import { createGreatLakesSource } from './source.js';

const STATIONS = Object.freeze([
  Object.freeze({ id: '9044020', name: 'Gibraltar', state: 'MI', lat: 42.09, lng: -83.18 }),
  Object.freeze({ id: '9063063', name: 'Cleveland', state: 'OH', lat: 41.54, lng: -81.63 }),
  Object.freeze({ id: '9099064', name: 'Duluth', state: 'MN', lat: 46.77, lng: -92.09 }),
]);

function reading(v) {
  return {
    ok: true,
    async json() {
      return { data: [{ t: '2026-10-21 05:36', v: String(v) }] };
    },
  };
}

test('queries each gauge from the fixed table and returns a record apiece', async () => {
  const seen = [];
  const source = createGreatLakesSource({
    stations: STATIONS,
    fetchImpl: async (url) => {
      seen.push(url);
      return reading(175);
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.partial, false);
  // The id, datum and units come from the source, never the caller.
  for (const station of STATIONS) {
    assert.ok(
      seen.some((u) => u.includes(`station=${station.id}`)),
      `queried ${station.id}`,
    );
  }
  assert.ok(seen.every((u) => u.includes('datum=IGLD')));
  assert.ok(seen.every((u) => u.includes('units=metric')));
  assert.ok(seen.every((u) => u.includes('product=water_level')));
  assert.ok(seen.every((u) => u.startsWith('https://api.tidesandcurrents.noaa.gov/')));
});

test('records are sorted by station name', async () => {
  const source = createGreatLakesSource({
    stations: STATIONS,
    fetchImpl: async () => reading(175),
  });
  const { records } = await source.getSnapshot();
  assert.deepEqual(
    records.map((r) => r.name),
    ['Cleveland', 'Duluth', 'Gibraltar'],
  );
});

test('a single dead gauge is skipped and the snapshot flagged partial', async () => {
  const source = createGreatLakesSource({
    stations: STATIONS,
    fetchImpl: async (url) => {
      if (url.includes('station=9063063')) return { ok: false, status: 503 };
      return reading(175);
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.partial, true);
  assert.ok(!snapshot.records.some((r) => r.name === 'Cleveland'));
});

test('a network error on one gauge is tolerated, not thrown', async () => {
  const source = createGreatLakesSource({
    stations: STATIONS,
    fetchImpl: async (url) => {
      if (url.includes('station=9099064')) throw new Error('ECONNRESET');
      return reading(175);
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.partial, true);
});

test('every gauge failing is a real outage', async () => {
  const source = createGreatLakesSource({
    stations: STATIONS,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => source.getSnapshot(), /unavailable/);
});

test('an aborted signal stops the fetch before any request', async () => {
  let calls = 0;
  const source = createGreatLakesSource({
    stations: STATIONS,
    fetchImpl: async () => {
      calls++;
      return reading(175);
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => source.getSnapshot({ signal: controller.signal }));
  assert.equal(calls, 0, 'no gauge is queried once aborted');
});

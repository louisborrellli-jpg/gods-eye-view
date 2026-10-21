import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWatchFeeds,
  emergencyEvents,
  fireEvents,
  quakeEvents,
} from './feeds.js';

test('USGS features become quake events; bad rows are skipped', () => {
  const events = quakeEvents({
    features: [
      {
        id: 'us1',
        geometry: { coordinates: [139, 35, 10] },
        properties: { mag: 4.1, time: 5, place: 'Japan' },
      },
      {
        id: 'us2',
        geometry: { coordinates: [999, 35, 10] },
        properties: { mag: 4.1 },
      },
      {
        id: 'us3',
        geometry: { coordinates: [1, 2] },
        properties: { mag: null },
      },
    ],
  });
  assert.deepEqual(events, [
    {
      id: 'quake:us1',
      kind: 'quake',
      lat: 35,
      lon: 139,
      atMs: 5,
      mag: 4.1,
      depthKm: 10,
      place: 'Japan',
    },
  ]);
});

test('fires and emergencies keep stable ids', () => {
  const [fire] = fireEvents({
    fires: [
      { lat: 1.23456, lon: 2, acqDate: '2026-10-21', acqTime: '0130', frp: 9 },
    ],
  });
  assert.equal(fire.id, 'fire:1.235:2.000:2026-10-21T0130');
  const [ac] = emergencyEvents({
    fetchedAt: 7,
    aircraft: [
      {
        hex: 'abc123',
        flight: 'BAW1',
        squawk: '7700',
        lat: 51,
        lon: 0,
        altFt: 30000,
      },
    ],
  });
  assert.equal(ac.id, 'emergency:abc123:7700');
  assert.equal(ac.atMs, 7);
});

test('a missing FIRMS key is reported, not thrown', async () => {
  const feeds = createWatchFeeds({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'no_key' }),
    }),
  });
  assert.deepEqual(await feeds.fire(), { events: [], keyRequired: true });
  await assert.rejects(feeds.quake(), /USGS HTTP 503/);
});

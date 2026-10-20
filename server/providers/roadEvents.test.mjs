import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRoadEvent,
  parseBbox,
  roadEventsProxy,
} from './roadEvents.js';

// Shape of a live 511on event row (Oct 2026).
const row = (id, lat, lon, extra = {}) => ({
  ID: id,
  Organization: 'MTO',
  RoadwayName: 'HWY 401',
  DirectionOfTravel: 'Westbound',
  Description:
    'Daily Construction on HWY 401 Westbound between Meyers Road and Meyers Road, Windsor. 1 Left Lane(s).',
  Reported: 1775559600,
  LastUpdated: 1775155380,
  PlannedEndDate: 1795841940,
  LanesAffected: '1 Left Lane(s)',
  Latitude: lat,
  Longitude: lon,
  LatitudeSecondary: null,
  LongitudeSecondary: null,
  EventType: 'roadwork',
  EventSubType: null,
  IsFullClosure: false,
  Severity: 'Unknown',
  ...extra,
});
const ROWS = [
  row(1, 42.25, -82.95),
  row(2, 42.3, -83.0, {
    EventType: 'accidentsAndIncidents',
    IsFullClosure: true,
  }),
  row(3, 43.65, -79.38), // Toronto
  row(4, 'x', -83), // bad coordinate
];

test('a 511on row normalizes; bad rows drop', () => {
  const e = normalizeRoadEvent(ROWS[1]);
  assert.equal(e.id, 'on511-2');
  assert.equal(e.type, 'accidentsandincidents');
  assert.equal(e.fullClosure, true);
  assert.equal(e.updatedAt, '2026-04-02T18:43:00.000Z');
  assert.equal(normalizeRoadEvent(ROWS[3]), null);
  assert.equal(normalizeRoadEvent({ ...ROWS[0], ID: '../1' }), null);
  assert.equal(
    normalizeRoadEvent({ ...ROWS[0], Description: '<script>x</script>' })
      .description,
    'script x /script',
  );
});

test('bbox parsing rejects inverted or malformed boxes', () => {
  assert.deepEqual(parseBbox('bbox=-83.2,42.1,-82.8,42.4'), {
    west: -83.2,
    south: 42.1,
    east: -82.8,
    north: 42.4,
  });
  assert.equal(parseBbox(''), null);
  assert.throws(() => parseBbox('bbox=1,2,3'));
  assert.throws(() => parseBbox('bbox=-83,42.4,-82,42.1'));
});

function harness({ key = 'k', fetchImpl, clock = { t: 1_000_000 } } = {}) {
  const calls = [];
  const plugin = roadEventsProxy({
    apiKey: () => key,
    now: () => clock.t,
    fetchImpl:
      fetchImpl ??
      (async (url) => {
        calls.push(String(url));
        return Response.json(ROWS);
      }),
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  const call = (url = '/') =>
    new Promise((resolve) =>
      handler(
        { method: 'GET', url },
        {
          writeHead(s) {
            this.s = s;
          },
          end(b) {
            resolve({ status: this.s, body: JSON.parse(b) });
          },
        },
      ),
    );
  return { call, calls, clock };
}

test('the proxy filters to a box, caches two minutes, and sends the key', async () => {
  const { call, calls, clock } = harness();
  const windsor = await call('/?bbox=-83.2,42.1,-82.8,42.4');
  assert.deepEqual(
    windsor.body.events.map((e) => e.id),
    ['on511-1', 'on511-2'],
  );
  const all = await call('/');
  assert.equal(all.body.events.length, 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /[?&]key=k(&|$)/);
  clock.t += 3 * 60_000;
  await call('/');
  assert.equal(calls.length, 2);
});

test('no key answers unavailable with the reason; bad bbox is a 400', async () => {
  const { call, calls } = harness({ key: '' });
  const r = await call('/');
  assert.equal(r.body.unavailable, true);
  assert.match(r.body.reason, /ONTARIO_511_API_KEY/);
  assert.equal(calls.length, 0);
  assert.equal((await call('/?bbox=nope')).status, 400);
});

test('an upstream failure serves the cache, marked stale', async () => {
  let fail = false;
  const clock = { t: 0 };
  const { call } = harness({
    clock,
    fetchImpl: async () =>
      fail ? new Response(null, { status: 500 }) : Response.json(ROWS),
  });
  await call('/');
  fail = true;
  clock.t += 3 * 60_000;
  const r = await call('/');
  assert.equal(r.body.stale, true);
  assert.equal(r.body.events.length, 3);
});

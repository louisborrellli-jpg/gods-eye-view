import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { validateBorderSnapshot } from '../../sources/borderWaits.js';
import { validateRoadEventsSnapshot } from '../../sources/roadEvents.js';
import { crossesBorder } from './windsor.js';

const lane = (minutes, status = 'open') => ({ minutes, status });
const snapshot = {
  schemaVersion: 1,
  source: 'CBSA (Canada-bound) and U.S. CBP (U.S.-bound)',
  attribution: 'CBSA; CBP',
  fetchedAt: '2026-10-20T12:30:00.000Z',
  stale: false,
  partial: false,
  unavailable: false,
  reason: null,
  crossings: [
    {
      id: 'ambassador-bridge',
      name: 'Ambassador Bridge',
      cities: 'Windsor, ON / Detroit, MI',
      lat: 42.3118,
      lon: -83.074,
      toCanada: {
        travellers: lane(0),
        commercial: lane(5),
        updatedAt: '2026-10-20T12:30:00.000Z',
      },
      toUS: {
        portStatus: 'open',
        updatedAt: '2026-10-20T12:20:02.000Z',
        travellers: { ...lane(25), lanesOpen: 2 },
        nexus: { ...lane(5), lanesOpen: 3 },
        commercial: { ...lane(5), lanesOpen: 4 },
        fast: null,
        notice: null,
      },
    },
    {
      id: 'windsor-detroit-tunnel',
      name: 'Detroit–Windsor Tunnel',
      cities: 'Windsor, ON / Detroit, MI',
      lat: 42.3213,
      lon: -83.0405,
      toCanada: {
        travellers: lane(15),
        commercial: lane(null, 'not_applicable'),
        updatedAt: '2026-10-20T12:30:00.000Z',
      },
      toUS: { unavailable: true, reason: 'CBP feed unavailable' },
    },
  ],
};

const borders = { getSnapshot: async () => validateBorderSnapshot(snapshot) };

test('the client validator rejects a malformed snapshot', () => {
  assert.throws(() => validateBorderSnapshot({ schemaVersion: 2 }));
  assert.throws(() =>
    validateBorderSnapshot({
      ...snapshot,
      crossings: [
        {
          ...snapshot.crossings[0],
          toUS: { travellers: { minutes: -4, status: 'open' } },
        },
      ],
    }),
  );
  assert.throws(() =>
    validateBorderSnapshot({
      ...snapshot,
      crossings: [{ ...snapshot.crossings[0], id: '../x' }],
    }),
  );
});

test('get_border_waits reports both directions and the fastest crossing', async () => {
  const catalog = composeCatalog({ tools: coreTools, services: { borders } });
  const result = await catalog.call('get_border_waits', {});
  assert.match(
    result.summary,
    /Ambassador Bridge: into Canada no delay \(trucks 5 min\); into US 25 min/,
  );
  assert.match(
    result.summary,
    /Detroit–Windsor Tunnel: into Canada 15 min .*; into US unavailable\./,
  );
  assert.deepEqual(result.data.fastest_to_us, {
    id: 'ambassador-bridge',
    name: 'Ambassador Bridge',
    minutes: 25,
  });
  assert.equal(result.data.fastest_to_canada.id, 'ambassador-bridge');
  assert.equal(result.data.crossings[1].to_us.unavailable, true);
});

test('get_border_waits says so when both feeds are down', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      borders: {
        getSnapshot: async () => ({
          ...snapshot,
          unavailable: true,
          crossings: [],
        }),
      },
    },
  });
  await assert.rejects(
    catalog.call('get_border_waits', {}),
    /unavailable right now/,
  );
});

test('the Detroit River check matches real trips', () => {
  const windsor = { lat: 42.3149, lon: -83.0364 };
  assert.equal(crossesBorder(windsor, { lat: 42.3314, lon: -83.0458 }), true); // Detroit
  assert.equal(crossesBorder(windsor, { lat: 42.3223, lon: -83.1763 }), true); // Dearborn
  assert.equal(crossesBorder(windsor, { lat: 42.2808, lon: -82.9478 }), false); // east Windsor
  assert.equal(crossesBorder({ lat: 42.1, lon: -83.11 }, windsor), false); // Amherstburg
  assert.equal(crossesBorder(windsor, { lat: 43.65, lon: -79.38 }), false); // Toronto: out of range
});

test('the commute brief still answers when traffic and cameras are unavailable', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      borders,
      weather: {
        getConditions: async () => ({
          weather: { temperature_2m: 9, weather_code: 3 },
          status: 'ok',
        }),
      },
    },
  });
  const result = await catalog.call('windsor_commute_brief', {
    from: { lat: 42.3149, lon: -83.0364 },
    to: { lat: 42.3314, lon: -83.0458 },
  });
  assert.match(
    result.summary,
    /^Commute 42\.3149, -83\.0364 → 42\.3314, -83\.0458:/,
  );
  assert.match(
    result.summary,
    /Trip crosses into the US\. Fastest: Ambassador Bridge \(25 min\); Detroit–Windsor Tunnel n\/a\./,
  );
  assert.equal(result.data.sections.borders.direction, 'to_us');
  assert.equal(result.data.sections.borders.crosses_border, true);
  assert.equal(result.data.sections.traffic.unavailable, true);
  const back = await catalog.call('windsor_commute_brief', {
    from: { lat: 42.3314, lon: -83.0458 },
    to: { lat: 42.3149, lon: -83.0364 },
  });
  assert.match(
    back.summary,
    /Trip crosses into Canada\. Fastest: Ambassador Bridge \(no delay\); Detroit–Windsor Tunnel 15 min\./,
  );
});

test('Blue Water is never named the fastest Windsor crossing', async () => {
  const blueWater = {
    id: 'blue-water-bridge',
    name: 'Blue Water Bridge',
    cities: 'Sarnia, ON / Port Huron, MI',
    lat: 42.9989,
    lon: -82.4239,
    toCanada: {
      travellers: lane(0),
      commercial: lane(0),
      updatedAt: '2026-10-20T12:30:00.000Z',
    },
    toUS: {
      portStatus: 'open',
      updatedAt: '2026-10-20T12:20:02.000Z',
      travellers: { ...lane(0), lanesOpen: 2 },
      nexus: null,
      commercial: null,
      fast: null,
      notice: null,
    },
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      borders: {
        getSnapshot: async () =>
          validateBorderSnapshot({
            ...snapshot,
            crossings: [...snapshot.crossings, blueWater],
          }),
      },
    },
  });
  const result = await catalog.call('get_border_waits', {});
  assert.equal(result.data.fastest_to_us.id, 'ambassador-bridge');
  assert.match(result.summary, /Blue Water Bridge: into Canada no delay/);
});

const roadEvent = (id, lat, lon, extra = {}) => ({
  id: `on511-${id}`,
  type: 'roadwork',
  subtype: null,
  road: 'HWY 401',
  direction: 'Westbound',
  description: 'Daily Construction',
  lanes: '1 Left Lane(s)',
  fullClosure: false,
  severity: 'Unknown',
  lat,
  lon,
  endLat: null,
  endLon: null,
  reportedAt: null,
  updatedAt: '2026-10-20T12:00:00.000Z',
  plannedEndAt: null,
  ...extra,
});
const roadEvents = (events) => ({
  getEvents: async () =>
    validateRoadEventsSnapshot({
      schemaVersion: 1,
      source: 'Ontario 511',
      attribution: 'Ontario 511',
      coverage: 'Ontario provincial highways; not municipal streets',
      fetchedAt: '2026-10-20T12:30:00.000Z',
      stale: false,
      unavailable: false,
      reason: null,
      events,
    }),
});

test('get_road_events lists incidents and closures before construction', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      roadEvents: roadEvents([
        roadEvent(1, 42.25, -82.95),
        roadEvent(2, 42.3, -83.0, {
          type: 'accidentsandincidents',
          fullClosure: true,
          direction: 'Eastbound',
        }),
      ]),
    },
  });
  const r = await catalog.call('get_road_events', {
    area: { bbox: [-83.2, 42.1, -82.8, 42.4] },
  });
  assert.deepEqual(
    r.data.rows.map((x) => x.id),
    ['on511-2', 'on511-1'],
  );
  assert.match(
    r.summary,
    /^2 road events on provincial highways .*1 incident\/closure: Incident on HWY 401 Eastbound \(FULL CLOSURE\)\.$/,
  );
});

test('the commute brief keeps only road events near the route', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      borders,
      roadEvents: roadEvents([
        roadEvent(1, 42.29, -83.01), // on the line between the two points
        roadEvent(2, 42.29, -83.06), // ~2 km off the line, inside the corridor box
      ]),
    },
  });
  const r = await catalog.call('windsor_commute_brief', {
    from: { lat: 42.3149, lon: -83.0364 },
    to: { lat: 42.27, lon: -82.98 },
  });
  assert.deepEqual(
    r.data.sections.road_events.events.map((e) => e.id),
    ['on511-1'],
  );
  assert.match(
    r.summary,
    /1 road event on highways near the route: Construction on HWY 401 Westbound \(1 Left Lane\(s\)\)\./,
  );
});

test('the commute brief follows the driving route and names the crossing it uses', async () => {
  // Windsor → Detroit over the Ambassador Bridge span (42.3118, -83.074).
  const geometry = [
    [-83.0364, 42.3149],
    [-83.055, 42.305],
    [-83.074, 42.3118],
    [-83.08, 42.322],
    [-83.0458, 42.3314],
  ];
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      borders,
      routing: {
        route: async (points, profile) => {
          assert.equal(profile, 'car');
          return { ok: true, geometry, distanceM: 9800, durationS: 840 };
        },
      },
    },
  });
  const r = await catalog.call('windsor_commute_brief', {
    from: { lat: 42.3149, lon: -83.0364 },
    to: { lat: 42.3314, lon: -83.0458 },
  });
  assert.equal(r.data.sections.route.source, 'driving_route');
  assert.equal(r.data.sections.route.crossing_used, 'ambassador-bridge');
  assert.match(
    r.summary,
    /Driving 9\.8 km via the Ambassador Bridge, about 14 min without traffic or border wait\./,
  );
  assert.match(r.summary, /Your route's Ambassador Bridge: 25 min\./);
  assert.doesNotMatch(r.summary, /worth rerouting/);
});

test('a failed route falls back to a straight line and says so', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      borders,
      routing: { route: async () => ({ ok: false, error: 'no route found' }) },
    },
  });
  const r = await catalog.call('windsor_commute_brief', {
    from: { lat: 42.3149, lon: -83.0364 },
    to: { lat: 42.3314, lon: -83.0458 },
  });
  assert.equal(r.data.sections.route.source, 'straight_line');
  assert.match(r.summary, /No driving route: no route found/);
});

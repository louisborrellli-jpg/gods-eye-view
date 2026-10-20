import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { validateBorderSnapshot } from '../../sources/borderWaits.js';
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

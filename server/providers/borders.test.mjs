import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BORDER_CROSSINGS,
  CBP_BWT_URL,
  CBSA_BWT_URL,
  borderWaitsProxy,
  parseCbpJson,
  parseCbsaCsv,
  parseCbsaDelay,
} from './borders.js';

// Trimmed from the live CBSA CSV (Oct 2026): ";;"-separated with a BOM and
// the agency's own "Invalid DateTime" in the Last updated column.
const CBSA_CSV =
  '﻿Customs Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Commercial Flow - U.S. bound;; Travellers Flow - Canada bound;; Travellers Flow - U.S. bound;;\n' +
  'St. Stephen;; St. Stephen, NB/Calais, ME;; Invalid DateTime;; Not Applicable;; --;; Closed;; --;; \n' +
  'Blue Water Bridge;; Point Edward, ON/Port Huron, MI;; Invalid DateTime;; No Delay;; --;; No Delay;; --;; \n' +
  'Windsor and Detroit Tunnel;; Windsor, ON/Detroit, MI;; Invalid DateTime;; Not Applicable;; --;; 1 hour 5 minutes;; --;; \n' +
  'Ambassador Bridge;; Windsor, ON/Detroit, MI;; Invalid DateTime;; 5 minutes;; --;; No Delay;; --;; \n' +
  'Gordie Howe International Bridge;; Windsor, ON/Detroit, MI;; Invalid DateTime;; No Delay;; --;; Closed;; --;; \n';

const lane = (status, delay, open) => ({
  update_time: 'At 7:00 am EDT',
  operational_status: status,
  delay_minutes: delay,
  lanes_open: open,
});
const cbpRow = (crossing, pvDelay, extra = {}) => ({
  port_number: '380001',
  border: 'Canadian Border',
  port_name: 'Detroit',
  crossing_name: crossing,
  date: '10/20/2026',
  time: '08:20:02',
  port_status: 'Open',
  commercial_vehicle_lanes: {
    standard_lanes: lane('no delay', '5', '4'),
    FAST_lanes: lane('N/A', '', ''),
  },
  passenger_vehicle_lanes: {
    standard_lanes: lane('delay', pvDelay, '2'),
    NEXUS_SENTRI_lanes: lane('Lanes Closed', '', ''),
  },
  construction_notice: '',
  ...extra,
});
const CBP_ROWS = [
  cbpRow('Ambassador Bridge', '25'),
  cbpRow('Windsor Tunnel', '5'),
  cbpRow('Gordie Howe International Bridge  ', '10'), // CBP pads this name
  { ...cbpRow('Bluewater Bridge', '0'), port_name: 'Port Huron' },
  // Same crossing name on the Mexican border must not match.
  { ...cbpRow('Ambassador Bridge', '99'), border: 'Mexican Border' },
];

test('CBSA delay strings parse to minutes and a status', () => {
  assert.deepEqual(parseCbsaDelay('No Delay'), { minutes: 0, status: 'open' });
  assert.deepEqual(parseCbsaDelay('5 minutes'), { minutes: 5, status: 'open' });
  assert.deepEqual(parseCbsaDelay('1 hour 5 minutes'), {
    minutes: 65,
    status: 'open',
  });
  assert.deepEqual(parseCbsaDelay('2 hours'), { minutes: 120, status: 'open' });
  assert.deepEqual(parseCbsaDelay('Closed'), {
    minutes: null,
    status: 'closed',
  });
  assert.deepEqual(parseCbsaDelay('Not Applicable'), {
    minutes: null,
    status: 'not_applicable',
  });
  assert.deepEqual(parseCbsaDelay('--'), {
    minutes: null,
    status: 'not_applicable',
  });
  assert.deepEqual(parseCbsaDelay('weird'), {
    minutes: null,
    status: 'unknown',
  });
});

test('the CBSA CSV keeps only covered crossings, Canada-bound', () => {
  const parsed = parseCbsaCsv(CBSA_CSV);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    BORDER_CROSSINGS.map((c) => c.id).sort(),
  );
  assert.deepEqual(parsed['ambassador-bridge'], {
    travellers: { minutes: 0, status: 'open' },
    commercial: { minutes: 5, status: 'open' },
  });
  assert.equal(parsed['windsor-detroit-tunnel'].travellers.minutes, 65);
  assert.equal(parsed['gordie-howe-bridge'].travellers.status, 'closed');
  assert.throws(() => parseCbsaCsv('<html>'), /invalid_cbsa_csv/);
});

test('the CBP JSON keeps only Canadian-border crossings, U.S.-bound', () => {
  const parsed = parseCbpJson(CBP_ROWS);
  assert.equal(parsed['ambassador-bridge'].travellers.minutes, 25);
  assert.equal(parsed['ambassador-bridge'].nexus.status, 'closed');
  assert.equal(parsed['ambassador-bridge'].fast, null);
  assert.equal(parsed['gordie-howe-bridge'].travellers.minutes, 10);
  assert.equal(parsed['blue-water-bridge'].travellers.minutes, 0);
  // 08:20:02 EDT on Oct 20 is 12:20:02Z.
  assert.equal(
    parsed['windsor-detroit-tunnel'].updatedAt,
    '2026-10-20T12:20:02.000Z',
  );
  assert.throws(() => parseCbpJson({}), /invalid_cbp_json/);
});

function harness(fetchImpl, clock = { t: Date.parse('2026-10-20T12:30:00Z') }) {
  const plugin = borderWaitsProxy({ fetchImpl, now: () => clock.t });
  let handler;
  plugin.configureServer({ middlewares: { use: (_path, h) => (handler = h) } });
  const call = (url = '/', method = 'GET') =>
    new Promise((resolve) => {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      handler({ method, url }, res);
    });
  return { call, clock };
}

const okFetch = (calls) => async (url) => {
  calls.push(String(url));
  if (String(url) === CBSA_BWT_URL) return new Response(CBSA_CSV);
  if (String(url) === CBP_BWT_URL) return Response.json(CBP_ROWS);
  return new Response(null, { status: 404 });
};

test('the proxy merges both directions and caches for three minutes', async () => {
  const calls = [];
  const { call, clock } = harness(okFetch(calls));
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.stale, false);
  assert.equal(first.body.partial, false);
  const amb = first.body.crossings.find((c) => c.id === 'ambassador-bridge');
  assert.equal(amb.toCanada.commercial.minutes, 5);
  assert.equal(amb.toUS.travellers.minutes, 25);
  await call();
  assert.equal(calls.length, 2); // cached
  clock.t += 4 * 60_000;
  await call();
  assert.equal(calls.length, 4); // refreshed both
});

test('one agency down leaves the other direction live and marks it partial', async () => {
  const { call } = harness(async (url) =>
    String(url) === CBP_BWT_URL
      ? Response.json(CBP_ROWS)
      : new Response(null, { status: 503 }),
  );
  const { body } = await call();
  assert.equal(body.partial, true);
  const amb = body.crossings.find((c) => c.id === 'ambassador-bridge');
  assert.equal(amb.toCanada.unavailable, true);
  assert.equal(amb.toUS.travellers.minutes, 25);
});

test('both agencies down answers unavailable, not an error', async () => {
  const { call } = harness(async () => new Response(null, { status: 500 }));
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.unavailable, true);
  assert.deepEqual(body.crossings, []);
});

test('the proxy rejects other methods and query strings', async () => {
  const { call } = harness(okFetch([]));
  assert.equal((await call('/', 'POST')).status, 405);
  assert.equal((await call('/?x=1')).status, 400);
});

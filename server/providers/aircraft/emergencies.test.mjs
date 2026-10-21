import test from 'node:test';
import assert from 'node:assert/strict';
import { emergenciesProxy, normalizeEmergencyAircraft } from './emergencies.js';

test('only positioned aircraft with the asked code survive', () => {
  const rows = normalizeEmergencyAircraft(
    {
      ac: [
        { hex: 'ABC123', flight: 'BAW1  ', squawk: '7700', lat: 51, lon: 0, alt_baro: 31000 },
        { hex: 'abc124', squawk: '7700' },
        { hex: 'nothex', squawk: '7700', lat: 1, lon: 1 },
        { hex: 'abc125', squawk: '1200', lat: 1, lon: 1 },
      ],
    },
    '7700',
  );
  assert.deepEqual(rows, [
    { hex: 'abc123', flight: 'BAW1', squawk: '7700', lat: 51, lon: 0, altFt: 31000 },
  ]);
});

function call(handler) {
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res);
  });
}

function mount(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (_path, fn) => (handler = fn) } });
  return handler;
}

test('one cached sweep serves callers; a failure falls back to the last answer', async () => {
  let calls = 0;
  let fail = false;
  let clock = 1_000_000;
  const fetchImpl = async (url) => {
    calls++;
    if (fail) throw new Error('down');
    const code = url.split('/').pop();
    return new Response(
      JSON.stringify({ ac: code === '7700' ? [{ hex: 'abc123', squawk: '7700', lat: 1, lon: 2 }] : [] }),
    );
  };
  const handler = mount(emergenciesProxy({ fetchImpl, now: () => clock }));
  const first = await call(handler);
  assert.equal(first.status, 200);
  assert.equal(first.body.aircraft.length, 1);
  assert.equal(calls, 3);
  await call(handler);
  assert.equal(calls, 3, 'cached for 30 s');
  clock += 31_000;
  fail = true;
  const stale = await call(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
});

test('a null position is skipped, not placed at 0,0', () => {
  assert.deepEqual(
    normalizeEmergencyAircraft({ ac: [{ hex: 'abc123', squawk: '7700', lat: null, lon: null }] }, '7700'),
    [],
  );
});

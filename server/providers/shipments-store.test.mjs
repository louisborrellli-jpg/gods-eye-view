import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SHIPMENTS_DATA_FILE,
  createFileStorage,
  createShipmentsServerStore,
} from './shipments-store.js';

const NOW = Date.UTC(2026, 9, 21, 12);
const BOX = 'MSCU1234566';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const tracking = {
  source: 'findteu',
  carrier: 'MSC',
  completed: false,
  vessel: { name: 'MSC TEST', imo: '9000000' },
  dates: { loaded: '2026-10-01', portEta: '2026-10-24' },
  fetchedAt: NOW,
};

function fakeService(calls = []) {
  return {
    calls,
    async track(container, carrier) {
      calls.push({ container, carrier });
      return { status: 200, body: { configured: true, tracking } };
    },
  };
}

/** A request the handler can read like Node's IncomingMessage. */
function request(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function client(server) {
  return (method, route, body) =>
    new Promise((resolve) => {
      const [pathPart, query = ''] = route.split('?');
      server.handle(
        request(method, `/api/shipments/store${route}`, body),
        pathPart,
        (status, payload) => resolve({ status, body: payload, query }),
      );
    });
}

function setup() {
  const service = fakeService();
  const server = createShipmentsServerStore({
    service,
    now: () => NOW,
    storage: memoryStorage(),
  });
  return { service, server, call: client(server) };
}

test('the shared list starts empty and says it is the server list', async () => {
  const { call } = setup();
  const { status, body } = await call('GET', '/');
  assert.equal(status, 200);
  assert.equal(body.mode, 'server');
  assert.deepEqual(body.shipments, []);
  assert.equal(body.tracking.keyMissing, false);
});

test('a new container is saved and tracked by the server', async () => {
  const { call, server, service } = setup();
  const saved = await call('PUT', '/item', {
    shipment: { container: 'mscu 123456-6', reference: 'PO 7' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.shipment.container, BOX);
  await server.runJob({ force: true });
  assert.ok(service.calls.some((entry) => entry.container === BOX));
  const { body } = await call('GET', '/');
  assert.equal(body.shipments.length, 1);
  assert.equal(body.shipments[0].reference, 'PO 7');
  assert.equal(body.shipments[0].auto.dates.loaded, '2026-10-01');
});

test('a browser cannot overwrite the server tracking or add a duplicate', async () => {
  const { call, server } = setup();
  const first = await call('PUT', '/item', { shipment: { container: BOX } });
  await server.runJob({ force: true });
  const id = first.body.shipment.id;
  const edit = await call('PUT', '/item', {
    shipment: { id, container: BOX, notes: 'gate 4', auto: null },
  });
  assert.equal(edit.status, 200);
  const stored = server.store.get(id);
  assert.equal(stored.notes, 'gate 4');
  assert.equal(stored.auto.vessel.name, 'MSC TEST');

  const twice = await call('PUT', '/item', { shipment: { container: BOX } });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.id, id);
  const bad = await call('PUT', '/item', { shipment: { container: 'nope' } });
  assert.equal(bad.status, 400);
});

test('remove, defaults and merge change the revision', async () => {
  const { call } = setup();
  const start = (await call('GET', '/')).body.revision;
  const merged = await call('POST', '/merge', {
    shipments: [
      { id: 'abc123', container: BOX },
      { container: BOX },
      { container: 'not a box' },
    ],
  });
  assert.equal(merged.body.added, 1);
  const list = (await call('GET', '/')).body;
  assert.ok(list.revision > start);
  assert.equal(list.shipments[0].id, 'abc123');

  const defaults = await call('PUT', '/defaults', {
    defaults: { rampFreeDays: 2 },
  });
  assert.equal(defaults.body.defaults.rampFreeDays, 2);

  const removed = await call('DELETE', '/item?id=abc123');
  assert.equal(removed.body.removed, true);
  assert.equal((await call('GET', '/')).body.shipments.length, 0);
  assert.equal((await call('DELETE', '/item?id=abc123')).status, 404);
});

test('refresh tracks now and answers with the new list', async () => {
  const { call } = setup();
  await call('POST', '/merge', { shipments: [{ container: BOX }] });
  const { status, body } = await call('POST', '/refresh');
  assert.equal(status, 200);
  assert.equal(body.shipments[0].auto.vessel.name, 'MSC TEST');
});

test('unknown routes and bad bodies are refused', async () => {
  const { call, server } = setup();
  assert.equal((await call('GET', '/nothing')).status, 404);
  assert.equal((await call('POST', '/item')).status, 405);
  const broken = await new Promise((resolve) =>
    server.handle(
      {
        method: 'PUT',
        url: '/item',
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{not json');
        },
      },
      '/item',
      (status) => resolve(status),
    ),
  );
  assert.equal(broken, 400);
});

test('the list survives a restart in its data file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-shipments-'));
  try {
    const first = createShipmentsServerStore({
      service: fakeService(),
      now: () => NOW,
      dataDir: dir,
    });
    await client(first)('PUT', '/item', { shipment: { container: BOX } });
    const file = path.join(dir, SHIPMENTS_DATA_FILE);
    assert.ok(readFileSync(file, 'utf8').includes(BOX));
    const again = createShipmentsServerStore({
      service: fakeService(),
      now: () => NOW,
      storage: createFileStorage(file),
    });
    assert.equal(again.store.list()[0].container, BOX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tracking job starts once and stops cleanly', () => {
  const started = [];
  const stopped = [];
  const server = createShipmentsServerStore({
    service: fakeService(),
    now: () => NOW,
    storage: memoryStorage(),
    setTimer: (fn, ms) => {
      started.push(ms);
      return { id: started.length };
    },
    clearTimer: (timer) => stopped.push(timer.id),
  });
  server.start();
  server.start();
  assert.equal(started.length, 1);
  server.stop();
  assert.deepEqual(stopped, [1]);
});

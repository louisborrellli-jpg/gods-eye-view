import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHIPMENTS_MIGRATED_KEY, createShipmentsBackend } from './backend.js';
import { SHIPMENTS_STORAGE_KEY, createShipmentStore } from './store.js';

const NOW = Date.UTC(2026, 9, 21, 12);
const BOX = 'MSCU1234566';

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/** A tiny stand-in for /api/shipments/store. */
function fakeServer() {
  let revision = 1;
  const shipments = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const route = String(url).replace('/api/shipments/store', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, route, body });
    let payload = null;
    if (method === 'GET')
      payload = {
        mode: 'server',
        revision,
        shipments: shipments.map((item) => ({ ...item })),
        defaults: { rampFreeDays: 1 },
        tracking: { keyMissing: false, busy: false, notes: {} },
      };
    else if (method === 'PUT' && route === '/item') {
      const index = shipments.findIndex((item) => item.id === body.shipment.id);
      if (index >= 0) shipments[index] = body.shipment;
      else shipments.push(body.shipment);
      revision += 1;
      payload = { shipment: body.shipment, revision };
    } else if (method === 'DELETE') {
      const id = new URLSearchParams(route.split('?')[1]).get('id');
      const index = shipments.findIndex((item) => item.id === id);
      if (index >= 0) shipments.splice(index, 1);
      revision += 1;
      payload = { removed: index >= 0, revision };
    } else if (method === 'POST' && route === '/merge') {
      for (const entry of body.shipments) shipments.push(entry);
      revision += 1;
      payload = { added: body.shipments.length, revision };
    } else if (method === 'POST' && route.startsWith('/refresh')) {
      for (const item of shipments)
        item.auto = { source: 'findteu', dates: { loaded: '2026-10-01' } };
      revision += 1;
      return fetchImpl('/api/shipments/store', { method: 'GET' });
    }
    return {
      ok: Boolean(payload),
      status: payload ? 200 : 404,
      json: async () => payload ?? { error: 'not_found' },
    };
  };
  return { fetchImpl, calls, shipments, bump: () => (revision += 1) };
}

const noTimer = { setTimer: () => null, clearTimer: () => {} };

test('with the shared list, changes go to the server and come back', async () => {
  const server = fakeServer();
  let changes = 0;
  const backend = createShipmentsBackend({
    storage: memoryStorage(),
    now: () => NOW,
    fetchImpl: server.fetchImpl,
    ...noTimer,
  });
  backend.subscribe(() => (changes += 1));
  assert.equal(await backend.ready, 'server');
  const saved = backend.store.save({ container: BOX });
  assert.ok(saved);
  assert.equal(backend.store.list().length, 1, 'shown at once');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(server.calls.some((call) => call.method === 'PUT'));
  assert.equal(server.shipments[0].id, saved.id);

  await backend.tracker.refresh({ force: true });
  assert.equal(backend.store.get(saved.id).auto.dates.loaded, '2026-10-01');
  assert.ok(changes >= 2);

  backend.store.remove(saved.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.shipments.length, 0);
});

test('the browser does not write tracking results in server mode', async () => {
  const server = fakeServer();
  server.shipments.push({ id: 'abc123', container: BOX });
  const backend = createShipmentsBackend({
    storage: memoryStorage(),
    now: () => NOW,
    fetchImpl: server.fetchImpl,
    ...noTimer,
  });
  await backend.ready;
  backend.store.setAuto('abc123', { source: 'browser', dates: {} });
  assert.equal(backend.store.get('abc123').auto, null);
});

test('a poll picks up a change made by someone else', async () => {
  const server = fakeServer();
  const backend = createShipmentsBackend({
    storage: memoryStorage(),
    now: () => NOW,
    fetchImpl: server.fetchImpl,
    ...noTimer,
  });
  await backend.ready;
  server.shipments.push({ id: 'other1', container: BOX });
  server.bump();
  await backend.reload();
  assert.equal(backend.store.get('other1').container, BOX);
});

test('containers kept in this browser are copied to the server once', async () => {
  const storage = memoryStorage();
  createShipmentStore({ storage, now: () => NOW }).save({ container: BOX });
  const server = fakeServer();
  const backend = createShipmentsBackend({
    storage,
    now: () => NOW,
    fetchImpl: server.fetchImpl,
    ...noTimer,
  });
  await backend.ready;
  assert.equal(server.shipments.length, 1);
  assert.equal(server.shipments[0].container, BOX);
  assert.equal(storage.getItem(SHIPMENTS_STORAGE_KEY), null);
  assert.ok(storage.getItem(SHIPMENTS_MIGRATED_KEY));
  assert.equal(backend.store.list().length, 1);
});

test('without the shared list it keeps working in this browser', async () => {
  const storage = memoryStorage();
  const backend = createShipmentsBackend({
    storage,
    now: () => NOW,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    trackingSource: {
      trackContainer: async () => ({ configured: false }),
    },
    ...noTimer,
  });
  assert.equal(await backend.ready, 'local');
  backend.store.save({ container: BOX });
  assert.ok(storage.getItem(SHIPMENTS_STORAGE_KEY).includes(BOX));
  await backend.tracker.refresh({ force: true });
  assert.equal(backend.tracker.keyMissing, true);
});

test('a network failure also falls back to this browser', async () => {
  const backend = createShipmentsBackend({
    storage: memoryStorage(),
    now: () => NOW,
    fetchImpl: async () => {
      throw new TypeError('offline');
    },
    ...noTimer,
  });
  assert.equal(await backend.ready, 'local');
});

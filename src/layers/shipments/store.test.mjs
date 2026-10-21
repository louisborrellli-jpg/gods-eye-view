import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SHIPMENTS } from './model.js';
import { SHIPMENTS_STORAGE_KEY, createShipmentStore } from './store.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

let seq = 0;
const makeId = () => `id${++seq}`;

test('shipments persist and reload, dropping malformed entries', () => {
  const storage = memoryStorage({
    [SHIPMENTS_STORAGE_KEY]: JSON.stringify([
      { id: 'a', container: 'MSCU1234566' },
      { id: 'b' },
      'junk',
    ]),
  });
  const store = createShipmentStore({ storage, makeId, now: () => 10 });
  assert.equal(store.size, 1);
  const saved = store.save({
    container: 'MSKU1234567',
    dates: { portEta: '2026-10-25' },
  });
  assert.equal(saved.createdAt, 10);
  const again = createShipmentStore({ storage, makeId });
  assert.deepEqual(
    again.list().map((item) => item.container),
    ['MSCU1234566', 'MSKU1234567'],
  );
});

test('editing keeps a found ship; naming another ship forgets it', () => {
  const store = createShipmentStore({ storage: memoryStorage(), makeId });
  const first = store.save({
    container: 'MSCU1234566',
    vessel: { query: 'MSC ANNA' },
  });
  store.setLastSeen(first.id, {
    lat: 44,
    lon: -63,
    at: 5,
    mmsi: '636019825',
    imo: '9839131',
  });
  const edited = store.save({
    id: first.id,
    container: 'MSCU1234566',
    vessel: { query: 'msc  anna' },
    notes: 'x',
  });
  assert.equal(edited.vessel.mmsi, '636019825');
  assert.equal(edited.lastSeen.lat, 44);
  const swapped = store.save({
    id: first.id,
    container: 'MSCU1234566',
    vessel: { query: 'MSC OTHER' },
  });
  assert.equal(swapped.vessel.mmsi, '');
  assert.equal(swapped.lastSeen, null);
});

test('the board has a size limit and storage failures are reported', () => {
  const store = createShipmentStore({ storage: memoryStorage(), makeId });
  for (let index = 0; index < MAX_SHIPMENTS; index++)
    assert.ok(
      store.save({ container: `MSCU${String(index).padStart(7, '0')}` }),
    );
  assert.equal(store.save({ container: 'MSCU9999999' }), null);

  const broken = createShipmentStore({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    },
    makeId,
  });
  assert.ok(broken.save({ container: 'MSCU1234566' }));
  assert.equal(broken.saveError, true);
});

test('alerts are announced once and import replaces the list', () => {
  const storage = memoryStorage();
  const store = createShipmentStore({ storage, makeId });
  store.markNotified('a|overdue|ramp|2026-10-21');
  assert.equal(
    createShipmentStore({ storage, makeId }).hasNotified(
      'a|overdue|ramp|2026-10-21',
    ),
    true,
  );
  store.save({ container: 'MSCU1234566' });
  assert.equal(
    store.replaceAll([{ container: 'MSKU1234567' }, { container: '' }]),
    1,
  );
  assert.deepEqual(
    store.list().map((item) => item.container),
    ['MSKU1234567'],
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createZoneStore,
  distanceInsideZone,
  kmBetween,
  nextCodename,
  nextRadiusKm,
  parseZones,
  ZONES_STORAGE_KEY,
} from './zones.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

test('distance and containment use great-circle kilometres', () => {
  const london = { lat: 51.5074, lon: -0.1278 };
  const paris = { lat: 48.8566, lon: 2.3522 };
  assert.ok(Math.abs(kmBetween(london, paris) - 344) < 3);
  const zone = { ...london, radiusKm: 400 };
  assert.ok(distanceInsideZone(zone, paris) > 340);
  assert.equal(distanceInsideZone({ ...zone, radiusKm: 300 }, paris), null);
  assert.equal(distanceInsideZone(zone, { lat: NaN, lon: 0 }), null);
});

test('codenames do not repeat and radius presets wrap', () => {
  assert.equal(nextCodename([]), 'ONYX');
  assert.equal(nextCodename(['onyx']), 'VIPER');
  assert.equal(nextRadiusKm(10), 50);
  assert.equal(nextRadiusKm(500), 10);
  assert.equal(nextRadiusKm(75), 200);
});

test('a damaged stored zone is dropped without losing the rest', () => {
  const zones = parseZones(
    JSON.stringify({
      zones: [
        { id: 'a', name: 'ONYX', lat: 10, lon: 20, radiusKm: 50 },
        { id: 'b', name: 'BAD', lat: 200, lon: 20, radiusKm: 50 },
        { id: 'a', name: 'DUP', lat: 1, lon: 2, radiusKm: 50 },
        {
          id: 'c',
          name: 'VIPER',
          lat: 1,
          lon: 2,
          radiusKm: 50,
          kinds: { fire: false },
        },
      ],
    }),
  );
  assert.deepEqual(
    zones.map((zone) => zone.id),
    ['a', 'c'],
  );
  assert.deepEqual(zones[1].kinds, {
    quake: true,
    fire: false,
    emergency: true,
  });
  assert.deepEqual(parseZones('not json'), []);
});

test('the store persists zones, edits and seen memory across reloads', () => {
  const storage = memoryStorage();
  let id = 0;
  const store = createZoneStore({
    storage,
    now: () => 1000,
    createId: () => `z${++id}`,
  });
  const zone = store.add({ lat: 1, lon: 2 });
  assert.equal(zone.name, 'ONYX');
  assert.equal(zone.radiusKm, 50);
  store.setRadius(zone.id, 200);
  store.setKind(zone.id, 'fire', false);
  store.rename(zone.id, 'Kestrel');
  store.markSeen(zone.id, 'quake:1');
  store.saveSeen();
  const reloaded = createZoneStore({ storage, now: () => 2000 });
  const [saved] = reloaded.list();
  assert.equal(saved.radiusKm, 200);
  assert.equal(saved.kinds.fire, false);
  assert.equal(saved.name, 'Kestrel');
  assert.ok(reloaded.hasSeen(zone.id, 'quake:1'));
  assert.ok(reloaded.remove(zone.id));
  assert.equal(JSON.parse(storage.map.get(ZONES_STORAGE_KEY)).zones.length, 0);
});

test('storage that throws keeps the store working for the page', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const store = createZoneStore({ storage });
  assert.ok(store.add({ lat: 0, lon: 0 }));
  assert.equal(store.size, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeLayer } from './index.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function fakeGeolocation() {
  const state = { onPos: null, onErr: null, id: 0, cleared: [] };
  return {
    watchPosition(onPos, onErr) {
      state.onPos = onPos;
      state.onErr = onErr;
      return ++state.id;
    },
    clearWatch(id) {
      state.cleared.push(id);
      state.onPos = null;
      state.onErr = null;
    },
    _emit(coords, timestamp) {
      state.onPos?.({ coords, timestamp });
    },
    _fail(code) {
      state.onErr?.({ code });
    },
    _state: state,
  };
}

function fakeViewer() {
  const added = [];
  return {
    dataSources: {
      add: (ds) => added.push(ds),
      remove: (ds) => {
        const i = added.indexOf(ds);
        if (i >= 0) added.splice(i, 1);
      },
    },
    scene: { requestRender() {} },
    _added: added,
    get _ds() {
      return added[0] ?? null;
    },
  };
}

function entityCount(viewer) {
  return viewer._ds ? viewer._ds.entities.values.length : 0;
}

test('a live fix plots the dot, persists last-known, and reports stats', () => {
  const geo = fakeGeolocation();
  const storage = fakeStorage();
  let clock = 1_000_000;
  const layer = createMeLayer({
    geolocation: geo,
    storage,
    now: () => clock,
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();

  assert.equal(entityCount(viewer), 0, 'nothing drawn before the first fix');

  geo._emit({ latitude: 42.3, longitude: -83.0, accuracy: 25 }, clock);

  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.live, true);
  assert.equal(stats.stale, false);
  assert.equal(stats.accuracyM, 25);
  assert.ok(entityCount(viewer) >= 2, 'dot + accuracy ring drawn');

  const stored = JSON.parse(storage.getItem('gev.me.lastFix'));
  assert.equal(stored.lat, 42.3);
  assert.equal(stored.lon, -83.0);
  assert.equal(stored.accuracy, 25);

  layer.destroy();
});

test('the last-known fix is restored on init and shown stale before any live fix', () => {
  const storage = fakeStorage();
  storage.setItem(
    'gev.me.lastFix',
    JSON.stringify({ lat: 1, lon: 2, accuracy: 10, at: 500 }),
  );
  const layer = createMeLayer({
    geolocation: fakeGeolocation(),
    storage,
    now: () => 10_000_000, // far past the stale window
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();

  const stats = layer.getStats();
  assert.equal(stats.count, 1, 'restored fix counts');
  assert.equal(stats.live, false, 'restored fix is not a live fix');
  assert.equal(stats.stale, true, 'an old restored fix reads as stale');
  assert.ok(entityCount(viewer) >= 1, 'restored fix is drawn');

  layer.destroy();
});

test('a permission error is reported while the last fix stays drawn', () => {
  const geo = fakeGeolocation();
  const layer = createMeLayer({
    geolocation: geo,
    storage: fakeStorage(),
    now: () => 1_000_000,
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  geo._emit({ latitude: 42.3, longitude: -83.0, accuracy: 25 }, 1_000_000);

  geo._fail(1); // PERMISSION_DENIED
  const stats = layer.getStats();
  assert.equal(stats.error, 'Location permission denied');
  assert.equal(stats.count, 1, 'the last fix is still shown');

  layer.destroy();
});

test('disable stops the watch and clears the drawing; destroy removes the source', () => {
  const geo = fakeGeolocation();
  const layer = createMeLayer({
    geolocation: geo,
    storage: fakeStorage(),
    now: () => 1_000_000,
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  geo._emit({ latitude: 42.3, longitude: -83.0, accuracy: 25 }, 1_000_000);
  assert.ok(entityCount(viewer) >= 1);

  layer.disable();
  assert.equal(geo._state.cleared.length, 1, 'watch cleared on disable');
  assert.equal(entityCount(viewer), 0, 'drawing cleared on disable');

  layer.destroy();
  assert.equal(viewer._added.length, 0, 'data source removed on destroy');
});

test('with no geolocation the layer explains itself instead of throwing', () => {
  const layer = createMeLayer({
    geolocation: null,
    storage: fakeStorage(),
    now: () => 1,
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.doesNotThrow(() => layer.enable());
  assert.equal(layer.getStats().error, 'Location not available on this device');
  layer.destroy();
});

test('update never returns false, so the manager keeps the layer enabled', () => {
  // The lifecycle manager calls update() right after enable() and rolls the
  // layer back to disabled if it returns false. An event-driven layer with no
  // fetch to do must still report success.
  const geo = fakeGeolocation();
  const layer = createMeLayer({
    geolocation: geo,
    storage: fakeStorage(),
    now: () => 1_000_000,
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  assert.notEqual(layer.update(viewer), false, 'no fix yet');
  geo._emit({ latitude: 42.3, longitude: -83.0, accuracy: 25 }, 1_000_000);
  assert.notEqual(layer.update(viewer), false, 'with a fix');
  layer.destroy();
});

test('the breadcrumb trail accumulates distinct positions', () => {
  const geo = fakeGeolocation();
  const layer = createMeLayer({
    geolocation: geo,
    storage: fakeStorage(),
    now: () => 2_000_000,
    flyToFirstFix: false,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  geo._emit({ latitude: 42.3, longitude: -83.0, accuracy: 20 }, 2_000_000);
  geo._emit({ latitude: 42.31, longitude: -83.01, accuracy: 20 }, 2_000_001);
  // dot + ring + trail polyline once there are two points
  assert.ok(entityCount(viewer) >= 3, 'trail polyline added for 2+ points');
  layer.destroy();
});

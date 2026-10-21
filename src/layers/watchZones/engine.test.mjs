import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoneStore } from './zones.js';
import { alertSeverity, evaluateFeed } from './engine.js';

const quake = (id, lat, lon, mag) => ({ id, kind: 'quake', lat, lon, mag });

function setup() {
  let n = 0;
  const store = createZoneStore({ createId: () => `z${++n}` });
  const zone = store.add({ lat: 35, lon: 139, radiusKm: 100 });
  return { store, zone, primed: new Set() };
}

test('what is already inside a new zone is background, later events alert once', () => {
  const { store, primed } = setup();
  const first = evaluateFeed({
    zones: store.list(),
    kind: 'quake',
    events: [quake('q1', 35.1, 139.1, 4), quake('far', 0, 0, 7)],
    store,
    primed,
  });
  assert.equal(first.alerts.length, 0);
  assert.deepEqual(
    first.background.map((a) => a.event.id),
    ['q1'],
  );

  const second = evaluateFeed({
    zones: store.list(),
    kind: 'quake',
    events: [quake('q1', 35.1, 139.1, 4), quake('q2', 35.2, 139.2, 5)],
    store,
    primed,
  });
  assert.deepEqual(
    second.alerts.map((a) => a.event.id),
    ['q2'],
  );
  assert.ok(second.alerts[0].event.distanceKm > 0);

  const third = evaluateFeed({
    zones: store.list(),
    kind: 'quake',
    events: [quake('q2', 35.2, 139.2, 5)],
    store,
    primed,
  });
  assert.equal(third.alerts.length, 0, 'never alerts twice');
});

test('quakes under the zone minimum and kinds the zone ignores are skipped', () => {
  const { store, zone, primed } = setup();
  primed.add(`${zone.id}|quake`);
  primed.add(`${zone.id}|fire`);
  const small = evaluateFeed({
    zones: store.list(),
    kind: 'quake',
    events: [quake('tiny', 35, 139, 2)],
    store,
    primed,
  });
  assert.equal(small.alerts.length, 0);
  store.setKind(zone.id, 'fire', false);
  const fires = evaluateFeed({
    zones: store.list(),
    kind: 'fire',
    events: [{ id: 'f1', kind: 'fire', lat: 35, lon: 139, frp: 5 }],
    store,
    primed,
  });
  assert.equal(fires.alerts.length, 0);
});

test('fire detections are grouped into one alert led by the most intense', () => {
  const { store, zone, primed } = setup();
  primed.add(`${zone.id}|fire`);
  const { alerts } = evaluateFeed({
    zones: store.list(),
    kind: 'fire',
    events: [
      { id: 'f1', kind: 'fire', lat: 35, lon: 139, frp: 5 },
      { id: 'f2', kind: 'fire', lat: 35.01, lon: 139, frp: 50 },
      { id: 'f3', kind: 'fire', lat: 35.02, lon: 139, frp: null },
    ],
    store,
    primed,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 3);
  assert.equal(alerts[0].event.id, 'f2');
});

test('severity ranks hijack and general emergencies and big quakes highest', () => {
  assert.equal(
    alertSeverity({ kind: 'emergency', event: { squawk: '7700' } }),
    3,
  );
  assert.equal(
    alertSeverity({ kind: 'emergency', event: { squawk: '7600' } }),
    2,
  );
  assert.equal(alertSeverity({ kind: 'quake', event: { mag: 6.2 } }), 3);
  assert.equal(alertSeverity({ kind: 'quake', event: { mag: 3 } }), 1);
  assert.equal(alertSeverity({ kind: 'fire', count: 30, event: {} }), 2);
});

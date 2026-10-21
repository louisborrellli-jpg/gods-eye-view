import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shipKeyOf,
  shipLeader,
  PORTS,
  alongLine,
  estimatePosition,
  portPosition,
  railLine,
  seaLane,
} from './geo.js';
import { normalizeShipment, shipmentStage } from './model.js';

const at = (day) =>
  Date.UTC(...day.split('-').map((v, i) => (i === 1 ? v - 1 : +v)), 12);

test('ports resolve by code or by name', () => {
  assert.deepEqual(portPosition({ code: 'ITSAL' }), PORTS.ITSAL);
  assert.deepEqual(portPosition({ port: 'Montréal' }), PORTS.CAMTR);
  assert.equal(portPosition({ code: 'XXZZZ', port: 'Nowhere' }), null);
});

test('a Mediterranean to Montreal lane goes by Gibraltar and up the St. Lawrence', () => {
  const lane = seaLane(PORTS.ITSAL, PORTS.CAMTR);
  assert.deepEqual(lane[0], PORTS.ITSAL);
  assert.deepEqual(lane.at(-1), PORTS.CAMTR);
  assert.ok(
    lane.some(
      ([lat, lon]) => Math.abs(lat - 35.95) < 0.1 && Math.abs(lon + 5.7) < 0.1,
    ),
  );
  assert.ok(
    lane.some(([, lon]) => lon < -59 && lon > -61),
    'Cabot Strait',
  );
  const egypt = seaLane(PORTS.EGPSD, PORTS.CAMTR);
  assert.ok(egypt.length > lane.length - 1);
  assert.deepEqual(seaLane(PORTS.USNYC, PORTS.CAHAL), [
    PORTS.USNYC,
    PORTS.CAHAL,
  ]);
  assert.equal(railLine(PORTS.CAMTR, PORTS.CATOR).length, 5);
});

test('positions along a line follow distance and clamp', () => {
  const line = [
    [0, 0],
    [0, 10],
  ];
  assert.deepEqual(alongLine(line, 0.5), [0, 5]);
  assert.deepEqual(alongLine(line, 2), [0, 10]);
  assert.deepEqual(alongLine(line, -1), [0, 0]);
});

test('a ship halfway through its voyage is estimated mid-ocean', () => {
  const shipment = normalizeShipment({
    container: 'FANU1040642',
    auto: {
      pol: { port: 'Salerno', code: 'ITSAL' },
      pod: { port: 'Montreal', code: 'CAMTR' },
      destination: { port: 'Toronto', code: 'CATOR' },
      dates: { departed: '2026-10-20', portEta: '2026-11-09' },
    },
  });
  const middle = estimatePosition(
    shipment,
    shipmentStage(shipment),
    at('2026-10-30'),
  );
  assert.equal(middle.leg, 'sea');
  assert.ok(
    middle.lon < -20 && middle.lon > -50,
    `mid-Atlantic, got ${middle.lon}`,
  );
  const before = estimatePosition(shipment, 'at-sea', at('2026-10-01'));
  assert.deepEqual([before.lat, before.lon], PORTS.ITSAL);

  const onRail = normalizeShipment({
    ...shipment,
    manual: {
      discharged: '2026-11-09',
      railDeparted: '2026-11-10',
      rampEta: '2026-11-14',
    },
  });
  const rail = estimatePosition(
    onRail,
    shipmentStage(onRail),
    at('2026-11-12'),
  );
  assert.equal(rail.leg, 'rail');
  assert.ok(rail.lon < -73.5 && rail.lon > -79.7);
  const done = normalizeShipment({
    ...shipment,
    manual: { pickedUp: '2026-11-15' },
  });
  assert.equal(
    estimatePosition(done, shipmentStage(done), at('2026-11-16')),
    null,
  );
});

test('containers on one ship share where that ship is', () => {
  const nowMs = Date.UTC(2026, 9, 21, 12);
  const box = (id, pol, departed, extra = {}) => ({
    id,
    auto: {
      vessel: { name: 'MSC TEST', imo: '9000001' },
      pol: { port: pol },
      dates: { departed },
    },
    ...extra,
  });
  const atSea = () => true;
  const salerno = box('a', 'Salerno', '2026-10-05');
  const gioia = box('b', 'Gioia Tauro', '2026-10-08');
  const list = [salerno, gioia];
  const options = { nowMs, heardMs: 3_600_000, atSea };
  // Not heard: the box that boarded last shows the leg the ship is on.
  assert.equal(shipLeader(salerno, list, options), gioia);
  assert.equal(shipLeader(gioia, list, options), gioia);
  // Heard: the live position wins for every box aboard.
  salerno.lastSeen = { at: nowMs - 60_000, lat: 40, lon: -30 };
  assert.equal(shipLeader(gioia, list, options), salerno);
  // A box on another ship stands alone.
  const other = box('c', 'Naples', '2026-10-09');
  other.auto.vessel = { name: 'OTHER SHIP' };
  assert.equal(shipLeader(other, [...list, other], options), other);
  assert.equal(
    shipKeyOf({ auto: { vessel: { name: 'Msc  Test' } } }),
    'name:MSC TEST',
  );
});

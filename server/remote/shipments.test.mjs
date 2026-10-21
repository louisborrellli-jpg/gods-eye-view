import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShipmentId, summarizeShipments } from './shipments.js';

const NOW = Date.UTC(2026, 9, 21, 15);

const snapshot = {
  mode: 'server',
  defaults: { rampFreeDays: 1 },
  shipments: [
    {
      id: 'sea1',
      container: 'MSCU1234566',
      reference: 'PO 7781',
      carrier: 'msc',
      auto: {
        source: 'FindTEU',
        vessel: { name: 'MSC ARICA' },
        pol: { port: 'Gioia Tauro', code: 'ITGIT' },
        pod: { port: 'Montreal', code: 'CAMTR' },
        destination: { port: 'Toronto', code: 'CATOR' },
        dates: { loaded: '2026-10-01', portEta: '2026-10-30' },
      },
    },
    {
      id: 'ramp1',
      container: 'MSKU1234567',
      carrier: 'maersk',
      holds: { customs: true },
      auto: {
        source: 'FindTEU',
        dates: {
          loaded: '2026-09-20',
          portEta: '2026-10-12',
          discharged: '2026-10-13',
          railDeparted: '2026-10-15',
          rampArrived: '2026-10-20',
        },
      },
    },
  ],
};

test('rows carry what a phone shows: stage, route, loaded, ETAs, last free day', () => {
  const rows = summarizeShipments(snapshot, NOW);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['ramp1', 'sea1'],
    'the box with a running free-time clock comes first',
  );
  const [ramp, sea] = rows;
  assert.equal(sea.stage, 'at-sea');
  assert.equal(sea.route, 'Gioia Tauro → Montreal → Toronto');
  assert.equal(sea.ship, 'MSC ARICA');
  assert.equal(sea.carrier, 'MSC');
  assert.equal(sea.loaded, '2026-10-01');
  assert.equal(sea.portEta, '2026-10-30');
  assert.equal(sea.lastFreeDay.daysLeft, null, 'estimated until off the rail');
  assert.equal(sea.lastFreeDay.estimated, true);

  assert.equal(ramp.stage, 'at-ramp');
  assert.equal(ramp.portEta, '', 'unloaded: no port ETA to show');
  assert.equal(ramp.rampEta, null, 'arrived: no rail ETA to show');
  assert.equal(ramp.lastFreeDay.day, '2026-10-21');
  assert.equal(ramp.lastFreeDay.daysLeft, 0);
  assert.equal(ramp.onHold, true);
  assert.ok(ramp.severity >= 2);
});

test('bad input gives no rows, and ids are checked', () => {
  assert.deepEqual(summarizeShipments(null, NOW), []);
  assert.deepEqual(summarizeShipments({ shipments: [{}] }, NOW), []);
  assert.equal(parseShipmentId('abc-1_2'), 'abc-1_2');
  assert.equal(parseShipmentId('a b'), null);
});

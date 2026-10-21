import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  localDay,
  normalizeDay,
  normalizeDefaults,
  normalizeShipment,
  rampEtaFor,
  shipmentAlerts,
  shipmentClocks,
  shipmentStage,
  shipmentSummary,
  worstSeverity,
} from './model.js';

const TODAY = '2026-10-21';
const ship = (input = {}) =>
  normalizeShipment({ id: 's1', container: 'MSCU1234566', ...input });
const codes = (shipment) => shipmentAlerts(shipment, TODAY).map((a) => a.code);

test('calendar days are validated and counted across months', () => {
  assert.equal(normalizeDay('2026-02-30'), '');
  assert.equal(normalizeDay('2026-10-21'), '2026-10-21');
  assert.equal(normalizeDay('21/10/2026'), '');
  assert.equal(daysBetween('2026-10-30', '2026-11-02'), 3);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(localDay(new Date(2026, 9, 21, 23, 59).getTime()), TODAY);
});

test('normalization bounds fields and defaults the Montreal → Toronto route', () => {
  const shipment = ship({
    carrier: 'nope',
    dates: { portEta: '2026-10-25', rampLfd: 'soon' },
    freeDays: { ramp: '4', return: 999 },
    vessel: { query: ' MSC ANNA ', mmsi: 'x', imo: '9839131' },
  });
  assert.equal(shipment.carrier, '');
  assert.equal(shipment.port, 'Montreal');
  assert.equal(shipment.ramp, 'Toronto');
  assert.equal(shipment.dates.portEta, '2026-10-25');
  assert.equal(shipment.dates.rampLfd, '');
  assert.deepEqual(shipment.freeDays, { ramp: 4, return: null });
  assert.deepEqual(shipment.vessel, {
    query: 'MSC ANNA',
    mmsi: '',
    imo: '9839131',
  });
});

test('the stage follows the latest recorded milestone', () => {
  assert.equal(shipmentStage(ship()), 'at-sea');
  assert.equal(
    shipmentStage(ship({ dates: { discharged: '2026-10-20' } })),
    'at-port',
  );
  assert.equal(
    shipmentStage(ship({ dates: { railDeparted: '2026-10-20' } })),
    'on-rail',
  );
  assert.equal(
    shipmentStage(ship({ dates: { rampArrived: '2026-10-20' } })),
    'at-ramp',
  );
  assert.equal(
    shipmentStage(ship({ dates: { pickedUp: '2026-10-20' } })),
    'with-you',
  );
  assert.equal(
    shipmentStage(ship({ dates: { emptyReturned: '2026-10-20' } })),
    'done',
  );
});

test('a ramp last free day is estimated from arrival and free days, counting the arrival day', () => {
  const estimated = shipmentClocks(
    ship({
      dates: { railDeparted: '2026-10-19', rampEta: '2026-10-22' },
      freeDays: { ramp: 2 },
    }),
    TODAY,
  ).find((clock) => clock.id === 'ramp');
  assert.equal(estimated.day, '2026-10-23');
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.daysLeft, 2);

  const actual = shipmentClocks(
    ship({ dates: { rampArrived: '2026-10-21' }, freeDays: { ramp: 2 } }),
    TODAY,
  ).find((clock) => clock.id === 'ramp');
  assert.equal(actual.day, '2026-10-22');
  assert.equal(actual.estimated, false);

  const typed = shipmentClocks(
    ship({
      dates: { rampArrived: '2026-10-21', rampLfd: '2026-10-25' },
      freeDays: { ramp: 2 },
    }),
    TODAY,
  ).find((clock) => clock.id === 'ramp');
  assert.equal(typed.day, '2026-10-25');
});

test('clocks close once the box moves past them', () => {
  const clocks = shipmentClocks(
    ship({
      dates: {
        portLfd: '2026-10-15',
        rampLfd: '2026-10-18',
        pickedUp: '2026-10-18',
        emptyReturnBy: '2026-10-24',
      },
    }),
    TODAY,
  );
  assert.deepEqual(
    clocks.map((clock) => [clock.id, clock.state]),
    [
      ['port', 'closed'],
      ['ramp', 'closed'],
      ['return', 'ok'],
    ],
  );
});

test('running out of free time escalates to severity 3', () => {
  const overdue = shipmentAlerts(
    ship({ dates: { rampArrived: '2026-10-16', rampLfd: '2026-10-19' } }),
    TODAY,
  );
  assert.equal(overdue[0].code, 'overdue');
  assert.equal(overdue[0].days, 2);
  assert.equal(overdue[0].severity, 3);

  const lastDay = shipmentAlerts(
    ship({ dates: { rampArrived: '2026-10-19', rampLfd: TODAY } }),
    TODAY,
  );
  assert.equal(lastDay[0].code, 'last-day');

  const soon = shipmentAlerts(
    ship({
      dates: {
        rampArrived: '2026-10-20',
        rampLfd: '2026-10-23',
        pickupPlanned: '2026-10-22',
      },
    }),
    TODAY,
  );
  assert.deepEqual(
    soon.map((a) => [a.code, a.severity]),
    [['due-soon', 2]],
  );
});

test('a truck booked after the last free day is flagged', () => {
  const alerts = shipmentAlerts(
    ship({
      dates: {
        rampArrived: '2026-10-20',
        rampLfd: '2026-10-24',
        pickupPlanned: '2026-10-26',
      },
    }),
    TODAY,
  );
  const late = alerts.find((alert) => alert.code === 'truck-late');
  assert.equal(late.days, 2);
  assert.equal(late.severity, 3);
});

test('no truck booked: warn at the ramp, and two days before the rail ETA', () => {
  assert.ok(
    codes(ship({ dates: { rampArrived: '2026-10-21' } })).includes(
      'book-truck',
    ),
  );
  assert.ok(
    codes(
      ship({ dates: { railDeparted: '2026-10-18', rampEta: '2026-10-23' } }),
    ).includes('book-truck'),
  );
  assert.ok(
    !codes(
      ship({ dates: { railDeparted: '2026-10-18', rampEta: '2026-10-28' } }),
    ).includes('book-truck'),
  );
  assert.ok(
    !codes(
      ship({
        dates: { rampArrived: '2026-10-21', pickupPlanned: '2026-10-22' },
      }),
    ).includes('book-truck'),
  );
});

test('holds, passed ETAs and a late ship are reported', () => {
  const hold = shipmentAlerts(
    ship({ dates: { discharged: '2026-10-20' }, holds: { customs: true } }),
    TODAY,
  );
  assert.deepEqual(hold[0], { code: 'hold', severity: 2, holds: ['customs'] });
  assert.ok(
    codes(ship({ dates: { portEta: '2026-10-18' } })).includes('eta-passed'),
  );
  assert.ok(
    codes(
      ship({ dates: { railDeparted: '2026-10-15', rampEta: '2026-10-19' } }),
    ).includes('rail-eta-passed'),
  );
  const late = shipmentAlerts(
    ship({
      dates: { portEta: '2026-10-24' },
      lastSeen: { lat: 45, lon: -60, at: 1, eta: '2026-10-28T12:00:00.000Z' },
    }),
    TODAY,
  ).find((alert) => alert.code === 'ship-late');
  assert.equal(late.days, 4);
  assert.equal(late.severity, 2);
});

test('a returned box raises nothing and the summary names the next date', () => {
  const done = ship({
    dates: { rampLfd: '2026-10-01', emptyReturned: '2026-10-05' },
  });
  assert.deepEqual(shipmentAlerts(done, TODAY), []);
  assert.equal(worstSeverity([done], TODAY), 0);
  assert.deepEqual(
    shipmentSummary(ship({ dates: { portEta: '2026-10-25' } }), TODAY),
    {
      stage: 'at-sea',
      next: { kind: 'port-eta', day: '2026-10-25', days: 4 },
    },
  );
  assert.deepEqual(
    shipmentSummary(
      ship({ dates: { rampArrived: '2026-10-20', rampLfd: '2026-10-22' } }),
      TODAY,
    ).next,
    { kind: 'clock:ramp', day: '2026-10-22', days: 1 },
  );
});

test('tracked dates fill in, and a typed date always wins', () => {
  const shipment = ship({
    dates: { portEta: '2026-10-26' },
    auto: {
      source: 'FindTEU',
      carrier: 'msc',
      dates: { portEta: '2026-10-24', discharged: '2026-10-25', bogus: 'x' },
      vessel: { name: 'MSC TESTA', imo: '9900123', mmsi: '990000123' },
      fetchedAt: 7,
    },
  });
  assert.equal(shipment.carrier, 'msc');
  assert.equal(shipment.manual.portEta, '2026-10-26');
  assert.equal(shipment.dates.portEta, '2026-10-26');
  assert.equal(shipment.dates.discharged, '2026-10-25');
  assert.equal(shipmentStage(shipment), 'at-port');
  assert.equal(shipment.auto.dates.bogus, undefined);
});

test('board defaults give every box its free days and a rail estimate', () => {
  const defaults = normalizeDefaults({
    rampFreeDays: '3',
    returnFreeDays: 5,
    railDays: 4,
  });
  const atPort = ship({ dates: { discharged: '2026-10-20' } });
  assert.deepEqual(rampEtaFor(atPort, defaults), {
    day: '2026-10-24',
    estimated: true,
  });
  const ramp = shipmentClocks(atPort, TODAY, defaults).find(
    (clock) => clock.id === 'ramp',
  );
  assert.equal(ramp.day, '2026-10-26');
  assert.equal(ramp.estimated, true);
  // A box's own free days win; attached defaults are read when none passed.
  const own = {
    ...ship({ dates: { rampArrived: TODAY }, freeDays: { ramp: 1 } }),
    defaults,
  };
  assert.equal(
    shipmentClocks(own, TODAY).find((c) => c.id === 'ramp').day,
    TODAY,
  );
  const sameplace = ship({
    port: 'Toronto',
    ramp: 'toronto',
    dates: { discharged: TODAY },
  });
  assert.equal(rampEtaFor(sameplace, defaults).day, '');
  assert.ok(
    shipmentAlerts(ship({ dates: { discharged: '2026-10-20' } }), TODAY, {
      ...defaults,
      railDays: 2,
    }).some((alert) => alert.code === 'book-truck'),
  );
});

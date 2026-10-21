import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFindTeu } from './tracking.js';

const event = (date, action, code, type, mode = 'Truck', vessel = null) => ({
  event_date: date,
  location: { terminal: '', port: code, country: '', iso_code: code },
  action: { action_name: action },
  mode: {
    transport_mode: mode,
    vessel: vessel ?? { vessel_name: '', imo: '', mmsi: '', voyage_nr: '' },
  },
  event_type: type,
  event_recent: false,
});
const SHIP = {
  vessel_name: 'MSC TESTA',
  imo: '9900123',
  mmsi: 990000123,
  voyage_nr: 'NA641R',
};

/** Gioia Tauro → Montreal by sea, then carrier rail to Toronto. */
function montrealToToronto(extra = []) {
  return {
    scac: 'MSCU',
    pol: { port: 'Gioia Tauro', iso_code: 'ITGIT', etd_date: '2026-10-02' },
    pod: { port: 'Montreal', iso_code: 'CAMTR', eta_date: '2026-10-20' },
    destination: { port: 'Toronto', iso_code: 'CATOR' },
    container: { number: 'MSCU1234566', completed: false },
    events: [
      event('2026-09-28', 'Gate in full by', 'ITGIT', 'actual'),
      event('2026-10-01', 'Loaded on', 'ITGIT', 'actual', 'Vessel', SHIP),
      event('2026-10-02', 'Departed by', 'ITGIT', 'actual', 'Vessel', SHIP),
      event('2026-10-20', 'Arrived by', 'CAMTR', 'expected', 'Vessel', SHIP),
      event(
        '2026-10-21',
        'Discharged from',
        'CAMTR',
        'expected',
        'Vessel',
        SHIP,
      ),
      event('2026-10-25', 'Arrived by', 'CATOR', 'expected', 'Rail'),
      ...extra,
    ],
  };
}

test('an ocean leg in progress names the ship and the expected dates', () => {
  const tracking = parseFindTeu(montrealToToronto(), { now: 5 });
  assert.equal(tracking.carrier, 'msc');
  assert.equal(tracking.fetchedAt, 5);
  assert.deepEqual(tracking.vessel, {
    name: 'MSC TESTA',
    imo: '9900123',
    mmsi: '990000123',
    voyage: 'NA641R',
  });
  assert.deepEqual(tracking.dates, {
    portEta: '2026-10-20',
    discharged: '',
    railDeparted: '',
    rampEta: '2026-10-25',
    rampArrived: '',
    pickedUp: '',
    emptyReturned: '',
  });
  assert.equal(tracking.destination.code, 'CATOR');
});

test('actual unloading, rail, ramp, pickup and return fill in as they happen', () => {
  const data = montrealToToronto([
    event('2026-10-20', 'Arrived by', 'CAMTR', 'actual', 'Vessel', SHIP),
    event('2026-10-21', 'Discharged from', 'CAMTR', 'actual', 'Vessel', SHIP),
    event('2026-10-22', 'Departed by', 'CAMTR', 'actual', 'Rail'),
    event('2026-10-24', 'Arrived by', 'CATOR', 'actual', 'Rail'),
    event('2026-10-26', 'Delivered by', 'CATOR', 'actual'),
    event('2026-10-30', 'Empty returned by', 'CATOR', 'actual'),
  ]);
  const tracking = parseFindTeu(data);
  assert.deepEqual(tracking.dates, {
    portEta: '2026-10-20',
    discharged: '2026-10-21',
    railDeparted: '2026-10-22',
    rampEta: '2026-10-24',
    rampArrived: '2026-10-24',
    pickedUp: '2026-10-26',
    emptyReturned: '2026-10-30',
  });
  assert.equal(tracking.vessel, null, 'no ship to follow once unloaded');
});

test('a port-only journey has no rail dates; unusable answers are refused', () => {
  const data = montrealToToronto();
  data.destination = { port: 'Montreal', iso_code: 'CAMTR' };
  const tracking = parseFindTeu(data);
  assert.equal(tracking.dates.rampEta, '');
  assert.equal(tracking.dates.railDeparted, '');
  assert.equal(parseFindTeu(null), null);
  assert.equal(parseFindTeu({ error: 1 }), null);
});

test('the FindTEU demo answer parses with its transshipment ship', () => {
  const demo = {
    scac: 'ONEY',
    pol: { port: 'Santos', iso_code: 'BRSSZ' },
    pod: { port: 'Pusan', iso_code: 'KRPUS', eta_date: '2025-04-12' },
    destination: { port: 'Pusan', iso_code: 'KRPUS' },
    container: { number: 'MSCU1234566', completed: false },
    events: [
      event('2025-02-27', 'Loaded on', 'BRSSZ', 'actual', 'Vessel', {
        vessel_name: 'CAPE SOUNIO',
        imo: '9727625',
        mmsi: 248089000,
      }),
      event('2025-04-07', 'Loaded on', 'CNSHA', 'expected', 'Vessel', {
        vessel_name: 'HMM BLESSING',
        imo: '9742170',
        mmsi: 440326000,
      }),
      event('2025-04-12', 'Arrived by', 'KRPUS', 'expected', 'Vessel', {
        vessel_name: 'HMM BLESSING',
      }),
    ],
  };
  const tracking = parseFindTeu(demo);
  assert.equal(tracking.carrier, 'one');
  assert.equal(tracking.vessel.name, 'CAPE SOUNIO');
  assert.equal(tracking.dates.portEta, '2025-04-12');
});

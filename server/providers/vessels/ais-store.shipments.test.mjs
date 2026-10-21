import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aisEtaIso,
  findAisVessels,
  ingestAisStreamEnvelope,
} from './ais-store.js';

const NOW = Date.UTC(2026, 9, 21, 12);

test('an AIS ETA gets the year that puts it nearest to now', () => {
  assert.equal(
    aisEtaIso({ Month: 10, Day: 25, Hour: 6, Minute: 30 }, NOW),
    '2026-10-25T06:30:00.000Z',
  );
  assert.equal(
    aisEtaIso({ Month: 1, Day: 3, Hour: 8, Minute: 0 }, NOW),
    '2027-01-03T08:00:00.000Z',
  );
  assert.equal(
    aisEtaIso({ Month: 9, Day: 30, Hour: 24, Minute: 60 }, NOW),
    '2026-09-30T12:00:00.000Z',
  );
  assert.equal(aisEtaIso({ Month: 0, Day: 0, Hour: 24, Minute: 60 }, NOW), '');
  assert.equal(aisEtaIso({ Month: 2, Day: 31, Hour: 1, Minute: 0 }, NOW), '');
  assert.equal(aisEtaIso(null, NOW), '');
});

const time = () =>
  new Date().toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');

function staticData(mmsi, name, imo, eta) {
  return {
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: mmsi, ShipName: name, time_utc: time() },
    Message: {
      ShipStaticData: {
        UserID: mmsi,
        Name: name,
        ImoNumber: imo,
        Destination: 'CAMTR',
        Eta: eta,
      },
    },
  };
}

function position(mmsi, name) {
  return {
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: mmsi,
      ShipName: name,
      latitude: 47.1,
      longitude: -70.2,
      time_utc: time(),
    },
    Message: {
      PositionReport: { UserID: mmsi, Sog: 12.5, Cog: 240, TrueHeading: 238 },
    },
  };
}

test('ships are found by MMSI, IMO or name, carrying their ETA', () => {
  const eta = { Month: 11, Day: 2, Hour: 14, Minute: 0 };
  ingestAisStreamEnvelope(
    staticData(990000001, 'SHIPTEST ALPHA', 9900001, eta),
  );
  ingestAisStreamEnvelope(position(990000001, 'SHIPTEST ALPHA'));
  ingestAisStreamEnvelope(position(990000002, 'SHIPTEST ALPHA II'));

  const byName = findAisVessels('shiptest alpha');
  assert.deepEqual(
    byName.map((row) => row.mmsi),
    ['990000001', '990000002'],
  );
  assert.equal(byName[0].destination, 'CAMTR');
  assert.match(byName[0].eta, /-11-02T14:00:00.000Z$/);
  assert.equal(byName[0]._updatedAt, undefined);
  assert.deepEqual(
    findAisVessels('IMO 9900001').map((row) => row.mmsi),
    ['990000001'],
  );
  assert.deepEqual(
    findAisVessels('990000002').map((row) => row.mmsi),
    ['990000002'],
  );
  assert.deepEqual(findAisVessels('ab'), []);
});

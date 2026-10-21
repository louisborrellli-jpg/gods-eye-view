import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShipmentVesselSource,
  pickVesselMatch,
  vesselLookupQuery,
} from './source.js';

test('lookups send only the ship query to the same-origin endpoint', async () => {
  const calls = [];
  const source = createShipmentVesselSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          matches: [{ mmsi: '1' }],
          configured: true,
          status: 'live',
        }),
      };
    },
  });
  const result = await source.findVessel('MSC ANNA');
  assert.deepEqual(calls, ['/api/vessels/find?q=MSC%20ANNA']);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(await source.findVessel('ab'), {
    matches: [],
    configured: true,
    status: null,
  });
});

test('a failed lookup throws an English message for the layer to translate', async () => {
  const source = createShipmentVesselSource({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  await assert.rejects(
    source.findVessel('MSC ANNA'),
    /Ship lookup unavailable/,
  );
});

test('matches prefer known ids and refuse ambiguous names', () => {
  const rows = [
    { mmsi: '111111111', imo: '1111111', name: 'MSC ANNA' },
    { mmsi: '222222222', imo: '2222222', name: 'MSC ANNA II' },
  ];
  assert.equal(pickVesselMatch(rows, { query: 'MSC ANNA' }).mmsi, '111111111');
  assert.equal(
    pickVesselMatch(rows, { query: 'IMO 2222222' }).mmsi,
    '222222222',
  );
  assert.equal(
    pickVesselMatch(rows, { mmsi: '222222222', query: 'MSC ANNA' }).mmsi,
    '222222222',
  );
  assert.equal(
    pickVesselMatch([...rows, { mmsi: '3', name: 'MSC ANNA' }], {
      query: 'msc anna',
    }),
    null,
  );
  assert.equal(pickVesselMatch(rows, { query: 'MSC' }), null);
  assert.equal(vesselLookupQuery({ query: 'x', imo: '1234567' }), '1234567');
});

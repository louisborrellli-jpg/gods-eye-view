import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesWords, searchEverything } from './globalSearchModel.js';

const shipments = [
  {
    id: 's1',
    container: 'MSCU1234566',
    reference: 'PO 7781 tiles',
    carrier: 'msc',
    auto: { vessel: { name: 'MSC ARICA' } },
  },
  { id: 's2', container: 'FANU1040642', reference: '', carrier: 'hapag' },
];
const layers = [
  { id: 'flights', name: 'Live Flights', enabled: false },
  { id: 'shipments', name: 'Shipments', enabled: true },
  { id: 'watch-zones', name: 'Watch Zones', enabled: true },
];
const items = [
  {
    layerId: 'watch-zones',
    layerName: 'Watch Zones',
    id: 'zone:z1',
    text: 'Zone Brampton yard',
    params: { select: 'z1' },
  },
  {
    layerId: 'shipments',
    layerName: 'Shipments',
    id: 's1',
    text: 'MSCU1234566 · At sea',
    params: { select: 's1' },
  },
];
const sources = { shipments, layers, items, shipmentsLayerId: 'shipments' };

test('a container is found by number, reference or ship, once', () => {
  for (const query of ['mscu 1234', 'tiles', 'arica']) {
    const results = searchEverything(query, sources);
    assert.equal(results[0].kind, 'container', query);
    assert.equal(results[0].target.id, 's1');
    // Its row in the Shipments layer is not listed a second time.
    assert.equal(results.filter((r) => r.title.startsWith('MSCU')).length, 1);
  }
});

test('items inside layers and the layers themselves are found', () => {
  const zone = searchEverything('brampton', sources);
  assert.equal(zone[0].kind, 'item');
  assert.deepEqual(zone[0].target, {
    layerId: 'watch-zones',
    params: { select: 'z1' },
  });
  const layer = searchEverything('flights', sources);
  assert.equal(layer[0].kind, 'layer');
  assert.equal(layer[0].target.enabled, false);
});

test('a place search is always offered last, never for one letter', () => {
  const results = searchEverything('Montreal', sources);
  assert.equal(results.at(-1).kind, 'place');
  assert.equal(results.at(-1).target.query, 'Montreal');
  assert.deepEqual(searchEverything('m', sources), []);
  assert.deepEqual(searchEverything('  ', sources), []);
});

test('word matching ignores case, accents and spacing', () => {
  assert.ok(matchesWords('Gioia Tauro → Montréal', 'montreal gioia'));
  assert.ok(matchesWords('FANU1040642', 'fanu 104'));
  assert.ok(!matchesWords('Salerno', 'naples'));
});

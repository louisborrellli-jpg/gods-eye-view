import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShipment } from './model.js';
import { matchesSearch, searchShipments } from './search.js';

const boxes = [
  normalizeShipment({
    id: 'a',
    container: 'FANU1040642',
    carrier: 'hapag',
    reference: 'Giaguaro Windsor',
    auto: { vessel: { name: 'ARICA EXPRESS' }, pol: { port: 'Salerno' } },
  }),
  normalizeShipment({
    id: 'b',
    container: 'MSCU1234566',
    carrier: 'msc',
    reference: 'PO 4471',
  }),
  normalizeShipment({ id: 'c', container: 'MSCU1234570', carrier: 'msc' }),
];

test('a search finds boxes by number, reference, ship, line or port', () => {
  const ids = (query) => searchShipments(boxes, query).map((box) => box.id);
  assert.deepEqual(ids('fanu'), ['a']);
  assert.deepEqual(ids('mscu 12345 66'), ['b']);
  assert.deepEqual(ids('mscu1234'), ['b', 'c']);
  assert.deepEqual(ids('windsor'), ['a']);
  assert.deepEqual(ids('arica'), ['a']);
  assert.deepEqual(ids('hapag'), ['a']);
  assert.deepEqual(ids('salerno'), ['a']);
  assert.deepEqual(ids('po 4471'), ['b']);
  assert.deepEqual(ids('nothing like this'), []);
  assert.equal(matchesSearch(boxes[0], '   '), true);
});

test('an exact number comes first', () => {
  assert.deepEqual(
    searchShipments([boxes[2], boxes[1]], 'MSCU1234566').map((box) => box.id),
    ['b'],
  );
});

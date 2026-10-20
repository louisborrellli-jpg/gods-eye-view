import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultCameraId,
  viewpointFromCartographic,
} from './defaultCamera.js';

const record = (id, lat, lon) => ({ camera: { id, lat, lon } });

// Austin leads the catalog because its pack loads first; Windsor is where the
// operator in this test is looking.
const CATALOG = [
  record('austin-congress', 30.2672, -97.7431),
  record('london-jamcam', 51.5072, -0.1276),
  record('windsor-riverside', 42.3149, -83.0364),
  record('toronto-gardiner', 43.6532, -79.3832),
];

const WINDSOR = { lat: 42.3149, lon: -83.0364 };

test('a viewer over Windsor gets a Windsor camera, not the first in the catalog', () => {
  assert.equal(defaultCameraId(CATALOG, WINDSOR), 'windsor-riverside');
});

test('the nearest camera wins even when it is far away', () => {
  // Nothing near Reykjavik: London is still the best available answer.
  const id = defaultCameraId(CATALOG, { lat: 64.1466, lon: -21.9426 });
  assert.equal(id, 'london-jamcam');
});

test('no viewer position falls back to catalog order rather than a bogus origin', () => {
  assert.equal(defaultCameraId(CATALOG, null), 'austin-congress');
  assert.equal(defaultCameraId(CATALOG), 'austin-congress');
  assert.equal(
    defaultCameraId(CATALOG, { lat: Number.NaN, lon: -83 }),
    'austin-congress',
  );
});

test('an empty or absent catalog yields null rather than throwing', () => {
  assert.equal(defaultCameraId([], WINDSOR), null);
  assert.equal(defaultCameraId(null, WINDSOR), null);
  assert.equal(defaultCameraId(undefined), null);
});

test('records without usable coordinates are skipped, not ranked', () => {
  const ragged = [
    { camera: { id: 'no-coords' } },
    { camera: { lat: 1, lon: 1 } }, // no id
    null,
    record('real', 42.31, -83.03),
  ];
  assert.equal(defaultCameraId(ragged, WINDSOR), 'real');
});

test('a catalog of only unusable records still answers with a first id', () => {
  const broken = [{ camera: { id: 'no-coords' } }, { camera: {} }];
  assert.equal(defaultCameraId(broken, WINDSOR), 'no-coords');
});

test('an exact tie keeps the earlier catalog entry, so the pick is stable', () => {
  const tied = [record('first', 10, 10), record('second', 10, 10)];
  assert.equal(defaultCameraId(tied, { lat: 10, lon: 10 }), 'first');
  assert.equal(defaultCameraId(tied, { lat: 10, lon: 10 }), 'first');
});

test('cartographic radians convert to the degrees the picker expects', () => {
  const point = viewpointFromCartographic({
    latitude: (42.3149 * Math.PI) / 180,
    longitude: (-83.0364 * Math.PI) / 180,
  });
  assert.ok(Math.abs(point.lat - 42.3149) < 1e-9);
  assert.ok(Math.abs(point.lon - -83.0364) < 1e-9);
});

test('a missing or partial cartographic is null, not a half-read position', () => {
  assert.equal(viewpointFromCartographic(null), null);
  assert.equal(viewpointFromCartographic(undefined), null);
  assert.equal(viewpointFromCartographic({ latitude: 0.7 }), null);
});

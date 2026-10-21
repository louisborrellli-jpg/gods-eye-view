import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DETROIT_CATEGORIES,
  DETROIT_DATASETS,
  bboxParam,
  datasetsInCategory,
  normalizeFeature,
} from './datasets.js';

test('every dataset names a known category, geom and colour', () => {
  for (const [id, spec] of Object.entries(DETROIT_DATASETS)) {
    assert.ok(DETROIT_CATEGORIES.includes(spec.category), `${id} category`);
    assert.ok(['point', 'line'].includes(spec.geom), `${id} geom`);
    assert.match(spec.color, /^#[0-9a-f]{6}$/i, `${id} colour`);
  }
  assert.deepEqual(datasetsInCategory('incidents'), ['crime']);
  assert.deepEqual(datasetsInCategory('road'), ['construction']);
});

test('bboxParam rounds to a stable key', () => {
  assert.equal(
    bboxParam({ west: -83.123456, south: 42.1, east: -83.0, north: 42.2 }),
    '-83.123,42.1,-83,42.2',
  );
});

test('a point feature normalizes from geojson geometry or lat/lon fields', () => {
  const geo = normalizeFeature(
    'traffic-signals',
    {
      geometry: { coordinates: [-83.05, 42.33] },
      properties: { int_id: 'A1', maintainin: 'City' },
    },
    0,
  );
  assert.equal(geo.id, 'traffic-signals:0');
  assert.equal(geo.category, 'civic');
  assert.ok(
    Math.abs(geo.lat - 42.33) < 1e-9 && Math.abs(geo.lon + 83.05) < 1e-9,
  );
  assert.equal(geo.title, 'A1');
  assert.deepEqual(geo.details, ['City']);
  // MDOT-style row with lat/lon fields, no geojson geometry.
  const crime = normalizeFeature(
    'crime',
    {
      properties: {
        latitude: 42.3,
        longitude: -83.1,
        offense_category: 'THEFT',
      },
    },
    2,
  );
  assert.equal(crime.title, 'THEFT');
  assert.equal(crime.lat, 42.3);
});

test('a line feature normalizes MDOT coordinatePoints; bad geometry is dropped', () => {
  const line = normalizeFeature(
    'construction',
    {
      coordinatePoints: [
        [-83.1, 42.3],
        [-83.0, 42.35],
      ],
      title: 'I-75 work',
    },
    0,
  );
  assert.deepEqual(line.path, [
    [-83.1, 42.3],
    [-83.0, 42.35],
  ]);
  assert.equal(line.title, 'I-75 work');
  assert.equal(
    normalizeFeature('crime', { properties: { offense_category: 'X' } }, 0),
    null,
  );
  assert.equal(
    normalizeFeature('construction', { coordinatePoints: [[-83, 42]] }, 0),
    null,
  );
});

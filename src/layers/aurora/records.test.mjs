import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AURORA_GRID_HEIGHT,
  AURORA_GRID_WIDTH,
  auroraColumn,
  auroraRow,
  normalizeAuroraSnapshot,
  parseAuroraTime,
} from './records.js';

/** A complete grid, with `fill(lon, lat)` choosing each cell's probability. */
const grid = (fill = () => 0) => {
  const coordinates = [];
  for (let lon = 0; lon < AURORA_GRID_WIDTH; lon += 1)
    for (let lat = -90; lat <= 90; lat += 1)
      coordinates.push([lon, lat, fill(lon, lat)]);
  return {
    'Observation Time': '2026-10-20T16:09:00Z',
    'Forecast Time': '2026-10-20T17:21:00Z',
    coordinates,
  };
};

test('the prime meridian lands mid-raster and north is the first row', () => {
  assert.equal(auroraColumn(0), 180);
  assert.equal(auroraColumn(180), 0);
  assert.equal(auroraColumn(200), 20);
  assert.equal(auroraColumn(359), 179);
  assert.equal(auroraRow(90), 0);
  assert.equal(auroraRow(0), 90);
  assert.equal(auroraRow(-90), AURORA_GRID_HEIGHT - 1);
});

test('a complete snapshot indexes every cell and reports its peak', () => {
  const snapshot = normalizeAuroraSnapshot(
    grid((lon, lat) => (lon === 200 && lat === 65 ? 46 : 0)),
  );
  assert.ok(snapshot);
  assert.equal(snapshot.probabilities.length, AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT);
  assert.equal(snapshot.peak, 46);
  assert.equal(snapshot.litCells, 1);
  const index = auroraRow(65) * AURORA_GRID_WIDTH + auroraColumn(200);
  assert.equal(snapshot.probabilities[index], 46);
  assert.equal(snapshot.observedAt, Date.parse('2026-10-20T16:09:00Z'));
  assert.equal(snapshot.forecastAt, Date.parse('2026-10-20T17:21:00Z'));
});

test('a partial grid is refused rather than drawn with holes', () => {
  const short = grid();
  short.coordinates.pop();
  assert.equal(normalizeAuroraSnapshot(short), null);
  assert.equal(normalizeAuroraSnapshot({ coordinates: [] }), null);
  assert.equal(normalizeAuroraSnapshot({}), null);
  assert.equal(normalizeAuroraSnapshot(null), null);
});

test('a cell outside the published ranges invalidates the snapshot', () => {
  const outOfRange = (cell) => {
    const payload = grid();
    payload.coordinates[0] = cell;
    return normalizeAuroraSnapshot(payload);
  };
  assert.equal(outOfRange([360, 0, 5]), null, 'longitude past the grid');
  assert.equal(outOfRange([-1, 0, 5]), null, 'negative longitude');
  assert.equal(outOfRange([0, 91, 5]), null, 'latitude past the pole');
  assert.equal(outOfRange([0, 0, 101]), null, 'probability over 100');
  assert.equal(outOfRange([0, 0, -1]), null, 'negative probability');
  assert.equal(outOfRange([0.5, 0, 5]), null, 'fractional longitude');
  assert.equal(outOfRange([0, 0]), null, 'missing probability');
  assert.equal(outOfRange('nope'), null, 'cell is not a tuple');
});

test('a repeated cell means this is not the grid we index', () => {
  const payload = grid();
  // Same coordinate twice: the count still matches, so only the duplicate
  // check can catch it.
  payload.coordinates[1] = [...payload.coordinates[0]];
  assert.equal(normalizeAuroraSnapshot(payload), null);
});

test('missing or unparsable timestamps read as unknown, never as now', () => {
  assert.equal(parseAuroraTime('2026-10-20T16:09:00Z'),
    Date.UTC(2026, 9, 20, 16, 9, 0),);
  assert.equal(parseAuroraTime('not a time'), null);
  assert.equal(parseAuroraTime(''), null);
  assert.equal(parseAuroraTime(undefined), null);

  const payload = grid();
  delete payload['Observation Time'];
  const snapshot = normalizeAuroraSnapshot(payload);
  assert.equal(snapshot.observedAt, null);
});

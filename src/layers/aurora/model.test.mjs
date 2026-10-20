import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AURORA_FULL_PROBABILITY,
  AURORA_MIN_PROBABILITY,
  auroraColor,
  buildAuroraRaster,
  visibleCellCount,
} from './model.js';
import {
  AURORA_GRID_HEIGHT,
  AURORA_GRID_WIDTH,
  auroraColumn,
  auroraRow,
} from './records.js';

const cells = (fill = 0) =>
  new Uint8Array(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT).fill(fill);

test('noise-level cells are fully transparent', () => {
  assert.deepEqual(auroraColor(0), [0, 0, 0, 0]);
  assert.deepEqual(auroraColor(AURORA_MIN_PROBABILITY - 1), [0, 0, 0, 0]);
  assert.deepEqual(auroraColor(Number.NaN), [0, 0, 0, 0]);
  // At the threshold itself the ramp starts from zero alpha, so the oval's
  // edge fades in rather than landing on a hard line.
  assert.equal(auroraColor(AURORA_MIN_PROBABILITY)[3], 0);
});

test('the ramp runs green to red and gains opacity with probability', () => {
  const low = auroraColor(10);
  const mid = auroraColor(AURORA_FULL_PROBABILITY / 2);
  const high = auroraColor(AURORA_FULL_PROBABILITY);

  assert.ok(low[1] > low[0], 'the quiet edge reads green');
  assert.ok(high[0] > high[1], 'the strongest cells read red');
  assert.ok(mid[0] > low[0] && mid[1] > 150, 'the middle passes through yellow');
  assert.ok(low[3] < mid[3] && mid[3] < high[3], 'alpha rises with probability');
});

test('probability past the ramp top stays at full strength, never brighter', () => {
  const top = auroraColor(AURORA_FULL_PROBABILITY);
  assert.deepEqual(auroraColor(100), top);
  assert.ok(top[3] <= 255);
});

test('the raster is a north-up whole-globe tile with the cell in its place', () => {
  const probabilities = cells(0);
  const index = auroraRow(65) * AURORA_GRID_WIDTH + auroraColumn(200);
  probabilities[index] = AURORA_FULL_PROBABILITY;

  const raster = buildAuroraRaster({ probabilities });
  assert.equal(raster.width, AURORA_GRID_WIDTH);
  assert.equal(raster.height, AURORA_GRID_HEIGHT);
  assert.equal(raster.data.length, AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT * 4);

  const offset = index * 4;
  assert.deepEqual(
    [...raster.data.slice(offset, offset + 4)],
    auroraColor(AURORA_FULL_PROBABILITY),
  );
  // Everything else is transparent, so the globe shows through.
  assert.equal(raster.data[3], 0);
});

test('an incomplete grid cannot be rastered', () => {
  assert.throws(() => buildAuroraRaster({ probabilities: new Uint8Array(4) }), TypeError);
  assert.throws(() => buildAuroraRaster(null), TypeError);
});

test('the reported count is what is drawn, not every cell the feed returned', () => {
  const probabilities = cells(0);
  probabilities[0] = AURORA_MIN_PROBABILITY - 1; // below the draw threshold
  probabilities[1] = AURORA_MIN_PROBABILITY;
  probabilities[2] = 80;
  assert.equal(visibleCellCount({ probabilities }), 2);
  assert.equal(visibleCellCount(null), 0);
});

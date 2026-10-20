import { AURORA_GRID_HEIGHT, AURORA_GRID_WIDTH } from './records.js';

/**
 * Below this probability the forecast is indistinguishable from background
 * noise, and drawing it lays a faint haze over the whole night side. Cells
 * under it are fully transparent so the oval reads as an oval.
 */
export const AURORA_MIN_PROBABILITY = 2;

/**
 * Probability at which the ramp reaches full strength. OVATION rarely exceeds
 * this outside a strong storm, so scaling to 100 would leave an ordinary night
 * almost invisible.
 */
export const AURORA_FULL_PROBABILITY = 50;

/** Opacity of a cell at full strength. The globe underneath must stay readable. */
export const AURORA_PEAK_ALPHA = 0.72;

/**
 * Colour for one cell, as the aurora itself grades: green at the quiet edge of
 * the oval, through yellow, to red where the forecast is strongest.
 *
 * @param {number} probability 0-100, as published.
 * @returns {[number, number, number, number]} RGBA, alpha 0-255.
 */
export function auroraColor(probability) {
  if (!Number.isFinite(probability) || probability < AURORA_MIN_PROBABILITY)
    return [0, 0, 0, 0];

  const span = AURORA_FULL_PROBABILITY - AURORA_MIN_PROBABILITY;
  const t = Math.min(1, (probability - AURORA_MIN_PROBABILITY) / span);

  // Green (60, 230, 120) -> yellow (235, 225, 90) -> red (240, 80, 70).
  let r;
  let g;
  let b;
  if (t < 0.5) {
    const k = t / 0.5;
    r = 60 + (235 - 60) * k;
    g = 230 + (225 - 230) * k;
    b = 120 + (90 - 120) * k;
  } else {
    const k = (t - 0.5) / 0.5;
    r = 235 + (240 - 235) * k;
    g = 225 + (80 - 225) * k;
    b = 90 + (70 - 90) * k;
  }

  // Alpha ramps from zero at the threshold so the oval's edge fades out
  // instead of ending on a hard line.
  const alpha = Math.round(AURORA_PEAK_ALPHA * 255 * t);
  return [Math.round(r), Math.round(g), Math.round(b), alpha];
}

/**
 * Paint a validated snapshot into an RGBA buffer laid out for a single
 * north-up imagery tile spanning the whole globe.
 *
 * Kept separate from any canvas so the pixels can be asserted directly.
 *
 * @param {{probabilities: Uint8Array}} snapshot From normalizeAuroraSnapshot.
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function buildAuroraRaster(snapshot) {
  const probabilities = snapshot?.probabilities;
  const expected = AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT;
  if (!probabilities || probabilities.length !== expected)
    throw new TypeError('Aurora raster requires a complete probability grid');

  const data = new Uint8ClampedArray(expected * 4);
  for (let index = 0; index < expected; index += 1) {
    const [r, g, b, a] = auroraColor(probabilities[index]);
    const offset = index * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = a;
  }
  return { width: AURORA_GRID_WIDTH, height: AURORA_GRID_HEIGHT, data };
}

/**
 * How many cells are at or above a visible probability. This is the count the
 * layer reports, so it reflects what is actually drawn rather than every cell
 * the feed returned.
 * @param {{probabilities: Uint8Array}} snapshot
 * @returns {number}
 */
export function visibleCellCount(snapshot) {
  const probabilities = snapshot?.probabilities;
  if (!probabilities) return 0;
  let count = 0;
  for (const probability of probabilities)
    if (probability >= AURORA_MIN_PROBABILITY) count += 1;
  return count;
}

/** NOAA SWPC OVATION publishes one value per whole degree of longitude and latitude. */
export const AURORA_GRID_WIDTH = 360;
export const AURORA_GRID_HEIGHT = 181;
const AURORA_CELL_COUNT = AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT;

/**
 * Column for a source longitude. OVATION counts longitude 0-359 eastward from
 * the prime meridian; the raster is drawn across a -180..180 rectangle, so the
 * prime meridian belongs in the middle.
 * @param {number} lon
 * @returns {number} 0-359
 */
export function auroraColumn(lon) {
  return (lon + 180) % AURORA_GRID_WIDTH;
}

/**
 * Row for a source latitude. Imagery is north-up, so +90 is the first row.
 * @param {number} lat
 * @returns {number} 0-180
 */
export function auroraRow(lat) {
  return 90 - lat;
}

/**
 * Validate a complete OVATION snapshot before it can replace the displayed
 * aurora. A partial grid is rejected rather than drawn, because a missing cell
 * is indistinguishable on screen from a cell with no aurora in it.
 *
 * @param {unknown} payload Parsed `ovation_aurora_latest.json`.
 * @returns {{observedAt: number|null, forecastAt: number|null,
 *   probabilities: Uint8Array, peak: number, litCells: number}|null}
 *   Null when the payload is unusable.
 */
export function normalizeAuroraSnapshot(payload) {
  const coordinates = payload?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== AURORA_CELL_COUNT)
    return null;

  const probabilities = new Uint8Array(AURORA_CELL_COUNT);
  const seen = new Uint8Array(AURORA_CELL_COUNT);
  let peak = 0;
  let litCells = 0;

  for (const cell of coordinates) {
    if (!Array.isArray(cell) || cell.length < 3) return null;
    const [lon, lat, probability] = cell;
    if (
      !Number.isInteger(lon) ||
      lon < 0 ||
      lon >= AURORA_GRID_WIDTH ||
      !Number.isInteger(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 100
    )
      return null;

    const index = auroraRow(lat) * AURORA_GRID_WIDTH + auroraColumn(lon);
    // A repeated cell means the grid is not the one-value-per-degree grid this
    // reader indexes, so the whole snapshot is suspect.
    if (seen[index]) return null;
    seen[index] = 1;
    probabilities[index] = probability;
    if (probability > peak) peak = probability;
    if (probability > 0) litCells += 1;
  }

  return {
    observedAt: parseAuroraTime(payload?.['Observation Time']),
    forecastAt: parseAuroraTime(payload?.['Forecast Time']),
    probabilities,
    peak,
    litCells,
  };
}

/** Epoch ms for an OVATION timestamp, or null when it is absent or unparsable. */
export function parseAuroraTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

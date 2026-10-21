// Portable package (no i18n): the layer panel localizes the label, and errors
// stay English data the panel localizes.
//
// NOAA CO-OPS publishes one "latest" water level per station; there is no bulk
// Great Lakes endpoint, so the source queries each station by id. Those ids are
// fixed HERE, never supplied by the caller, so a request can only ever reach a
// known gauge — the query is built from this table, not from client input.

const msg = (text) => text;

/**
 * The 52 NOAA CO-OPS water-level gauges on the Great Lakes and their connecting
 * channels (the St. Clair/Detroit and St. Marys rivers, Lake Ontario's outflow
 * at the St. Lawrence). Coordinates are the station metadata from CO-OPS; the
 * list changes very rarely, so it is bundled rather than fetched.
 */
export const GREAT_LAKES_STATIONS = Object.freeze([
  Object.freeze({
    id: '8311030',
    name: 'Ogdensburg',
    lat: 44.702778,
    lng: -75.494446,
    state: 'NY',
  }),
  Object.freeze({
    id: '8311062',
    name: 'Alexandria Bay',
    lat: 44.33111,
    lng: -75.934525,
    state: 'NY',
  }),
  Object.freeze({
    id: '9014070',
    name: 'Algonac',
    lat: 42.621113,
    lng: -82.526665,
    state: 'MI',
  }),
  Object.freeze({
    id: '9014080',
    name: 'St. Clair State Police',
    lat: 42.81222,
    lng: -82.48556,
    state: 'MI',
  }),
  Object.freeze({
    id: '9014087',
    name: 'Dry Dock',
    lat: 42.94528,
    lng: -82.44334,
    state: 'MI',
  }),
  Object.freeze({
    id: '9014090',
    name: 'Mouth of the Black River',
    lat: 42.9738,
    lng: -82.4204,
    state: 'MI',
  }),
  Object.freeze({
    id: '9014098',
    name: 'Fort Gratiot',
    lat: 43.0069,
    lng: -82.4225,
    state: 'MI',
  }),
  Object.freeze({
    id: '9034052',
    name: 'St Clair Shores',
    lat: 42.47322,
    lng: -82.87925,
    state: 'MI',
  }),
  Object.freeze({
    id: '9044020',
    name: 'Gibraltar',
    lat: 42.090862,
    lng: -83.186,
    state: 'MI',
  }),
  Object.freeze({
    id: '9044030',
    name: 'Wyandotte',
    lat: 42.202305,
    lng: -83.1475,
    state: 'MI',
  }),
  Object.freeze({
    id: '9044036',
    name: 'Fort Wayne',
    lat: 42.298912,
    lng: -83.092636,
    state: 'MI',
  }),
  Object.freeze({
    id: '9044049',
    name: 'Windmill Point',
    lat: 42.357777,
    lng: -82.92995,
    state: 'MI',
  }),
  Object.freeze({
    id: '9052000',
    name: 'Cape Vincent',
    lat: 44.13028,
    lng: -76.33222,
    state: 'NY',
  }),
  Object.freeze({
    id: '9052030',
    name: 'Oswego',
    lat: 43.46417,
    lng: -76.51183,
    state: 'NY',
  }),
  Object.freeze({
    id: '9052058',
    name: 'Rochester',
    lat: 43.26903,
    lng: -77.62575,
    state: 'NY',
  }),
  Object.freeze({
    id: '9052076',
    name: 'Olcott',
    lat: 43.33839,
    lng: -78.72733,
    state: 'NY',
  }),
  Object.freeze({
    id: '9063007',
    name: 'Ashland Ave',
    lat: 43.09992,
    lng: -79.05991,
    state: 'NY',
  }),
  Object.freeze({
    id: '9063009',
    name: 'American Falls',
    lat: 43.08106,
    lng: -79.06136,
    state: 'NY',
  }),
  Object.freeze({
    id: '9063012',
    name: 'Niagara Intake',
    lat: 43.07689,
    lng: -79.01403,
    state: 'NY',
  }),
  Object.freeze({
    id: '9063020',
    name: 'Buffalo',
    lat: 42.877445,
    lng: -78.89047,
    state: 'NY',
  }),
  Object.freeze({
    id: '9063028',
    name: 'Sturgeon Point',
    lat: 42.691307,
    lng: -79.04733,
    state: 'NY',
  }),
  Object.freeze({
    id: '9063038',
    name: 'Erie, Lake Erie',
    lat: 42.15389,
    lng: -80.075836,
    state: 'PA',
  }),
  Object.freeze({
    id: '9063053',
    name: 'Fairport',
    lat: 41.75975,
    lng: -81.28106,
    state: 'OH',
  }),
  Object.freeze({
    id: '9063063',
    name: 'Cleveland',
    lat: 41.54086,
    lng: -81.635475,
    state: 'OH',
  }),
  Object.freeze({
    id: '9063079',
    name: 'Marblehead',
    lat: 41.54364,
    lng: -82.73139,
    state: 'OH',
  }),
  Object.freeze({
    id: '9063085',
    name: 'Toledo',
    lat: 41.693554,
    lng: -83.472275,
    state: 'OH',
  }),
  Object.freeze({
    id: '9063090',
    name: 'Fermi Power Plant',
    lat: 41.96,
    lng: -83.25667,
    state: 'MI',
  }),
  Object.freeze({
    id: '9075002',
    name: 'Lakeport',
    lat: 43.141693,
    lng: -82.49331,
    state: 'MI',
  }),
  Object.freeze({
    id: '9075014',
    name: 'Harbor Beach',
    lat: 43.84639,
    lng: -82.64306,
    state: 'MI',
  }),
  Object.freeze({
    id: '9075035',
    name: 'Essexville',
    lat: 43.6404,
    lng: -83.8468,
    state: 'MI',
  }),
  Object.freeze({
    id: '9075065',
    name: 'Alpena',
    lat: 45.063,
    lng: -83.4286,
    state: 'MI',
  }),
  Object.freeze({
    id: '9075080',
    name: 'Mackinaw City',
    lat: 45.77722,
    lng: -84.72111,
    state: 'MI',
  }),
  Object.freeze({
    id: '9075099',
    name: 'De Tour Village',
    lat: 45.9925,
    lng: -83.8982,
    state: 'MI',
  }),
  Object.freeze({
    id: '9076024',
    name: 'Rock Cut',
    lat: 46.264805,
    lng: -84.19119,
    state: 'MI',
  }),
  Object.freeze({
    id: '9076027',
    name: 'West Neebish Island',
    lat: 46.28469,
    lng: -84.20981,
    state: 'MI',
  }),
  Object.freeze({
    id: '9076033',
    name: 'Little Rapids',
    lat: 46.485832,
    lng: -84.30167,
    state: 'MI',
  }),
  Object.freeze({
    id: '9076060',
    name: 'U.S. Slip',
    lat: 46.500805,
    lng: -84.34036,
    state: 'MI',
  }),
  Object.freeze({
    id: '9076070',
    name: 'S.W. Pier, St. Marys River',
    lat: 46.50111,
    lng: -84.37261,
    state: 'MI',
  }),
  Object.freeze({
    id: '9087023',
    name: 'Ludington',
    lat: 43.94736,
    lng: -86.4415,
    state: 'MI',
  }),
  Object.freeze({
    id: '9087031',
    name: 'Holland',
    lat: 42.773335,
    lng: -86.212776,
    state: 'MI',
  }),
  Object.freeze({
    id: '9087044',
    name: 'Calumet Harbor',
    lat: 41.72972,
    lng: -87.53833,
    state: 'IL',
  }),
  Object.freeze({
    id: '9087057',
    name: 'Milwaukee',
    lat: 43.001972,
    lng: -87.88764,
    state: 'WI',
  }),
  Object.freeze({
    id: '9087068',
    name: 'Kewaunee, Lake Michigan',
    lat: 44.46389,
    lng: -87.50103,
    state: 'WI',
  }),
  Object.freeze({
    id: '9087072',
    name: 'Sturgeon Bay Canal',
    lat: 44.794693,
    lng: -87.31392,
    state: 'WI',
  }),
  Object.freeze({
    id: '9087077',
    name: 'Green Bay East',
    lat: 44.539024,
    lng: -88.00106,
    state: 'WI',
  }),
  Object.freeze({
    id: '9087088',
    name: 'Menominee',
    lat: 45.09589,
    lng: -87.58994,
    state: 'MI',
  }),
  Object.freeze({
    id: '9087096',
    name: 'Port Inland',
    lat: 45.96989,
    lng: -85.8715,
    state: 'MI',
  }),
  Object.freeze({
    id: '9099004',
    name: 'Point Iroquois',
    lat: 46.484444,
    lng: -84.63084,
    state: 'MI',
  }),
  Object.freeze({
    id: '9099018',
    name: 'Marquette C.G.',
    lat: 46.545555,
    lng: -87.37861,
    state: 'MI',
  }),
  Object.freeze({
    id: '9099044',
    name: 'Ontonagon',
    lat: 46.874443,
    lng: -89.324165,
    state: 'MI',
  }),
  Object.freeze({
    id: '9099064',
    name: 'Duluth',
    lat: 46.77575,
    lng: -92.092026,
    state: 'MN',
  }),
  Object.freeze({
    id: '9099090',
    name: 'Grand Marais, Lake Superior',
    lat: 47.748554,
    lng: -90.34128,
    state: 'MN',
  }),
]);

// World text goes through the overlay host (collision-managed HTML labels),
// never Cesium entity labels — see src/noCesiumLabels.test.mjs.
export const GREAT_LAKES_OVERLAY_SOURCE_ID = 'great-lakes';
export const GREAT_LAKES_OVERLAY_COHORT_LIMIT = 60;
export const GREAT_LAKES_OVERLAY_COLLISION_CAPACITY = 52;
// A calm water blue that reads on the dark globe without competing with the
// hotter alert and fire palettes.
export const GREAT_LAKES_ACCENT = '#38bdf8';

/** `174.4 m` — one decimal is the gauge's meaningful precision on the lakes. */
export function formatLevelMeters(level) {
  return `${level.toFixed(1)} m`;
}

/**
 * Normalize one CO-OPS `datagetter` latest-water-level response against the
 * station it was requested for. Returns null for an error payload or a reading
 * that is missing or non-numeric, so a single dead gauge is simply skipped.
 *
 * @param {object} payload Parsed datagetter JSON (`{metadata, data:[{t,v}]}`).
 * @param {{id:string,name:string,state:string,lat:number,lng:number}} station
 */
export function parseWaterLevelReading(payload, station) {
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!row) return null; // `{ error: { message } }` or an empty series
  // CO-OPS reports `v` as a string; a blank one is "no reading", and `Number('')`
  // is 0, so guard the empty case before coercing.
  const raw = typeof row.v === 'string' ? row.v.trim() : row.v;
  if (raw === '' || raw == null) return null;
  const level = Number(raw);
  if (!Number.isFinite(level)) return null;
  const stamp = typeof row.t === 'string' ? row.t.trim() : '';
  // CO-OPS reports GMT as `YYYY-MM-DD HH:MM`; keep it as an ISO instant.
  const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp)
    ? `${stamp.replace(' ', 'T')}:00Z`
    : null;
  return Object.freeze({
    id: station.id,
    name: station.name,
    state: station.state,
    lat: station.lat,
    lng: station.lng,
    level, // metres, IGLD 1985 datum
    datum: 'IGLD',
    time,
  });
}

/** One ambient label for a station, at its position, showing its level. */
export function createGreatLakesOverlayEntry({
  id,
  position,
  title,
  priority,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent: GREAT_LAKES_ACCENT,
    priority: Math.round(Number(priority) || 0),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

export const GREAT_LAKES_SOURCE_UNAVAILABLE = msg(
  'Great Lakes water levels unavailable',
);

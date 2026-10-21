/**
 * Detroit open-data datasets the Detroit layer can show, grouped into three
 * categories the layer toggles: civic (static infrastructure points),
 * incidents (recent crime and fire runs), and road (construction / closures).
 *
 * Every dataset is fetched by the SERVER from a fixed, registered endpoint
 * (see server/providers/detroit.js); the browser only asks
 * `/api/detroit/<id>?bbox=…` for a registered id, so no client-supplied URL is
 * ever fetched. Pure data + helpers: no DOM, no Cesium, no Node.
 * @module layers/detroit/datasets
 */

// Portable (server-imported): a local marker lets `npm run i18n` extract the
// label strings; the browser layer translates them with t() at render.
const msg = (text) => text;

export const DETROIT_CATEGORIES = Object.freeze(['civic', 'incidents', 'road']);

export const DETROIT_CATEGORY_LABEL = Object.freeze({
  civic: msg('Civic'),
  incidents: msg('Incidents'),
  road: msg('Roadwork'),
});

/**
 * Registered datasets. `kind` picks the server fetch strategy:
 *  - `arcgis`: a City of Detroit ArcGIS FeatureServer, queried by map-area
 *    (bbox) so the spatial index keeps it fast.
 *  - `mdot`: the statewide Mi Drive construction feed, filtered to the bbox.
 * `geom` is 'point' or 'line'. `recentField`/`recentDays`, when set, limit an
 * incident feed to the trailing window. `titleField`/`detailFields` drive the
 * selection card. Colours are per dataset.
 */
export const DETROIT_DATASETS = Object.freeze({
  'traffic-signals': {
    category: 'civic',
    kind: 'arcgis',
    label: msg('Traffic signals'),
    geom: 'point',
    color: '#4fc3f7',
    titleField: 'int_id',
    detailFields: ['maintainin', 'jurisdicti'],
  },
  crime: {
    category: 'incidents',
    kind: 'arcgis',
    label: msg('Crime (30d)'),
    geom: 'point',
    color: '#ef5350',
    recentField: 'incident_occurred_at',
    recentDays: 30,
    titleField: 'offense_category',
    detailFields: ['offense_description', 'incident_occurred_at'],
  },
  construction: {
    category: 'road',
    kind: 'mdot',
    label: msg('Construction'),
    geom: 'line',
    color: '#ffca28',
    titleField: 'title',
    detailFields: [],
  },
});

/** Dataset ids in a category, in display order. */
export function datasetsInCategory(category) {
  return Object.keys(DETROIT_DATASETS).filter(
    (id) => DETROIT_DATASETS[id].category === category,
  );
}

/** A stable [W,S,E,N] bbox string, rounded, for cache keys and requests. */
export function bboxParam(rect) {
  const r = (n) => Math.round(Number(n) * 1000) / 1000;
  return [r(rect.west), r(rect.south), r(rect.east), r(rect.north)].join(',');
}

/**
 * Normalize an ArcGIS/MDOT feature into a plain record the layer renders.
 * Points carry {lat, lon}; lines carry {path: [[lon,lat],…]}. Returns null
 * when no usable geometry is present.
 * @param {string} datasetId
 * @param {object} feature GeoJSON feature (arcgis) or MDOT row.
 * @param {number} index
 * @returns {object|null}
 */
export function normalizeFeature(datasetId, feature, index) {
  const spec = DETROIT_DATASETS[datasetId];
  if (!spec) return null;
  const props = feature?.properties || feature || {};
  const title = pick(props, spec.titleField);
  const details = spec.detailFields
    .map((f) => pick(props, f))
    .filter((v) => v !== null && v !== '');
  const base = {
    id: `${datasetId}:${index}`,
    datasetId,
    category: spec.category,
    title: title || spec.label,
    details,
  };
  if (spec.geom === 'line') {
    const path = normalizePath(feature);
    return path && path.length >= 2 ? { ...base, path } : null;
  }
  const point = normalizePoint(feature, props);
  return point ? { ...base, ...point } : null;
}

function pick(props, field) {
  if (!field) return null;
  const v = props?.[field];
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : String(v);
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePoint(feature, props) {
  const coords = feature?.geometry?.coordinates;
  let lon = Array.isArray(coords) ? finite(coords[0]) : null;
  let lat = Array.isArray(coords) ? finite(coords[1]) : null;
  if (lat === null || lon === null) {
    lat = finite(props?.latitude ?? props?.lat);
    lon = finite(props?.longitude ?? props?.lon);
  }
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function normalizePath(feature) {
  // MDOT: coordinatePoints is [[lon,lat],…]. ArcGIS line: geometry.coordinates.
  const mdot = feature?.coordinatePoints;
  const raw = Array.isArray(mdot)
    ? mdot
    : feature?.geometry?.type === 'LineString'
      ? feature.geometry.coordinates
      : null;
  if (!Array.isArray(raw)) return null;
  const path = [];
  for (const pt of raw) {
    const lon = finite(pt?.[0]);
    const lat = finite(pt?.[1]);
    if (
      lat !== null &&
      lon !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    )
      path.push([lon, lat]);
  }
  return path;
}

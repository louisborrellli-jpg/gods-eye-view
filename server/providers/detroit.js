import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { DETROIT_DATASETS } from '../../src/layers/detroit/datasets.js';

/**
 * Detroit open-data proxy for the Detroit layer.
 *
 * GET /api/detroit/<dataset>?bbox=W,S,E,N → GeoJSON-ish {features:[…]} the
 * layer renders. Only registered dataset ids are served, and the upstream URL
 * is built here from a fixed table — the browser never supplies a URL (no
 * SSRF). ArcGIS incident/point feeds are queried by the map-area bbox so the
 * spatial index keeps them fast; the Mi Drive construction feed is fetched
 * whole, cached, and filtered to the bbox here. Each (dataset,bbox) is cached
 * ~2 min; a failed refresh serves the last good answer.
 */
const ARCGIS_BASE =
  'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services';
const MDOT_CONSTRUCTION_URL =
  'https://mdotjboss.state.mi.us/MiDrive/construction/AllForMap';

/** ArcGIS FeatureServer path + query shaping per dataset. */
const ARCGIS = Object.freeze({
  'traffic-signals': {
    service: 'Traffic_Signals',
    outFields: 'int_id,maintainin,jurisdicti',
    cap: 600,
  },
  crime: {
    service: 'RMS_Crime_Incidents_2026',
    outFields: 'offense_category,offense_description,incident_occurred_at',
    cap: 400,
  },
  // Improve Detroit (SeeClickFix) 311 requests. These rows carry no ArcGIS
  // geometry — the point is in longitude/latitude attribute fields — so this
  // dataset is queried by an attribute bbox and the proxy builds the GeoJSON.
  '311-requests': {
    service: 'improve_detroit',
    outFields: 'request_type,status,address,created_at,longitude,latitude',
    cap: 1000,
    attrCoords: { lon: 'longitude', lat: 'latitude' },
  },
});

const CACHE_MS = 120_000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
const STALE_LIMIT_MS = 30 * 60_000;
/** Refuse a wild bbox: Detroit-area only, and never a whole-globe query. */
const MAX_BBOX_SPAN_DEG = 2;

function parseBbox(raw) {
  const parts = String(raw || '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90 ||
    east <= west ||
    north <= south ||
    east - west > MAX_BBOX_SPAN_DEG ||
    north - south > MAX_BBOX_SPAN_DEG
  )
    return null;
  return { west, south, east, north };
}

function recencyWhere(datasetId) {
  const spec = DETROIT_DATASETS[datasetId];
  if (!spec?.recentField || !spec?.recentDays) return '1=1';
  const since = new Date(Date.now() - spec.recentDays * 86400_000)
    .toISOString()
    .slice(0, 10);
  // ArcGIS date literal.
  return `${spec.recentField} >= DATE '${since}'`;
}

function arcgisUrl(datasetId, bbox) {
  const cfg = ARCGIS[datasetId];
  const geom = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  const params = new URLSearchParams({
    where: recencyWhere(datasetId),
    geometry: geom,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: cfg.outFields,
    returnGeometry: 'true',
    resultRecordCount: String(cfg.cap),
    f: 'geojson',
  });
  return `${ARCGIS_BASE}/${cfg.service}/FeatureServer/0/query?${params}`;
}

/** Attribute-bbox query for a dataset whose points live in lon/lat fields
 * rather than ArcGIS geometry. bbox values are validated finite numbers
 * (parseBbox), so interpolating them into the where clause is injection-safe. */
function arcgisAttrUrl(datasetId, bbox) {
  const cfg = ARCGIS[datasetId];
  const { lon, lat } = cfg.attrCoords;
  const where = [
    recencyWhere(datasetId),
    `${lon} >= ${bbox.west}`,
    `${lon} <= ${bbox.east}`,
    `${lat} >= ${bbox.south}`,
    `${lat} <= ${bbox.north}`,
  ]
    .filter((clause) => clause && clause !== '1=1')
    .join(' AND ');
  const params = new URLSearchParams({
    where: where || '1=1',
    outFields: cfg.outFields,
    returnGeometry: 'false',
    resultRecordCount: String(cfg.cap),
    f: 'json',
  });
  return `${ARCGIS_BASE}/${cfg.service}/FeatureServer/0/query?${params}`;
}

/** Build GeoJSON point features from an ArcGIS attribute-coords response. */
function featuresFromAttrRows(payload, attrCoords) {
  const { lon, lat } = attrCoords;
  const features = [];
  for (const row of Array.isArray(payload?.features) ? payload.features : []) {
    const props = row?.attributes || {};
    const x = Number(props[lon]);
    const y = Number(props[lat]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [x, y] },
      properties: props,
    });
  }
  return features;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'gods-eye-view-detroit/1.0',
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`upstream_${response.status}`);
  }
  return readResponseJsonCapped(response, MAX_BYTES);
}

/** Vite plugin serving /api/detroit/<dataset> in dev and preview. */
export function detroitProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // key `${dataset}|${bbox}` → {at, body}
  const inFlight = new Map();
  let mdotCache = null; // {at, rows}
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function loadArcgis(datasetId, bbox) {
    const cfg = ARCGIS[datasetId];
    if (cfg?.attrCoords) {
      const payload = await fetchJson(
        fetchImpl,
        arcgisAttrUrl(datasetId, bbox),
      );
      if (payload?.error)
        throw new Error(payload.error.message || 'arcgis_error');
      return { features: featuresFromAttrRows(payload, cfg.attrCoords) };
    }
    const payload = await fetchJson(fetchImpl, arcgisUrl(datasetId, bbox));
    if (payload?.error)
      throw new Error(payload.error.message || 'arcgis_error');
    return {
      features: Array.isArray(payload?.features) ? payload.features : [],
    };
  }

  async function loadMdot(bbox) {
    if (!mdotCache || now() - mdotCache.at >= CACHE_MS) {
      const rows = await fetchJson(fetchImpl, MDOT_CONSTRUCTION_URL);
      mdotCache = { at: now(), rows: Array.isArray(rows) ? rows : [] };
    }
    const inBbox = (lat, lon) =>
      lat >= bbox.south &&
      lat <= bbox.north &&
      lon >= bbox.west &&
      lon <= bbox.east;
    const features = mdotCache.rows.filter((row) => {
      const lat = Number(row?.latitude);
      const lon = Number(row?.longitude);
      return Number.isFinite(lat) && Number.isFinite(lon) && inBbox(lat, lon);
    });
    return { features };
  }

  async function load(datasetId, bbox) {
    return DETROIT_DATASETS[datasetId]?.kind === 'mdot'
      ? loadMdot(bbox)
      : loadArcgis(datasetId, bbox);
  }

  async function handler(req, res, next) {
    const send = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url || '/', 'http://localhost');
    const datasetId = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (!datasetId) return next?.();
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (!DETROIT_DATASETS[datasetId])
      return send(404, { error: 'unknown_dataset' });
    const bbox = parseBbox(url.searchParams.get('bbox'));
    if (!bbox) return send(400, { error: 'bad_bbox' });
    const key = `${datasetId}|${url.searchParams.get('bbox')}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return send(200, hit.body);
    if (!inFlight.has(key) && !allow(clientKey(req)))
      return hit
        ? send(200, hit.body, true)
        : send(429, { error: 'rate_limited' });
    try {
      if (!inFlight.has(key))
        inFlight.set(
          key,
          load(datasetId, bbox).finally(() => inFlight.delete(key)),
        );
      const result = await inFlight.get(key);
      const body = { dataset: datasetId, fetchedAt: now(), ...result };
      cache.set(key, { at: now(), body });
      if (cache.size > 128) cache.delete(cache.keys().next().value);
      send(200, body);
    } catch {
      if (hit && now() - hit.at < STALE_LIMIT_MS)
        return send(200, hit.body, true);
      send(502, { error: 'detroit_unavailable' });
    }
  }

  return {
    name: 'detroit-open-data',
    configureServer({ middlewares }) {
      middlewares.use('/api/detroit', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/detroit', handler);
    },
  };
}

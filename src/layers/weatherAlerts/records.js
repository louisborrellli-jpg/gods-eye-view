// Portable package (no i18n): the layer panel localizes the label and errors.
// Normalizes two public alert feeds into one record shape:
//   - NWS (api.weather.gov/alerts/active): US, severity Extreme..Minor, CAP
//     polygons inline on some features (many are zone-only with null geometry).
//   - ECCC (api.weather.gc.ca weather-alerts): Canada, alert_type
//     warning/watch/advisory/statement, every feature carries a polygon.

const msg = (text) => text;

/** Severity ranks, high to low, shared by both feeds. */
export const SEVERITY = Object.freeze({
  EXTREME: 4,
  SEVERE: 3,
  MODERATE: 2,
  MINOR: 1,
  UNKNOWN: 0,
});

/** Rank → { hex, label }. Colors read on the dark globe and separate by rank. */
const SEVERITY_STYLE = Object.freeze({
  4: { hex: '#d946ef', label: msg('Extreme') }, // fuchsia
  3: { hex: '#ef4444', label: msg('Severe') }, // red
  2: { hex: '#f59e0b', label: msg('Moderate') }, // amber
  1: { hex: '#eab308', label: msg('Minor') }, // yellow
  0: { hex: '#94a3b8', label: msg('Unknown') }, // slate
});

/** Public: the style for a severity rank (falls back to Unknown). */
export function severityStyle(rank) {
  return SEVERITY_STYLE[rank] ?? SEVERITY_STYLE[0];
}

function nwsSeverityRank(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'extreme':
      return SEVERITY.EXTREME;
    case 'severe':
      return SEVERITY.SEVERE;
    case 'moderate':
      return SEVERITY.MODERATE;
    case 'minor':
      return SEVERITY.MINOR;
    default:
      return SEVERITY.UNKNOWN;
  }
}

// ECCC has no severity field; alert_type is the strength signal.
function ecccSeverityRank(alertType) {
  switch (String(alertType || '').toLowerCase()) {
    case 'warning':
      return SEVERITY.SEVERE;
    case 'watch':
      return SEVERITY.MODERATE;
    case 'advisory':
      return SEVERITY.MINOR;
    default:
      return SEVERITY.UNKNOWN; // statement, and anything unrecognized
  }
}

function epochMs(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Keep only Polygon / MultiPolygon geometries, as a list of coordinate rings
 * (each ring an array of [lon, lat]); null for anything unusable. */
function polygonRings(geometry) {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  if (type === 'Polygon' && Array.isArray(coordinates)) {
    // Outer ring only; alert polygons rarely carry holes and a hole would only
    // under-draw the fill, never mislead.
    const outer = coordinates[0];
    return isRing(outer) ? [outer] : null;
  }
  if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
    const rings = coordinates
      .map((poly) => (Array.isArray(poly) ? poly[0] : null))
      .filter(isRing);
    return rings.length ? rings : null;
  }
  return null;
}

function isRing(ring) {
  return (
    Array.isArray(ring) &&
    ring.length >= 3 &&
    ring.every(
      (p) =>
        Array.isArray(p) &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Math.abs(p[1]) <= 90 &&
        Math.abs(p[0]) <= 180,
    )
  );
}

/** Rough centroid (vertex mean of the first ring) for label placement. */
export function ringsCentroid(rings) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of rings[0]) {
    sx += p[0];
    sy += p[1];
    n++;
  }
  return n ? { lon: sx / n, lat: sy / n } : null;
}

/** Normalize an NWS /alerts/active FeatureCollection. */
export function normalizeNwsAlerts(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const out = [];
  for (const f of features) {
    const rings = polygonRings(f?.geometry);
    if (!rings) continue; // zone-only alert with no drawable area
    const p = f.properties || {};
    out.push({
      id: `nws:${String(p.id || f.id || '')}`,
      source: 'NWS',
      event: String(p.event || 'Alert').trim(),
      severityRank: nwsSeverityRank(p.severity),
      area: String(p.areaDesc || '').trim(),
      headline: String(p.headline || '').trim(),
      onset: epochMs(p.onset || p.effective),
      expires: epochMs(p.ends || p.expires),
      rings,
    });
  }
  return out;
}

/** Normalize an ECCC weather-alerts items FeatureCollection. */
export function normalizeEcccAlerts(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const out = [];
  for (const f of features) {
    const rings = polygonRings(f?.geometry);
    if (!rings) continue;
    const p = f.properties || {};
    const name = String(p.alert_name_en || p.alert_type || 'Alert').trim();
    out.push({
      id: `eccc:${String(p.feature_id || '')}:${String(p.alert_code || '')}`,
      source: 'ECCC',
      event: name,
      severityRank: ecccSeverityRank(p.alert_type),
      area: String(p.feature_name_en || p.province || '').trim(),
      headline: name,
      onset: epochMs(p.validity_datetime || p.publication_datetime),
      expires: epochMs(p.expiration_datetime || p.event_end_datetime),
      rings,
    });
  }
  return out;
}

/**
 * Merge both feeds, drop expired, sort by severity (then soonest expiry), and
 * cap the count so a national storm cannot flood the globe with entities.
 */
export function mergeAlertRecords(lists, { cap = 500, now = Date.now() } = {}) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const rec of list || []) {
      if (!rec || seen.has(rec.id)) continue;
      if (rec.expires && rec.expires < now) continue; // already lapsed
      seen.add(rec.id);
      merged.push(rec);
    }
  }
  merged.sort((a, b) => {
    if (b.severityRank !== a.severityRank)
      return b.severityRank - a.severityRank;
    const ax = a.expires ?? Infinity;
    const bx = b.expires ?? Infinity;
    return ax - bx;
  });
  return merged.slice(0, Math.max(0, cap));
}

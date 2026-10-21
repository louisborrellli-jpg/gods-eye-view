/**
 * Worldwide event feeds a watch zone can be checked against. Each feed is
 * fetched independently of the map view and the data layers, so a zone on the
 * other side of the world is watched while the camera is elsewhere.
 *
 * Every feed returns plain events: {id, kind, lat, lon, atMs, ...facts}.
 * Text for people is built at presentation time, never here.
 * @module layers/watchZones/feeds
 */

const USGS_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';

/** How often each feed is asked, in ms. FIRMS is a large global file. */
export const FEED_INTERVAL_MS = Object.freeze({
  quake: 60_000,
  emergency: 60_000,
  fire: 10 * 60_000,
});

// Number(null) and Number('') are 0, which would invent a position or an M0.
const finite = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;
const validPoint = (lat, lon) =>
  lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** USGS GeoJSON → quake events. */
export function quakeEvents(geojson) {
  const out = [];
  for (const feature of Array.isArray(geojson?.features)
    ? geojson.features
    : []) {
    const [lon, lat, depthKm] = feature?.geometry?.coordinates || [];
    const mag = finite(feature?.properties?.mag);
    if (!validPoint(finite(lat), finite(lon)) || mag === null || !feature.id)
      continue;
    out.push({
      id: `quake:${feature.id}`,
      kind: 'quake',
      lat: Number(lat),
      lon: Number(lon),
      atMs: finite(feature.properties.time),
      mag,
      depthKm: finite(depthKm),
      place:
        typeof feature.properties.place === 'string'
          ? feature.properties.place
          : null,
    });
  }
  return out;
}

/** /api/firms fires → fire detection events (one per detection). */
export function fireEvents(payload) {
  const out = [];
  for (const fire of Array.isArray(payload?.fires) ? payload.fires : []) {
    const lat = finite(fire?.lat);
    const lon = finite(fire?.lon);
    if (!validPoint(lat, lon)) continue;
    const at = `${fire.acqDate ?? ''}T${fire.acqTime ?? ''}`;
    out.push({
      id: `fire:${lat.toFixed(3)}:${lon.toFixed(3)}:${at}`,
      kind: 'fire',
      lat,
      lon,
      atMs: null,
      frp: finite(fire.frp),
    });
  }
  return out;
}

/** /api/emergencies → emergency squawk events, one per aircraft and code. */
export function emergencyEvents(payload) {
  const out = [];
  for (const ac of Array.isArray(payload?.aircraft) ? payload.aircraft : []) {
    const lat = finite(ac?.lat);
    const lon = finite(ac?.lon);
    if (!validPoint(lat, lon) || !ac.hex || !ac.squawk) continue;
    out.push({
      id: `emergency:${ac.hex}:${ac.squawk}`,
      kind: 'emergency',
      lat,
      lon,
      atMs: finite(payload.fetchedAt),
      hex: String(ac.hex),
      flight: ac.flight ? String(ac.flight) : null,
      squawk: String(ac.squawk),
      altFt: finite(ac.altFt),
    });
  }
  return out;
}

/**
 * Construct the three feeds over a fetch implementation.
 * A FIRMS key is optional: without one the fire feed reports `keyRequired`.
 */
export function createWatchFeeds({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function json(url, signal) {
    const response = await fetchImpl(url, { signal, cache: 'no-store' });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* status decides */
    }
    return { response, payload };
  }
  return {
    async quake({ signal } = {}) {
      const { response, payload } = await json(USGS_URL, signal);
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      return { events: quakeEvents(payload) };
    },
    async emergency({ signal } = {}) {
      const { response, payload } = await json('/api/emergencies', signal);
      if (!response.ok) throw new Error(`Emergencies HTTP ${response.status}`);
      return { events: emergencyEvents(payload) };
    },
    async fire({ signal } = {}) {
      const { response, payload } = await json('/api/firms', signal);
      if (response.status === 503 && payload?.error === 'no_key')
        return { events: [], keyRequired: true };
      if (!response.ok) throw new Error(`FIRMS HTTP ${response.status}`);
      return { events: fireEvents(payload) };
    },
  };
}

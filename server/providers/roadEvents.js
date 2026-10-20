/**
 * Ontario 511 road events (collisions, closures, construction, incidents) at
 * `/api/road-events`, optionally filtered by `?bbox=west,south,east,north`.
 *
 * Upstream: https://511on.ca/api/v2/get/event (needs ONTARIO_511_API_KEY, the
 * same free developer key the Ontario camera pack uses). 511on throttles to
 * ten calls a minute, so the whole province is read at most every 2 minutes
 * and filtered here. Covers provincial highways (401, 3, 77, …), not city
 * streets.
 */

import { readResponseTextCapped } from './common/http.js';

export const ONTARIO_511_EVENTS_URL =
  'https://511on.ca/api/v2/get/event?format=json&lang=en';

const FRESH_MS = 2 * 60_000;
const STALE_LIMIT_MS = 30 * 60_000;
const RETRY_MS = 30_000;
const MAX_BYTES = 8 * 1024 * 1024;

const clean = (value, max = 400) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max) || null
    : null;
const epoch = (value) =>
  Number.isFinite(value) && value > 0 && value < 4e9
    ? new Date(value * 1000).toISOString()
    : null;
const coord = (value, limit) =>
  Number.isFinite(value) && Math.abs(value) <= limit ? value : null;

const KINDS = new Set([
  'accidentsandincidents',
  'roadwork',
  'closures',
  'specialevents',
  'generalinfo',
]);

/** One 511on event row → a normalized event, or null. */
export function normalizeRoadEvent(row) {
  if (!row || typeof row !== 'object') return null;
  const lat = coord(row.Latitude, 90);
  const lon = coord(row.Longitude, 180);
  if (lat === null || lon === null) return null;
  if (lat < 41.5 || lat > 57 || lon < -95.5 || lon > -74) return null;
  const rawType = String(row.EventType ?? '').toLowerCase();
  const type = KINDS.has(rawType) ? rawType : 'other';
  const id = String(row.ID ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) return null;
  return {
    id: `on511-${id}`,
    type,
    subtype: clean(row.EventSubType, 80),
    road: clean(row.RoadwayName, 80),
    direction: clean(row.DirectionOfTravel, 40),
    description: clean(row.Description),
    lanes: clean(row.LanesAffected, 120),
    fullClosure: row.IsFullClosure === true,
    severity: clean(row.Severity, 40),
    lat,
    lon,
    endLat: coord(row.LatitudeSecondary, 90),
    endLon: coord(row.LongitudeSecondary, 180),
    reportedAt: epoch(row.Reported),
    updatedAt: epoch(row.LastUpdated),
    plannedEndAt: epoch(row.PlannedEndDate),
  };
}

export function parseBbox(search) {
  const raw = new URLSearchParams(search).get('bbox');
  if (raw === null) return null;
  const parts = raw.split(',').map(Number);
  if (
    parts.length !== 4 ||
    !parts.every(Number.isFinite) ||
    parts[1] >= parts[3] ||
    parts[0] >= parts[2] ||
    Math.abs(parts[0]) > 180 ||
    Math.abs(parts[2]) > 180 ||
    Math.abs(parts[1]) > 90 ||
    Math.abs(parts[3]) > 90
  )
    throw new Error('invalid_bbox');
  return { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
}

export function roadEventsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 15_000,
  apiKey = () => String(process.env.ONTARIO_511_API_KEY || '').trim(),
} = {}) {
  let cache = null;
  let inflight = null;
  let attemptedAt = -Infinity;

  async function refresh(key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(ONTARIO_511_EVENTS_URL);
      url.searchParams.set('key', key);
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`road_events_upstream_${response.status}`);
      }
      const rows = JSON.parse(
        await readResponseTextCapped(response, MAX_BYTES, controller.signal),
      );
      if (!Array.isArray(rows)) throw new Error('invalid_road_events');
      const events = rows.map(normalizeRoadEvent).filter(Boolean);
      cache = { events, fetchedAt: now() };
      return cache;
    } finally {
      clearTimeout(timer);
    }
  }

  async function acquire(key) {
    if (cache && now() - cache.fetchedAt < FRESH_MS) return cache;
    if (!inflight) {
      if (cache && now() - attemptedAt < RETRY_MS) return cache;
      attemptedAt = now();
      inflight = refresh(key).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function describe(value, { stale = false, box = null, reason = null } = {}) {
    const events = (value?.events ?? []).filter(
      (e) =>
        !box ||
        (e.lat >= box.south &&
          e.lat <= box.north &&
          e.lon >= box.west &&
          e.lon <= box.east),
    );
    return {
      schemaVersion: 1,
      source: 'Ontario 511',
      attribution: 'Ontario 511, Ministry of Transportation Ontario',
      coverage: 'Ontario provincial highways; not municipal streets',
      fetchedAt: value ? new Date(value.fetchedAt).toISOString() : null,
      stale: stale || !value,
      unavailable: !value,
      reason:
        reason ??
        (!value
          ? 'Road events unavailable'
          : stale
            ? 'Cached road events; upstream unavailable'
            : null),
      events,
    };
  }

  async function handler(req, res) {
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    let box;
    try {
      const search = (req.url || '').split('?')[1] ?? '';
      const path = (req.url || '/').split('?')[0];
      if (path !== '/' && path !== '')
        return json(400, { error: 'invalid_road_events_query' });
      box = parseBbox(search);
    } catch {
      return json(400, { error: 'invalid_bbox' });
    }
    const key = apiKey();
    if (!key)
      return json(
        200,
        describe(null, {
          reason:
            'Road events need ONTARIO_511_API_KEY (free at 511on.ca/developers)',
        }),
      );
    try {
      json(200, describe(await acquire(key), { box }));
    } catch {
      const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
      json(200, describe(usable ? cache : null, { stale: true, box }));
    }
  }

  return {
    name: 'road-events',
    configureServer({ middlewares }) {
      middlewares.use('/api/road-events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/road-events', handler);
    },
  };
}

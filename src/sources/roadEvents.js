/**
 * Client for `/api/road-events` (server/providers/roadEvents.js): Ontario 511
 * collisions, closures and construction, filtered to a box server-side.
 */

import { readResponseJsonCapped } from './httpBody.js';

export const ROAD_EVENTS_RESPONSE_LIMIT = 2 * 1024 * 1024;
const malformed = () => new Error('Malformed road events snapshot');

const text = (value, max = 400) => {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw malformed();
  return value;
};
const time = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw malformed();
  return new Date(value).toISOString();
};
const num = (value, limit, nullable = true) => {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw malformed();
  return value;
};

export function validateRoadEventsSnapshot(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1)
    throw malformed();
  if (!Array.isArray(value.events) || value.events.length > 5000)
    throw malformed();
  return {
    schemaVersion: 1,
    source: text(value.source),
    attribution: text(value.attribution),
    coverage: text(value.coverage),
    fetchedAt: time(value.fetchedAt),
    stale: value.stale === true,
    unavailable: value.unavailable === true,
    reason: text(value.reason),
    events: value.events.map((e) => {
      if (!e || typeof e.id !== 'string' || !/^on511-\d{1,12}$/.test(e.id))
        throw malformed();
      return {
        id: e.id,
        type: text(e.type, 40),
        subtype: text(e.subtype, 80),
        road: text(e.road, 80),
        direction: text(e.direction, 40),
        description: text(e.description),
        lanes: text(e.lanes, 120),
        fullClosure: e.fullClosure === true,
        severity: text(e.severity, 40),
        lat: num(e.lat, 90, false),
        lon: num(e.lon, 180, false),
        endLat: num(e.endLat, 90),
        endLon: num(e.endLon, 180),
        reportedAt: time(e.reportedAt),
        updatedAt: time(e.updatedAt),
        plannedEndAt: time(e.plannedEndAt),
      };
    }),
  };
}

export function createRoadEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  return {
    async getEvents({ box = null, signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Road events request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const query = box
          ? `?bbox=${[box.west, box.south, box.east, box.north].map((n) => n.toFixed(5)).join(',')}`
          : '';
        const response = await fetchImpl(`/api/road-events${query}`, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Road events HTTP ${response.status}`);
        }
        return validateRoadEventsSnapshot(
          await readResponseJsonCapped(
            response,
            ROAD_EVENTS_RESPONSE_LIMIT,
            controller.signal,
          ),
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

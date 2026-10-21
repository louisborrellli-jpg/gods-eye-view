/**
 * Client for `/api/border-waits` (server/providers/borders.js): Detroit–Windsor
 * and Sarnia–Port Huron crossings, Canada-bound (CBSA) and U.S.-bound (CBP).
 * Validates the snapshot so tools never repeat a malformed upstream value.
 */

import { readResponseJsonCapped } from './httpBody.js';

export const BORDER_RESPONSE_LIMIT = 256 * 1024;
const malformed = () => new Error('Malformed border wait snapshot');

const STATUSES = new Set([
  'open',
  'closed',
  'pending',
  'not_applicable',
  'unknown',
]);

function text(value, max = 300) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw malformed();
  return value;
}
function time(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw malformed();
  return new Date(value).toISOString();
}
function minutes(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 1440) throw malformed();
  return value;
}
function lane(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || !STATUSES.has(value.status))
    throw malformed();
  return {
    minutes: minutes(value.minutes),
    status: value.status,
    ...(value.lanesOpen !== undefined
      ? {
          lanesOpen: value.lanesOpen === null ? null : minutes(value.lanesOpen),
        }
      : {}),
  };
}
function direction(value, lanes) {
  if (!value || typeof value !== 'object') throw malformed();
  if (value.unavailable)
    return { unavailable: true, reason: text(value.reason) ?? 'unavailable' };
  const out = { updatedAt: time(value.updatedAt) };
  for (const key of lanes) out[key] = lane(value[key]);
  if ('portStatus' in value) out.portStatus = text(value.portStatus, 40);
  if ('notice' in value) out.notice = text(value.notice);
  return out;
}

export function validateBorderSnapshot(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1)
    throw malformed();
  if (!Array.isArray(value.crossings) || value.crossings.length > 32)
    throw malformed();
  return {
    schemaVersion: 1,
    source: text(value.source),
    attribution: text(value.attribution),
    fetchedAt: time(value.fetchedAt),
    stale: value.stale === true,
    partial: value.partial === true,
    unavailable: value.unavailable === true,
    reason: text(value.reason),
    crossings: value.crossings.map((c) => {
      if (
        !c ||
        typeof c.id !== 'string' ||
        !/^[a-z0-9-]{1,48}$/.test(c.id) ||
        !Number.isFinite(c.lat) ||
        !Number.isFinite(c.lon)
      )
        throw malformed();
      return {
        id: c.id,
        name: text(c.name, 80),
        cities: text(c.cities, 80),
        lat: c.lat,
        lon: c.lon,
        toCanada: direction(c.toCanada, ['travellers', 'commercial']),
        toUS: direction(c.toUS, ['travellers', 'nexus', 'commercial', 'fast']),
      };
    }),
  };
}

/** Same-origin acquisition with its own deadline and cancellation. */
export function createBorderWaitSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Border wait request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/border-waits', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Border wait HTTP ${response.status}`);
        }
        const result = await readResponseJsonCapped(
          response,
          BORDER_RESPONSE_LIMIT,
          controller.signal,
        );
        return validateBorderSnapshot(result);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

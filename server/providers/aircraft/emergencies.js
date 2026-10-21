import { readResponseJsonCapped } from '../common/http.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';

/**
 * Worldwide aircraft squawking an emergency code, for watch zones.
 *
 * GET /api/emergencies → {fetchedAt, aircraft: [{hex, flight, squawk, lat,
 * lon, altFt}]} from adsb.lol's keyless /v2/sqk/{code} lookups for 7500
 * (unlawful interference), 7600 (radio failure) and 7700 (general
 * emergency). One shared 30 s cache serves every caller; on an upstream
 * failure the last good answer is served with `stale: true`.
 */
export const EMERGENCY_SQUAWKS = Object.freeze(['7500', '7600', '7700']);
const CACHE_MS = 30_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const STALE_LIMIT_MS = 10 * 60_000;

/**
 * Keep only aircraft with a usable position and the code that was asked for.
 * @param {unknown} payload adsb.lol /v2/sqk response.
 * @param {string} code
 * @returns {Array<object>}
 */
export function normalizeEmergencyAircraft(payload, code) {
  const rows = Array.isArray(payload?.ac) ? payload.ac : [];
  const out = [];
  for (const ac of rows) {
    const lat = Number(ac?.lat);
    const lon = Number(ac?.lon);
    const hex = String(ac?.hex || '')
      .trim()
      .toLowerCase();
    if (!/^~?[0-9a-f]{6}$/.test(hex)) continue;
    // Number(null) is 0: an aircraft without a fix must not land at 0°, 0°.
    if (ac?.lat == null || ac?.lon == null) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (String(ac?.squawk ?? code) !== code) continue;
    const alt = ac?.alt_baro == null ? NaN : Number(ac.alt_baro);
    out.push({
      hex,
      flight:
        String(ac?.flight || '')
          .trim()
          .slice(0, 12) || null,
      squawk: code,
      lat,
      lon,
      altFt: Number.isFinite(alt) ? alt : null,
    });
  }
  return out;
}

/** Vite plugin serving /api/emergencies in dev and preview. */
export function emergenciesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cache = null; // {fetchedAt, aircraft}
  let inFlight = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });

  async function load() {
    const results = await Promise.all(
      EMERGENCY_SQUAWKS.map(async (code) => {
        const response = await fetchImpl(
          `https://api.adsb.lol/v2/sqk/${code}`,
          {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'error',
            headers: {
              Accept: 'application/json',
              'User-Agent': 'gods-eye-view-watch-zones/1.0',
            },
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`upstream_${response.status}`);
        }
        const payload = await readResponseJsonCapped(response, MAX_BYTES);
        return normalizeEmergencyAircraft(payload, code);
      }),
    );
    return { fetchedAt: now(), aircraft: results.flat() };
  }

  async function handler(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (cache && now() - cache.fetchedAt < CACHE_MS) return send(200, cache);
    if (!inFlight && !allow(clientKey(req)))
      return cache
        ? send(200, { ...cache, stale: true })
        : send(429, { error: 'rate_limited' });
    try {
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      cache = await inFlight;
      send(200, cache);
    } catch {
      if (cache && now() - cache.fetchedAt < STALE_LIMIT_MS)
        return send(200, { ...cache, stale: true });
      send(502, { error: 'emergencies_unavailable' });
    }
  }

  return {
    name: 'aircraft-emergencies',
    configureServer({ middlewares }) {
      middlewares.use('/api/emergencies', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/emergencies', handler);
    },
  };
}

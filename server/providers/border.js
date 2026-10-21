import {
  readResponseTextCapped,
  readResponseJsonCapped,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  parseCbsaCsv,
  parseCbpFeed,
} from '../../src/layers/borderWaits/records.js';

/**
 * Canada–U.S. border wait times for the Border Crossings layer.
 *
 * GET /api/border/waits → {fetchedAt, crossings:[…]} merged from two public
 * feeds: CBSA (entry INTO Canada, `cbsa-asfc.gc.ca` CSV, Open Government
 * Licence – Canada) and U.S. CBP (entry INTO the U.S., `bwt.cbp.gov` JSON,
 * U.S. Government public data). One shared ~2-minute cache serves every
 * caller; on upstream failure the last good answer is served with `stale`.
 * CBSA is required; if CBP is unreachable the crossings still return with the
 * U.S. direction reading "not reported".
 */
export const CBSA_BWT_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
export const CBP_BWT_URL = 'https://bwt.cbp.gov/api/bwtnew';
const CACHE_MS = 120_000;
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 1024 * 1024;
const CBP_MAX_BYTES = 4 * 1024 * 1024;
const STALE_LIMIT_MS = 60 * 60_000;

/** Vite plugin serving /api/border/waits in dev and preview. */
export function borderWaitsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cache = null; // {fetchedAt, crossings}
  let inFlight = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });

  /** Fetch the CBP feed (entry into the U.S.); null if it is unreachable. */
  async function loadCbp() {
    try {
      const response = await fetchImpl(CBP_BWT_URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-border-waits/1.0',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const payload = await readResponseJsonCapped(response, CBP_MAX_BYTES);
      return parseCbpFeed(payload);
    } catch {
      return null;
    }
  }

  async function load() {
    // CBSA is required; CBP is best-effort (the U.S. direction degrades to
    // "not reported" if it fails), so run both and don't let CBP sink the load.
    const [response, cbpByPort] = await Promise.all([
      fetchImpl(CBSA_BWT_URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
        headers: {
          Accept: 'text/csv,text/plain',
          'User-Agent': 'gods-eye-view-border-waits/1.0',
        },
      }),
      loadCbp(),
    ]);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_${response.status}`);
    }
    const text = await readResponseTextCapped(response, MAX_BYTES);
    const crossings = parseCbsaCsv(
      typeof text === 'string' ? text : text?.text,
      cbpByPort,
    );
    if (!crossings.length) throw new Error('empty_border_feed');
    return { fetchedAt: now(), crossings, usReported: Boolean(cbpByPort) };
  }

  async function handler(req, res) {
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
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
      send(502, { error: 'border_waits_unavailable' });
    }
  }

  return {
    name: 'border-waits',
    configureServer({ middlewares }) {
      middlewares.use('/api/border/waits', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/border/waits', handler);
    },
  };
}

import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  CARRIER_SCAC,
  parseFindTeu,
} from '../../src/layers/shipments/tracking.js';

/**
 * Automatic container tracking for the Shipments layer.
 *
 * GET /api/shipments/track?container=MSCU1234566[&carrier=msc]
 *   → {configured, tracking, terminal49}
 * GET /api/shipments/status → {findteu, terminal49}
 *
 * FindTEU (FINDTEU_API_KEY) answers the ocean milestones. FindTEU counts
 * each new container once per month, and its data refreshes every few
 * hours, so answers are cached per container for CACHE_MS. When
 * TERMINAL49_API_KEY is set, each container is also registered with
 * Terminal49 once per server run, so its own dashboard follows the box,
 * rail leg included; its free plan does not let us read that data back.
 *
 * Keys stay on this server. The browser sends only a container number,
 * which is validated before it reaches either provider.
 */
export const FINDTEU_API_URL = 'https://api.findteu.com/container/';
export const TERMINAL49_API_URL =
  'https://api.terminal49.com/v2/tracking_requests';
const CACHE_MS = 3 * 60 * 60_000;
const FAILURE_CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 70_000; // FindTEU answers "within 60 seconds".
const MAX_BYTES = 1024 * 1024;
const MAX_CACHE = 200;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;

/** Vite plugin serving /api/shipments/* in dev and preview. */
export function shippingProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  /** @type {Map<string, {at:number, value:object, failed?:boolean}>} */
  const cache = new Map();
  const inFlight = new Map();
  const registered = new Map(); // container → 'registered' | 'failed'
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });

  const findTeuKey = () => String(env.FINDTEU_API_KEY || '').trim();
  const terminal49Key = () => String(env.TERMINAL49_API_KEY || '').trim();

  async function loadFindTeu(container, carrier) {
    const body = new URLSearchParams();
    const scac = CARRIER_SCAC[carrier];
    if (scac) body.set('scac', scac);
    const response = await fetchImpl(`${FINDTEU_API_URL}${container}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Authorization-ApiKey': findTeuKey(),
        'User-Agent': 'gods-eye-view-shipments/1.0',
      },
      body,
    });
    const payload = await readResponseJsonCapped(response, MAX_BYTES).catch(
      () => null,
    );
    if (!response.ok || !payload)
      throw Object.assign(new Error(`findteu_http_${response.status}`), {
        status: response.status,
      });
    if (payload.success === false) {
      const reason = String(payload.error?.text || 'findteu_error').slice(
        0,
        160,
      );
      throw Object.assign(new Error(reason), { upstream: true });
    }
    const tracking = parseFindTeu(payload.data, { now: now() });
    if (!tracking) throw new Error('findteu_unusable_answer');
    return tracking;
  }

  /** Register once per server run; Terminal49's dashboard does the rest. */
  async function registerTerminal49(container, carrier) {
    if (!terminal49Key()) return 'off';
    if (registered.has(container)) return registered.get(container);
    registered.set(container, 'pending');
    const scac = CARRIER_SCAC[carrier];
    const attributes = {
      request_type: 'container',
      request_number: container,
      ...(scac ? { scac } : { auto_detect_vocc_scac: true }),
    };
    try {
      const response = await fetchImpl(TERMINAL49_API_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Token ${terminal49Key()}`,
          'User-Agent': 'gods-eye-view-shipments/1.0',
        },
        body: JSON.stringify({
          data: { type: 'tracking_request', attributes },
        }),
      });
      await response.body?.cancel?.();
      // 422 is Terminal49 saying the number is already being tracked.
      const state =
        response.ok || response.status === 422 ? 'registered' : 'failed';
      registered.set(container, state);
      return state;
    } catch {
      registered.set(container, 'failed');
      return 'failed';
    }
  }

  function remember(container, entry) {
    cache.delete(container);
    cache.set(container, entry);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  async function track(req, res, send) {
    const url = new URL(req.url || '', 'http://localhost');
    const container = String(url.searchParams.get('container') || '')
      .toUpperCase()
      .replace(/\s+/g, '');
    const carrier = String(url.searchParams.get('carrier') || '');
    if (!CONTAINER.test(container))
      return send(400, { error: 'container must be 4 letters and 7 digits' });
    if (!findTeuKey())
      return send(200, {
        configured: false,
        tracking: null,
        terminal49: await registerTerminal49(container, carrier),
      });
    const cached = cache.get(container);
    const fresh =
      cached &&
      now() - cached.at < (cached.failed ? FAILURE_CACHE_MS : CACHE_MS);
    if (!fresh && !inFlight.has(container) && !allow(clientKey(req)))
      return cached && !cached.failed
        ? send(200, { ...cached.value, stale: true })
        : send(429, { error: 'rate_limited' });
    const terminal49 = registerTerminal49(container, carrier);
    if (fresh)
      return cached.failed
        ? send(502, { ...cached.value, terminal49: await terminal49 })
        : send(200, { ...cached.value, terminal49: await terminal49 });
    try {
      if (!inFlight.has(container))
        inFlight.set(
          container,
          loadFindTeu(container, carrier).finally(() =>
            inFlight.delete(container),
          ),
        );
      const tracking = await inFlight.get(container);
      const value = { configured: true, tracking };
      remember(container, { at: now(), value });
      send(200, { ...value, terminal49: await terminal49 });
    } catch (error) {
      const value = {
        configured: true,
        tracking: null,
        error: error?.upstream ? error.message : 'tracking_unavailable',
      };
      if (cached && !cached.failed)
        return send(200, {
          ...cached.value,
          stale: true,
          terminal49: await terminal49,
        });
      remember(container, { at: now(), value, failed: true });
      send(502, { ...value, terminal49: await terminal49 });
    }
  }

  async function handler(req, res) {
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const path = new URL(req.url || '', 'http://localhost').pathname;
    if (path === '/status')
      return send(200, {
        findteu: Boolean(findTeuKey()),
        terminal49: Boolean(terminal49Key()),
      });
    if (path === '/track') return track(req, res, send);
    send(404, { error: 'not_found' });
  }

  return {
    name: 'shipments-tracking',
    configureServer({ middlewares }) {
      middlewares.use('/api/shipments', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/shipments', handler);
    },
  };
}

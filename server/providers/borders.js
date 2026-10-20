/**
 * Live border wait times for the Detroit–Windsor and Port Huron–Sarnia
 * crossings, both directions, served same-origin at `/api/border-waits`.
 *
 * Upstreams (both keyless, public, government-published):
 *   - CBSA "Border wait times: United States to Canada" CSV (Canada-bound)
 *     https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv
 *   - U.S. CBP Border Wait Times JSON (U.S.-bound)
 *     https://bwt.cbp.gov/api/bwtnew
 *
 * Each side fails independently: one agency's outage leaves the other
 * direction live and marks the missing side unavailable. The last good read
 * is served, marked stale, for up to an hour.
 */

import { readResponseTextCapped } from './common/http.js';

export const CBSA_BWT_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
export const CBP_BWT_URL = 'https://bwt.cbp.gov/api/bwtnew';

const FRESH_MS = 3 * 60_000;
const STALE_LIMIT_MS = 60 * 60_000;
const RETRY_MS = 30_000;

/**
 * The crossings this layer covers. `cbsa` matches the CSV's Customs Office
 * column; `cbp` matches the JSON's crossing_name (CBP pads some names with
 * spaces, so matching is trimmed and case-insensitive). Coordinates sit on
 * the span or plaza so a pin lands on the crossing itself.
 */
export const BORDER_CROSSINGS = Object.freeze([
  {
    id: 'ambassador-bridge',
    name: 'Ambassador Bridge',
    cities: 'Windsor, ON / Detroit, MI',
    lat: 42.3118,
    lon: -83.074,
    cbsa: 'Ambassador Bridge',
    cbp: 'Ambassador Bridge',
  },
  {
    id: 'windsor-detroit-tunnel',
    name: 'Detroit–Windsor Tunnel',
    cities: 'Windsor, ON / Detroit, MI',
    lat: 42.3213,
    lon: -83.0405,
    cbsa: 'Windsor and Detroit Tunnel',
    cbp: 'Windsor Tunnel',
  },
  {
    id: 'gordie-howe-bridge',
    name: 'Gordie Howe International Bridge',
    cities: 'Windsor, ON / Detroit, MI',
    lat: 42.2893,
    lon: -83.0985,
    cbsa: 'Gordie Howe International Bridge',
    cbp: 'Gordie Howe International Bridge',
  },
  {
    id: 'blue-water-bridge',
    name: 'Blue Water Bridge',
    cities: 'Sarnia, ON / Port Huron, MI',
    lat: 42.9989,
    lon: -82.4239,
    cbsa: 'Blue Water Bridge',
    cbp: 'Bluewater Bridge',
  },
]);

const norm = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Parse one CBSA wait string ("No Delay", "5 minutes", "1 hour 10 minutes",
 * "Closed", "Not Applicable", "--") into `{ minutes, status }`.
 * `minutes` is null whenever no number applies.
 */
export function parseCbsaDelay(value) {
  const textValue = norm(value);
  if (!textValue || textValue === '--' || textValue === 'not applicable')
    return { minutes: null, status: 'not_applicable' };
  if (textValue.startsWith('closed'))
    return { minutes: null, status: 'closed' };
  if (textValue === 'no delay') return { minutes: 0, status: 'open' };
  const hours = /(\d+)\s*(?:hours?|hrs?)\b/.exec(textValue);
  const minutes = /(\d+)\s*(?:minutes?|mins?)\b/.exec(textValue);
  if (hours || minutes) {
    const total =
      (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
    if (Number.isFinite(total) && total >= 0 && total <= 24 * 60)
      return { minutes: total, status: 'open' };
  }
  return { minutes: null, status: 'unknown' };
}

/**
 * Parse the CBSA CSV (";;"-separated, UTF-8 BOM) into Canada-bound waits keyed
 * by crossing id. Rows for crossings outside BORDER_CROSSINGS are ignored.
 */
export function parseCbsaCsv(text) {
  if (typeof text !== 'string' || !text.includes(';;'))
    throw new Error('invalid_cbsa_csv');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split(';;').map(norm);
  const col = (needle) => header.findIndex((name) => name.includes(needle));
  const office = col('customs office');
  const commercial = col('commercial flow - canada bound');
  const travellers = col('travellers flow - canada bound');
  if (office < 0 || commercial < 0 || travellers < 0)
    throw new Error('invalid_cbsa_csv');
  const byName = new Map(BORDER_CROSSINGS.map((c) => [norm(c.cbsa), c.id]));
  const result = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(';;').map((cell) => cell.trim());
    const id = byName.get(norm(cells[office]));
    if (!id) continue;
    result[id] = {
      travellers: parseCbsaDelay(cells[travellers]),
      commercial: parseCbsaDelay(cells[commercial]),
    };
  }
  return result;
}

function cbpLane(lane) {
  if (!lane || typeof lane !== 'object') return null;
  const status = norm(lane.operational_status);
  if (!status || status === 'n/a') return null;
  if (status.includes('closed'))
    return { minutes: null, status: 'closed', lanesOpen: 0 };
  if (status.includes('update pending'))
    return { minutes: null, status: 'pending', lanesOpen: null };
  const minutes = Number.parseInt(lane.delay_minutes, 10);
  const lanesOpen = Number.parseInt(lane.lanes_open, 10);
  return {
    minutes:
      Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440
        ? minutes
        : null,
    status: 'open',
    lanesOpen: Number.isFinite(lanesOpen) ? lanesOpen : null,
  };
}

/** CBP stamps "MM/DD/YYYY" + "HH:MM:SS" in U.S. Eastern time. */
function cbpTime(date, time) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(date ?? '').trim());
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!d || !t) return null;
  // Detroit observes U.S. Eastern; work out the offset for that wall time.
  const wall = Date.UTC(+d[3], +d[1] - 1, +d[2], +t[1], +t[2], +t[3]);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(wall));
  const offset = /GMT([+-]\d+)/.exec(
    parts.find((p) => p.type === 'timeZoneName')?.value ?? '',
  );
  const hours = offset ? Number(offset[1]) : -5;
  const ms = wall - hours * 3_600_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parse the CBP JSON array into U.S.-bound waits keyed by crossing id. */
export function parseCbpJson(rows) {
  if (!Array.isArray(rows)) throw new Error('invalid_cbp_json');
  const byName = new Map(BORDER_CROSSINGS.map((c) => [norm(c.cbp), c.id]));
  const result = {};
  for (const row of rows) {
    if (norm(row?.border) !== 'canadian border') continue;
    const id = byName.get(norm(row?.crossing_name));
    if (!id) continue;
    const pv = row.passenger_vehicle_lanes ?? {};
    const cv = row.commercial_vehicle_lanes ?? {};
    result[id] = {
      portStatus: norm(row.port_status) || null,
      updatedAt: cbpTime(row.date, row.time),
      travellers: cbpLane(pv.standard_lanes),
      nexus: cbpLane(pv.NEXUS_SENTRI_lanes),
      commercial: cbpLane(cv.standard_lanes),
      fast: cbpLane(cv.FAST_lanes),
      notice:
        typeof row.construction_notice === 'string' &&
        row.construction_notice.trim()
          ? row.construction_notice.trim().slice(0, 300)
          : null,
    };
  }
  return result;
}

/** Join both directions onto the crossing list. */
export function mergeBorderWaits({ toCanada, toUS, toCanadaAt, now }) {
  return BORDER_CROSSINGS.map((crossing) => ({
    id: crossing.id,
    name: crossing.name,
    cities: crossing.cities,
    lat: crossing.lat,
    lon: crossing.lon,
    toCanada: toCanada
      ? toCanada[crossing.id]
        ? { ...toCanada[crossing.id], updatedAt: toCanadaAt ?? null }
        : { unavailable: true, reason: 'not listed by CBSA' }
      : { unavailable: true, reason: 'CBSA feed unavailable' },
    toUS: toUS
      ? (toUS[crossing.id] ?? {
          unavailable: true,
          reason: 'not listed by CBP',
        })
      : { unavailable: true, reason: 'CBP feed unavailable' },
    checkedAt: new Date(now).toISOString(),
  }));
}

/** Vite plugin: `/api/border-waits` → both directions for every crossing. */
export function borderWaitsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 12_000,
} = {}) {
  let cache = null;
  let inflight = null;
  let attemptedAt = -Infinity;

  async function upstream(url, cap, accept, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: accept,
        'User-Agent': 'Gods Eye View (public border wait times)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`border_upstream_${response.status}`);
    }
    return readResponseTextCapped(response, cap, signal);
  }

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const [cbsa, cbp] = await Promise.allSettled([
        upstream(
          CBSA_BWT_URL,
          256 * 1024,
          'text/csv,text/plain',
          controller.signal,
        ).then(parseCbsaCsv),
        upstream(
          CBP_BWT_URL,
          2 * 1024 * 1024,
          'application/json',
          controller.signal,
        ).then((body) => parseCbpJson(JSON.parse(body))),
      ]);
      const at = now();
      const toCanada =
        cbsa.status === 'fulfilled' ? cbsa.value : (cache?.toCanada ?? null);
      const toUS =
        cbp.status === 'fulfilled' ? cbp.value : (cache?.toUS ?? null);
      if (!toCanada && !toUS) throw new Error('border_upstreams_unavailable');
      cache = {
        toCanada,
        toUS,
        // CBSA's own "Last updated" column currently reads "Invalid DateTime",
        // so the Canada-bound time is when we last read it successfully.
        toCanadaAt:
          cbsa.status === 'fulfilled'
            ? new Date(at).toISOString()
            : (cache?.toCanadaAt ?? null),
        fetchedAt: at,
        partial: cbsa.status !== 'fulfilled' || cbp.status !== 'fulfilled',
      };
      return cache;
    } finally {
      clearTimeout(timer);
    }
  }

  async function acquire() {
    if (cache && now() - cache.fetchedAt < FRESH_MS) return cache;
    if (!inflight) {
      if (now() - attemptedAt < RETRY_MS && cache) return cache;
      attemptedAt = now();
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function describe(value, stale) {
    return {
      schemaVersion: 1,
      source: 'CBSA (Canada-bound) and U.S. CBP (U.S.-bound)',
      attribution:
        'Canada Border Services Agency border wait times; U.S. Customs and Border Protection Border Wait Times',
      fetchedAt: value ? new Date(value.fetchedAt).toISOString() : null,
      stale: stale || !value,
      partial: value?.partial ?? false,
      unavailable: !value,
      reason: !value
        ? 'Border wait times unavailable'
        : stale
          ? 'Cached border wait times; upstream unavailable'
          : value.partial
            ? 'One direction is unavailable or cached'
            : null,
      crossings: value
        ? mergeBorderWaits({ ...value, now: value.fetchedAt })
        : [],
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
    if (req.url !== '/' && req.url !== '')
      return json(400, { error: 'invalid_border_query' });
    try {
      json(200, describe(await acquire(), false));
    } catch {
      const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
      json(200, describe(usable ? cache : null, true));
    }
  }

  return {
    name: 'border-waits',
    configureServer({ middlewares }) {
      middlewares.use('/api/border-waits', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/border-waits', handler);
    },
  };
}

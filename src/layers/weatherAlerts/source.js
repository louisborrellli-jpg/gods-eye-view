import {
  normalizeNwsAlerts,
  normalizeEcccAlerts,
  mergeAlertRecords,
} from './records.js';

// Both feeds are keyless and CORS-enabled (Access-Control-Allow-Origin: *), so
// the browser reads them directly — no proxy, matching the USGS earthquakes
// reference source.
const NWS_URL = 'https://api.weather.gov/alerts/active';
// ECCC OGC API Features; limit is generous because Canada-wide active alerts
// are few hundred at most and each carries a polygon.
const ECCC_URL =
  'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000';

async function fetchJson(fetchImpl, url, { signal, headers } = {}) {
  const response = await fetchImpl(url, { signal, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Active weather alerts across the US (NWS) and Canada (ECCC), merged.
 *
 * The two feeds are fetched in parallel and tolerated independently: if one is
 * down the other still renders, and the snapshot is flagged partial so the
 * panel can say so. Only alerts with a drawable polygon are kept.
 *
 * @param {object} [deps]
 * @param {(url:string, init?:object)=>Promise<Response>} [deps.fetchImpl]
 * @param {number} [deps.cap] Max rendered alerts (severity-sorted).
 */
export function createWeatherAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  cap = 500,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const [nws, eccc] = await Promise.allSettled([
        fetchJson(fetchImpl, NWS_URL, {
          signal,
          headers: { Accept: 'application/geo+json' },
        }),
        fetchJson(fetchImpl, ECCC_URL, { signal }),
      ]);
      signal?.throwIfAborted();

      const lists = [];
      let sources = 0;
      let partial = false;
      if (nws.status === 'fulfilled') {
        lists.push(normalizeNwsAlerts(nws.value));
        sources++;
      } else {
        partial = true;
      }
      if (eccc.status === 'fulfilled') {
        lists.push(normalizeEcccAlerts(eccc.value));
        sources++;
      } else {
        partial = true;
      }
      // Both feeds failing is a real outage, not a partial.
      if (sources === 0) throw new Error('Weather alert feeds unavailable');

      return {
        records: mergeAlertRecords(lists, { cap }),
        partial,
        fetchedAt: Date.now(),
      };
    },
  };
}

import { GREAT_LAKES_STATIONS, parseWaterLevelReading } from './records.js';

// NOAA CO-OPS water-level API. The endpoint is keyless and CORS-enabled
// (Access-Control-Allow-Origin: *), so the browser reads it directly — the
// same posture as the USGS earthquakes and weather-alerts reference sources.
// There is no bulk Great Lakes product, so each gauge is queried for its
// latest reading; the station id is the only variable and comes from the
// fixed GREAT_LAKES_STATIONS table, never from the caller.
const DATAGETTER_URL =
  'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

// The browser caps concurrent connections per host at ~6; requesting more at
// once only queues them, so match that and let the rest follow as slots free.
const DEFAULT_CONCURRENCY = 6;

function stationUrl(id) {
  const params = new URLSearchParams({
    product: 'water_level',
    date: 'latest',
    station: id,
    datum: 'IGLD', // International Great Lakes Datum 1985, metres above sea level
    units: 'metric',
    time_zone: 'gmt',
    format: 'json',
  });
  return `${DATAGETTER_URL}?${params}`;
}

/** Run `task` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, task) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) {
        await task(queue.shift());
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Latest water level at every Great Lakes CO-OPS gauge.
 *
 * Gauges are polled independently and tolerated one by one: a dead station is
 * skipped and the snapshot flagged partial, never failing the whole layer. The
 * reading is returned only when at least one gauge answered.
 *
 * @param {object} [deps]
 * @param {(url:string, init?:object)=>Promise<Response>} [deps.fetchImpl]
 * @param {ReadonlyArray<object>} [deps.stations] Override the gauge table (tests).
 * @param {number} [deps.concurrency]
 */
export function createGreatLakesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  stations = GREAT_LAKES_STATIONS,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const records = [];
      let failures = 0;

      await mapWithConcurrency(stations, concurrency, async (station) => {
        if (signal?.aborted) return;
        try {
          const response = await fetchImpl(stationUrl(station.id), {
            signal,
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            await response.body?.cancel?.();
            failures++;
            return;
          }
          const record = parseWaterLevelReading(await response.json(), station);
          if (record) records.push(record);
          else failures++;
        } catch (error) {
          if (signal?.aborted) throw error; // abort is not a gauge failure
          failures++;
        }
      });

      signal?.throwIfAborted();
      if (!records.length)
        throw new Error('Great Lakes water levels unavailable');
      records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { records, partial: failures > 0, fetchedAt: Date.now() };
    },
  };
}

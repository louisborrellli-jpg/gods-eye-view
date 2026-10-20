import { normalizeAuroraSnapshot } from './records.js';

const API_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/**
 * Request and validate a complete OVATION aurora nowcast before it can replace
 * what is displayed. Keyless: NOAA SWPC publishes this openly.
 */
export function createOvationAuroraSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`NOAA SWPC HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const snapshot = normalizeAuroraSnapshot(payload);
      if (!snapshot) throw new Error('Malformed OVATION response');
      return snapshot;
    },
  };
}

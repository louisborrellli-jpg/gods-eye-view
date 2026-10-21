// A source module (no browser globals, see check:boundaries), so no i18n
// import: failures stay English here and the layer translates them on show.
const msg = (text) => text;

/**
 * Ship lookups for the Shipments layer, answered by this app's own server
 * from its live AISStream cache (`/api/vessels/find`). Only the ship's name
 * or number is sent; container numbers and dates never leave the browser.
 */
export function createShipmentVesselSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/vessels/find',
} = {}) {
  return {
    /**
     * @param {string} query Ship name, IMO or MMSI.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{matches:Array<object>, configured:boolean,
     *   status:string|null}>}
     */
    async findVessel(query, { signal } = {}) {
      signal?.throwIfAborted();
      const q = String(query ?? '').trim();
      if (q.length < 3) return { matches: [], configured: true, status: null };
      const response = await fetchImpl(
        `${endpoint}?q=${encodeURIComponent(q.slice(0, 40))}`,
        { signal, headers: { Accept: 'application/json' } },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      signal?.throwIfAborted();
      if (!response.ok || !payload)
        throw Object.assign(new Error(msg('Ship lookup unavailable')), {
          status: response.status,
        });
      return {
        matches: Array.isArray(payload.matches) ? payload.matches : [],
        configured: payload.configured !== false,
        status: typeof payload.status === 'string' ? payload.status : null,
      };
    },
  };
}

/**
 * Automatic container tracking through this app's server
 * (`/api/shipments/track`), which holds the FindTEU and Terminal49 keys.
 * Only the container number and its line are sent.
 */
export function createShipmentTrackingSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/shipments/track',
} = {}) {
  return {
    /**
     * @param {string} container Normalized container number.
     * @param {{carrier?: string, signal?: AbortSignal}} [options]
     * @returns {Promise<{configured:boolean, tracking:object|null,
     *   terminal49:string, error:string|null}>}
     */
    async trackContainer(container, { carrier = '', signal } = {}) {
      signal?.throwIfAborted();
      const query = new URLSearchParams({ container });
      if (carrier) query.set('carrier', carrier);
      const response = await fetchImpl(`${endpoint}?${query}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      signal?.throwIfAborted();
      if (!payload || (!response.ok && response.status !== 502))
        throw Object.assign(new Error(msg('Automatic tracking unavailable')), {
          status: response.status,
        });
      return {
        configured: payload.configured !== false,
        tracking: payload.tracking ?? null,
        terminal49:
          typeof payload.terminal49 === 'string' ? payload.terminal49 : 'off',
        error: typeof payload.error === 'string' ? payload.error : null,
      };
    },
  };
}

/**
 * The ship to follow: the one the operator named, else the one automatic
 * tracking says is carrying the box.
 * @param {object} shipment Normalized shipment.
 * @returns {{query:string, mmsi:string, imo:string}}
 */
export function effectiveVessel(shipment) {
  const own = shipment?.vessel ?? {};
  if (own.query || own.mmsi || own.imo)
    return { query: own.query || '', mmsi: own.mmsi || '', imo: own.imo || '' };
  const auto = shipment?.auto?.vessel;
  if (!auto) return { query: '', mmsi: '', imo: '' };
  return { query: auto.name, mmsi: auto.mmsi || '', imo: auto.imo || '' };
}

/**
 * The best match for a shipment's ship: its known MMSI, then its IMO, then
 * a name the operator typed. A name that matches several ships is only
 * accepted when exactly one has that exact name.
 *
 * @param {Array<object>} matches Rows from findVessel.
 * @param {{query?:string, mmsi?:string, imo?:string}} vessel
 * @returns {object|null}
 */
export function pickVesselMatch(matches, vessel = {}) {
  const rows = Array.isArray(matches) ? matches : [];
  if (vessel.mmsi) {
    const byMmsi = rows.find((row) => String(row.mmsi) === vessel.mmsi);
    if (byMmsi) return byMmsi;
  }
  if (vessel.imo) {
    const byImo = rows.find((row) => String(row.imo) === vessel.imo);
    if (byImo) return byImo;
  }
  const query = String(vessel.query ?? '').trim();
  const digits = query.replace(/^IMO\s*/i, '').replace(/\s+/g, '');
  if (/^\d{7}$/.test(digits))
    return rows.find((row) => String(row.imo) === digits) ?? null;
  if (/^\d{9}$/.test(digits))
    return rows.find((row) => String(row.mmsi) === digits) ?? null;
  const key = nameKey(query);
  const exact = rows.filter((row) => nameKey(row.name) === key);
  if (exact.length === 1) return exact[0];
  if (!exact.length && rows.length === 1) return rows[0];
  return null;
}

function nameKey(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * The query a shipment's ship is looked up by: its MMSI when known (exact
 * and cheapest), else its IMO, else what the operator typed.
 */
export function vesselLookupQuery(vessel = {}) {
  return vessel.mmsi || vessel.imo || String(vessel.query ?? '').trim();
}

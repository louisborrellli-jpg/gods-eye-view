/**
 * Canada–U.S. land border crossings and the CBSA border-wait feed.
 *
 * The CBSA publishes current wait times for entry INTO Canada as a
 * semicolon-paired CSV; it does not publish coordinates, so each crossing is
 * placed here by its Customs Office name (the feed's stable key). The entry
 * INTO the U.S. direction is reported by U.S. CBP, a separate feed that can be
 * merged in later; until then U.S.-bound values arrive as "--" and read as
 * "not reported". Pure: no DOM, no Cesium.
 * @module layers/borderWaits/records
 */

/** Canadian-side plaza coordinates, keyed by the CBSA "Customs Office" name. */
export const CROSSINGS = Object.freeze({
  'St. Stephen': { lat: 45.187, lon: -67.277, cbp: '011501' },
  'St. Stephen 3rd Bridge': { lat: 45.157, lon: -67.284, cbp: '011503' },
  Edmundston: { lat: 47.354, lon: -68.325, cbp: 'L01901' },
  'Woodstock Road': { lat: 46.142, lon: -67.79, cbp: '010601' },
  Stanstead: { lat: 45.007, lon: -72.096, cbp: '020901' },
  'St-Armand/Philipsburg': { lat: 45.016, lon: -73.082, cbp: '021201' },
  'Lacolle: Route 221': { lat: 45.009, lon: -73.368 },
  'St-Bernard-de-Lacolle': { lat: 45.003, lon: -73.37, cbp: '071201' },
  Hemmingford: { lat: 45.007, lon: -73.597 },
  'Cornwall Traffic Office': { lat: 44.99, lon: -74.733, cbp: '070401' },
  Prescott: { lat: 44.705, lon: -75.516, cbp: '070101' },
  'Thousand Islands Bridge': { lat: 44.362, lon: -75.997, cbp: '070801' },
  'Sault Ste. Marie': { lat: 46.504, lon: -84.342, cbp: '380301' },
  'Fort Frances Bridge': { lat: 48.604, lon: -93.403, cbp: '360401' },
  'Queenston-Lewiston Bridge': { lat: 43.161, lon: -79.047, cbp: '090104' },
  'Rainbow Bridge': { lat: 43.09, lon: -79.068, cbp: '090102' },
  'Peace Bridge': { lat: 42.906, lon: -78.907, cbp: '090101' },
  'Blue Water Bridge': { lat: 42.999, lon: -82.425, cbp: '380201' },
  // Windsor-Essex: placed precisely.
  'Windsor and Detroit Tunnel': { lat: 42.3179, lon: -83.0398, cbp: '380002' },
  'Ambassador Bridge': { lat: 42.3115, lon: -83.0735, cbp: '380001' },
  'Gordie Howe International Bridge': {
    lat: 42.249,
    lon: -83.112,
    cbp: '380102',
  },
  Emerson: { lat: 49.0, lon: -97.21, cbp: '340101' },
  'North Portal': { lat: 49.0, lon: -102.56 },
  Coutts: { lat: 49.0, lon: -111.957, cbp: '331001' },
  'Abbotsford-Huntingdon': { lat: 49.003, lon: -122.265, cbp: '300901' },
  Aldergrove: { lat: 49.003, lon: -122.48, cbp: '302301' },
  'Pacific Highway': { lat: 49.0025, lon: -122.756, cbp: '300401' },
  Douglas: { lat: 49.003, lon: -122.757, cbp: '300402' },
  'Boundary Bay': { lat: 49.0, lon: -123.064, cbp: '300403' },
});

/**
 * Parse one CBSA flow cell into minutes.
 *  - "No Delay" → 0
 *  - "40 minutes" / "1 hour 10 minutes" → total minutes
 *  - "--", "", "Not Available", "Closed" → null (not reported)
 * @param {string} value
 * @returns {{minutes: number|null, closed: boolean, text: string}}
 */
export function parseWaitCell(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '--') return { minutes: null, closed: false, text: '' };
  const lower = text.toLowerCase();
  if (lower.includes('no delay')) return { minutes: 0, closed: false, text };
  if (lower.includes('closed')) return { minutes: null, closed: true, text };
  if (lower.includes('not available') || lower.includes('n/a'))
    return { minutes: null, closed: false, text };
  const hours = /(\d+)\s*hour/.exec(lower);
  const mins = /(\d+)\s*min/.exec(lower);
  if (hours || mins) {
    const total =
      (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
    return {
      minutes: Number.isFinite(total) ? total : null,
      closed: false,
      text,
    };
  }
  return { minutes: null, closed: false, text };
}

/** Split one `;;`-paired CBSA line into trimmed fields. */
function splitRow(line) {
  return String(line)
    .replace(/^﻿/, '')
    .split(';;')
    .map((cell) => cell.trim());
}

/**
 * Parse the CBSA bwt CSV into placed crossings. Rows whose Customs Office is
 * not in CROSSINGS are skipped (no coordinate to place them). Returns [] for
 * an empty or header-only body.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseCbsaCsv(text, cbpByPort = null) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length < 2) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const office = cells[0];
    const point = CROSSINGS[office];
    if (!office || !point) continue;
    // Entry into the U.S. comes from CBP when merged; CBSA always sends "--".
    const us = (point.cbp && cbpByPort?.get(point.cbp)) || null;
    out.push({
      id: `cbsa:${office}`,
      name: office,
      location: cells[1] || '',
      updated: cells[2] || '',
      lat: point.lat,
      lon: point.lon,
      // Entry into Canada (what CBSA reports).
      canadaBound: {
        commercial: parseWaitCell(cells[3]),
        travellers: parseWaitCell(cells[5]),
      },
      usBound: us || {
        commercial: parseWaitCell(cells[4]),
        travellers: parseWaitCell(cells[6]),
      },
    });
  }
  return out;
}

/**
 * Parse one CBP lane object into the shared wait shape.
 *  - operational_status "lanes closed" → closed
 *  - "update pending"/"" with no delay number → not reported
 *  - delay_minutes → minutes (0 reads as "No delay")
 * @param {object} lane CBP `…_lanes.standard_lanes`.
 * @returns {{minutes: number|null, closed: boolean, text: string}}
 */
export function parseCbpLane(lane) {
  const status = String(lane?.operational_status ?? '')
    .trim()
    .toLowerCase();
  if (status.includes('closed'))
    return { minutes: null, closed: true, text: 'Closed' };
  const raw = String(lane?.delay_minutes ?? '').trim();
  const minutes = /^\d+$/.test(raw) ? Number(raw) : null;
  if (minutes === null) return { minutes: null, closed: false, text: '' };
  return {
    minutes,
    closed: false,
    text: minutes === 0 ? 'No delay' : `${minutes} minutes`,
  };
}

/**
 * Build a port_number → {travellers, commercial} map from the CBP bwtnew feed
 * (entry into the U.S.). Only Canadian-border ports are kept.
 * @param {Array<object>} payload CBP bwtnew JSON.
 * @returns {Map<string, {travellers: object, commercial: object}>}
 */
export function parseCbpFeed(payload) {
  const map = new Map();
  for (const port of Array.isArray(payload) ? payload : []) {
    const id = String(port?.port_number ?? '').trim();
    if (
      !id ||
      !String(port?.border ?? '')
        .toLowerCase()
        .includes('canad')
    )
      continue;
    map.set(id, {
      travellers: parseCbpLane(port?.passenger_vehicle_lanes?.standard_lanes),
      commercial: parseCbpLane(port?.commercial_vehicle_lanes?.standard_lanes),
    });
  }
  return map;
}

/** Colour a wait by its worst reported minutes (green→amber→red). */
export function waitColor(minutes) {
  if (!Number.isFinite(minutes)) return '#9e9e9e';
  if (minutes <= 0) return '#43a047';
  if (minutes < 15) return '#c0ca33';
  if (minutes < 30) return '#ffb300';
  if (minutes < 60) return '#fb8c00';
  return '#e53935';
}

/** The headline wait a pin shows: the longer of the two travellers directions. */
export function headlineMinutes(crossing) {
  const values = [
    crossing?.canadaBound?.travellers?.minutes,
    crossing?.usBound?.travellers?.minutes,
  ].filter((m) => Number.isFinite(m));
  return values.length ? Math.max(...values) : null;
}

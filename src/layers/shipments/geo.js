/**
 * Where a container probably is when no live ship position is available:
 * ships leave coastal AIS coverage mid-ocean, so the board estimates the
 * position from the departure and arrival dates along a plausible sea lane,
 * and along the rail line for the inland leg. Pure functions, no DOM.
 *
 * The lanes are deliberately simple: waypoints that keep the line on water
 * between the Mediterranean, the North Atlantic, the Gulf of St. Lawrence
 * and Montreal, which is the route this board was built for. Elsewhere it
 * falls back to a straight line between the two ports.
 */

/** UN/LOCODE → [lat, lon] for the ports this route uses. */
export const PORTS = Object.freeze({
  ITGIT: [38.44, 15.9],
  ITSAL: [40.67, 14.75],
  ITNAP: [40.84, 14.27],
  ITGOA: [44.4, 8.92],
  ITSPE: [44.1, 9.85],
  ITLIV: [43.55, 10.3],
  ITVCE: [45.44, 12.33],
  ITTRS: [45.63, 13.76],
  ITAOI: [43.62, 13.51],
  ITBRI: [41.13, 16.87],
  ITRAN: [44.49, 12.28],
  ITCTA: [37.5, 15.1],
  ITPMO: [38.13, 13.37],
  ITCAG: [39.21, 9.11],
  ESAGP: [36.71, -4.42],
  ESALG: [36.13, -5.44],
  ESVLC: [39.44, -0.32],
  ESBCN: [41.35, 2.17],
  PTSIE: [37.95, -8.87],
  PTLIS: [38.7, -9.15],
  EGPSD: [31.26, 32.31],
  EGALY: [31.18, 29.87],
  EGEDK: [31.18, 29.87],
  EGDAM: [31.47, 31.76],
  EGSOK: [29.62, 32.35],
  GRPIR: [37.94, 23.62],
  MTMAR: [35.83, 14.54],
  TRMER: [36.79, 34.63],
  CAMTR: [45.55, -73.53],
  CAQUE: [46.82, -71.2],
  CAHAL: [44.64, -63.56],
  CATOR: [43.72, -79.7],
  USNYC: [40.67, -74.1],
});

/** Port names as FindTEU writes them, for answers without a code. */
const PORT_NAMES = Object.freeze({
  'gioia tauro': 'ITGIT',
  salerno: 'ITSAL',
  naples: 'ITNAP',
  napoli: 'ITNAP',
  genoa: 'ITGOA',
  genova: 'ITGOA',
  'la spezia': 'ITSPE',
  livorno: 'ITLIV',
  venice: 'ITVCE',
  trieste: 'ITTRS',
  ancona: 'ITAOI',
  bari: 'ITBRI',
  ravenna: 'ITRAN',
  catania: 'ITCTA',
  palermo: 'ITPMO',
  cagliari: 'ITCAG',
  malaga: 'ESAGP',
  algeciras: 'ESALG',
  valencia: 'ESVLC',
  barcelona: 'ESBCN',
  sines: 'PTSIE',
  lisbon: 'PTLIS',
  'port said': 'EGPSD',
  alexandria: 'EGALY',
  damietta: 'EGDAM',
  sokhna: 'EGSOK',
  piraeus: 'GRPIR',
  marsaxlokk: 'MTMAR',
  mersin: 'TRMER',
  montreal: 'CAMTR',
  quebec: 'CAQUE',
  halifax: 'CAHAL',
  toronto: 'CATOR',
  brampton: 'CATOR',
  'new york': 'USNYC',
});

const GIBRALTAR = [35.95, -5.7];
const CAPE_ST_VINCENT = [36.4, -9.6];
const SICILY_CHANNEL = [37.5, 11.6];
const SOUTH_OF_SARDINIA = [38.4, 9.2];
const SOUTH_OF_IBIZA = [38.0, 1.0];
const WEST_OF_CORSICA = [41.0, 7.8];
const OTRANTO = [39.6, 19.2];
const MID_ADRIATIC = [41.6, 17.6];
const IONIAN = [36.4, 16.4];
const SOUTH_OF_NEWFOUNDLAND = [45.4, -55.0];
const CABOT_STRAIT = [47.4, -59.9];
const HONGUEDO_STRAIT = [48.95, -63.9];
const ST_LAWRENCE_ESTUARY = [48.7, -68.6];
const ST_LAWRENCE_MID = [47.9, -69.8];
const QUEBEC = [46.82, -71.2];
const LAC_SAINT_PIERRE = [46.2, -72.8];
/** Montreal → Toronto by rail, along the St. Lawrence and Lake Ontario. */
const RAIL_MONTREAL_TORONTO = Object.freeze([
  [45.55, -73.53],
  [45.02, -74.73],
  [44.23, -76.5],
  [43.9, -78.86],
  [43.72, -79.7],
]);

/**
 * Coordinates for a port, from its UN/LOCODE or, failing that, its name.
 * @param {{code?: string, port?: string}} place
 * @returns {[number, number]|null}
 */
export function portPosition(place) {
  const code = String(place?.code ?? '').toUpperCase();
  if (PORTS[code]) return PORTS[code];
  const name = String(place?.port ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
  const byName = PORT_NAMES[name];
  return byName ? PORTS[byName] : null;
}

const inMediterranean = ([lat, lon]) =>
  lon > -5.6 && lon < 37 && lat > 30 && lat < 46.5;
const inStLawrence = ([lat, lon]) => lon < -64 && lon > -75 && lat > 45;

/**
 * Waypoints from one port to another that stay on water for the
 * Mediterranean → St. Lawrence trade; a straight line otherwise.
 * @param {[number, number]} from
 * @param {[number, number]} to
 * @returns {Array<[number, number]>}
 */
export function seaLane(from, to) {
  const points = [from];
  if (inMediterranean(from) && !inMediterranean(to)) {
    const [lat, lon] = from;
    // East of the Italian boot: the heel (Bari, Brindisi) or the north
    // Adriatic (Ancona, Venice, Trieste); Naples and Salerno are not.
    const adriatic =
      lat > 40.5 && lon > 12.2 && lon < 20 && (lon > 15.5 || lat > 42.5);
    if (adriatic) points.push(MID_ADRIATIC, OTRANTO);
    if (adriatic || lon >= 16) points.push(IONIAN, SICILY_CHANNEL);
    else if (lat >= 42 && lon < 12)
      points.push(WEST_OF_CORSICA, SOUTH_OF_IBIZA);
    else if (lat >= 38 && lon >= 9) points.push(SOUTH_OF_SARDINIA);
    else if (lat >= 39 && lon > -1) points.push(SOUTH_OF_IBIZA);
    points.push(GIBRALTAR, CAPE_ST_VINCENT);
  }
  if (inStLawrence(to) && !inStLawrence(from))
    points.push(
      SOUTH_OF_NEWFOUNDLAND,
      CABOT_STRAIT,
      HONGUEDO_STRAIT,
      ST_LAWRENCE_ESTUARY,
      ST_LAWRENCE_MID,
      QUEBEC,
      LAC_SAINT_PIERRE,
    );
  points.push(to);
  return points;
}

/** The inland rail line from a port to a ramp. */
export function railLine(from, to) {
  const montreal = PORTS.CAMTR;
  const toronto = PORTS.CATOR;
  const near = (a, b) =>
    Math.abs(a[0] - b[0]) < 0.3 && Math.abs(a[1] - b[1]) < 0.3;
  if (near(from, montreal) && near(to, toronto))
    return [...RAIL_MONTREAL_TORONTO];
  return [from, to];
}

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The point `fraction` (0..1) of the way along a line, by distance.
 * @param {Array<[number, number]>} line
 * @param {number} fraction
 * @returns {[number, number]}
 */
export function alongLine(line, fraction) {
  if (line.length < 2) return line[0];
  const lengths = line.slice(1).map((point, i) => distanceKm(line[i], point));
  const total = lengths.reduce((sum, km) => sum + km, 0);
  let left = Math.min(Math.max(fraction, 0), 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? Math.min(left / lengths[i], 1) : 0;
      const [lat1, lon1] = line[i];
      const [lat2, lon2] = line[i + 1];
      return [lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t];
    }
    left -= lengths[i];
  }
  return line.at(-1);
}

function dayMs(day, hour = 12) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!match) return NaN;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hour,
  );
}

function progress(fromDay, toDay, nowMs) {
  const start = dayMs(fromDay);
  const end = dayMs(toDay);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null;
  return Math.min(Math.max((nowMs - start) / (end - start), 0), 1);
}

/**
 * The container's estimated position and the line it travels on.
 *
 * At sea: between the departure port and the discharge port, by how much of
 * the departure → ETA time has passed. On rail: the same between port and
 * ramp. Waiting at the port or the ramp: there. Picked up or finished: none.
 *
 * @param {object} shipment Normalized shipment (with `auto` and `dates`).
 * @param {string} stage One of the model's STAGES.
 * @param {number} nowMs
 * @param {{rampEta?: string}} [extra] Ramp ETA (estimated if need be).
 * @returns {null|{lat:number, lon:number, leg:'sea'|'rail'|'port'|'ramp',
 *   line:Array<[number, number]>}}
 */
export function estimatePosition(shipment, stage, nowMs, extra = {}) {
  const auto = shipment.auto;
  const origin = portPosition(auto?.pol);
  const port = portPosition(auto?.pod) ?? portPosition({ port: shipment.port });
  const ramp =
    portPosition(auto?.destination) ?? portPosition({ port: shipment.ramp });
  const d = shipment.dates;
  const at = ([lat, lon], leg, line) => ({ lat, lon, leg, line });

  if (stage === 'at-sea') {
    if (!origin || !port) return port ? at(port, 'port', []) : null;
    const lane = seaLane(origin, port);
    const departed = auto?.dates?.departed;
    const fraction = departed ? progress(departed, d.portEta, nowMs) : 0;
    return at(alongLine(lane, fraction ?? 0), 'sea', lane);
  }
  if (stage === 'at-port') return port ? at(port, 'port', []) : null;
  if (stage === 'on-rail') {
    if (!port || !ramp) return null;
    const line = railLine(port, ramp);
    const fraction = progress(
      d.railDeparted || d.discharged,
      extra.rampEta || d.rampEta,
      nowMs,
    );
    return at(alongLine(line, fraction ?? 0.5), 'rail', line);
  }
  if (stage === 'at-ramp') return ramp ? at(ramp, 'ramp', []) : null;
  return null;
}

/**
 * Which ship a container is on, as one key: IMO, else MMSI, else the name.
 * Empty when the ship is not known.
 * @param {object} shipment
 * @returns {string}
 */
export function shipKeyOf(shipment) {
  const own = shipment?.vessel ?? {};
  const auto = shipment?.auto?.vessel ?? {};
  const imo = String(own.imo || auto.imo || '').trim();
  if (imo) return `imo:${imo}`;
  const mmsi = String(own.mmsi || auto.mmsi || '').trim();
  if (mmsi) return `mmsi:${mmsi}`;
  const name = String(own.query || auto.name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  return name ? `name:${name}` : '';
}

/**
 * Containers on one ship are in one place. Of the at-sea containers sharing
 * `shipment`'s ship, the one whose position stands for all of them: the one
 * whose ship was heard most recently (within `heardMs`), else the one that
 * boarded last — its loading port is the ship's latest port of call, so its
 * leg is the one the ship is sailing now.
 *
 * @param {object} shipment
 * @param {Array<object>} shipments Every listed shipment.
 * @param {{nowMs: number, heardMs: number, atSea: (s: object) => boolean}} options
 * @returns {object} `shipment` itself when it stands alone.
 */
export function shipLeader(shipment, shipments, { nowMs, heardMs, atSea }) {
  const key = shipKeyOf(shipment);
  if (!key || !atSea(shipment)) return shipment;
  const crew = shipments.filter(
    (other) => atSea(other) && shipKeyOf(other) === key,
  );
  if (crew.length < 2) return shipment;
  const heard = crew
    .filter((other) => nowMs - (other.lastSeen?.at ?? -Infinity) < heardMs)
    .sort((a, b) => b.lastSeen.at - a.lastSeen.at);
  if (heard.length) return heard[0];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const boarded = (other) => {
    const day = other.auto?.dates?.departed || other.auto?.dates?.loaded || '';
    return day && day <= today ? day : '';
  };
  return [...crew].sort((a, b) => {
    const da = boarded(a);
    const db = boarded(b);
    if (da !== db) return da < db ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  })[0];
}

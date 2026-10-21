/**
 * Automatic tracking data: a carrier-tracking answer turned into the board's
 * milestones. Portable (the server imports it), so no DOM and no i18n.
 *
 * FindTEU reports one container's journey as dated events ("Loaded on",
 * "Departed by", "Arrived by", "Discharged from", "Delivered by", "Empty
 * returned by"), each `actual` or `expected`, with the port's UN/LOCODE and,
 * for sea legs, the ship. The port of discharge (`pod`) is where the box
 * comes off the ship; a `destination` beyond it means an inland leg, which
 * for Montreal → Toronto is the rail move.
 */

/** Line SCAC codes → the board's carrier ids (and back, for Terminal49). */
export const SCAC_CARRIERS = Object.freeze({
  MSCU: 'msc',
  MEDU: 'msc',
  MAEU: 'maersk',
  MSKU: 'maersk',
  SUDU: 'maersk',
  SEAU: 'maersk',
  HLCU: 'hapag',
  HLXU: 'hapag',
  CMDU: 'cma',
  APLU: 'cma',
  ANNU: 'cma',
  COSU: 'cosco',
  ONEY: 'one',
  EGLV: 'evergreen',
  OOLU: 'oocl',
  ZIMU: 'zim',
  HDMU: 'hmm',
  YMLU: 'yangming',
  YMJA: 'yangming',
});

export const CARRIER_SCAC = Object.freeze({
  msc: 'MSCU',
  maersk: 'MAEU',
  hapag: 'HLCU',
  cma: 'CMDU',
  cosco: 'COSU',
  one: 'ONEY',
  evergreen: 'EGLV',
  oocl: 'OOLU',
  zim: 'ZIMU',
  hmm: 'HDMU',
  yangming: 'YMLU',
});

/** The milestone dates automatic tracking can fill. */
export const AUTO_DATE_FIELDS = Object.freeze([
  'departed',
  'portEta',
  'discharged',
  'railDeparted',
  'rampEta',
  'rampArrived',
  'pickedUp',
  'emptyReturned',
]);

const DAY = /^(\d{4}-\d{2}-\d{2})/;

function day(value) {
  const match = DAY.exec(String(value ?? ''));
  return match ? match[1] : '';
}

function text(value, limit = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);
}

function vesselOf(event) {
  const vessel = event?.mode?.vessel || {};
  const name = text(vessel.vessel_name);
  if (!name) return null;
  const imo = String(vessel.imo ?? '').trim();
  const mmsi = String(vessel.mmsi ?? '').trim();
  return {
    name,
    imo: /^\d{7}$/.test(imo) ? imo : '',
    mmsi: /^\d{9}$/.test(mmsi) ? mmsi : '',
    voyage: text(vessel.voyage_nr, 20),
  };
}

function place(value) {
  return {
    port: text(value?.port),
    country: text(value?.country),
    code: text(value?.iso_code, 8).toUpperCase(),
    terminal: text(value?.terminal),
  };
}

const ARRIVE = /arriv|discharg|unload|ramp|available/i;
const DEPART = /depart|loaded on|loaded|gate out full|left/i;
const PICKUP = /deliver|gate out full|pick/i;
const EMPTY_RETURN = /empty return|gate in empty|empty in/i;
const RAIL = /rail|train/i;

/**
 * Milestones from a FindTEU `data` object.
 *
 * Only the board's own fields come out; everything else (holds, last free
 * days) FindTEU does not report. Returns null for an unusable payload.
 *
 * @param {object} data FindTEU response `data`.
 * @param {{now?: number}} [options]
 * @returns {null|{source:string, carrier:string, scac:string,
 *   completed:boolean, pol:object, pod:object, destination:object,
 *   vessel:object|null, dates:object, events:Array<object>, fetchedAt:number}}
 */
export function parseFindTeu(data, { now = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || data.error) return null;
  const events = (Array.isArray(data.events) ? data.events : [])
    .map((event) => ({
      day: day(event?.event_date),
      action: text(event?.action?.action_name),
      actual: event?.event_type === 'actual',
      mode: text(event?.mode?.transport_mode, 20),
      code: text(event?.location?.iso_code, 8).toUpperCase(),
      port: text(event?.location?.port),
      terminal: text(event?.location?.terminal),
      vessel: vesselOf(event),
    }))
    .filter((event) => event.day && event.action)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const pol = place(data.pol);
  const pod = place(data.pod);
  const destination = place(data.destination);
  const inland =
    Boolean(destination.code) &&
    Boolean(pod.code) &&
    destination.code !== pod.code;
  const scac = text(data.scac, 8).toUpperCase();
  const dates = Object.fromEntries(AUTO_DATE_FIELDS.map((key) => [key, '']));

  const atPod = (event) => pod.code && event.code === pod.code;
  const atPol = (event) => pol.code && event.code === pol.code;

  // When the ship left the loading port: actual, else planned.
  const departures = events.filter(
    (event) => atPol(event) && /depart/i.test(event.action),
  );
  dates.departed =
    departures.find((event) => event.actual)?.day ||
    departures[0]?.day ||
    day(data.pol?.etd_date) ||
    '';
  const atDestination = (event) =>
    inland && destination.code && event.code === destination.code;

  // The ship's arrival at the discharge port: actual if it has happened,
  // otherwise the carrier's latest expected date.
  const podArrivals = events.filter(
    (event) => atPod(event) && /arriv/i.test(event.action),
  );
  const arrived = podArrivals.find((event) => event.actual);
  dates.portEta =
    arrived?.day || day(data.pod?.eta_date) || podArrivals.at(-1)?.day || '';

  const discharged = events.find(
    (event) =>
      atPod(event) && /discharg|unload/i.test(event.action) && event.actual,
  );
  dates.discharged = discharged?.day || '';

  if (inland) {
    const afterPort = events.filter(
      (event) => !discharged || event.day >= discharged.day,
    );
    const railOut = afterPort.find(
      (event) =>
        event.actual &&
        !atDestination(event) &&
        (RAIL.test(event.mode) ||
          (atPod(event) && DEPART.test(event.action))) &&
        !EMPTY_RETURN.test(event.action),
    );
    dates.railDeparted = railOut?.day || '';
    const rampEvents = events.filter(
      (event) => atDestination(event) && ARRIVE.test(event.action),
    );
    const rampActual = rampEvents.find((event) => event.actual);
    dates.rampArrived = rampActual?.day || '';
    dates.rampEta =
      rampActual?.day ||
      rampEvents.at(-1)?.day ||
      day(data.destination?.eta_date) ||
      '';
  }

  const finalCode = inland ? destination.code : pod.code;
  const pickup = events.find(
    (event) =>
      event.actual &&
      PICKUP.test(event.action) &&
      !EMPTY_RETURN.test(event.action) &&
      !/loaded on/i.test(event.action) &&
      (!finalCode || event.code === finalCode) &&
      !/vessel/i.test(event.mode),
  );
  dates.pickedUp = pickup?.day || '';
  const emptyBack = events.find(
    (event) =>
      event.actual &&
      EMPTY_RETURN.test(event.action) &&
      (!dates.pickedUp || event.day >= dates.pickedUp),
  );
  dates.emptyReturned = emptyBack?.day || '';

  // The ship to follow: the one carrying the box now (latest actual loading
  // or departure), or before loading, the first planned one.
  const sea = events.filter((event) => event.vessel);
  const current = [...sea]
    .reverse()
    .find((event) => event.actual && DEPART.test(event.action));
  const vessel =
    dates.discharged || dates.pickedUp
      ? null
      : (current?.vessel ?? sea.find((event) => !event.actual)?.vessel ?? null);

  return {
    source: 'FindTEU',
    carrier: SCAC_CARRIERS[scac] ?? '',
    scac,
    completed: Boolean(data.container?.completed),
    pol,
    pod,
    destination,
    vessel,
    dates,
    events: events.slice(-40).map(({ vessel: v, ...rest }) => ({
      ...rest,
      vessel: v?.name ?? '',
    })),
    fetchedAt: now,
  };
}

/**
 * Shipment records and the free-time arithmetic behind them: where the box
 * is, which "last free day" clocks are running, and what needs doing next.
 *
 * Pure functions over plain data. Dates are calendar days (`YYYY-MM-DD`) in
 * the operator's own time zone, because terminals and ramps count free days
 * by the calendar, not by the hour. A last free day of today means 0 days
 * left; charges start the day after.
 */
import { msg } from '../../i18n/marker.js';
import { CARRIER_IDS, normalizeContainerNumber } from './containers.js';
import { AUTO_DATE_FIELDS } from './tracking.js';

export const MAX_SHIPMENTS = 60;
const MAX_TEXT = 80;
const MAX_NOTES = 600;
const MAX_FREE_DAYS = 60;
const DAY_MS = 86_400_000;

/** Milestone dates in the order a box meets them. */
export const DATE_FIELDS = Object.freeze([
  'portEta',
  'discharged',
  'portLfd',
  'railDeparted',
  'rampEta',
  'rampArrived',
  'rampLfd',
  'pickupPlanned',
  'pickedUp',
  'emptyReturnBy',
  'emptyReturned',
]);

export const DATE_LABELS = Object.freeze({
  loaded: msg('Loaded at origin'),
  departed: msg('Ship left origin'),
  portEta: msg('Ship ETA at port'),
  discharged: msg('Unloaded at port'),
  portLfd: msg('Port last free day'),
  railDeparted: msg('Left port on rail'),
  rampEta: msg('Rail ETA at ramp'),
  rampArrived: msg('Arrived at ramp'),
  rampLfd: msg('Ramp last free day'),
  pickupPlanned: msg('Truck booked for'),
  pickedUp: msg('Picked up'),
  emptyReturnBy: msg('Return empty by'),
  emptyReturned: msg('Empty returned'),
});

export const HOLD_KINDS = Object.freeze(['customs', 'freight', 'other']);
export const HOLD_LABELS = Object.freeze({
  customs: msg('Customs hold'),
  freight: msg('Freight / line hold'),
  other: msg('Other hold'),
});

export const STAGES = Object.freeze([
  'at-sea',
  'at-port',
  'on-rail',
  'at-ramp',
  'with-you',
  'done',
]);
export const STAGE_LABELS = Object.freeze({
  'at-sea': msg('At sea'),
  'at-port': msg('At port'),
  'on-rail': msg('On rail'),
  'at-ramp': msg('At rail ramp'),
  'with-you': msg('Picked up'),
  done: msg('Done'),
});

export const CLOCK_LABELS = Object.freeze({
  port: msg('Port free time'),
  ramp: msg('Ramp free time'),
  return: msg('Empty return'),
});

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A `YYYY-MM-DD` string that names a real calendar day, or ''.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDay(value) {
  const text = String(value ?? '').trim();
  const match = ISO_DAY.exec(text);
  if (!match) return '';
  const [year, month, day] = match.slice(1).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    year >= 2000 &&
    year <= 2100
    ? text
    : '';
}

/** The operator's local calendar day for an epoch-ms instant. */
export function localDay(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayNumber(day) {
  const match = ISO_DAY.exec(day);
  if (!match) return NaN;
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS
  );
}

/**
 * Whole calendar days from `from` to `to` (positive when `to` is later).
 * @param {string} from
 * @param {string} to
 * @returns {number} NaN when either day is missing.
 */
export function daysBetween(from, to) {
  return Math.round(dayNumber(to) - dayNumber(from));
}

/** `day` plus `count` calendar days. */
export function addDays(day, count) {
  const base = dayNumber(day);
  if (!Number.isFinite(base) || !Number.isFinite(count)) return '';
  const date = new Date((base + count) * DAY_MS);
  return date.toISOString().slice(0, 10);
}

function text(value, limit = MAX_TEXT) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);
}

function freeDays(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 0 && number <= MAX_FREE_DAYS
    ? number
    : null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLastSeen(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = finite(value.lat);
  const lon = finite(value.lon);
  const at = finite(value.at);
  if (
    lat === null ||
    lon === null ||
    at === null ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const eta = text(value.eta, 40);
  return {
    lat,
    lon,
    at,
    name: text(value.name),
    mmsi: /^\d{5,10}$/.test(String(value.mmsi ?? '')) ? String(value.mmsi) : '',
    imo: /^\d{7}$/.test(String(value.imo ?? '')) ? String(value.imo) : '',
    speed: finite(value.speed),
    course: finite(value.course),
    destination: text(value.destination, 40),
    eta: Number.isFinite(Date.parse(eta)) ? eta : '',
  };
}

function normalizeVesselRef(value) {
  if (!value || typeof value !== 'object') return null;
  const name = text(value.name);
  if (!name) return null;
  return {
    name,
    imo: /^\d{7}$/.test(String(value.imo ?? '')) ? String(value.imo) : '',
    mmsi: /^\d{9}$/.test(String(value.mmsi ?? '')) ? String(value.mmsi) : '',
    voyage: text(value.voyage, 20),
  };
}

function normalizePlace(value) {
  return {
    port: text(value?.port),
    code: text(value?.code, 8),
  };
}

/**
 * Automatic tracking as stored on a shipment: only the milestone dates the
 * board uses, the ship, the ports and when it was fetched.
 */
export function normalizeAuto(value) {
  if (!value || typeof value !== 'object') return null;
  const dates = {};
  for (const field of AUTO_DATE_FIELDS)
    dates[field] = normalizeDay(value.dates?.[field]);
  return {
    source: text(value.source, 20),
    carrier: CARRIER_IDS.includes(value.carrier) ? value.carrier : '',
    completed: Boolean(value.completed),
    vessel: normalizeVesselRef(value.vessel),
    pol: normalizePlace(value.pol),
    pod: normalizePlace(value.pod),
    destination: normalizePlace(value.destination),
    dates,
    fetchedAt: finite(value.fetchedAt) ?? 0,
    // Which parser read it; 0 for records saved before versions existed.
    version: finite(value.version) ?? 0,
  };
}

/**
 * A shipment from stored or typed input, with every field bounded and
 * typed. Unknown fields are dropped.
 *
 * `manual` holds the dates the operator typed and `auto` what automatic
 * tracking reported; `dates` is the two merged, a typed date always
 * winning. Records saved before automatic tracking kept typed dates in
 * `dates`, which is read as `manual`.
 *
 * @param {object} input
 * @returns {object}
 */
export function normalizeShipment(input = {}) {
  const manual = {};
  const typed = input.manual ?? input.dates;
  for (const field of DATE_FIELDS) manual[field] = normalizeDay(typed?.[field]);
  const auto = normalizeAuto(input.auto);
  const dates = {};
  for (const field of DATE_FIELDS)
    dates[field] = manual[field] || auto?.dates[field] || '';
  // A box the line reports as finished needs no clocks.
  if (auto?.completed && !dates.emptyReturned && dates.pickedUp)
    dates.emptyReturned = dates.pickedUp;
  const holds = {};
  for (const kind of HOLD_KINDS) holds[kind] = Boolean(input.holds?.[kind]);
  const vessel = input.vessel || {};
  return {
    id: text(input.id, 40),
    container: normalizeContainerNumber(input.container).slice(0, 11),
    carrier: CARRIER_IDS.includes(input.carrier)
      ? input.carrier
      : (auto?.carrier ?? ''),
    reference: text(input.reference),
    port: text(input.port) || 'Montreal',
    ramp: text(input.ramp) || 'Toronto',
    vessel: {
      query: text(vessel.query),
      mmsi: /^\d{5,10}$/.test(String(vessel.mmsi ?? ''))
        ? String(vessel.mmsi)
        : '',
      imo: /^\d{7}$/.test(String(vessel.imo ?? '')) ? String(vessel.imo) : '',
    },
    manual,
    auto,
    dates,
    freeDays: {
      ramp: freeDays(input.freeDays?.ramp),
      return: freeDays(input.freeDays?.return),
    },
    holds,
    notes: text(input.notes, MAX_NOTES),
    lastSeen: normalizeLastSeen(input.lastSeen),
    createdAt: finite(input.createdAt) ?? 0,
    updatedAt: finite(input.updatedAt) ?? 0,
  };
}

/**
 * Where the box is, from the latest milestone the operator has recorded.
 * @param {object} shipment Normalized shipment.
 * @returns {string} One of STAGES.
 */
export function shipmentStage(shipment) {
  const d = shipment.dates;
  if (d.emptyReturned) return 'done';
  if (d.pickedUp) return 'with-you';
  if (d.rampArrived) return 'at-ramp';
  if (d.railDeparted) return 'on-rail';
  if (d.discharged) return 'at-port';
  return 'at-sea';
}

/**
 * Published free time used when the operator has set nothing, so no number
 * has to be typed. Contracts often differ; numbers on the board win.
 * - ramp: CN intermodal storage, 1 free day once the box is off the rail;
 * - return: MSC Montreal import detention, 4 working days after pickup;
 * - rail: about 4 days from Montreal to Toronto;
 * - port: not counted unless set. On carrier haulage the box goes from the
 *   ship straight onto the train, so port storage is the line's matter.
 */
export const STANDARD_FREE_TIME = Object.freeze({
  portFreeDays: null,
  rampFreeDays: 1,
  returnFreeDays: 4,
  railDays: 4,
});

/** Which clocks count working days (Monday to Friday) rather than all days. */
const WORKING_DAY_CLOCKS = new Set(['port', 'return']);

/**
 * Board-wide free time the operator may set once from their contract. Unset
 * values fall back to STANDARD_FREE_TIME. A shipment's own free days win.
 */
export function normalizeDefaults(value = {}) {
  return {
    portFreeDays: freeDays(value?.portFreeDays),
    rampFreeDays: freeDays(value?.rampFreeDays),
    returnFreeDays: freeDays(value?.returnFreeDays),
    railDays: freeDays(value?.railDays),
  };
}

const DEFAULT_KEYS = Object.freeze({
  port: 'portFreeDays',
  ramp: 'rampFreeDays',
  return: 'returnFreeDays',
  rail: 'railDays',
});

/**
 * The free days that apply to one clock, and whether they are the published
 * standard rather than numbers from the operator.
 * @returns {{days:number, standard:boolean}}
 */
export function freeTimeFor(shipment, defaults, kind) {
  const own = kind === 'rail' ? null : shipment.freeDays?.[kind];
  if (own !== null && own !== undefined) return { days: own, standard: false };
  const set = defaults?.[DEFAULT_KEYS[kind]];
  if (set !== null && set !== undefined) return { days: set, standard: false };
  const standard = STANDARD_FREE_TIME[DEFAULT_KEYS[kind]];
  return { days: standard ?? null, standard: true };
}

function isWorkingDay(day) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/**
 * The last free day when free time starts the day after `from`: `count`
 * calendar days, or `count` working days for working-day clocks.
 */
export function lastFreeDay(from, count, { workingDays = false } = {}) {
  if (!normalizeDay(from) || !Number.isFinite(count) || count < 0) return '';
  if (!workingDays) return addDays(from, count);
  let day = from;
  let counted = 0;
  while (counted < count) {
    day = addDays(day, 1);
    if (isWorkingDay(day)) counted++;
  }
  return day;
}

/**
 * When the box should reach the rail ramp: the reported or typed rail ETA,
 * else (when port and ramp differ and a usual rail transit is set) the
 * unloading date, or the ship's ETA, plus that transit.
 *
 * @returns {{day:string, estimated:boolean}}
 */
export function rampEtaFor(shipment, defaults = null) {
  defaults ??= shipment.defaults ?? null;
  const d = shipment.dates;
  if (d.rampArrived) return { day: d.rampArrived, estimated: false };
  if (d.rampEta) return { day: d.rampEta, estimated: false };
  const rail = freeTimeFor(shipment, defaults, 'rail').days;
  const base = d.railDeparted || d.discharged || latestPortEta(shipment);
  const sameplace =
    shipment.port.trim().toLowerCase() === shipment.ramp.trim().toLowerCase();
  if (rail === null || rail === undefined || !base || sameplace)
    return { day: '', estimated: false };
  return { day: addDays(base, rail), estimated: true };
}

/**
 * The freshest port ETA: the ship's own AIS ETA when it was heard after the
 * last tracking answer (ships often update it first), else the tracked or
 * typed ETA. A typed ETA always wins.
 */
export function latestPortEta(shipment) {
  const d = shipment.dates;
  if (shipment.manual?.portEta) return shipment.manual.portEta;
  const seen = shipment.lastSeen;
  const eta = seen?.eta ? Date.parse(seen.eta) : NaN;
  if (
    !d.discharged &&
    Number.isFinite(eta) &&
    seen.at > (shipment.auto?.fetchedAt ?? 0)
  )
    return localDay(eta);
  return d.portEta;
}

function stageOf(dates) {
  return shipmentStage({ dates });
}

function clockState(daysLeft) {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft === 0) return 'today';
  if (daysLeft <= 2) return 'soon';
  return 'ok';
}

/**
 * The free-time clocks for one shipment.
 *
 * A typed last free day always wins. Without one, the ramp clock is
 * estimated from the ramp arrival (or the rail ETA) plus the ramp's free
 * days, and the empty-return clock from the pickup plus its free days.
 * A clock is `closed` once the box has moved on.
 *
 * @param {object} shipment Normalized shipment.
 * @param {string} today Local `YYYY-MM-DD`.
 * @param {object|null} [defaults] Board defaults (normalizeDefaults); the
 *   shipment's own `defaults`, attached by the store, when omitted.
 * @returns {Array<{id:string, day:string, estimated:boolean,
 *   daysLeft:number, state:string, closed:boolean}>}
 */
export function shipmentClocks(shipment, today, defaults = null) {
  defaults ??= shipment.defaults ?? null;
  const d = shipment.dates;
  const clocks = [];
  const push = (id, day, estimated, closed) => {
    if (!day) return;
    const daysLeft = daysBetween(today, day);
    clocks.push({
      id,
      day,
      estimated,
      daysLeft,
      state: closed ? 'closed' : clockState(daysLeft),
      closed,
      pending: false,
    });
  };
  // Port free time matters only while the box waits at the port.
  let portDay = d.portLfd;
  let portEstimated = false;
  const portFree = freeTimeFor(shipment, defaults, 'port');
  if (!portDay && d.discharged && portFree.days !== null) {
    const free = portFree;
    portDay = lastFreeDay(d.discharged, free.days, {
      workingDays: WORKING_DAY_CLOCKS.has('port'),
    });
    portEstimated = free.standard;
  }
  push(
    'port',
    portDay,
    portEstimated,
    Boolean(d.railDeparted || d.pickedUp || d.emptyReturned),
  );

  // The ramp's last free day is a count of days once the box is off the
  // rail, not a date anyone publishes. Until it is off the rail the clock is
  // pending: the rule, plus a projection from the rail ETA for planning.
  const rampFree = freeTimeFor(shipment, defaults, 'ramp');
  const rampDone = Boolean(d.pickedUp || d.emptyReturned);
  if (d.rampLfd) push('ramp', d.rampLfd, false, rampDone);
  else if (d.rampArrived) {
    // Free time starts the day after the box comes off the rail.
    push('ramp', lastFreeDay(d.rampArrived, rampFree.days), false, rampDone);
  } else if (!rampDone && stageOf(d) !== 'done') {
    const eta = rampEtaFor(shipment, defaults);
    const projected = eta.day ? lastFreeDay(eta.day, rampFree.days) : '';
    clocks.push({
      id: 'ramp',
      day: projected,
      estimated: true,
      daysLeft: projected ? daysBetween(today, projected) : null,
      state: 'pending',
      closed: false,
      pending: true,
      freeDays: rampFree.days,
    });
  }

  let returnDay = d.emptyReturnBy;
  let returnEstimated = false;
  if (!returnDay && d.pickedUp) {
    const free = freeTimeFor(shipment, defaults, 'return');
    returnDay = lastFreeDay(d.pickedUp, free.days, {
      workingDays: WORKING_DAY_CLOCKS.has('return'),
    });
    returnEstimated = free.standard;
  }
  push('return', returnDay, returnEstimated, Boolean(d.emptyReturned));
  return clocks;
}

/** Hours between a ship's own AIS ETA and the planned ETA, in whole days. */
function aisEtaSlipDays(shipment) {
  const eta = shipment.lastSeen?.eta;
  const planned = shipment.dates.portEta;
  if (!eta || !planned) return null;
  const reported = localDay(Date.parse(eta));
  const slip = daysBetween(planned, reported);
  return Number.isFinite(slip) ? slip : null;
}

/**
 * What needs attention, most urgent first. Each alert is a code with its
 * values; the UI turns it into words.
 *
 * Severity: 3 = act today (charges running or start tomorrow), 2 = act in
 * the next day or two, 1 = worth knowing.
 *
 * @param {object} shipment Normalized shipment.
 * @param {string} today Local `YYYY-MM-DD`.
 * @returns {Array<{code:string, severity:number, clock?:string,
 *   days?:number, holds?:string[]}>}
 */
export function shipmentAlerts(shipment, today, defaults = null) {
  defaults ??= shipment.defaults ?? null;
  const stage = shipmentStage(shipment);
  if (stage === 'done') return [];
  const d = shipment.dates;
  const alerts = [];
  // A pending clock is only a projection; it raises no alert of its own.
  const clocks = shipmentClocks(shipment, today, defaults).filter(
    (clock) => !clock.closed && !clock.pending,
  );
  for (const clock of clocks) {
    if (clock.state === 'overdue')
      alerts.push({
        code: 'overdue',
        severity: 3,
        clock: clock.id,
        days: -clock.daysLeft,
      });
    else if (clock.state === 'today')
      alerts.push({ code: 'last-day', severity: 3, clock: clock.id, days: 0 });
    else if (clock.daysLeft <= 3)
      alerts.push({
        code: 'due-soon',
        severity: clock.daysLeft === 1 ? 3 : clock.daysLeft === 2 ? 2 : 1,
        clock: clock.id,
        days: clock.daysLeft,
      });
  }

  const holds = HOLD_KINDS.filter((kind) => shipment.holds[kind]);
  if (holds.length && stage !== 'with-you') {
    const nearest = Math.min(
      ...clocks.map((clock) => clock.daysLeft),
      Infinity,
    );
    alerts.push({
      code: 'hold',
      severity: nearest <= 2 ? 3 : stage === 'at-sea' ? 1 : 2,
      holds,
    });
  }

  const ramp = clocks.find((clock) => clock.id === 'ramp');
  if (
    !d.pickedUp &&
    d.pickupPlanned &&
    ramp &&
    daysBetween(ramp.day, d.pickupPlanned) > 0
  )
    alerts.push({
      code: 'truck-late',
      severity: 3,
      days: daysBetween(ramp.day, d.pickupPlanned),
    });

  if (!d.pickedUp && !d.pickupPlanned) {
    const rampEta = rampEtaFor(shipment, defaults);
    const railSoon =
      (stage === 'on-rail' || stage === 'at-port') &&
      rampEta.day &&
      daysBetween(today, rampEta.day) <= 2;
    if (stage === 'at-ramp' || railSoon)
      alerts.push({
        code: 'book-truck',
        severity: 2,
        days:
          stage === 'at-ramp'
            ? 0
            : Math.max(0, daysBetween(today, rampEta.day)),
      });
  }

  if (stage === 'on-rail' && d.rampEta && daysBetween(d.rampEta, today) >= 1)
    alerts.push({
      code: 'rail-eta-passed',
      severity: 2,
      days: daysBetween(d.rampEta, today),
    });

  if (stage === 'at-sea') {
    if (d.portEta && daysBetween(d.portEta, today) >= 2)
      alerts.push({
        code: 'eta-passed',
        severity: 1,
        days: daysBetween(d.portEta, today),
      });
    const slip = aisEtaSlipDays(shipment);
    if (slip !== null && slip >= 1)
      alerts.push({
        code: 'ship-late',
        severity: slip >= 3 ? 2 : 1,
        days: slip,
      });
  }
  return alerts.sort((a, b) => b.severity - a.severity);
}

/**
 * One-line status for lists: the stage, plus the next date that matters.
 * @param {object} shipment Normalized shipment.
 * @param {string} today Local `YYYY-MM-DD`.
 * @returns {{stage:string, next:{kind:string, day:string, days:number}|null}}
 */
export function shipmentSummary(shipment, today, defaults = null) {
  defaults ??= shipment.defaults ?? null;
  const stage = shipmentStage(shipment);
  const d = shipment.dates;
  const open = shipmentClocks(shipment, today, defaults).filter(
    (clock) => !clock.closed && !clock.pending,
  );
  const rampEta = rampEtaFor(shipment, defaults);
  const clock = open.sort((a, b) => a.daysLeft - b.daysLeft)[0];
  let next = null;
  if (stage === 'at-sea' && d.portEta)
    next = {
      kind: 'port-eta',
      day: d.portEta,
      days: daysBetween(today, d.portEta),
    };
  else if (
    (stage === 'on-rail' || stage === 'at-port') &&
    rampEta.day &&
    !clock
  )
    next = {
      kind: 'ramp-eta',
      day: rampEta.day,
      days: daysBetween(today, rampEta.day),
      estimated: rampEta.estimated,
    };
  else if (clock)
    next = { kind: `clock:${clock.id}`, day: clock.day, days: clock.daysLeft };
  return { stage, next };
}

/**
 * The most severe alert level across shipments (0 when all is quiet).
 * @param {Array<object>} shipments
 * @param {string} today
 */
export function worstSeverity(shipments, today, defaults = null) {
  let worst = 0;
  for (const shipment of shipments)
    for (const alert of shipmentAlerts(shipment, today, defaults))
      worst = Math.max(worst, alert.severity);
  return worst;
}

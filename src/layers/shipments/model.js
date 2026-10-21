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

/**
 * A shipment from stored or typed input, with every field bounded and
 * typed. Unknown fields are dropped.
 * @param {object} input
 * @returns {object}
 */
export function normalizeShipment(input = {}) {
  const dates = {};
  for (const field of DATE_FIELDS)
    dates[field] = normalizeDay(input.dates?.[field]);
  const holds = {};
  for (const kind of HOLD_KINDS) holds[kind] = Boolean(input.holds?.[kind]);
  const vessel = input.vessel || {};
  return {
    id: text(input.id, 40),
    container: normalizeContainerNumber(input.container).slice(0, 11),
    carrier: CARRIER_IDS.includes(input.carrier) ? input.carrier : '',
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
 * @returns {Array<{id:string, day:string, estimated:boolean,
 *   daysLeft:number, state:string, closed:boolean}>}
 */
export function shipmentClocks(shipment, today) {
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
    });
  };
  push(
    'port',
    d.portLfd,
    false,
    Boolean(d.railDeparted || d.pickedUp || d.emptyReturned),
  );

  let rampDay = d.rampLfd;
  let rampEstimated = false;
  if (!rampDay && shipment.freeDays.ramp !== null) {
    const from = d.rampArrived || d.rampEta;
    if (from) {
      // The arrival day itself is free day one.
      rampDay = addDays(from, Math.max(0, shipment.freeDays.ramp - 1));
      rampEstimated = !d.rampArrived;
    }
  }
  push('ramp', rampDay, rampEstimated, Boolean(d.pickedUp || d.emptyReturned));

  let returnDay = d.emptyReturnBy;
  if (!returnDay && shipment.freeDays.return !== null && d.pickedUp)
    returnDay = addDays(d.pickedUp, Math.max(0, shipment.freeDays.return - 1));
  push('return', returnDay, false, Boolean(d.emptyReturned));
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
export function shipmentAlerts(shipment, today) {
  const stage = shipmentStage(shipment);
  if (stage === 'done') return [];
  const d = shipment.dates;
  const alerts = [];
  const clocks = shipmentClocks(shipment, today).filter(
    (clock) => !clock.closed,
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
    const railSoon =
      stage === 'on-rail' && d.rampEta && daysBetween(today, d.rampEta) <= 2;
    if (stage === 'at-ramp' || railSoon)
      alerts.push({
        code: 'book-truck',
        severity: 2,
        days:
          stage === 'at-ramp' ? 0 : Math.max(0, daysBetween(today, d.rampEta)),
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
export function shipmentSummary(shipment, today) {
  const stage = shipmentStage(shipment);
  const d = shipment.dates;
  const open = shipmentClocks(shipment, today).filter((clock) => !clock.closed);
  const clock = open.sort((a, b) => a.daysLeft - b.daysLeft)[0];
  let next = null;
  if (stage === 'at-sea' && d.portEta)
    next = {
      kind: 'port-eta',
      day: d.portEta,
      days: daysBetween(today, d.portEta),
    };
  else if (stage === 'on-rail' && d.rampEta && !clock)
    next = {
      kind: 'ramp-eta',
      day: d.rampEta,
      days: daysBetween(today, d.rampEta),
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
export function worstSeverity(shipments, today) {
  let worst = 0;
  for (const shipment of shipments)
    for (const alert of shipmentAlerts(shipment, today))
      worst = Math.max(worst, alert.severity);
  return worst;
}

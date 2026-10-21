/**
 * Shipment alerts and statuses in the UI language. The model returns codes
 * and numbers; this module is the only place they become words.
 */
import { formatDate, formatRelativeTime, t, tn } from '../../i18n/index.js';
import {
  CLOCK_LABELS,
  HOLD_LABELS,
  STAGE_LABELS,
  shipmentSummary,
} from './model.js';

/** "Oct 24" for a `YYYY-MM-DD` day, in the UI language. */
export function displayDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!match) return '';
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return formatDate(time, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "today", "tomorrow", "in 3 days", "2 days ago". */
export function relativeDays(days) {
  return Number.isFinite(days) ? formatRelativeTime(days, 'day') : '';
}

const clockName = (id) => t(CLOCK_LABELS[id] ?? CLOCK_LABELS.ramp);

/**
 * One alert as a sentence.
 * @param {{code:string, clock?:string, days?:number, holds?:string[]}} alert
 * @returns {string}
 */
export function describeShipmentAlert(alert) {
  const count = alert.days ?? 0;
  switch (alert.code) {
    case 'overdue':
      return tn(
        count,
        '{clock} ended {count} day ago — charges are running',
        '{clock} ended {count} days ago — charges are running',
        { clock: clockName(alert.clock), count },
      );
    case 'last-day':
      return t('{clock}: today is the last free day', {
        clock: clockName(alert.clock),
      });
    case 'due-soon':
      return tn(
        count,
        '{clock}: {count} free day left',
        '{clock}: {count} free days left',
        {
          clock: clockName(alert.clock),
          count,
        },
      );
    case 'hold':
      return t('On hold: {holds}', {
        holds: (alert.holds ?? [])
          .map((kind) => t(HOLD_LABELS[kind]))
          .join(', '),
      });
    case 'truck-late':
      return tn(
        count,
        'The truck is booked {count} day after the ramp last free day',
        'The truck is booked {count} days after the ramp last free day',
        { count },
      );
    case 'book-truck':
      return count > 0
        ? tn(
            count,
            'Reaches the ramp in {count} day — book a truck',
            'Reaches the ramp in {count} days — book a truck',
            { count },
          )
        : t('At the ramp or due today — book a truck');
    case 'rail-eta-passed':
      return tn(
        count,
        'Rail ETA passed {count} day ago — check with the ramp',
        'Rail ETA passed {count} days ago — check with the ramp',
        { count },
      );
    case 'eta-passed':
      return tn(
        count,
        'Ship ETA passed {count} day ago — check whether it is unloaded',
        'Ship ETA passed {count} days ago — check whether it is unloaded',
        { count },
      );
    case 'ship-late':
      return tn(
        count,
        'The ship reports arriving {count} day later than planned',
        'The ship reports arriving {count} days later than planned',
        { count },
      );
    default:
      return '';
  }
}

/**
 * "At sea · Montreal Oct 24 (in 3 days)" for lists and globe cards.
 * @param {object} shipment Normalized shipment.
 * @param {string} today Local `YYYY-MM-DD`.
 */
export function describeShipmentStatus(shipment, today) {
  const { stage, next } = shipmentSummary(shipment, today);
  const stageText = t(STAGE_LABELS[stage]);
  if (!next) return stageText;
  const when = `${displayDay(next.day)} (${relativeDays(next.days)})`;
  if (next.kind === 'port-eta')
    return t('{stage} · {place} ETA {when}', {
      stage: stageText,
      place: shipment.port,
      when,
    });
  if (next.kind === 'ramp-eta')
    return t('{stage} · {place} ETA {when}', {
      stage: stageText,
      place: shipment.ramp,
      when,
    });
  return t('{stage} · {clock} ends {when}', {
    stage: stageText,
    clock: clockName(next.kind.slice('clock:'.length)),
    when,
  });
}

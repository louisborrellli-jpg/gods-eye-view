/**
 * Containers for the phone remote: the shared shipments list, cut down to
 * what fits a phone row — where the box is, when it loaded, when it gets in,
 * and its last free day. Pure; the remote server fetches the list from the
 * app over loopback and hands it here.
 */
import { CARRIERS } from '../../src/layers/shipments/containers.js';
import {
  CLOCK_LABELS,
  STAGE_LABELS,
  localDay,
  normalizeDefaults,
  normalizeShipment,
  rampEtaFor,
  shipmentAlerts,
  shipmentClocks,
  shipmentStage,
} from '../../src/layers/shipments/model.js';

const SHIPMENT_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A shipment id from the phone, or null. */
export function parseShipmentId(value) {
  return typeof value === 'string' && SHIPMENT_ID.test(value) ? value : null;
}

/** The clock that matters most: a running one, else the projected one. */
function nearestClock(shipment, today, defaults) {
  const open = shipmentClocks(shipment, today, defaults).filter(
    (clock) => !clock.closed,
  );
  const running = open
    .filter((clock) => !clock.pending)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  return running[0] ?? open.find((clock) => clock.pending) ?? null;
}

/**
 * @param {{shipments?: Array<object>, defaults?: object}} snapshot The
 *   app's /api/shipments/store answer.
 * @param {number} nowMs
 * @returns {Array<object>} Most urgent first, finished boxes last.
 */
export function summarizeShipments(snapshot, nowMs = Date.now()) {
  const today = localDay(nowMs);
  const defaults = normalizeDefaults(snapshot?.defaults ?? {});
  const rows = [];
  for (const record of Array.isArray(snapshot?.shipments)
    ? snapshot.shipments
    : []) {
    const shipment = normalizeShipment(record);
    if (!shipment.id || !shipment.container) continue;
    const stage = shipmentStage(shipment);
    const auto = shipment.auto ?? {};
    const alert = shipmentAlerts(shipment, today, defaults)[0] ?? null;
    const clock = nearestClock(shipment, today, defaults);
    const ramp = rampEtaFor(shipment, defaults);
    rows.push({
      id: shipment.id,
      container: shipment.container,
      reference: shipment.reference || '',
      carrier: CARRIERS[shipment.carrier]?.name || '',
      stage,
      stageLabel: STAGE_LABELS[stage] ?? stage,
      route: [auto.pol?.port, auto.pod?.port, auto.destination?.port]
        .filter(Boolean)
        .join(' → '),
      ship: shipment.lastSeen?.name || auto.vessel?.name || '',
      loaded: auto.dates?.loaded || '',
      portEta: shipment.dates.discharged ? '' : shipment.dates.portEta || '',
      rampEta: shipment.dates.rampArrived
        ? null
        : ramp.day
          ? { day: ramp.day, estimated: Boolean(ramp.estimated) }
          : null,
      lastFreeDay: clock
        ? {
            label: CLOCK_LABELS[clock.id] ?? clock.id,
            day: clock.day || '',
            daysLeft: clock.pending ? null : clock.daysLeft,
            estimated: Boolean(clock.pending || clock.estimated),
          }
        : null,
      severity: alert?.severity ?? 0,
      onHold: Object.values(shipment.holds ?? {}).some(Boolean),
    });
  }
  const rank = (row) => [
    row.stage === 'done' ? 1 : 0,
    -row.severity,
    row.lastFreeDay?.daysLeft ?? 999,
  ];
  return rows.sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
    return a.container < b.container ? -1 : 1;
  });
}

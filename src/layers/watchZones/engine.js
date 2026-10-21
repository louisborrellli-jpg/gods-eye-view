/**
 * Match feed events against watch zones and decide what is new.
 *
 * Pure apart from the injected zone store. The first time a zone sees a feed,
 * what is already inside is recorded as background (no FLASH): a quake from
 * this morning is not news to a zone drawn this afternoon. After that, every
 * unseen event inside the zone is an alert. Fire detections arrive in
 * hundreds per blaze, so they are grouped into one alert per zone per check.
 * @module layers/watchZones/engine
 */
import { distanceInsideZone } from './zones.js';

/**
 * @param {object} input
 * @param {Array<object>} input.zones Zones from the store.
 * @param {string} input.kind Feed kind just fetched.
 * @param {Array<object>} input.events That feed's events.
 * @param {object} input.store Zone store (hasSeen/markSeen).
 * @param {Set<string>} input.primed `${zoneId}|${kind}` pairs already seeded.
 * @returns {{alerts: Array<object>, background: Array<object>}}
 */
export function evaluateFeed({ zones, kind, events, store, primed }) {
  const alerts = [];
  const background = [];
  for (const zone of zones) {
    if (!zone.kinds?.[kind]) continue;
    const key = `${zone.id}|${kind}`;
    const seeding = !primed.has(key);
    const fresh = [];
    for (const event of events) {
      if (kind === 'quake' && !(event.mag >= zone.minMag)) continue;
      const km = distanceInsideZone(zone, event);
      if (km === null || store.hasSeen(zone.id, event.id)) continue;
      store.markSeen(zone.id, event.id);
      fresh.push({ ...event, distanceKm: km });
    }
    primed.add(key);
    if (!fresh.length) continue;
    const target = seeding ? background : alerts;
    if (kind === 'fire') {
      // Lead with the most intense detection; carry the count.
      fresh.sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0));
      target.push({
        zoneId: zone.id,
        zoneName: zone.name,
        kind,
        event: fresh[0],
        count: fresh.length,
      });
    } else {
      for (const event of fresh)
        target.push({
          zoneId: zone.id,
          zoneName: zone.name,
          kind,
          event,
          count: 1,
        });
    }
  }
  return { alerts, background };
}

/** Severity for ordering and styling: 3 = flash, 2 = priority, 1 = routine. */
export function alertSeverity(alert) {
  const event = alert?.event || {};
  if (alert?.kind === 'emergency')
    return event.squawk === '7500' || event.squawk === '7700' ? 3 : 2;
  if (alert?.kind === 'quake')
    return event.mag >= 6 ? 3 : event.mag >= 4.5 ? 2 : 1;
  if (alert?.kind === 'fire') return alert.count >= 25 ? 2 : 1;
  return 1;
}

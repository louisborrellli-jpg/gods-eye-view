/**
 * Automatic tracking refreshes, shared by the Shipments layer and the
 * Shipments page so both ask for milestones the same way and at the same
 * pace. No DOM and no i18n: notes are English for the UI to translate.
 */
import { msg } from '../../i18n/marker.js';
import { shipmentStage } from './model.js';
import { TRACKING_VERSION } from './tracking.js';

/**
 * How often each container's milestones are refreshed. FindTEU updates its
 * data every 6 to 48 hours and the server caches each answer for 3.
 */
export const TRACK_INTERVAL_MS = 3 * 60 * 60_000;
export const TRACKING_KEY_NOTE = msg(
  'Automatic tracking needs a FindTEU key — add it under ADD KEYS',
);
export const TRACKING_UNAVAILABLE = msg('Automatic tracking unavailable');

/**
 * @param {{store: object, source: {trackContainer: Function},
 *   now?: () => number}} options
 */
export function createShipmentTracker({
  store,
  source,
  now = () => Date.now(),
}) {
  /** @type {Map<string, {text:string, reason:string|null}>} */
  const notes = new Map();
  const lastTry = new Map();
  let keyMissing = false;
  let running = null;

  function due(shipment, force) {
    if (shipmentStage(shipment) === 'done') return false;
    // Read by an older parser: fetch once more for the fields it missed
    // (the loading date), even for a box the line calls finished.
    const outdated =
      Boolean(shipment.auto) && (shipment.auto.version ?? 0) < TRACKING_VERSION;
    if (outdated && !lastTry.has(shipment.id)) return true;
    if (shipment.auto?.completed && !outdated) return false;
    const last = Math.max(
      lastTry.get(shipment.id) ?? 0,
      shipment.auto?.fetchedAt ?? 0,
    );
    return force || now() - last >= TRACK_INTERVAL_MS;
  }

  async function trackOne(shipment, signal) {
    lastTry.set(shipment.id, now());
    const result = await source.trackContainer(shipment.container, {
      carrier: shipment.carrier,
      signal,
    });
    if (!result.configured) {
      keyMissing = true;
      return false;
    }
    keyMissing = false;
    if (!result.tracking) {
      notes.set(shipment.id, {
        text: TRACKING_UNAVAILABLE,
        reason: result.error,
      });
      return true;
    }
    notes.delete(shipment.id);
    store.setAuto(shipment.id, result.tracking);
    return true;
  }

  return {
    /** True when the server has no FindTEU key. */
    get keyMissing() {
      return keyMissing;
    },
    get busy() {
      return Boolean(running);
    },
    /** Why a container's tracking failed: {text (English), reason}. */
    note: (id) => notes.get(String(id)) ?? null,
    forget(id) {
      notes.delete(String(id));
      lastTry.delete(String(id));
    },
    /**
     * Refresh every due container (or only `onlyId`), one at a time.
     * Resolves once done; a second call while running joins the first.
     */
    refresh({ force = false, onlyId = null, signal } = {}) {
      if (running) return running;
      running = (async () => {
        for (const shipment of store.list()) {
          if (onlyId && shipment.id !== onlyId) continue;
          if (!due(shipment, force)) continue;
          if (keyMissing && !force) break;
          try {
            if (!(await trackOne(shipment, signal))) break;
          } catch {
            if (signal?.aborted) return;
            notes.set(shipment.id, {
              text: TRACKING_UNAVAILABLE,
              reason: null,
            });
          }
        }
      })().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

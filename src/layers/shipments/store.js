/**
 * The operator's shipments, kept in this browser's storage only. They never
 * enter share links. To track them, this app's own server receives the
 * container number (passed on to FindTEU and Terminal49) and the ship's
 * name or number (answered from its live AIS cache); nothing else leaves.
 */
import {
  MAX_SHIPMENTS,
  normalizeDefaults,
  normalizeShipment,
} from './model.js';

export const SHIPMENTS_STORAGE_KEY = 'gev.shipments.v1';
export const SHIPMENTS_NOTIFIED_KEY = 'gev.shipments.notified.v1';
export const SHIPMENTS_DEFAULTS_KEY = 'gev.shipments.defaults.v1';
/** The Shipments page leaves a container id here for the map to fly to. */
export const SHIPMENTS_FOCUS_KEY = 'gev.shipments.focus';
const MAX_NOTIFIED = 400;

function read(storage, key, fallback) {
  try {
    const raw = storage?.getItem?.(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{storage?: Storage|null, now?: () => number,
 *   makeId?: () => string}} options
 */
export function createShipmentStore({
  storage = null,
  now = () => Date.now(),
  makeId = () =>
    `s${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
} = {}) {
  const loaded = read(storage, SHIPMENTS_STORAGE_KEY, []);
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const entry of Array.isArray(loaded) ? loaded : []) {
    const shipment = normalizeShipment(entry);
    if (shipment.id && shipment.container && !byId.has(shipment.id))
      byId.set(shipment.id, shipment);
    if (byId.size >= MAX_SHIPMENTS) break;
  }
  const loadedNotified = read(storage, SHIPMENTS_NOTIFIED_KEY, []);
  let notified = new Set(
    Array.isArray(loadedNotified)
      ? loadedNotified.filter((key) => typeof key === 'string')
      : [],
  );
  let saveError = false;
  let defaults = normalizeDefaults(read(storage, SHIPMENTS_DEFAULTS_KEY, {}));

  // `dates` is derived from `manual` and `auto`, so it is not stored.
  const persist = () => {
    saveError = !write(
      storage,
      SHIPMENTS_STORAGE_KEY,
      [...byId.values()].map(({ dates, ...stored }) => stored),
    );
    return !saveError;
  };
  // Shipments leave the store carrying the board defaults, so every reader
  // of the model counts free days the same way.
  const withDefaults = (shipment) =>
    shipment ? { ...shipment, defaults } : null;

  return {
    get size() {
      return byId.size;
    },
    /** True when the last write failed (storage full or blocked). */
    get saveError() {
      return saveError;
    },
    /** Shipments in the order they were added. */
    list() {
      return [...byId.values()].map(withDefaults);
    },
    get(id) {
      return withDefaults(byId.get(String(id)) ?? null);
    },
    /** Board-wide free days and rail transit, set once. */
    get defaults() {
      return defaults;
    },
    setDefaults(value) {
      defaults = normalizeDefaults({ ...defaults, ...value });
      saveError = !write(storage, SHIPMENTS_DEFAULTS_KEY, defaults);
      return defaults;
    },
    /** Store what automatic tracking reported; a new ship forgets the old. */
    setAuto(id, auto) {
      const shipment = byId.get(String(id));
      if (!shipment) return null;
      const oldShip = shipment.auto?.vessel?.imo || shipment.auto?.vessel?.name;
      const newShip = auto?.vessel?.imo || auto?.vessel?.name;
      const followsAuto = !shipment.vessel.query;
      const next = normalizeShipment({
        ...shipment,
        auto,
        lastSeen:
          followsAuto && oldShip && newShip && oldShip !== newShip
            ? null
            : shipment.lastSeen,
      });
      byId.set(next.id, next);
      persist();
      return withDefaults(next);
    },
    /**
     * Add (no id) or replace (known id) a shipment. Returns the stored
     * record, or null when the list is full or the container is missing.
     */
    save(input) {
      const existing = input?.id ? byId.get(String(input.id)) : null;
      if (!existing && byId.size >= MAX_SHIPMENTS) return null;
      // Editing other fields keeps the ship already found; naming a
      // different ship forgets the old one and where it was last seen.
      const sameShip = Boolean(existing) && sameVessel(existing, input);
      const shipment = normalizeShipment({
        ...input,
        manual: input?.manual ?? input?.dates ?? existing?.manual,
        auto: input?.auto ?? existing?.auto ?? null,
        id: existing?.id ?? makeId(),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        vessel: sameShip
          ? {
              ...existing.vessel,
              query: input?.vessel?.query ?? existing.vessel.query,
            }
          : input?.vessel,
        lastSeen: sameShip
          ? (input?.lastSeen ?? existing.lastSeen)
          : (input?.lastSeen ?? null),
      });
      if (!shipment.container) return null;
      byId.set(shipment.id, shipment);
      persist();
      return withDefaults(shipment);
    },
    remove(id) {
      const removed = byId.delete(String(id));
      if (removed) persist();
      return removed;
    },
    /** Remember a ship position (and the ids it resolved to). */
    setLastSeen(id, lastSeen) {
      const shipment = byId.get(String(id));
      if (!shipment) return null;
      const next = normalizeShipment({
        ...shipment,
        lastSeen,
        vessel: shipment.vessel.query
          ? {
              ...shipment.vessel,
              mmsi: shipment.vessel.mmsi || lastSeen?.mmsi,
              imo: shipment.vessel.imo || lastSeen?.imo,
            }
          : shipment.vessel,
      });
      byId.set(next.id, next);
      persist();
      return withDefaults(next);
    },
    /** Replace every shipment (import). Returns how many were kept. */
    replaceAll(entries) {
      byId.clear();
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (byId.size >= MAX_SHIPMENTS) break;
        const shipment = normalizeShipment({
          ...entry,
          id: entry?.id && !byId.has(String(entry.id)) ? entry.id : makeId(),
        });
        if (shipment.container) byId.set(shipment.id, shipment);
      }
      persist();
      return byId.size;
    },
    /** Alert keys already announced, so each is raised once. */
    hasNotified(key) {
      return notified.has(key);
    },
    markNotified(key) {
      notified.add(key);
      if (notified.size > MAX_NOTIFIED)
        notified = new Set([...notified].slice(-MAX_NOTIFIED));
      write(storage, SHIPMENTS_NOTIFIED_KEY, [...notified]);
    },
  };
}

function shipKey(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sameVessel(existing, input) {
  return shipKey(existing.vessel?.query) === shipKey(input?.vessel?.query);
}

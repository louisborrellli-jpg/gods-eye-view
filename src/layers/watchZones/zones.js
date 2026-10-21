/**
 * Watch zones: circles on the globe the operator wants watched, and the
 * memory of which events each zone has already reported.
 *
 * Pure: no DOM, no Cesium. Zones live in this browser's storage only and
 * never enter share links or layer state.
 * @module layers/watchZones/zones
 */

export const ZONES_STORAGE_KEY = 'gev.watchZones.v1';
export const SEEN_STORAGE_KEY = 'gev.watchZones.seen.v1';
export const MAX_ZONES = 24;
export const MAX_NAME_LENGTH = 32;
/** Radius presets the zone's radius chip cycles through, in km. */
export const RADIUS_STEPS_KM = Object.freeze([10, 50, 200, 500]);
export const DEFAULT_RADIUS_KM = 50;
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 2000;
/** How long an event id is remembered so it never alerts twice. */
export const SEEN_TTL_MS = 3 * 24 * 3600_000;
const MAX_SEEN = 5000;

/** Event families a zone can watch, in display order. */
export const WATCH_KINDS = Object.freeze(['quake', 'fire', 'emergency']);

// Operation-style codenames for new zones. Plain words, not film titles.
const CODENAMES = Object.freeze([
  'ONYX',
  'VIPER',
  'KESTREL',
  'CITADEL',
  'NIGHTJAR',
  'OBSIDIAN',
  'TEMPEST',
  'HALCYON',
  'SABLE',
  'CORSAIR',
  'MERIDIAN',
  'FALCON',
  'GRANITE',
  'MISTRAL',
  'LODESTAR',
  'BASILISK',
]);

/**
 * Next unused codename, falling back to a numbered one when all are taken.
 * @param {Iterable<string>} taken Existing zone names.
 * @returns {string}
 */
export function nextCodename(taken) {
  const used = new Set([...taken].map((name) => String(name).toUpperCase()));
  for (const name of CODENAMES) if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${CODENAMES[0]}-${n}`)) n++;
  return `${CODENAMES[0]}-${n}`;
}

/** Great-circle distance in km. */
export function kmBetween(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from the zone centre in km when the point is inside, else null. */
export function distanceInsideZone(zone, point) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) return null;
  const km = kmBetween(zone, point);
  return km <= zone.radiusKm ? km : null;
}

/** The radius after `current` in RADIUS_STEPS_KM, wrapping around. */
export function nextRadiusKm(current) {
  const index = RADIUS_STEPS_KM.findIndex((step) => step > current);
  return RADIUS_STEPS_KM[index === -1 ? 0 : index];
}

export function normalizeZoneName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

function normalizeZone(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const name = normalizeZoneName(raw?.name);
  if (raw?.lat == null || raw?.lon == null) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const radiusKm = Number(raw?.radiusKm);
  if (!/^[a-z0-9-]{1,64}$/i.test(id) || !name) return null;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  if (
    !Number.isFinite(radiusKm) ||
    radiusKm < MIN_RADIUS_KM ||
    radiusKm > MAX_RADIUS_KM
  )
    return null;
  const kinds = WATCH_KINDS.filter((kind) => raw?.kinds?.[kind] !== false);
  const minMag = Number(raw?.minMag);
  return {
    id,
    name,
    lat,
    lon,
    radiusKm,
    kinds: Object.fromEntries(
      WATCH_KINDS.map((kind) => [kind, kinds.includes(kind)]),
    ),
    minMag: Number.isFinite(minMag) ? Math.min(9, Math.max(0, minMag)) : 2.5,
    createdAt: Number(raw?.createdAt) || null,
  };
}

/** Parse stored zones; a damaged row is dropped without losing the others. */
export function parseZones(text) {
  let payload;
  try {
    payload = JSON.parse(String(text || ''));
  } catch {
    return [];
  }
  const zones = [];
  const ids = new Set();
  for (const row of Array.isArray(payload?.zones) ? payload.zones : []) {
    const zone = normalizeZone(row);
    if (!zone || ids.has(zone.id)) continue;
    ids.add(zone.id);
    zones.push(zone);
    if (zones.length >= MAX_ZONES) break;
  }
  return zones;
}

function defaultId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `zone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function readStorage(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Own the zone list and the seen-event memory over injected storage.
 * @param {object} [options]
 * @param {Storage|null} [options.storage]
 * @param {() => number} [options.now]
 * @param {() => string} [options.createId]
 */
export function createZoneStore({
  storage = null,
  now = () => Date.now(),
  createId = defaultId,
} = {}) {
  let zones = parseZones(readStorage(storage, ZONES_STORAGE_KEY));
  /** @type {Map<string, number>} `${zoneId}|${eventId}` → first seen ms */
  const seen = new Map();
  try {
    const stored = JSON.parse(readStorage(storage, SEEN_STORAGE_KEY) || '{}');
    for (const [key, at] of Object.entries(stored?.seen || {}))
      if (Number.isFinite(at) && now() - at < SEEN_TTL_MS) seen.set(key, at);
  } catch {
    /* start with an empty memory */
  }

  const saveZones = () =>
    writeStorage(
      storage,
      ZONES_STORAGE_KEY,
      JSON.stringify({ version: 1, zones }),
    );
  const find = (id) => zones.find((zone) => zone.id === id) || null;
  const update = (id, patch) => {
    if (!find(id)) return null;
    zones = zones.map((zone) =>
      zone.id === id ? normalizeZone({ ...zone, ...patch }) || zone : zone,
    );
    saveZones();
    return { ...find(id) };
  };

  return {
    list: () => zones.map((zone) => ({ ...zone, kinds: { ...zone.kinds } })),
    get: (id) => {
      const zone = find(id);
      return zone ? { ...zone, kinds: { ...zone.kinds } } : null;
    },
    get size() {
      return zones.length;
    },

    /** Add a zone at a point; returns it, or null when invalid or full. */
    add({ lat, lon, name, radiusKm = DEFAULT_RADIUS_KM }) {
      if (zones.length >= MAX_ZONES) return null;
      const zone = normalizeZone({
        id: createId(),
        name: normalizeZoneName(name) || nextCodename(zones.map((z) => z.name)),
        lat,
        lon,
        radiusKm,
        createdAt: now(),
      });
      if (!zone || find(zone.id)) return null;
      zones = [...zones, zone];
      saveZones();
      return { ...zone, kinds: { ...zone.kinds } };
    },

    rename: (id, name) =>
      normalizeZoneName(name) ? update(id, { name }) : null,
    setRadius: (id, radiusKm) => update(id, { radiusKm }),
    setKind: (id, kind, on) => {
      const zone = find(id);
      if (!zone || !WATCH_KINDS.includes(kind)) return null;
      return update(id, { kinds: { ...zone.kinds, [kind]: Boolean(on) } });
    },

    remove(id) {
      if (!find(id)) return false;
      zones = zones.filter((zone) => zone.id !== id);
      for (const key of [...seen.keys()])
        if (key.startsWith(`${id}|`)) seen.delete(key);
      saveZones();
      this.saveSeen();
      return true;
    },

    hasSeen: (zoneId, eventId) => seen.has(`${zoneId}|${eventId}`),
    markSeen(zoneId, eventId) {
      seen.set(`${zoneId}|${eventId}`, now());
    },
    /** Persist the seen memory, dropping expired and oldest entries. */
    saveSeen() {
      const cutoff = now() - SEEN_TTL_MS;
      for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
      while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
      writeStorage(
        storage,
        SEEN_STORAGE_KEY,
        JSON.stringify({ seen: Object.fromEntries(seen) }),
      );
    },
  };
}

/**
 * The operator's own list of cars: a nickname and the spot they last left it.
 *
 * Positions are placed by hand on the globe. Nothing here reads a car, a
 * phone or a manufacturer account, so a pin moves only when the operator
 * moves it. The list lives in this browser's storage and never enters share
 * links or layer state. Pure: no DOM, no Cesium.
 * @module layers/myCars/garage
 */

export const GARAGE_STORAGE_KEY = 'gev.myCars.v1';
export const MAX_CARS = 50;
export const MAX_NAME_LENGTH = 40;

/**
 * Trim and bound a nickname; collapse runs of whitespace.
 * @param {unknown} value
 * @returns {string} '' when nothing usable remains.
 */
export function normalizeCarName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/**
 * A finite, in-range ground point, or null.
 * @param {unknown} point
 * @returns {{lat: number, lon: number}|null}
 */
export function normalizeCarPoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function normalizeCar(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const name = normalizeCarName(raw?.name);
  const point = normalizeCarPoint(raw);
  const placedAt = Number(raw?.placedAt);
  if (!/^[a-z0-9-]{1,64}$/i.test(id) || !name || !point) return null;
  return {
    id,
    name,
    ...point,
    placedAt: Number.isFinite(placedAt) && placedAt > 0 ? placedAt : null,
  };
}

/**
 * Parse stored JSON into a clean list. Bad rows are dropped one by one, so a
 * single damaged entry never loses the rest of the garage.
 * @param {string|null|undefined} text
 * @returns {Array<{id: string, name: string, lat: number, lon: number, placedAt: number|null}>}
 */
export function parseGarage(text) {
  if (typeof text !== 'string' || !text) return [];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(payload?.cars) ? payload.cars : [];
  const seen = new Set();
  const cars = [];
  for (const row of rows) {
    const car = normalizeCar(row);
    if (!car || seen.has(car.id)) continue;
    seen.add(car.id);
    cars.push(car);
    if (cars.length >= MAX_CARS) break;
  }
  return cars;
}

/** @returns {string} JSON for storage. */
export function serializeGarage(cars) {
  return JSON.stringify({ version: 1, cars });
}

function defaultId() {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `car-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Own the garage list over an injected storage (localStorage in the app).
 * Storage failures (private mode, quota) keep the list working for this page.
 * @param {object} [options]
 * @param {Storage|null} [options.storage]
 * @param {() => number} [options.now]
 * @param {() => string} [options.createId]
 */
export function createGarage({
  storage = null,
  now = () => Date.now(),
  createId = defaultId,
} = {}) {
  let cars = [];
  try {
    cars = parseGarage(storage?.getItem?.(GARAGE_STORAGE_KEY));
  } catch {
    cars = [];
  }

  function save() {
    try {
      storage?.setItem?.(GARAGE_STORAGE_KEY, serializeGarage(cars));
      return true;
    } catch {
      return false;
    }
  }

  const find = (id) => cars.find((car) => car.id === id) || null;

  return {
    /** @returns {Array<object>} A copy, in the order cars were added. */
    list() {
      return cars.map((car) => ({ ...car }));
    },

    get(id) {
      const car = find(id);
      return car ? { ...car } : null;
    },

    get size() {
      return cars.length;
    },

    /**
     * Add a car at a point.
     * @returns {object|null} The new car, or null for a bad name/point or a full garage.
     */
    add(name, point) {
      const clean = normalizeCarName(name);
      const at = normalizeCarPoint(point);
      if (!clean || !at || cars.length >= MAX_CARS) return null;
      let id = createId();
      while (find(id)) id = `${id}-x`;
      const car = { id, name: clean, ...at, placedAt: now() };
      cars = [...cars, car];
      save();
      return { ...car };
    },

    /** Move a car to a new point; stamps the time it was placed. */
    move(id, point) {
      const at = normalizeCarPoint(point);
      if (!at || !find(id)) return null;
      cars = cars.map((car) =>
        car.id === id ? { ...car, ...at, placedAt: now() } : car,
      );
      save();
      return { ...find(id) };
    },

    rename(id, name) {
      const clean = normalizeCarName(name);
      if (!clean || !find(id)) return null;
      cars = cars.map((car) => (car.id === id ? { ...car, name: clean } : car));
      save();
      return { ...find(id) };
    },

    remove(id) {
      if (!find(id)) return false;
      cars = cars.filter((car) => car.id !== id);
      save();
      return true;
    },
  };
}

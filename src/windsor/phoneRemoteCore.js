/**
 * Pure helpers for the phone remote: camera nudges and the local camera
 * order. No browser or Cesium imports, so they unit-test in Node.
 */

const M_PER_DEG = 111_320;
const MIN_ALT = 120;
const MAX_ALT = 400_000;
const MIN_PITCH = -89;
const MAX_PITCH = -12;

export const WINDSOR_CENTER = Object.freeze({ lat: 42.3, lon: -83.03 });
/** Cameras within this distance of downtown Windsor count as local. */
export const LOCAL_RADIUS_KM = 30;

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (h) => ((h % 360) + 360) % 360;

/** Move a lat/lon `meters` along compass `headingDeg` (flat-earth, fine for a city). */
export function offset(lat, lon, headingDeg, meters) {
  const h = rad(headingDeg);
  return {
    lat: lat + (meters * Math.cos(h)) / M_PER_DEG,
    lon: lon + (meters * Math.sin(h)) / (M_PER_DEG * Math.cos(rad(lat))),
  };
}

/** Great-circle-ish distance in km (equirectangular; plenty for sorting). */
export function distanceKm(a, b) {
  const x = rad(b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2));
  const y = rad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * 6371;
}

/**
 * The ground point the camera looks at, and the slant range to it. Pitch is
 * clamped so a near-horizontal view still has a sensible centre.
 */
export function viewCentre(view) {
  const pitch = clamp(view.pitch ?? -35, MIN_PITCH, MAX_PITCH);
  const alt = Math.max(view.alt, MIN_ALT);
  const range = alt / Math.sin(rad(-pitch));
  const ground = range * Math.cos(rad(-pitch));
  return { ...offset(view.lat, view.lon, view.heading ?? 0, ground), range };
}

/** Place the camera `range` metres from `centre` at `heading`/`pitch`. */
function cameraAround(centre, heading, pitch, range) {
  const p = clamp(pitch, MIN_PITCH, MAX_PITCH);
  const alt = clamp(range * Math.sin(rad(-p)), MIN_ALT, MAX_ALT);
  const ground = alt / Math.tan(rad(-p));
  return {
    ...offset(centre.lat, centre.lon, heading + 180, ground),
    alt,
    heading: wrap(heading),
    pitch: p,
  };
}

/**
 * The next camera state for a remote nudge. Turning and tilting pivot around
 * the point you're looking at; zoom moves along the line of sight; moves
 * slide the view relative to where it faces.
 */
export function nudgeView(view, cmd, arg) {
  if (!view) return null;
  const heading = view.heading ?? 0;
  const pitch = clamp(view.pitch ?? -35, MIN_PITCH, MAX_PITCH);
  const alt = clamp(view.alt, MIN_ALT, MAX_ALT);
  const centre = viewCentre({ ...view, alt, pitch });

  if (cmd === 'move') {
    const turn = { forward: 0, back: 180, left: -90, right: 90 }[arg];
    if (turn === undefined) return null;
    const step = Math.max(alt, 300) * 0.6;
    return {
      ...offset(view.lat, view.lon, heading + turn, step),
      alt,
      heading,
      pitch,
    };
  }
  if (cmd === 'zoom') {
    const factor = arg === 'in' ? 0.55 : arg === 'out' ? 1 / 0.55 : null;
    if (!factor) return null;
    return cameraAround(centre, heading, pitch, centre.range * factor);
  }
  if (cmd === 'turn') {
    const delta = arg === 'left' ? -30 : arg === 'right' ? 30 : null;
    if (delta === null) return null;
    return cameraAround(centre, heading + delta, pitch, centre.range);
  }
  if (cmd === 'tilt') {
    // "Up" raises the view toward the horizon.
    const delta = arg === 'up' ? 12 : arg === 'down' ? -12 : null;
    if (delta === null) return null;
    return cameraAround(centre, heading, pitch + delta, centre.range);
  }
  return null;
}

/** Local camera ids, nearest downtown Windsor first. */
export function localCameraOrder(
  cameras,
  centre = WINDSOR_CENTER,
  radiusKm = LOCAL_RADIUS_KM,
) {
  return (cameras ?? [])
    .filter((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lon))
    .map((c) => ({ id: c.id, d: distanceKm(centre, c) }))
    .filter((c) => c.d <= radiusKm)
    .sort((a, b) => a.d - b.d)
    .map((c) => c.id);
}

/** Step through the order from the current camera (wraps around). */
export function stepCamera(order, currentId, step) {
  if (!order?.length) return null;
  const at = order.indexOf(currentId);
  if (at === -1) return step >= 0 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}

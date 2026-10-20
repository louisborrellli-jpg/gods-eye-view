import { greatCircleKm } from '../../geoDistance.js';

/**
 * Which camera a freshly enabled CCTV layer should show.
 *
 * The catalog is ordered by source pack, not by where the operator is, so
 * taking the first record hands everyone the first camera of the first pack —
 * Austin, for anyone who has not changed `CCTV_AUSTIN_*`. Someone looking at
 * Windsor switching cameras on should get a camera in Windsor.
 *
 * Nearest is measured from the viewer, not from a configured home city: the
 * operator's current view is the only thing that knows where they are. When
 * the globe genuinely has no camera nearby, the nearest one worldwide is still
 * the best available answer, and the panel names where it is.
 *
 * @param {Array<{camera?: {id?: string, lat?: number, lon?: number}}>} records
 *   Camera runtime records, in catalog order.
 * @param {{lat: number, lon: number}|null} [viewpoint] Viewer position in
 *   degrees. Null or incomplete falls back to catalog order.
 * @returns {string|null} Camera id, or null when there are no usable records.
 */
export function defaultCameraId(records, viewpoint = null) {
  if (!Array.isArray(records) || records.length === 0) return null;

  const firstId = firstUsableId(records);
  const lat = viewpoint?.lat;
  const lon = viewpoint?.lon;
  // No viewer yet (init before the camera settles) leaves catalog order, which
  // is at least deterministic, rather than ranking against a bogus origin.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return firstId;

  const from = { lat, lon };
  let bestId = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const camera = record?.camera;
    if (!camera?.id) continue;
    if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lon)) continue;
    const km = greatCircleKm(from, { lat: camera.lat, lon: camera.lon });
    // Strictly closer, so an exact tie keeps the earlier catalog entry and the
    // same catalog yields the same camera every time.
    if (km < bestKm) {
      bestKm = km;
      bestId = camera.id;
    }
  }
  return bestId ?? firstId;
}

/** First record carrying an id, ignoring malformed entries. */
function firstUsableId(records) {
  for (const record of records) {
    const id = record?.camera?.id;
    if (id) return id;
  }
  return null;
}

/**
 * Viewer position in degrees from a Cesium `positionCartographic`, which is in
 * radians.
 * @param {{latitude?: number, longitude?: number}|null|undefined} carto
 * @returns {{lat: number, lon: number}|null}
 */
export function viewpointFromCartographic(carto) {
  const latitude = carto?.latitude;
  const longitude = carto?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    lat: (latitude * 180) / Math.PI,
    lon: (longitude * 180) / Math.PI,
  };
}

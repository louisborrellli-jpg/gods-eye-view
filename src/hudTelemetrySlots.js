import { layerSnapshots } from './data/layerSnapshot.js';

/**
 * Real values for the HUD slots that used to carry invented sensor metadata.
 *
 * The HUD's corner readouts sit in one visual register, so a fabricated
 * mission number reads exactly like the GSD and MGRS values beside it, which
 * are genuine camera math. Every slot here resolves from something the app can
 * actually observe — the active imagery stack, the globe's projection, and the
 * freshness of the enabled feeds — so the whole frame can be trusted at a
 * glance. A slot with nothing to report says so rather than inventing filler.
 *
 * These are technical readouts in the HUD's fixed ASCII register (the same
 * reason the imagery product names in src/maps/catalog.js carry i18n-ignore),
 * so they are not translated.
 */

/**
 * The banner. The project's whole premise is that this view is assembled from
 * public feeds, so the honest marking is also the more interesting one.
 */
export const HUD_PROVENANCE_BANNER =
  'OPEN SOURCE // PUBLIC DATA // UNCLASSIFIED';

/**
 * Names the optics the GSD, NIIRS and ONA readouts are computed from. Those
 * numbers describe a synthetic camera flying over real imagery, not an orbital
 * sensor, and the HUD should say which.
 */
export const HUD_OPTICS_LINE = 'OPTICS: SYNTHETIC CAMERA';

const UNKNOWN_IMAGERY = 'UNKNOWN';

/** Fold an imagery product label into the HUD's fixed-width ASCII register. */
export function formatImageryLabel(stack) {
  const label = String(stack?.label ?? stack?.id ?? '').trim();
  if (!label) return UNKNOWN_IMAGERY;
  return label.toUpperCase();
}

/**
 * The right-edge strip: what is actually being drawn and in which frame.
 * @param {{label?: string, id?: string}|null} stack Active map stack.
 * @param {{terrain?: boolean}} [options] Whether terrain relief is applied.
 * @returns {string[]} One short line per row, top to bottom.
 */
export function imageryStripLines(stack, { terrain = false } = {}) {
  return [
    `SRC: ${formatImageryLabel(stack)}`,
    'PROJ: WGS84',
    `TERR: ${terrain ? 'ON' : 'OFF'}`,
  ];
}

/**
 * Freshness of the enabled feeds, for the slot that used to hold a random
 * orbit and pass number.
 *
 * `live` counts only feeds reporting nominal: a stale or degraded feed is
 * exactly what this readout exists to expose, so it must not be counted as
 * live. `oldestAgeSec` is taken across every enabled feed that has ever
 * reported, because the oldest one bounds how current the picture really is.
 *
 * @param {Array<object>} [layers] `DataLayerManager.getAll()` rows.
 * @param {{now?: number}} [options]
 * @returns {{enabled: number, live: number, oldestAgeSec: number|null}}
 */
export function feedFreshness(layers = [], { now = Date.now() } = {}) {
  const snapshots = layerSnapshots(layers, { now }).filter((s) => s.enabled);
  let oldestAgeSec = null;
  let live = 0;
  for (const snapshot of snapshots) {
    if (snapshot.feedState === 'nominal') live += 1;
    const age = snapshot.ageSec;
    if (Number.isFinite(age) && (oldestAgeSec === null || age > oldestAgeSec))
      oldestAgeSec = age;
  }
  return { enabled: snapshots.length, live, oldestAgeSec };
}

/** Render an age in the compact form the HUD corners have room for. */
export function formatAge(ageSec) {
  if (!Number.isFinite(ageSec) || ageSec < 0) return '--';
  if (ageSec < 60) return `${Math.floor(ageSec)}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h`;
}

/**
 * The feed line itself, e.g. `FEEDS: 3/4 LIVE · OLDEST 12s`.
 *
 * With nothing enabled it reports that rather than a zeroed-out reading that
 * could be mistaken for feeds that are enabled and silent.
 *
 * @param {Array<object>} [layers] `DataLayerManager.getAll()` rows.
 * @param {{now?: number}} [options]
 * @returns {string}
 */
export function feedStatusLine(layers = [], options) {
  const { enabled, live, oldestAgeSec } = feedFreshness(layers, options);
  if (!enabled) return 'FEEDS: NONE ENABLED';
  const age =
    oldestAgeSec === null ? '' : ` · OLDEST ${formatAge(oldestAgeSec)}`;
  return `FEEDS: ${live}/${enabled} LIVE${age}`;
}

/**
 * Altitude in the unit a reader can take in at a glance.
 *
 * The camera ranges from street level to a whole-globe standoff, and a raw
 * metre count ("18000000m") stops being legible long before the top of that
 * range. Metres hold until 10 km, which covers every street, cockpit and city
 * view; above that the number becomes kilometres.
 *
 * @param {number} altMslM Height above mean sea level, in metres.
 * @returns {string} e.g. `600m`, `18000km`, or `--` when unknown.
 */
export function formatAltitude(altMslM) {
  if (!Number.isFinite(altMslM)) return '--';
  if (Math.abs(altMslM) < 10_000) return `${Math.round(altMslM)}m`;
  return `${Math.round(altMslM / 1000)}km`;
}

/**
 * NIIRS is defined over roughly 0-9. The GIQE form the HUD uses falls below 0
 * once ground sample distance passes about 31 m, which is most of the camera's
 * range, and clamping that to a printed "0.0" asserts a rating the scale does
 * not actually give. Off-scale reads `--` instead; a rating only appears where
 * one genuinely applies.
 *
 * @param {number} gsdMeters Ground sample distance in metres.
 * @returns {string} A one-decimal rating, or `--` when off-scale.
 */
export function formatNiirs(gsdMeters) {
  if (!Number.isFinite(gsdMeters) || gsdMeters <= 0) return '--';
  const niirs = 10.25 - 3.32 * Math.log10(gsdMeters * 39.37);
  if (niirs < 0) return '--';
  return Math.min(9, niirs).toFixed(1);
}

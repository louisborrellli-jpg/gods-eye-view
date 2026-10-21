import { readResponseJsonCapped } from '../common/http.js';
import { fallbackHeadingFromId, prioritizeSources } from './normalize.js';

/**
 * Michigan DOT "Mi Drive" public traffic cameras (statewide, ~800).
 *
 * The camera list is one keyless JSON call to `/MiDrive/camera/list`; each row
 * is HTML-fragment-encoded, carrying the camera's coordinates and id inside a
 * `county` link and its still-image URL inside an `image` <img>. Frames are
 * stills on the official hosts `micamerasimages.net` (thumbnails redirect to
 * the full-size still on the same host; this loader registers the full-size
 * URL directly) and `mdotjboss.state.mi.us` (RWIS). The frame proxy relays
 * them like any other registered still.
 *
 * Mi Drive is published "for informational purposes only" with no open
 * licence (the same posture as the Caltrans/TxDOT packs this app already
 * ships), so the pack is on by default, attributed "Michigan DOT Mi Drive",
 * and disableable with `CCTV_MDOT_ENABLED=0`. Mi Drive states the cameras are
 * live viewing and not continuously recorded; frames are fetched at request
 * time and never stored or redistributed.
 */
export const MDOT_CAMERA_LIST_URL =
  'https://mdotjboss.state.mi.us/MiDrive/camera/list';
export const MDOT_IMAGE_HOSTS = Object.freeze([
  'micamerasimages.net',
  'mdotjboss.state.mi.us',
]);
export const DEFAULT_MDOT_MAX_SOURCES = 600;
export const MDOT_MAX_CATALOG_BYTES = 6 * 1024 * 1024;
const MDOT_FETCH_TIMEOUT_MS = 20_000;
/** SE-Michigan elevation prior (m); the ground-floor snap corrects per camera. */
const MDOT_GROUND_ELEVATION_M = 180;

/** Prioritization anchors, Detroit first (nearest Windsor), then other metros. */
const ANCHORS = [
  { lat: 42.3314, lon: -83.0458 }, // Detroit
  { lat: 42.2808, lon: -83.743 }, // Ann Arbor
  { lat: 43.0125, lon: -83.6875 }, // Flint
  { lat: 42.7325, lon: -84.5555 }, // Lansing
  { lat: 42.9634, lon: -85.6681 }, // Grand Rapids
  { lat: 42.2917, lon: -85.5872 }, // Kalamazoo
];

const LATLON_RE = /lat=([-\d.]+)&lon=([-\d.]+)&zoom=\d+&id=(\d+)/;
const SRC_RE = /src="([^"]+)"/;

/** Collapse whitespace and trim the HTML-ish location/route text. */
function clean(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pin a Mi Drive image URL to an official host, and prefer the full-size
 * still over the thumbnail (thumbs redirect to it on the same host anyway).
 * @param {string} value Raw `src` from the list row.
 * @returns {string} A canonical https URL on an official host, or '' if not.
 */
export function normalizeMdotImageUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || !MDOT_IMAGE_HOSTS.includes(url.hostname))
    return '';
  if (url.hostname === 'micamerasimages.net') {
    url.pathname = url.pathname
      .replace(/\/thumbs\//, '/')
      .replace(/\.flv\.jpg$/i, '.jpg');
  }
  return url.toString();
}

/** Parse one Mi Drive list row into a camera row, or null when unusable. */
export function parseMdotRow(row) {
  const geo = LATLON_RE.exec(row?.county || '');
  const src = SRC_RE.exec(row?.image || '');
  if (!geo || !src) return null;
  const lat = Number(geo[1]);
  const lon = Number(geo[2]);
  const camId = geo[3];
  const imageUrl = normalizeMdotImageUrl(src[1]);
  if (
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180 ||
    !/^\d+$/.test(camId) ||
    !imageUrl
  )
    return null;
  const route = clean(row?.route);
  const location = clean(row?.location).replace(/^@\s*/, '').trim();
  const county = clean(row?.county)
    .split('<')[0]
    .trim()
    .replace(/\s*County$/i, '');
  const name =
    [route, location].filter(Boolean).join(' ').trim() || `Camera ${camId}`;
  const id = `mdot-${camId}`;
  return {
    id,
    name,
    city: county || 'Michigan',
    cityId: county
      ? county.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      : 'michigan',
    provider: 'Michigan DOT Mi Drive',
    lat,
    lon,
    // Travel direction is published, not camera bearing, so headings use the
    // shared id-hash fallback at low confidence (correctable with the gizmo).
    headingDeg: fallbackHeadingFromId(id),
    headingConfidence: 'low',
    pitchDeg: -14,
    fovDeg: 48,
    rangeM: 160,
    mountHeightM: 9,
    groundElevationM: MDOT_GROUND_ELEVATION_M,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'mdot-midrive',
    license: 'Michigan DOT Mi Drive',
  };
}

/** Fetch and parse the Mi Drive camera list; [] on any failure. */
export async function loadMdotSources({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  try {
    const response = await fetchImpl(MDOT_CAMERA_LIST_URL, {
      signal: AbortSignal.timeout(MDOT_FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-mdot-cctv/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await readResponseJsonCapped(
      response,
      MDOT_MAX_CATALOG_BYTES,
    );
    const rows = Array.isArray(payload) ? payload : [];
    const cameras = [];
    const seen = new Set();
    for (const row of rows) {
      const camera = parseMdotRow(row);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      process.env.CCTV_MDOT_MAX_SOURCES || DEFAULT_MDOT_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(806, Math.floor(maxRaw)))
      : DEFAULT_MDOT_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, ANCHORS);
    console.log(
      `[CCTV] Loaded Michigan DOT Mi Drive sources: ${cameras.length} available (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Mi Drive download error:', error?.message || error);
    return [];
  }
}

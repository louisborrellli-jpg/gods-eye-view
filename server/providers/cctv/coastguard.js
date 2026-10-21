import { fallbackHeadingFromId, prioritizeSources } from './normalize.js';

/**
 * Canadian Coast Guard e-Navigation river cameras on the Detroit River /
 * Lake St. Clair system, around Windsor-Essex.
 *
 * The CCG publishes these still images "as a courtesy"; they are operated for
 * marine navigation, not as an open-data product, and carry no stated re-use
 * licence. So the pack is OPT-IN (`CCTV_COASTGUARD_ENABLED=1`) and attributed
 * to the Canadian Coast Guard (see DATA_SOURCES.md). Each sequence is a single
 * JPEG refreshed about every 30 minutes on one host; the frame proxy relays it
 * like any other registered still, keeping redirects on that host and accepting
 * only image/*.
 *
 * Only cameras whose location can be placed with confidence in or next to
 * Windsor-Essex are listed. The source publishes no coordinates, so each pin
 * below is hand-placed and approximate — the in-app calibration gizmo corrects
 * pose, and headings use the shared id-hash fallback at low confidence. More
 * CCG sequences exist (Hay Point, Stribling Point, Lake St-Clair range marks);
 * they are left out until their exact positions are confirmed rather than
 * guessed onto the map.
 */
export const COASTGUARD_IMAGE_ORIGIN =
  'https://e-nav.ccg-gcc.gc.ca/nvss-svsn/sequences/';
export const DEFAULT_COASTGUARD_MAX_SOURCES = 25;

/** Detroit-River water-surface datum (IGLD): ~174 m above sea level. */
const RIVER_ELEVATION_M = 174;

/**
 * Hand-authored camera list. `camfile` is the sequence basename on the CCG
 * host; `lat`/`lon` are approximate hand-placed pins (see module header).
 */
const CAMERAS = [
  {
    id: 'ccg-windsor',
    camfile: 'Windsor',
    name: 'Windsor Waterfront (Detroit River)',
    lat: 42.3186,
    lon: -83.043,
    // The feed burns in its own compass facing ("N W").
    headingDeg: 315,
  },
  {
    id: 'ccg-livingstone-channel',
    camfile: 'LivingstoneChannel',
    name: 'Livingstone Channel (Amherstburg)',
    lat: 42.056,
    lon: -83.115,
    headingDeg: 180, // feed compass "S"
  },
];

/** Windsor-Essex / lower-Detroit-River prioritization anchor. */
const WINDSOR = { lat: 42.3149, lon: -83.0364 };

/**
 * Build the Coast Guard camera rows. Static and synchronous apart from the
 * signature the catalog expects; nothing is fetched here — the frame proxy
 * pulls each JPEG on demand from its registered host.
 * @returns {Array<object>} Normalized-ready camera rows.
 */
export function loadCoastGuardSources() {
  const cameras = CAMERAS.map(({ id, camfile, name, lat, lon, headingDeg }) => {
    const imageUrl = `${COASTGUARD_IMAGE_ORIGIN}${encodeURIComponent(camfile)}.jpg`;
    // Keep every registered URL on the official host, by construction.
    if (!imageUrl.startsWith(COASTGUARD_IMAGE_ORIGIN)) return null;
    // The feeds burn in a compass facing, so most cameras carry a real
    // heading; any without one fall back to the shared id-hash heading.
    const hasHeading = Number.isFinite(headingDeg);
    return {
      id,
      name,
      city: 'Windsor-Essex',
      cityId: 'windsor-essex',
      provider: 'Canadian Coast Guard',
      lat,
      lon,
      headingDeg: hasHeading ? headingDeg : fallbackHeadingFromId(id),
      headingConfidence: hasHeading ? 'medium' : 'low',
      pitchDeg: -8,
      fovDeg: 55,
      rangeM: 600,
      mountHeightM: 12,
      groundElevationM: RIVER_ELEVATION_M,
      feedType: 'image',
      url: imageUrl,
      snapshotUrl: imageUrl,
      poseSource: 'curated',
      sourceKind: 'ccg-enav',
      license: 'Canadian Coast Guard e-Navigation (public courtesy feed)',
    };
  }).filter(Boolean);

  const maxRaw = Number(
    process.env.CCTV_COASTGUARD_MAX_SOURCES || DEFAULT_COASTGUARD_MAX_SOURCES,
  );
  const maxCount = Number.isFinite(maxRaw)
    ? Math.max(1, Math.min(50, Math.floor(maxRaw)))
    : DEFAULT_COASTGUARD_MAX_SOURCES;
  const prioritized = prioritizeSources(cameras, maxCount, [WINDSOR]);
  console.log(
    `[CCTV] Loaded Canadian Coast Guard sources: ${cameras.length} available (using nearest ${prioritized.length})`,
  );
  return prioritized;
}

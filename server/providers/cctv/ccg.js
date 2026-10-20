/**
 * Canadian Coast Guard river cameras on the Detroit River, Lake St. Clair and
 * St. Clair River: the Windsor, Livingstone Channel, Lake St. Clair, Point
 * Edward and Sarnia views from CCG's Camera Ice Monitoring System
 * (e-navigation.canada.ca/topics/cameras). Still JPEGs refreshed roughly every
 * few minutes; CCG offers them "to the public as a courtesy and for
 * information only".
 *
 * CCG doesn't publish camera coordinates, so positions are placed by name at
 * the waterway each camera is named for and marked approximate. Frames are
 * pinned to the official still host.
 *
 * Opt-in (CCTV_CCG_ENABLED=1), matching how this repo gates packs whose reuse
 * terms aren't spelled out.
 */

import { cameraDisplayCode } from './normalize.js';

export const CCG_IMAGE_ORIGIN =
  'https://e-nav.ccg-gcc.gc.ca/nvss-svsn/sequences/';

/** Curated: live when checked (Oct 2026). Port Lambton was stale since 2025. */
export const CCG_CAMERAS = Object.freeze([
  {
    file: 'Windsor',
    // From the frame: elevated, looking west down the river, with Belle
    // Isle's tip in the foreground, the Ren Cen right and the Ambassador
    // Bridge in the distance, so it sits on the east Windsor riverfront.
    name: 'Detroit River from east Windsor, looking west to downtown (Coast Guard)',
    lat: 42.332,
    lon: -82.972,
    heading: 262,
  },
  {
    file: 'LivingstoneChannel',
    name: 'Detroit River, Livingstone Channel near Amherstburg (Coast Guard)',
    lat: 42.09,
    lon: -83.122,
    heading: 0,
  },
  {
    file: 'LakeSaintClair(X32)',
    name: 'Lake St. Clair shipping channel (Coast Guard)',
    lat: 42.47,
    lon: -82.72,
    heading: 45,
  },
  {
    file: 'PointEdward',
    name: 'St. Clair River at Point Edward, Blue Water Bridge (Coast Guard)',
    lat: 43.0036,
    lon: -82.4155,
    heading: 0,
  },
  {
    file: 'SarniaMCTSNorth',
    name: 'St. Clair River at Sarnia, looking north (Coast Guard)',
    lat: 42.99,
    lon: -82.411,
    heading: 0,
  },
  {
    file: 'SarniaMCTSSouth',
    name: 'St. Clair River at Sarnia, looking south (Coast Guard)',
    lat: 42.99,
    lon: -82.411,
    heading: 180,
  },
]);

export function ccgCameraToSource(cam) {
  if (!/^[A-Za-z0-9()_-]{1,60}$/.test(cam.file)) return null;
  const url = `${CCG_IMAGE_ORIGIN}${encodeURIComponent(cam.file)}.jpg`;
  const id = `ccg-${cam.file
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+$/, '')}`;
  return {
    id,
    name: cam.name,
    city: 'Detroit / St. Clair River',
    cityId: 'ccg-great-lakes',
    provider: 'Canadian Coast Guard',
    lat: cam.lat,
    lon: cam.lon,
    headingDeg: cam.heading,
    headingConfidence: 'low',
    positionConfidence: 'approximate',
    pitchDeg: -10,
    fovDeg: 60,
    rangeM: 800,
    mountHeightM: 15,
    groundElevationM: 175,
    feedType: 'image',
    url,
    snapshotUrl: url,
    sourceKind: 'ccg-e-navigation',
    license:
      'Canadian Coast Guard, offered to the public as a courtesy and for information only',
    code: cameraDisplayCode(cam.file.toUpperCase()),
  };
}

export async function loadCcgSources() {
  const cameras = CCG_CAMERAS.map(ccgCameraToSource).filter(Boolean);
  console.log(
    `[CCTV] Loaded Canadian Coast Guard river cameras: ${cameras.length}`,
  );
  return cameras;
}

/**
 * Michigan DOT "Mi Drive" traffic cameras — the Detroit side of the
 * Windsor–Detroit corridor (plus the rest of Michigan's ~800 cameras).
 *
 * The public Mi Drive map loads its camera list from a keyless JSON endpoint
 * whose rows carry HTML fragments: coordinates live in the county cell's map
 * link, the still image in an <img> tag. This loader extracts only those two
 * things and pins every frame to the official image host, so a row can never
 * point the frame proxy anywhere else.
 *
 * Opt-in (CCTV_MDOT_ENABLED=1): MDOT's Mi Drive disclaimer doesn't spell out
 * reuse terms for camera images, matching how this repo gates FL511 and NYC.
 */

import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';
import { directionToHeading } from '../../../src/data/directionText.js';
import { readResponseJsonCapped } from '../common/http.js';

export const MDOT_CAMERAS_URL =
  'https://mdotjboss.state.mi.us/MiDrive/camera/list';
export const MDOT_IMAGE_ORIGIN = 'https://micamerasimages.net/';
export const MDOT_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MDOT_MAX_SOURCES = 300;
// Nearest-first from the Detroit riverfront, across from Windsor, so the
// default cap keeps metro Detroit rather than spreading across the state.
const ANCHORS = [{ lat: 42.3314, lon: -83.0458 }];

const decode = (value) =>
  String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function isLikelyMichiganCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 41.6 &&
    lat <= 48.4 &&
    lon >= -90.5 &&
    lon <= -82.1
  );
}

/**
 * Keep only a micamerasimages.net still: the list links a `/thumbs/<name>.flv.jpg`
 * thumbnail that 301s to `/<name>.jpg`, so take the full-size path directly.
 */
export function normalizeMdotImageUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || url.hostname !== 'micamerasimages.net')
      return '';
    const match = /^\/(?:thumbs\/)?([a-z0-9_-]{1,80})(?:\.flv)?\.jpg$/i.exec(
      url.pathname,
    );
    return match ? `${MDOT_IMAGE_ORIGIN}${match[1]}.jpg` : '';
  } catch {
    return '';
  }
}

/** One Mi Drive list row → a normalized camera source, or null. */
export function mdotCameraToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const county = String(row.county ?? '');
  const coords =
    /[?&]lat=(-?\d+(?:\.\d+)?)&(?:amp;)?lon=(-?\d+(?:\.\d+)?)/.exec(county);
  const idMatch = /[?&](?:amp;)?id=(\d{1,7})\b/.exec(county);
  if (!coords || !idMatch) return null;
  const lat = Number(coords[1]);
  const lon = Number(coords[2]);
  if (!isLikelyMichiganCoordinate(lat, lon)) return null;

  const img = /\bsrc="([^"]+)"/.exec(String(row.image ?? ''));
  const imageUrl = normalizeMdotImageUrl(img?.[1]);
  if (!imageUrl) return null;

  const cameraId = `mdot-${idMatch[1]}`;
  const route = decode(row.route);
  const location = decode(row.location).replace(/^@\s*/, '');
  const countyName = decode(county.split('<')[0]);
  const name = [route, location].filter(Boolean).join(' @ ') || cameraId;
  const heading = directionToHeading(decode(row.direction), true);
  const hasHeading = Number.isFinite(heading);

  return {
    id: cameraId,
    name,
    city: countyName || 'Michigan',
    cityId: 'michigan',
    provider: 'Michigan DOT (Mi Drive)',
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    pitchDeg: hasHeading ? -24 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 210 : 145,
    mountHeightM: hasHeading ? 10 : 8,
    groundElevationM: 185,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'mdot-midrive',
    license:
      'Michigan Department of Transportation, Mi Drive (Copyright State of Michigan)',
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

export async function loadMdotSources() {
  try {
    const resp = await fetch(process.env.CCTV_MDOT_URL || MDOT_CAMERAS_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      console.warn(
        '[CCTV] Michigan Mi Drive camera download failed:',
        resp.status,
      );
      return [];
    }
    const rows = await readResponseJsonCapped(resp, MDOT_MAX_CATALOG_BYTES);
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    const cameras = [];
    for (const row of rows) {
      const camera = mdotCameraToSource(row);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      process.env.CCTV_MDOT_MAX_SOURCES || DEFAULT_MDOT_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
      : DEFAULT_MDOT_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, ANCHORS);
    console.log(
      `[CCTV] Loaded Michigan Mi Drive camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Michigan Mi Drive camera download error:',
      error?.message || error,
    );
    return [];
  }
}

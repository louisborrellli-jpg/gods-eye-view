import * as Cesium from 'cesium';
import {
  GREAT_LAKES_OVERLAY_SOURCE_ID,
  GREAT_LAKES_OVERLAY_COHORT_LIMIT,
  GREAT_LAKES_OVERLAY_COLLISION_CAPACITY,
  GREAT_LAKES_ACCENT,
  GREAT_LAKES_SOURCE_UNAVAILABLE,
  createGreatLakesOverlayEntry,
  formatLevelMeters,
} from './records.js';
export * from './records.js';
export { createGreatLakesSource } from './source.js';

/** CO-OPS publishes a fresh reading every 6 minutes; match that cadence. */
const UPDATE_INTERVAL_MS = 6 * 60 * 1000;

/**
 * Live water level at the 52 NOAA CO-OPS gauges on the Great Lakes and their
 * connecting channels, drawn as a station dot with a zoom-gated label carrying
 * the reading (IGLD metres). The number is the whole point, so it rides the
 * overlay host as a collision-managed label — never a Cesium entity label
 * (src/noCesiumLabels.test.mjs).
 *
 * @param {object} deps
 * @param {{getSnapshot: Function}} deps.source
 * @param {object} deps.overlayHost World-overlay host for the ambient labels.
 * @param {typeof Cesium} [deps.cesium]
 */
export function createGreatLakesLayer({
  source,
  overlayHost,
  cesium = Cesium,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Great Lakes requires a snapshot source');
  if (!overlayHost) throw new TypeError('Great Lakes requires an overlay host');

  let _viewer = null;
  let _ds = null;
  let _request = null;
  let _enabled = false;
  let _count = 0;
  let _partial = false;
  let _lastUpdate = null;
  let _lastError = null;

  const dotColor = cesium.Color.fromCssColorString(GREAT_LAKES_ACCENT);

  const layer = {
    id: 'great-lakes',
    name: 'Great Lakes Levels',
    icon: '🌊',
    source: 'NOAA CO-OPS',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Great Lakes layer is already initialized');
      _viewer = viewer;
      _ds = new cesium.CustomDataSource('great-lakes');
      viewer.dataSources.add(_ds);
      _enabled = false;
      _count = 0;
      _partial = false;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:GreatLakes] Initialized');
    },

    enable() {
      _enabled = true;
      if (_ds) _ds.show = true;
      overlayHost.setVisible(GREAT_LAKES_OVERLAY_SOURCE_ID, true);
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(GREAT_LAKES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GREAT_LAKES_OVERLAY_SOURCE_ID, false);
      if (_ds) {
        _ds.entities.removeAll();
        _ds.show = false;
      }
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      if (!_enabled || !_viewer) return true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const records = Array.isArray(snapshot?.records)
          ? snapshot.records
          : [];
        const next = [];
        const overlayEntries = [];

        for (const rec of records) {
          const position = cesium.Cartesian3.fromDegrees(rec.lng, rec.lat);
          next.push(
            new cesium.Entity({
              id: `great-lakes:${rec.id}`,
              name: rec.name,
              position,
              point: {
                pixelSize: 7,
                color: dotColor.withAlpha(0.95),
                outlineColor: cesium.Color.BLACK.withAlpha(0.55),
                outlineWidth: 1,
                heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                station: rec.name,
                state: rec.state,
                level_m: rec.level,
                datum: rec.datum,
                time: rec.time,
              },
            }),
          );
          // One ambient label per gauge, carrying "<station> · <level> m",
          // through the overlay host (collision-managed), never a Cesium label.
          overlayEntries.push(
            createGreatLakesOverlayEntry({
              id: rec.id,
              position,
              title: `${rec.name} · ${formatLevelMeters(rec.level)}`,
              priority: 1,
            }),
          );
        }

        _ds.entities.removeAll();
        for (const entity of next) _ds.entities.add(entity);
        _ds.show = _enabled;
        if (_enabled) {
          overlayHost.setEntries(
            GREAT_LAKES_OVERLAY_SOURCE_ID,
            overlayEntries,
            {
              cohortLimit: GREAT_LAKES_OVERLAY_COHORT_LIMIT,
              collisionCapacity: GREAT_LAKES_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = records.length;
        _partial = Boolean(snapshot.partial);
        _lastUpdate = Date.now();
        _lastError = null;
        _viewer.scene?.requestRender?.();
        console.log(
          `[Data:GreatLakes] Updated: ${_count} gauges` +
            (_partial ? ' (partial: some gauges unreachable)' : ''),
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GreatLakes] Fetch error:', e);
        _lastError = e?.message || GREAT_LAKES_SOURCE_UNAVAILABLE;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      overlayHost.clearSource(GREAT_LAKES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GREAT_LAKES_OVERLAY_SOURCE_ID, false);
      if (_ds && viewer?.dataSources) {
        try {
          viewer.dataSources.remove(_ds, true);
        } catch {
          /* removed with the viewer */
        }
      }
      _ds = null;
      _viewer = null;
      _enabled = false;
      _count = 0;
      _partial = false;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        partial: _partial,
      };
    },

    /** On-demand snapshot for the analyst/voice query engine. */
    getAnalystRecords(maxCount = 1000) {
      if (!_ds || !_ds.show) return [];
      const now = cesium.JulianDate.now();
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 1000;
      const out = [];
      for (const entity of _ds.entities.values) {
        if (out.length >= limit) break;
        if (!entity.point) continue;
        const p = entity.properties;
        out.push({
          station: p?.station?.getValue(now) ?? null,
          state: p?.state?.getValue(now) ?? null,
          level_m: p?.level_m?.getValue(now) ?? null,
          datum: p?.datum?.getValue(now) ?? null,
          time: p?.time?.getValue(now) ?? null,
        });
      }
      return out;
    },
  };
  return layer;
}

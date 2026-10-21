import * as Cesium from 'cesium';
import { severityStyle, ringsCentroid, SEVERITY } from './records.js';
export * from './records.js';
export { createWeatherAlertsSource } from './source.js';

// Portable package (no i18n): the layer panel localizes the label, and errors
// stay English data the panel localizes.
const msg = (text) => text;

/** NWS republishes within a minute; ECCC a few minutes. 60s is the floor. */
const UPDATE_INTERVAL_MS = 60 * 1000;

const COLOR_CACHE = new Map();
function severityColor(rank) {
  if (!COLOR_CACHE.has(rank)) {
    COLOR_CACHE.set(
      rank,
      Cesium.Color.fromCssColorString(severityStyle(rank).hex),
    );
  }
  return COLOR_CACHE.get(rank);
}

/** Flatten a ring ([[lon,lat],...]) into the [lon,lat,lon,lat,...] Cesium wants. */
function flatDegrees(ring) {
  const out = [];
  for (const p of ring) {
    out.push(p[0], p[1]);
  }
  return out;
}

/**
 * Active weather-alert areas across the US (NWS) and Canada (ECCC), drawn as
 * severity-coloured polygons with a zoom-gated label. Click-through detail is a
 * follow-up; the colour and label carry the headline meaning.
 *
 * @param {object} deps
 * @param {{getSnapshot: Function}} deps.source
 * @param {typeof Cesium} [deps.cesium]
 */
export function createWeatherAlertsLayer({ source, cesium = Cesium } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Weather alerts requires a snapshot source');

  let _viewer = null;
  let _ds = null;
  let _request = null;
  let _enabled = false;
  let _count = 0;
  let _bySeverity = { 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
  let _partial = false;
  let _lastUpdate = null;
  let _lastError = null;

  const layer = {
    id: 'weather-alerts',
    name: 'Weather Alerts',
    icon: '⚠️',
    source: 'NWS + Environment Canada',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer)
        throw new Error('Weather alerts layer is already initialized');
      _viewer = viewer;
      _ds = new cesium.CustomDataSource('weather-alerts');
      viewer.dataSources.add(_ds);
      _enabled = false;
      _count = 0;
      _bySeverity = { 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
      _partial = false;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:WeatherAlerts] Initialized');
    },

    enable() {
      _enabled = true;
      if (_ds) _ds.show = true;
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
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
        const tally = { 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };

        for (const rec of records) {
          const color = severityColor(rec.severityRank);
          const significant = rec.severityRank >= SEVERITY.SEVERE;
          rec.rings.forEach((ring, index) => {
            next.push(
              new cesium.Entity({
                id: `weather-alert:${rec.id}:${index}`,
                name: rec.event,
                polygon: {
                  hierarchy: new cesium.PolygonHierarchy(
                    cesium.Cartesian3.fromDegreesArray(flatDegrees(ring)),
                  ),
                  material: color.withAlpha(significant ? 0.26 : 0.18),
                  outline: true,
                  outlineColor: color.withAlpha(0.9),
                  outlineWidth: significant ? 2 : 1,
                },
                properties: {
                  source: rec.source,
                  event: rec.event,
                  severity: severityStyle(rec.severityRank).label,
                  severityRank: rec.severityRank,
                  area: rec.area,
                  headline: rec.headline,
                  expires: rec.expires,
                },
              }),
            );
          });
          // One label per alert at its first ring's centroid, only once the
          // camera is close enough to read it (≈ regional zoom).
          const c = ringsCentroid(rec.rings);
          if (c) {
            next.push(
              new cesium.Entity({
                id: `weather-alert-label:${rec.id}`,
                position: cesium.Cartesian3.fromDegrees(c.lon, c.lat),
                label: {
                  text: rec.event,
                  font: '600 13px "Inter", sans-serif',
                  fillColor: color,
                  outlineColor: cesium.Color.BLACK.withAlpha(0.85),
                  outlineWidth: 3,
                  style: cesium.LabelStyle.FILL_AND_OUTLINE,
                  pixelOffset: new cesium.Cartesian2(0, 0),
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  distanceDisplayCondition: new cesium.DistanceDisplayCondition(
                    0,
                    1_200_000,
                  ),
                  translucencyByDistance: new cesium.NearFarScalar(
                    300_000,
                    1,
                    1_200_000,
                    0.3,
                  ),
                },
              }),
            );
          }
          tally[rec.severityRank] = (tally[rec.severityRank] || 0) + 1;
        }

        _ds.entities.removeAll();
        for (const entity of next) _ds.entities.add(entity);
        _ds.show = _enabled;

        _count = records.length;
        _bySeverity = tally;
        _partial = Boolean(snapshot.partial);
        _lastUpdate = Date.now();
        _lastError = null;
        _viewer.scene?.requestRender?.();
        console.log(
          `[Data:WeatherAlerts] Updated: ${_count} alerts` +
            (_partial ? ' (partial: one feed down)' : ''),
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:WeatherAlerts] Fetch error:', e);
        _lastError = e?.message || msg('Weather alert source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
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
      _bySeverity = { 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
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
        bySeverity: { ..._bySeverity },
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
        if (!entity.polygon) continue; // skip label entities
        const p = entity.properties;
        out.push({
          source: p?.source?.getValue(now) ?? null,
          event: p?.event?.getValue(now) ?? null,
          severity: p?.severity?.getValue(now) ?? null,
          area: p?.area?.getValue(now) ?? null,
          expires: p?.expires?.getValue(now) ?? null,
        });
      }
      return out;
    },
  };
  return layer;
}

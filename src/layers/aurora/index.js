import * as Cesium from 'cesium';
import { buildAuroraRaster, visibleCellCount } from './model.js';
export * from './model.js';
export * from './records.js';
export { createOvationAuroraSource } from './source.js';

// A portable package (no i18n): errors stay English data and the layer panel
// shows them translated.
const msg = (text) => text;

/** OVATION republishes about every five minutes; polling faster only costs. */
const AURORA_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Own the aurora nowcast overlay and its refresh lifecycle.
 *
 * The forecast is a whole-globe grid, so it draws as one ground-draped imagery
 * tile rather than 65,160 entities: one texture, no per-frame work, and no
 * entity collection to reconcile.
 */
export function createAuroraLayer({ source, cesium = Cesium } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Aurora requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _imagery = null;
  let _collection = null;
  let _count = 0;
  let _peak = 0;
  let _observedAt = null;
  let _forecastAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const removeImagery = () => {
    if (_imagery && _collection) {
      // `true` destroys the provider's texture with the layer; leaving it
      // behind leaks a full-globe RGBA image on every refresh.
      try {
        _collection.remove(_imagery, true);
      } catch {
        /* collection already torn down with the viewer */
      }
    }
    _imagery = null;
    _collection = null;
  };

  const layer = {
    id: 'aurora',
    name: 'Aurora (nowcast)',
    icon: '🌌',
    source: 'NOAA SWPC OVATION',
    updateInterval: AURORA_UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Aurora layer is already initialized');
      _viewer = viewer;
      _count = 0;
      _peak = 0;
      _observedAt = null;
      _forecastAt = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:Aurora] Initialized');
    },

    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = true;
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      removeImagery();
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      if (!_enabled || !_viewer) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const collection =
          _viewer.imageryLayers ?? _viewer.scene?.imageryLayers ?? null;
        if (!collection || !cesium.SingleTileImageryProvider) {
          _lastError = msg('Globe imagery unavailable');
          return false;
        }

        const raster = buildAuroraRaster(snapshot);
        const canvas = document.createElement('canvas');
        canvas.width = raster.width;
        canvas.height = raster.height;
        const context = canvas.getContext('2d');
        const pixels = context.createImageData(raster.width, raster.height);
        pixels.data.set(raster.data);
        context.putImageData(pixels, 0, 0);

        const provider = new cesium.SingleTileImageryProvider({
          url: canvas.toDataURL('image/png'),
          tileWidth: raster.width,
          tileHeight: raster.height,
          rectangle: cesium.Rectangle.MAX_VALUE,
        });

        // Add the replacement before dropping the old one so a refresh does
        // not blink the oval off the globe.
        const next = collection.addImageryProvider(provider);
        next.alpha = 1;
        removeImagery();
        _imagery = next;
        _collection = collection;
        _imagery.show = _enabled;

        _count = visibleCellCount(snapshot);
        _peak = snapshot.peak;
        _observedAt = snapshot.observedAt;
        _forecastAt = snapshot.forecastAt;
        _lastUpdate = Date.now();
        _lastError = null;
        _viewer.scene?.requestRender?.();
        console.log(
          `[Data:Aurora] Updated: ${_count} cells, peak ${_peak}% probability`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Aurora] Fetch error:', e);
        _lastError = e?.message || msg('Aurora source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      removeImagery();
      _viewer = null;
      _enabled = false;
      _count = 0;
      _peak = 0;
      _observedAt = null;
      _forecastAt = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // OVATION is a short-horizon forecast, so the observation it was built
        // from and the time it describes are both part of reading it honestly.
        observedAt: _observedAt,
        forecastAt: _forecastAt,
        peakProbability: _peak,
      };
    },
  };
  return layer;
}

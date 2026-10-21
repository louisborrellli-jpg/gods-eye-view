import * as Cesium from 'cesium';

// Portable package (no i18n): the layer panel translates the label, and errors
// stay English data the panel localizes. Keep this module free of app imports
// so it stays a self-contained, device-local layer.
const msg = (text) => text;

/** localStorage key holding the single most recent fix ("just in case"). */
const STORAGE_KEY = 'gev.me.lastFix';
/** Breadcrumb points retained for the trail polyline. */
const TRAIL_LIMIT = 300;
/** A fix older than this reads as stale (dimmed), not live. */
const STALE_AFTER_MS = 45 * 1000;
/** Re-evaluate staleness on this cadence even without a new fix. */
const UPDATE_INTERVAL_MS = 10 * 1000;

const LIVE_COLOR = Cesium.Color.fromCssColorString('#38bdf8'); // sky-400
const STALE_COLOR = Cesium.Color.fromCssColorString('#94a3b8'); // slate-400

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read the persisted last-known fix, tolerating absent or corrupt storage. */
function readStoredFix(storage) {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const lat = finite(v?.lat);
    const lon = finite(v?.lon);
    if (lat === null || lon === null) return null;
    return {
      lat,
      lon,
      accuracy: finite(v?.accuracy),
      heading: finite(v?.heading),
      speed: finite(v?.speed),
      altitude: finite(v?.altitude),
      at: finite(v?.at),
    };
  } catch {
    return null;
  }
}

/** Persist the latest fix; a full or blocked store is a non-fatal courtesy. */
function writeStoredFix(storage, fix) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(fix));
  } catch {
    /* quota exceeded or private-mode: last-known is best-effort */
  }
}

/** A GeolocationPositionError code mapped to English panel text. */
function errorText(error) {
  switch (error?.code) {
    case 1:
      return msg('Location permission denied');
    case 2:
      return msg('Location unavailable');
    case 3:
      return msg('Location request timed out');
    default:
      return msg('Location error');
  }
}

/**
 * The device's own location on the globe: a live dot with an accuracy ring and
 * a breadcrumb trail, driven by the browser Geolocation API with the viewer's
 * explicit permission. The most recent fix is persisted so reopening the page
 * still shows where you were and when ("just in case").
 *
 * This is a device-local layer: another browser cannot have this device's
 * location, so it never enters share links or stored layer state.
 *
 * @param {object} deps
 * @param {Geolocation} [deps.geolocation] Browser geolocation (injected for tests).
 * @param {Storage} [deps.storage] localStorage-like store for the last fix.
 * @param {typeof Cesium} [deps.cesium]
 * @param {() => number} [deps.now] Clock seam for tests.
 * @param {boolean} [deps.flyToFirstFix] Gently frame the first fix after enable.
 */
export function createMeLayer({
  geolocation,
  storage = null,
  cesium = Cesium,
  now = () => Date.now(),
  flyToFirstFix = true,
} = {}) {
  let _viewer = null;
  let _ds = null;
  let _watchId = null;
  let _enabled = false;
  let _fix = null; // latest known fix (live or restored)
  let _live = false; // true once a fix arrived this session
  let _framed = false; // first-fix camera framing spent
  let _trail = []; // [{ lat, lon, at }]
  let _error = null;
  let _lastUpdate = null;

  const isStale = () =>
    !_live || _fix?.at == null || now() - _fix.at > STALE_AFTER_MS;

  const render = () => {
    if (!_ds) return;
    _ds.entities.removeAll();
    if (!_fix) return;
    const color = isStale() ? STALE_COLOR : LIVE_COLOR;
    const position = cesium.Cartesian3.fromDegrees(_fix.lon, _fix.lat);

    // Accuracy ring: a translucent ground ellipse sized to the reported radius.
    if (_fix.accuracy && _fix.accuracy > 0) {
      _ds.entities.add({
        position,
        ellipse: {
          semiMajorAxis: _fix.accuracy,
          semiMinorAxis: _fix.accuracy,
          material: color.withAlpha(0.12),
          outline: true,
          outlineColor: color.withAlpha(0.5),
          outlineWidth: 1,
          height: 0,
        },
      });
    }

    // Breadcrumb trail: a thin line through recent positions.
    if (_trail.length > 1) {
      _ds.entities.add({
        polyline: {
          positions: cesium.Cartesian3.fromDegreesArray(
            _trail.flatMap((p) => [p.lon, p.lat]),
          ),
          width: 2,
          material: color.withAlpha(0.6),
          clampToGround: true,
        },
      });
    }

    // The dot itself: a haloed point so it reads on any basemap.
    _ds.entities.add({
      id: 'me:self',
      position,
      point: {
        pixelSize: 12,
        color,
        outlineColor: cesium.Color.WHITE.withAlpha(isStale() ? 0.5 : 0.9),
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    _viewer?.scene?.requestRender?.();
  };

  const adoptFix = (fix, { live }) => {
    _fix = fix;
    if (live) {
      _live = true;
      _lastUpdate = now();
      _error = null;
      if (fix.at != null) {
        const last = _trail[_trail.length - 1];
        if (!last || last.lat !== fix.lat || last.lon !== fix.lon) {
          _trail.push({ lat: fix.lat, lon: fix.lon, at: fix.at });
          if (_trail.length > TRAIL_LIMIT) _trail.shift();
        }
      }
      writeStoredFix(storage, fix);
    }
    render();

    if (live && flyToFirstFix && !_framed && _viewer?.camera?.flyTo) {
      _framed = true;
      try {
        _viewer.camera.flyTo({
          destination: cesium.Cartesian3.fromDegrees(fix.lon, fix.lat, 4000),
          duration: 1.5,
        });
      } catch {
        /* camera busy or torn down */
      }
    }
  };

  const onPosition = (position) => {
    if (!_enabled) return;
    const c = position?.coords;
    const lat = finite(c?.latitude);
    const lon = finite(c?.longitude);
    if (lat === null || lon === null) return;
    adoptFix(
      {
        lat,
        lon,
        accuracy: finite(c?.accuracy),
        heading: finite(c?.heading),
        speed: finite(c?.speed),
        altitude: finite(c?.altitude),
        at: finite(position?.timestamp) ?? now(),
      },
      { live: true },
    );
  };

  const onError = (error) => {
    if (!_enabled) return;
    _error = errorText(error);
    // Keep showing the last/stored fix (now styled stale) if we have one.
    render();
    _viewer?.scene?.requestRender?.();
  };

  const stopWatch = () => {
    if (_watchId !== null) {
      try {
        geolocation?.clearWatch?.(_watchId);
      } catch {
        /* already gone */
      }
      _watchId = null;
    }
  };

  const layer = {
    id: 'me',
    name: 'Me',
    icon: '📍',
    source: 'This device',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Me layer is already initialized');
      _viewer = viewer;
      _ds = new cesium.CustomDataSource('me');
      viewer.dataSources.add(_ds);
      // Surface the last-known fix immediately (stale), so "just in case"
      // works the moment the layer is turned on, before any live fix.
      const stored = readStoredFix(storage);
      if (stored) _fix = stored;
      _live = false;
      _framed = false;
      _trail = [];
      _error = null;
      _lastUpdate = null;
      _enabled = false;
      console.log('[Data:Me] Initialized');
    },

    enable() {
      _enabled = true;
      render(); // show the restored last-known fix at once
      if (!geolocation?.watchPosition) {
        _error = msg('Location not available on this device');
        return;
      }
      _error = null;
      try {
        _watchId = geolocation.watchPosition(onPosition, onError, {
          enableHighAccuracy: true,
          maximumAge: 10000,
          timeout: 30000,
        });
      } catch {
        _error = msg('Location not available on this device');
      }
    },

    disable() {
      _enabled = false;
      stopWatch();
      if (_ds) _ds.entities.removeAll();
      _viewer?.scene?.requestRender?.();
    },

    update() {
      // Event-driven, not polled: fixes arrive through watchPosition, so this
      // tick has no fetch to do. It only lets a fix that has stopped arriving
      // fade to stale styling. Returns truthy so the manager treats enable as
      // succeeded — a `false` here would be read as a failed update and roll
      // the layer back to disabled.
      if (!_enabled || !_viewer) return true;
      if (_fix && isStale()) render();
      return true;
    },

    destroy() {
      stopWatch();
      if (_ds && _viewer?.dataSources) {
        try {
          _viewer.dataSources.remove(_ds, true);
        } catch {
          /* removed with the viewer */
        }
      }
      _ds = null;
      _viewer = null;
      _enabled = false;
      _fix = null;
      _live = false;
      _framed = false;
      _trail = [];
      _error = null;
      _lastUpdate = null;
    },

    getStats() {
      return {
        count: _fix ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _error,
        accuracyM: _fix?.accuracy ?? null,
        speedMps: _fix?.speed ?? null,
        stale: _fix ? isStale() : false,
        fixAt: _fix?.at ?? null,
        live: _live,
      };
    },
  };
  return layer;
}

import * as Cesium from 'cesium';
import {
  formatNumber,
  formatRelativeTime,
  msg,
  t,
  tn,
} from '../../i18n/index.js';
import {
  createZoneStore,
  nextRadiusKm,
  WATCH_KINDS,
  DEFAULT_RADIUS_KM,
} from './zones.js';
import { FEED_INTERVAL_MS, createWatchFeeds } from './feeds.js';
import { alertSeverity, evaluateFeed } from './engine.js';
export * from './zones.js';
export * from './feeds.js';
export * from './engine.js';

export const WATCH_ZONES_LAYER_ID = 'watch-zones';
export const WATCH_ZONES_OVERLAY_SOURCE_ID = 'watch-zones';
export const WATCH_ZONES_POINTER_OWNER = 'watch-zones';
const ZONE_PICK = 'watch-zone:';
const ALERT_PICK = 'watch-alert:';
const ZONE_ACCENT = '#00e5ff';
const SEVERITY_ACCENT = Object.freeze({
  1: '#ffd54f',
  2: '#ff9100',
  3: '#ff1744',
});
const MAX_LOG = 40;
const LOG_TTL_MS = 24 * 3600_000;

const KIND_LABELS = Object.freeze({
  quake: msg('Quakes'),
  fire: msg('Fires'),
  emergency: msg('Mayday'),
});
const SQUAWK_MEANINGS = Object.freeze({
  7500: msg('hijack code'),
  7600: msg('radio failure'),
  7700: msg('general emergency'),
});

/**
 * One line describing an alert, in the UI language.
 * @param {object} alert From evaluateFeed.
 * @returns {string}
 */
export function describeAlert(alert) {
  const event = alert.event;
  const km = formatNumber(Math.round(event.distanceKm ?? 0));
  if (alert.kind === 'quake')
    return t('M{mag} earthquake · {km} km from centre', {
      mag: formatNumber(Math.round(event.mag * 10) / 10),
      km,
    });
  if (alert.kind === 'emergency')
    return t('{flight} squawking {code} ({meaning}) · {km} km from centre', {
      flight: event.flight || event.hex.toUpperCase(),
      code: event.squawk,
      meaning: t(SQUAWK_MEANINGS[event.squawk] || msg('emergency')),
      km,
    });
  return tn(
    alert.count,
    '{count} new fire detection · {km} km from centre',
    '{count} new fire detections · {km} km from centre',
    { count: formatNumber(alert.count), km },
  );
}

/**
 * Watch zones: circles the operator draws, checked worldwide against live
 * earthquake, active-fire and aircraft-emergency feeds. A new event inside a
 * zone raises a FLASH: a toast, a pin on the globe, a log entry and, when the
 * tab is in the background, a system notification.
 *
 * Checks run while this layer is on and the page is open; nothing runs on a
 * server on the operator's behalf.
 */
export function createWatchZonesLayer({
  services,
  storage = null,
  feeds = createWatchFeeds(),
  promptName = () => null,
  confirmRemove = () => true,
  notifier = null,
  now = () => Date.now(),
} = {}) {
  if (!services?.overlays || !services?.input || !services?.scenePick)
    throw new TypeError('Watch zones require scene services');
  const store = createZoneStore({ storage, now });
  let _viewer = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _enabled = false;
  let _selectedZoneId = null;
  let _focusedAlertId = null;
  let _armed = false;
  let _pointerClaim = null;
  let _releaseTimer = null;
  let _notice = null;
  let _rowListener = null;
  let _shell = null;
  let _sweep = null;
  let _lastSweep = null;
  let _feedError = null;
  let _fireKeyRequired = false;
  const _lastFetch = new Map(); // kind → ms
  const _primed = new Set();
  /** @type {Array<object>} newest first */
  let _log = [];
  let _alertSeq = 0;

  const notifyRow = () => _rowListener?.();
  /** "2 minutes ago" for an epoch-ms time, in the UI language. */
  const ago = (ms) => {
    const seconds = Math.round((ms - now()) / 1000);
    const abs = Math.abs(seconds);
    if (abs < 60) return formatRelativeTime(seconds, 'second');
    if (abs < 3600)
      return formatRelativeTime(Math.round(seconds / 60), 'minute');
    return formatRelativeTime(Math.round(seconds / 3600), 'hour');
  };
  const requestRender = () => _viewer?.scene?.requestRender?.();

  // --- Pointer (next globe tap places a zone) ------------------------------

  function releaseClaim() {
    if (_releaseTimer) clearTimeout(_releaseTimer);
    _releaseTimer = null;
    if (_pointerClaim) services.input.releasePointer(_pointerClaim);
    _pointerClaim = null;
  }

  function disarm({ afterDispatch = false } = {}) {
    _armed = false;
    if (!afterDispatch) return releaseClaim();
    if (_releaseTimer) clearTimeout(_releaseTimer);
    _releaseTimer = setTimeout(() => {
      _releaseTimer = null;
      releaseClaim();
    }, 0);
  }

  function arm() {
    if (!services.input.isLeaseCurrent(_pointerClaim)) {
      const lease = services.input.claimPointer(WATCH_ZONES_POINTER_OWNER);
      if (!lease) {
        _notice = msg('Another map tool is using taps — close it first');
        return false;
      }
      _pointerClaim = lease;
    }
    _notice = null;
    _armed = true;
    notifier?.requestPermission?.();
    return true;
  }

  // --- Scene ---------------------------------------------------------------

  function liveLog() {
    const cutoff = now() - LOG_TTL_MS;
    _log = _log.filter((entry) => entry.loggedAt >= cutoff).slice(0, MAX_LOG);
    return _log;
  }

  function render() {
    if (!_dataSource) return;
    const zones = store.list();
    if (_selectedZoneId && !store.get(_selectedZoneId)) _selectedZoneId = null;
    _dataSource.entities.removeAll();
    const entries = [];
    for (const zone of zones) {
      const selected = zone.id === _selectedZoneId;
      const position = Cesium.Cartesian3.fromDegrees(zone.lon, zone.lat);
      const color = Cesium.Color.fromCssColorString(ZONE_ACCENT);
      _dataSource.entities.add({
        id: `${ZONE_PICK}${zone.id}`,
        position,
        ellipse: {
          semiMajorAxis: zone.radiusKm * 1000,
          semiMinorAxis: zone.radiusKm * 1000,
          material: color.withAlpha(selected ? 0.16 : 0.07),
          outline: true,
          outlineColor: color.withAlpha(selected ? 1 : 0.75),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      entries.push({
        id: `watch-zone-label:${zone.id}`,
        position,
        ...(selected
          ? {
              selected: true,
              interactive: false,
              title: t('ZONE {name}', { name: zone.name }),
              details: [zoneSummary(zone)],
              priority: Number.MAX_SAFE_INTEGER - 1,
            }
          : {
              variant: 'label',
              title: t('ZONE {name}', { name: zone.name }),
              priority: 5000,
              collisionGroup: 'ambient-label',
              paintLane: 'ambient-label',
              interactive: false,
              edgeFade: 'keyhole',
              horizonCull: true,
              terrainOcclusion: false,
            }),
        accent: ZONE_ACCENT,
        gapPx: 12,
        verticalOnly: true,
        placement: 'above',
      });
    }
    for (const entry of liveLog()) {
      if (entry.background) continue;
      const { event } = entry.alert;
      const accent = SEVERITY_ACCENT[entry.severity];
      const position = Cesium.Cartesian3.fromDegrees(event.lon, event.lat);
      const focused = entry.id === _focusedAlertId;
      _dataSource.entities.add({
        id: `${ALERT_PICK}${entry.id}`,
        position,
        point: {
          pixelSize: focused ? 16 : 11,
          color: Cesium.Color.fromCssColorString(accent),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      if (focused)
        entries.push({
          id: `watch-alert-card:${entry.id}`,
          position,
          selected: true,
          interactive: false,
          title: t('FLASH · ZONE {name}', { name: entry.alert.zoneName }),
          details: [describeAlert(entry.alert), ago(entry.loggedAt)],
          accent,
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 15,
          verticalOnly: true,
          placement: 'above',
        });
    }
    if (_enabled)
      services.overlays.setOverlayEntries(
        WATCH_ZONES_OVERLAY_SOURCE_ID,
        entries,
        { cohortLimit: 64, collisionCapacity: 64, moving: false },
      );
    requestRender();
  }

  function zoneSummary(zone) {
    const watching = WATCH_KINDS.filter((kind) => zone.kinds[kind]).map(
      (kind) => t(KIND_LABELS[kind]),
    );
    return t('{radius} km · watching {kinds}', {
      radius: formatNumber(zone.radiusKm),
      kinds: watching.length ? watching.join(', ') : t('nothing'),
    });
  }

  function flyTo(lat, lon, radiusM) {
    if (!_viewer) return;
    const sphere = new Cesium.BoundingSphere(
      Cesium.Cartesian3.fromDegrees(lon, lat),
      radiusM,
    );
    const go = () =>
      _viewer.camera.flyToBoundingSphere(sphere, {
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-50),
          radiusM * 3.2,
        ),
        duration: 1.8,
      });
    if (_shell?.runNavigation) _shell.runNavigation(go);
    else go();
  }

  // --- Sweeps --------------------------------------------------------------

  function neededKinds() {
    const kinds = new Set();
    for (const zone of store.list())
      for (const kind of WATCH_KINDS) if (zone.kinds[kind]) kinds.add(kind);
    return kinds;
  }

  async function sweep({ force = false } = {}) {
    if (_sweep || !_enabled) return _sweep;
    const controller = new AbortController();
    const run = (async () => {
      const due = [...neededKinds()].filter(
        (kind) =>
          force ||
          now() - (_lastFetch.get(kind) ?? 0) >= FEED_INTERVAL_MS[kind],
      );
      const raised = [];
      let error = null;
      for (const kind of due) {
        try {
          const result = await feeds[kind]({ signal: controller.signal });
          if (!_enabled) return;
          _lastFetch.set(kind, now());
          if (kind === 'fire') _fireKeyRequired = Boolean(result.keyRequired);
          const { alerts, background } = evaluateFeed({
            zones: store.list(),
            kind,
            events: result.events,
            store,
            primed: _primed,
          });
          for (const alert of background) logAlert(alert, true);
          for (const alert of alerts) raised.push(logAlert(alert, false));
        } catch (caught) {
          if (controller.signal.aborted) return;
          error = caught?.message || msg('Feed unavailable');
        }
      }
      store.saveSeen();
      _feedError = error;
      _lastSweep = now();
      if (raised.length) announce(raised);
      render();
      notifyRow();
    })().finally(() => {
      _sweep = null;
    });
    _sweep = run;
    _sweep.abort = () => controller.abort();
    return run;
  }

  function logAlert(alert, background) {
    const entry = {
      id: `a${++_alertSeq}`,
      alert,
      background,
      severity: alertSeverity(alert),
      loggedAt: now(),
    };
    _log = [entry, ..._log].slice(0, MAX_LOG);
    return entry;
  }

  function announce(entries) {
    const top = [...entries].sort((a, b) => b.severity - a.severity)[0];
    const text = t('FLASH · ZONE {name} — {what}', {
      name: top.alert.zoneName,
      what: describeAlert(top.alert),
    });
    const extra =
      entries.length > 1
        ? ` ${t('(+{count} more)', { count: entries.length - 1 })}`
        : '';
    _shell?.showToast?.(text + extra);
    notifier?.notify?.(text + extra, { severity: top.severity });
  }

  // --- Input ---------------------------------------------------------------

  function pickGround(screenPosition) {
    const cartesian = services.scenePick.pickGroundPosition(
      _viewer,
      screenPosition,
    );
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return carto
      ? {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
        }
      : null;
  }

  function placeZone(point) {
    disarm({ afterDispatch: true });
    const zone = store.add({ ...point, radiusKm: DEFAULT_RADIUS_KM });
    if (!zone) {
      _notice = msg('Zone limit reached');
      notifyRow();
      return;
    }
    _selectedZoneId = zone.id;
    _focusedAlertId = null;
    render();
    notifyRow();
    void sweep({ force: true });
  }

  function onClick(click) {
    if (!_enabled || !_viewer) return;
    if (_armed && services.input.isLeaseCurrent(_pointerClaim)) {
      const point = pickGround(click.position);
      if (point) placeZone(point);
      return;
    }
    if (!services.input.isPointerFree()) return;
    let picked = null;
    try {
      picked = _viewer.scene.pick(click.position);
    } catch {
      picked = null;
    }
    const pickId = picked ? services.picking?.resolvePickId?.(picked) : null;
    if (typeof pickId === 'string' && pickId.startsWith(ALERT_PICK)) {
      _focusedAlertId = pickId.slice(ALERT_PICK.length);
      render();
      return notifyRow();
    }
    if (typeof pickId === 'string' && pickId.startsWith(ZONE_PICK)) {
      _selectedZoneId = pickId.slice(ZONE_PICK.length);
      _focusedAlertId = null;
      render();
      return notifyRow();
    }
    if (pickId && services.picking?.isOwnedByOtherLayer?.(layer.id, pickId))
      return;
    if (_selectedZoneId || _focusedAlertId) {
      _selectedZoneId = null;
      _focusedAlertId = null;
      render();
      notifyRow();
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !_armed) return;
    disarm();
    notifyRow();
  }

  // --- Commands ------------------------------------------------------------

  function command(name) {
    const zone = _selectedZoneId ? store.get(_selectedZoneId) : null;
    if (name === 'add') {
      if (_armed) disarm();
      else arm();
    } else if (name === 'sweep') {
      void sweep({ force: true });
    } else if (!zone) {
      return false;
    } else if (name === 'radius') {
      store.setRadius(zone.id, nextRadiusKm(zone.radiusKm));
    } else if (name.startsWith('kind:')) {
      const kind = name.slice(5);
      if (!WATCH_KINDS.includes(kind)) return false;
      store.setKind(zone.id, kind, !zone.kinds[kind]);
      if (!zone.kinds[kind]) void sweep({ force: true });
    } else if (name === 'rename') {
      const next = promptName(t('Codename for this zone'), zone.name);
      if (next != null) store.rename(zone.id, next.toUpperCase());
    } else if (name === 'remove') {
      if (!confirmRemove(t('Stand down zone {name}?', { name: zone.name })))
        return true;
      store.remove(zone.id);
      _selectedZoneId = null;
    } else {
      return false;
    }
    render();
    notifyRow();
    return true;
  }

  const layer = {
    id: WATCH_ZONES_LAYER_ID,
    name: 'Watch Zones',
    icon: '◎',
    source: 'USGS · NASA FIRMS · adsb.lol',
    updateInterval: 30000,

    init(viewer) {
      if (_viewer) throw new Error('Watch zones layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(WATCH_ZONES_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      services.overlays.setOverlaySourceVisible(
        WATCH_ZONES_OVERLAY_SOURCE_ID,
        true,
      );
      if (!_clickHandler && _viewer) {
        _clickHandler = services.createClickHandler?.(_viewer) ?? null;
        _clickHandler?.setInputAction(
          onClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
        services.picking?.registerPickOwner?.(
          WATCH_ZONES_LAYER_ID,
          (id) =>
            typeof id === 'string' &&
            (id.startsWith(ZONE_PICK) || id.startsWith(ALERT_PICK)),
        );
        globalThis.document?.addEventListener?.('keydown', onKeyDown);
      }
      render();
    },

    disable() {
      _enabled = false;
      _sweep?.abort?.();
      disarm();
      _notice = null;
      _clickHandler?.destroy?.();
      _clickHandler = null;
      services.picking?.unregisterPickOwner?.(WATCH_ZONES_LAYER_ID);
      globalThis.document?.removeEventListener?.('keydown', onKeyDown);
      if (_dataSource) _dataSource.show = false;
      services.overlays.clearOverlaySource(WATCH_ZONES_OVERLAY_SOURCE_ID);
      services.overlays.setOverlaySourceVisible(
        WATCH_ZONES_OVERLAY_SOURCE_ID,
        false,
      );
    },

    async update() {
      if (!_enabled) return false;
      await sweep();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _rowListener = null;
      _shell = null;
    },

    /**
     * `select` picks a zone id (null clears) and flies to it; `focus` picks a
     * logged alert id and flies to it; `command` runs add / sweep / radius /
     * kind:<kind> / rename / remove on the selected zone.
     */
    setParams(params = {}) {
      if (Object.hasOwn(params, 'select')) {
        const zone = params.select ? store.get(String(params.select)) : null;
        if (params.select && !zone) return false;
        _selectedZoneId = zone?.id ?? null;
        _focusedAlertId = null;
        if (zone) flyTo(zone.lat, zone.lon, zone.radiusKm * 1000);
      }
      if (params.focus != null) {
        const entry = _log.find((item) => item.id === String(params.focus));
        if (!entry) return false;
        _focusedAlertId = entry.id;
        _selectedZoneId = entry.alert.zoneId;
        flyTo(entry.alert.event.lat, entry.alert.event.lon, 4000);
      }
      if (params.command != null) return command(String(params.command));
      render();
      notifyRow();
      return true;
    },

    getParams() {
      return { select: _selectedZoneId };
    },

    getRowControls() {
      const zones = store.list();
      const zone = _selectedZoneId ? store.get(_selectedZoneId) : null;
      const chips = [
        {
          id: 'add',
          label: _armed ? t('Tap the map…') : t('New zone'),
          active: _armed,
          onClick: () => command('add'),
        },
      ];
      if (zones.length)
        chips.push({
          id: 'sweep',
          label: t('Sweep now'),
          disabled: Boolean(_sweep),
          onClick: () => command('sweep'),
        });
      if (zone) {
        chips.push({
          id: 'radius',
          label: t('{radius} km', { radius: formatNumber(zone.radiusKm) }),
          title: t('Change the zone radius'),
          onClick: () => command('radius'),
        });
        for (const kind of WATCH_KINDS)
          chips.push({
            id: `kind:${kind}`,
            label: t(KIND_LABELS[kind]),
            active: zone.kinds[kind],
            onClick: () => command(`kind:${kind}`),
          });
        chips.push(
          {
            id: 'rename',
            label: t('Rename'),
            onClick: () => command('rename'),
          },
          {
            id: 'remove',
            label: t('Stand down'),
            onClick: () => command('remove'),
          },
        );
      }
      let info;
      if (_notice) info = t(_notice);
      else if (_armed) info = t('Tap the map to drop the zone centre');
      else if (!zones.length)
        info = t('No zones yet — press New zone, then tap the map');
      else {
        const parts = [
          tn(zones.length, '{count} zone armed', '{count} zones armed', {
            count: zones.length,
          }),
        ];
        if (_lastSweep)
          parts.push(t('last sweep {age}', { age: ago(_lastSweep) }));
        if (_fireKeyRequired) parts.push(t('fires need a NASA FIRMS key'));
        if (_feedError) parts.push(t('a feed failed; retrying'));
        info = parts.join(' · ');
      }
      const log = liveLog().filter((entry) => !entry.background);
      return {
        chips,
        info,
        list: {
          ariaLabel: t('Watch zones and alerts'),
          items: [
            ...zones.map((item) => ({
              id: `zone:${item.id}`,
              lead: '◎',
              text: t('ZONE {name}', { name: item.name }),
              active: item.id === _selectedZoneId,
              params: { select: item.id },
            })),
            ...log.slice(0, 12).map((entry) => ({
              id: `alert:${entry.id}`,
              lead: entry.severity === 3 ? '⚠' : '•',
              text: `${entry.alert.zoneName} · ${describeAlert(entry.alert)}`,
              active: entry.id === _focusedAlertId,
              params: { focus: entry.id },
            })),
          ],
        },
      };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** Toast and camera seams from the application shell. */
    attachShellServices(shell) {
      _shell = shell || null;
    },

    /** JSON-safe records for the analyst query engine: zones and recent alerts. */
    getAnalystRecords(maxCount = 100) {
      if (!_enabled) return [];
      const zones = store.list().map((zone) => ({
        id: zone.id,
        type: 'zone',
        name: zone.name,
        lat: zone.lat,
        lon: zone.lon,
        radiusKm: zone.radiusKm,
        watching: WATCH_KINDS.filter((kind) => zone.kinds[kind]),
      }));
      const alerts = liveLog().map((entry) => ({
        id: entry.alert.event.id,
        type: 'alert',
        zone: entry.alert.zoneName,
        kind: entry.alert.kind,
        background: entry.background,
        severity: entry.severity,
        lat: entry.alert.event.lat,
        lon: entry.alert.event.lon,
        distanceKm: entry.alert.event.distanceKm,
        loggedAtMs: entry.loggedAt,
        count: entry.alert.count,
      }));
      return [...zones, ...alerts].slice(0, Math.max(1, maxCount | 0));
    },

    getStats() {
      const count = store.size;
      return {
        count,
        countLabel: count
          ? tn(count, '{count} zone', '{count} zones', { count })
          : '',
        lastUpdate: _lastSweep,
        error: null,
      };
    },
  };
  return layer;
}

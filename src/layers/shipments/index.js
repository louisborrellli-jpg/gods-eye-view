import * as Cesium from 'cesium';
import {
  formatNumber,
  formatRelativeTime,
  msg,
  t,
  tn,
} from '../../i18n/index.js';
import {
  CARRIERS,
  carrierTrackingUrl,
  parseContainerNumber,
} from './containers.js';
import {
  localDay,
  rampEtaFor,
  shipmentAlerts,
  shipmentStage,
  worstSeverity,
} from './model.js';
import { createShipmentsBackend } from './backend.js';
import { SHIPMENTS_FOCUS_KEY } from './store.js';
import { TRACKING_KEY_NOTE } from './tracker.js';
import { estimatePosition, shipLeader } from './geo.js';
import {
  createShipmentTrackingSource,
  createShipmentVesselSource,
  effectiveVessel,
  pickVesselMatch,
  vesselLookupQuery,
} from './source.js';
import { describeShipmentAlert, describeShipmentStatus } from './text.js';
export * from './containers.js';
export * from './model.js';
export * from './store.js';
export * from './text.js';
export * from './tracking.js';
export * from './tracker.js';
export * from './geo.js';
export { effectiveVessel } from './source.js';

export const SHIPMENTS_LAYER_ID = 'shipments';
export const SHIPMENTS_OVERLAY_SOURCE_ID = 'shipments';
const PICK = 'shipment:';
const ROUTE = 'shipment-route:';
/** The focus value that asks for every container at once (home page). */
const SHOW_ALL = '*';
const ACCENT = '#ffb74d';
const SEVERITY_ACCENT = Object.freeze({
  0: ACCENT,
  1: '#ffd54f',
  2: '#ff9100',
  3: '#ff1744',
});
/** How often each linked ship is looked up while the layer is on. */
const LOOKUP_INTERVAL_MS = 2 * 60_000;
/** A ship position older than this is shown as "last seen", not live. */
const LIVE_POSITION_MS = 45 * 60_000;
/** A ship position older than this gives way to the estimate. */
const HEARD_POSITION_MS = 12 * 60 * 60_000;

/**
 * Shipments: the operator's own containers, each with its ship, port and
 * rail milestones and the "last free day" clocks that decide when storage
 * and detention charges start.
 *
 * The operator types only a container number. Automatic tracking (FindTEU
 * through this app's server) fills in the ship, ETAs, unloading, the rail
 * leg when the line reports it, pickup and empty return; anything the
 * operator types wins. The layer looks the ship up in the live AIS feed,
 * pins it on the globe,
 * remembers where it was last heard (ships leave coastal AIS coverage
 * mid-ocean), and raises a toast and a system notification once per day for
 * any clock that is about to run out. Everything is kept in this browser.
 *
 * @param {object} options
 * @param {object} options.services Scene services (picking, input, overlays).
 * @param {Storage|null} [options.storage]
 * @param {object} [options.source] Ship lookup source.
 * @param {object} [options.trackingSource] Container tracking source.
 * @param {(id: string|null) => void} [options.openBoard] Opens the board.
 * @param {object|null} [options.notifier]
 * @param {() => number} [options.now]
 * @param {object} [options.backend] Where the list lives (server or browser).
 */
export function createShipmentsLayer({
  services,
  storage = null,
  source = createShipmentVesselSource(),
  trackingSource = createShipmentTrackingSource(),
  openBoard = () => {},
  notifier = null,
  now = () => Date.now(),
  backend = createShipmentsBackend({ storage, now, trackingSource }),
} = {}) {
  if (!services?.overlays || !services?.input)
    throw new TypeError('Shipments require scene services');
  const { store, tracker } = backend;
  let _viewer = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _enabled = false;
  let _selectedId = null;
  let _shell = null;
  let _rowListener = null;
  let _checking = null;
  let _lastCheck = null;
  let _feedNote = null;
  let _pendingFocus = null;
  /** @type {Map<string, string>} shipment id → why its ship was not found */
  const _lookupNotes = new Map();
  const _lastLookup = new Map();
  const _listeners = new Set();
  // The shared list changed (another person, the server's tracking job).
  const _unsubscribe = backend.subscribe?.(() => changed()) ?? (() => {});

  const today = () => localDay(now());
  const requestRender = () => _viewer?.scene?.requestRender?.();
  const changed = () => {
    render();
    _rowListener?.();
    for (const listener of _listeners) {
      try {
        listener();
      } catch {
        /* a board listener must not break the layer */
      }
    }
  };

  /** The ship matters until the box comes off it. */
  function followsShip(shipment) {
    return shipmentStage(shipment) === 'at-sea';
  }

  function shipLabel(shipment) {
    return shipment.lastSeen?.name || effectiveVessel(shipment).query || '';
  }

  function positionAge(shipment) {
    const at = shipment.lastSeen?.at;
    if (!Number.isFinite(at)) return '';
    const minutes = Math.round((at - now()) / 60_000);
    if (Math.abs(minutes) < 60) return formatRelativeTime(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) return formatRelativeTime(hours, 'hour');
    return formatRelativeTime(Math.round(hours / 24), 'day');
  }

  // --- Scene ---------------------------------------------------------------

  /**
   * Where to draw a shipment: its ship's AIS position while recent, else the
   * estimate along its sea lane or rail line. Null once picked up.
   * @returns {null|{lat:number, lon:number, mode:'live'|'heard'|'est',
   *   line:Array<[number, number]>}}
   */
  /** Where a container is: where its ship is, shared by every box aboard. */
  function positionFor(shipment) {
    const leader = shipLeader(shipment, store.list(), {
      nowMs: now(),
      heardMs: HEARD_POSITION_MS,
      atSea: followsShip,
    });
    return ownPosition(leader);
  }

  function ownPosition(shipment) {
    const stage = shipmentStage(shipment);
    const estimate = estimatePosition(shipment, stage, now(), {
      rampEta: rampEtaFor(shipment).day,
    });
    const seen = shipment.lastSeen;
    if (seen && followsShip(shipment) && now() - seen.at < HEARD_POSITION_MS)
      return {
        lat: seen.lat,
        lon: seen.lon,
        mode: now() - seen.at < LIVE_POSITION_MS ? 'live' : 'heard',
        line: estimate?.line ?? [],
      };
    if (!estimate) return null;
    return {
      lat: estimate.lat,
      lon: estimate.lon,
      mode: 'est',
      line: estimate.line,
    };
  }

  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    const entries = [];
    const day = today();
    if (_selectedId && !store.get(_selectedId)) _selectedId = null;
    for (const shipment of store.list()) {
      const where = positionFor(shipment);
      if (!where) continue;
      const alerts = shipmentAlerts(shipment, day);
      const severity = alerts[0]?.severity ?? 0;
      const accent = SEVERITY_ACCENT[severity];
      const color = Cesium.Color.fromCssColorString(accent);
      const selected = shipment.id === _selectedId;
      const position = Cesium.Cartesian3.fromDegrees(where.lon, where.lat);
      if (where.line.length > 1)
        _dataSource.entities.add({
          id: `${ROUTE}${shipment.id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(
              where.line.flatMap(([lat, lon]) => [lon, lat]),
            ),
            width: selected ? 3 : 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: color.withAlpha(selected ? 0.9 : 0.45),
              dashLength: 14,
            }),
            arcType: Cesium.ArcType.GEODESIC,
          },
        });
      const estimated = where.mode === 'est';
      _dataSource.entities.add({
        id: `${PICK}${shipment.id}`,
        position,
        point: {
          pixelSize: selected ? 15 : 11,
          color: estimated
            ? Cesium.Color.WHITE.withAlpha(0.9)
            : color.withAlpha(where.mode === 'live' ? 1 : 0.7),
          outlineColor: estimated ? color : Cesium.Color.BLACK,
          outlineWidth: estimated ? 3 : 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const ship = shipLabel(shipment);
      const base = ship
        ? `${shipment.container} · ${ship}`
        : shipment.container;
      const title = estimated ? t('{name} (est.)', { name: base }) : base;
      entries.push({
        id: `shipment-label:${shipment.id}`,
        position,
        ...(selected
          ? {
              selected: true,
              interactive: false,
              title,
              details: shipmentCardLines(shipment, day, where.mode),
              priority: Number.MAX_SAFE_INTEGER - 2,
            }
          : {
              variant: 'label',
              title,
              priority: 5200,
              collisionGroup: 'ambient-label',
              paintLane: 'ambient-label',
              interactive: false,
              edgeFade: 'keyhole',
              horizonCull: true,
              terrainOcclusion: false,
            }),
        accent,
        gapPx: 12,
        verticalOnly: true,
        placement: 'above',
      });
    }
    if (_enabled)
      services.overlays.setOverlayEntries(
        SHIPMENTS_OVERLAY_SOURCE_ID,
        entries,
        {
          cohortLimit: 64,
          collisionCapacity: 64,
          moving: false,
        },
      );
    requestRender();
  }

  function shipmentCardLines(shipment, day, mode) {
    const lines = [describeShipmentStatus(shipment, day)];
    if (mode === 'est') {
      lines.push(
        t(
          'Estimated from its departure and ETA; live position returns near the coast',
        ),
      );
      const top = shipmentAlerts(shipment, day)[0];
      if (top) lines.push(describeShipmentAlert(top));
      return lines;
    }
    const seen = shipment.lastSeen;
    const live = mode === 'live';
    const motion = [];
    if (Number.isFinite(seen.speed))
      motion.push(
        t('{speed} kn', {
          speed: formatNumber(Math.round(seen.speed * 10) / 10),
        }),
      );
    if (seen.destination)
      motion.push(t('to {place}', { place: seen.destination }));
    if (motion.length) lines.push(motion.join(' · '));
    lines.push(
      live
        ? t('Position {age}', { age: positionAge(shipment) })
        : t('Last heard {age} · out of coastal AIS range', {
            age: positionAge(shipment),
          }),
    );
    const top = shipmentAlerts(shipment, day)[0];
    if (top) lines.push(describeShipmentAlert(top));
    return lines;
  }

  function flyTo(lat, lon, radiusM = 40_000) {
    if (!_viewer) return;
    const sphere = new Cesium.BoundingSphere(
      Cesium.Cartesian3.fromDegrees(lon, lat),
      radiusM,
    );
    const go = () =>
      _viewer.camera.flyToBoundingSphere(sphere, {
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-55),
          radiusM * 3,
        ),
        duration: 1.8,
      });
    if (_shell?.runNavigation) _shell.runNavigation(go);
    else go();
  }

  // --- Ship lookups and alerts -----------------------------------------------

  async function lookupShip(shipment, { signal } = {}) {
    const vessel = effectiveVessel(shipment);
    const query = vesselLookupQuery(vessel);
    if (!query) return;
    _lastLookup.set(shipment.id, now());
    const result = await source.findVessel(query, { signal });
    if (!result.configured) {
      _feedNote = msg('Live ship positions need an AISStream key');
      return;
    }
    const match = pickVesselMatch(result.matches, vessel);
    if (!match) {
      _lookupNotes.set(
        shipment.id,
        result.matches.length > 1
          ? msg('Several ships match — enter the IMO number')
          : msg(
              'Ship not heard right now — it may be out of coastal AIS range',
            ),
      );
      return;
    }
    _lookupNotes.delete(shipment.id);
    const at = Number(match.last_position_epoch) * 1000;
    store.setLastSeen(shipment.id, {
      lat: match.lat,
      lon: match.lon,
      at: Number.isFinite(at) && at > 0 ? at : now(),
      name: match.name,
      mmsi: match.mmsi,
      imo: match.imo,
      speed: match.speed,
      course: match.course,
      destination: match.destination,
      eta: match.eta,
    });
  }

  async function check({ force = false, onlyId = null } = {}) {
    if (_checking) return _checking;
    const controller = new AbortController();
    const run = (async () => {
      _feedNote = null;
      // Milestones first: they can name the ship to follow.
      await tracker.refresh({ force, onlyId, signal: controller.signal });
      if (controller.signal.aborted) return;
      for (const shipment of store.list()) {
        if (onlyId && shipment.id !== onlyId) continue;
        if (!followsShip(shipment)) continue;
        if (!vesselLookupQuery(effectiveVessel(shipment))) continue;
        const last = _lastLookup.get(shipment.id) ?? 0;
        if (!force && now() - last < LOOKUP_INTERVAL_MS) continue;
        try {
          await lookupShip(shipment, { signal: controller.signal });
        } catch {
          if (controller.signal.aborted) return;
          _feedNote = msg('Ship lookup unavailable');
        }
        if (_feedNote === msg('Live ship positions need an AISStream key'))
          break;
      }
      _lastCheck = now();
      announce();
      changed();
    })().finally(() => {
      _checking = null;
    });
    _checking = run;
    _checking.abort = () => controller.abort();
    return run;
  }

  /** Raise each urgent alert once per day: a toast and, if hidden, a notification. */
  function announce() {
    const day = today();
    const fresh = [];
    for (const shipment of store.list())
      for (const alert of shipmentAlerts(shipment, day)) {
        if (alert.severity < 2) continue;
        const key = `${shipment.id}|${alert.code}|${alert.clock ?? ''}|${day}`;
        if (store.hasNotified(key)) continue;
        store.markNotified(key);
        fresh.push({ shipment, alert });
      }
    if (!fresh.length) return;
    fresh.sort((a, b) => b.alert.severity - a.alert.severity);
    const top = fresh[0];
    const text = t('{container} — {what}', {
      container: top.shipment.container,
      what: describeShipmentAlert(top.alert),
    });
    const extra =
      fresh.length > 1
        ? ` ${t('(+{count} more)', { count: fresh.length - 1 })}`
        : '';
    _shell?.showToast?.(text + extra);
    notifier?.notify?.(text + extra, { severity: top.alert.severity });
  }

  // --- Input ---------------------------------------------------------------

  function onClick(click) {
    if (!_enabled || !_viewer || !services.input.isPointerFree?.()) return;
    let picked = null;
    try {
      picked = _viewer.scene.pick(click.position);
    } catch {
      picked = null;
    }
    const pickId = picked ? services.picking?.resolvePickId?.(picked) : null;
    if (typeof pickId === 'string' && pickId.startsWith(PICK)) {
      _selectedId = pickId.slice(PICK.length);
      return changed();
    }
    if (pickId && services.picking?.isOwnedByOtherLayer?.(layer.id, pickId))
      return;
    if (_selectedId) {
      _selectedId = null;
      changed();
    }
  }

  /** A container id, or SHOW_ALL for every container's position at once. */
  function showFocus(focus) {
    if (focus !== SHOW_ALL) return layer.board.showOnGlobe(focus);
    const points = store
      .list()
      .map((shipment) => positionFor(shipment))
      .filter(Boolean);
    if (!points.length) return flyTo(45, -40, 3_200_000);
    const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const lon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
    const spread = Math.max(
      ...points.map((p) => Math.hypot(p.lat - lat, (p.lon - lon) * 0.7)),
      8,
    );
    flyTo(lat, lon, Math.min(spread * 111_000 * 1.2, 4_000_000));
    return true;
  }

  // --- Board API -----------------------------------------------------------

  /** What the board (src/ui/shipmentsBoard.js) reads and changes. */
  const board = Object.freeze({
    today,
    list: () => store.list(),
    get: (id) => store.get(id),
    /** @returns {{shipment: object|null, problem: string|null}} */
    save(input) {
      const parsed = parseContainerNumber(input?.container);
      if (!parsed.wellFormed)
        return { shipment: null, problem: parsed.problem };
      const duplicate = store
        .list()
        .find(
          (item) => item.container === parsed.number && item.id !== input.id,
        );
      if (duplicate)
        return {
          shipment: null,
          problem: msg('That container is already on the board'),
        };
      const shipment = store.save({
        ...input,
        container: parsed.number,
        carrier: input.carrier || parsed.carrier || '',
      });
      if (!shipment)
        return { shipment: null, problem: msg('The board is full') };
      _selectedId = shipment.id;
      changed();
      void check({ force: true, onlyId: shipment.id });
      return {
        shipment,
        problem: store.saveError ? msg('Could not save in this browser') : null,
      };
    },
    remove(id) {
      const removed = store.remove(id);
      if (removed) {
        _lookupNotes.delete(id);
        _lastLookup.delete(id);
        tracker.forget(id);
        changed();
      }
      return removed;
    },
    exportAll: () =>
      store.list().map(({ lastSeen, dates, defaults, ...rest }) => rest),
    importAll(entries) {
      const count = store.replaceAll(entries);
      _lookupNotes.clear();
      _lastLookup.clear();
      changed();
      void check({ force: true });
      return count;
    },
    check: (id = null) => check({ force: true, onlyId: id }),
    lookupNote: (id) => _lookupNotes.get(id) ?? null,
    /** Already translated: it can carry the tracking service's own words. */
    trackNote(id) {
      const note = tracker.note(id);
      if (!note) return null;
      return note.reason
        ? t('The tracking service says: {reason}', { reason: note.reason })
        : t(note.text);
    },
    feedNote: () => _feedNote,
    trackingNote: () => (tracker.keyMissing ? TRACKING_KEY_NOTE : null),
    defaults: () => store.defaults,
    setDefaults(value) {
      const next = store.setDefaults(value);
      changed();
      return next;
    },
    trackingUrl: (shipment) =>
      carrierTrackingUrl(shipment.carrier, shipment.container),
    carrierName: (id) => CARRIERS[id]?.name ?? '',
    /** Fly to a shipment's ship; turns the layer on through the shell when off. */
    showOnGlobe(id) {
      const shipment = store.get(id);
      const where = shipment ? positionFor(shipment) : null;
      if (!where) return false;
      _selectedId = shipment.id;
      if (!_enabled) _shell?.setLayerEnabled?.(SHIPMENTS_LAYER_ID, true);
      flyTo(where.lat, where.lon, where.mode === 'est' ? 900_000 : 40_000);
      changed();
      return true;
    },
    /** Whether a shipment has a position to show on the globe. */
    hasPosition(id) {
      const shipment = store.get(id);
      return Boolean(shipment && positionFor(shipment));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
  });

  const layer = {
    id: SHIPMENTS_LAYER_ID,
    name: 'Shipments',
    icon: '▣',
    source: 'Your entries · AISStream',
    updateInterval: 60_000,
    board,

    init(viewer) {
      if (_viewer) throw new Error('Shipments layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(SHIPMENTS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      services.overlays.setOverlaySourceVisible(
        SHIPMENTS_OVERLAY_SOURCE_ID,
        true,
      );
      if (!_clickHandler && _viewer) {
        _clickHandler = services.createClickHandler?.(_viewer) ?? null;
        _clickHandler?.setInputAction(
          onClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
        services.picking?.registerPickOwner?.(
          SHIPMENTS_LAYER_ID,
          (id) => typeof id === 'string' && id.startsWith(PICK),
        );
      }
      render();
      if (_pendingFocus) {
        const focus = _pendingFocus;
        _pendingFocus = null;
        showFocus(focus);
      }
      void check();
    },

    disable() {
      _enabled = false;
      _checking?.abort?.();
      _clickHandler?.destroy?.();
      _clickHandler = null;
      services.picking?.unregisterPickOwner?.(SHIPMENTS_LAYER_ID);
      if (_dataSource) _dataSource.show = false;
      services.overlays.clearOverlaySource(SHIPMENTS_OVERLAY_SOURCE_ID);
      services.overlays.setOverlaySourceVisible(
        SHIPMENTS_OVERLAY_SOURCE_ID,
        false,
      );
    },

    async update() {
      if (!_enabled) return false;
      await check();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _rowListener = null;
      _shell = null;
      _listeners.clear();
      _unsubscribe();
      backend.stop?.();
    },

    /**
     * `select` picks a shipment (null clears) and flies to its ship;
     * `command` runs board / add / check.
     */
    setParams(params = {}) {
      if (Object.hasOwn(params, 'select')) {
        const shipment = params.select
          ? store.get(String(params.select))
          : null;
        if (params.select && !shipment) return false;
        _selectedId = shipment?.id ?? null;
        const where = shipment ? positionFor(shipment) : null;
        if (where)
          flyTo(where.lat, where.lon, where.mode === 'est' ? 900_000 : 40_000);
        else if (shipment) openBoard(shipment.id);
      }
      // Board and Add are chip presses, so the browser treats the
      // notification prompt as user-initiated.
      if (params.command === 'board' || params.command === 'add')
        notifier?.requestPermission?.();
      if (params.command === 'board') openBoard(_selectedId);
      else if (params.command === 'add') openBoard('new');
      else if (params.command === 'check') void check({ force: true });
      else if (params.command != null) return false;
      changed();
      return true;
    },

    getParams() {
      return { select: _selectedId };
    },

    getRowControls() {
      const shipments = store.list();
      const day = today();
      const chips = [
        {
          id: 'home',
          label: t('Simple home'),
          title: t('Find a container in a few clicks'),
          onClick: () => globalThis.location?.assign?.('/home.html'),
        },
        {
          id: 'page',
          label: t('Shipments page'),
          title: t('Every container on one easy-to-read page'),
          onClick: () => globalThis.location?.assign?.('/shipments.html'),
        },
        {
          id: 'board',
          label: t('Open board'),
          onClick: () => layer.setParams({ command: 'board' }),
        },
        {
          id: 'add',
          label: t('Add container'),
          onClick: () => layer.setParams({ command: 'add' }),
        },
      ];
      if (shipments.length)
        chips.push({
          id: 'check',
          label: t('Refresh tracking'),
          disabled: Boolean(_checking),
          onClick: () => layer.setParams({ command: 'check' }),
        });
      let info;
      if (!shipments.length)
        info = t('No containers yet — press Add container');
      else {
        const urgent = shipments.filter((item) =>
          shipmentAlerts(item, day).some((alert) => alert.severity >= 2),
        ).length;
        const parts = [
          tn(shipments.length, '{count} container', '{count} containers', {
            count: shipments.length,
          }),
        ];
        if (urgent)
          parts.push(
            tn(urgent, '{count} needs action', '{count} need action', {
              count: urgent,
            }),
          );
        if (tracker.keyMissing) parts.push(t(TRACKING_KEY_NOTE));
        if (_feedNote) parts.push(t(_feedNote));
        info = parts.join(' · ');
      }
      return {
        chips,
        info,
        list: {
          ariaLabel: t('Your containers'),
          items: shipments.map((item) => {
            const severity = shipmentAlerts(item, day)[0]?.severity ?? 0;
            return {
              id: `shipment:${item.id}`,
              lead: severity >= 3 ? '⚠' : severity === 2 ? '!' : '•',
              text: `${item.container} · ${describeShipmentStatus(item, day)}`,
              active: item.id === _selectedId,
              params: { select: item.id },
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** Toast, navigation and layer-toggle seams from the application shell. */
    attachShellServices(shell) {
      _shell = shell || null;
      // The Shipments page asked to show a container on the map.
      let focus = null;
      try {
        focus = storage?.getItem?.(SHIPMENTS_FOCUS_KEY) ?? null;
        if (focus) storage.removeItem?.(SHIPMENTS_FOCUS_KEY);
      } catch {
        focus = null;
      }
      if (!_shell || !focus) return;
      // The shared list may still be on its way from the server.
      const go = () => {
        if (!_shell || (focus !== SHOW_ALL && !store.get(focus))) return;
        _pendingFocus = focus;
        if (_enabled) showFocus(focus);
        else _shell.setLayerEnabled?.(SHIPMENTS_LAYER_ID, true);
      };
      if (
        !backend.ready ||
        (focus === SHOW_ALL ? store.size : store.get(focus))
      )
        go();
      else void Promise.resolve(backend.ready).then(go);
    },

    getStats() {
      const count = store.size;
      const severity = worstSeverity(store.list(), today());
      return {
        count,
        countLabel: count
          ? tn(count, '{count} container', '{count} containers', { count })
          : '',
        lastUpdate: _lastCheck,
        error: null,
        severity,
      };
    },
  };
  return layer;
}

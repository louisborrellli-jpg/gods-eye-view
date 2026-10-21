import * as Cesium from 'cesium';
import { formatRelativeTime, msg, t, tn } from '../../i18n/index.js';
import { createGarage } from './garage.js';
export * from './garage.js';

export const MY_CARS_LAYER_ID = 'my-cars';
export const MY_CARS_OVERLAY_SOURCE_ID = 'my-cars';
export const MY_CARS_POINTER_OWNER = 'my-cars';
const PICK_PREFIX = 'my-car:';
const ACCENT = '#4fc3f7';
const DRIVING_ACCENT = '#66bb6a';
/** Drop GPS fixes worse than this; a city-block error would misplace a pin. */
export const DRIVE_MAX_ACCURACY_M = 100;
/** Write a driving fix at most this often unless the car moved far. */
export const DRIVE_MIN_INTERVAL_MS = 5000;
export const DRIVE_MIN_MOVE_M = 15;

/** Great-circle distance in metres between two {lat, lon} points. */
export function metresBetween(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a phone fix should move the driven car's pin. Pure, for tests.
 * @param {{lat: number, lon: number, accuracy?: number, at: number}} fix
 * @param {{lat: number, lon: number, at: number}|null} last Last written fix.
 * @returns {boolean}
 */
export function shouldApplyDriveFix(fix, last) {
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lon)) return false;
  if (Number.isFinite(fix.accuracy) && fix.accuracy > DRIVE_MAX_ACCURACY_M)
    return false;
  if (!last) return true;
  const moved = metresBetween(last, fix);
  if (moved >= DRIVE_MIN_MOVE_M * 10) return true;
  return moved >= DRIVE_MIN_MOVE_M && fix.at - last.at >= DRIVE_MIN_INTERVAL_MS;
}

/**
 * The operator's own cars as named pins they place, select, move and remove.
 *
 * A pin moves only when the operator moves it, or while "Driving" is on and
 * this page is open on the phone riding in that car: then the browser's own
 * location updates the pin. Nothing is read from the car itself.
 * @param {object} options
 * @param {object} options.services Scene owners: picking, scenePick, overlays,
 *   input, focus. See src/app/layers/myCars.js.
 * @param {Storage|null} [options.storage]
 * @param {Geolocation|null} [options.geolocation]
 * @param {(text: string, current: string) => string|null} [options.promptName]
 * @param {(text: string) => boolean} [options.confirmRemove]
 * @param {() => number} [options.now]
 */
export function createMyCarsLayer({
  services,
  storage = null,
  geolocation = null,
  promptName = () => null,
  confirmRemove = () => true,
  now = () => Date.now(),
} = {}) {
  if (!services?.overlays || !services?.input || !services?.scenePick)
    throw new TypeError('My cars require scene services');
  const garage = createGarage({ storage, now });
  let _viewer = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _enabled = false;
  let _selectedId = null;
  /** @type {null | {kind: 'add'} | {kind: 'move', id: string}} */
  let _armed = null;
  let _pointerClaim = null;
  let _releaseTimer = null;
  let _notice = null;
  let _drive = null; // {id, watchId, last, error}
  let _rowListener = null;
  let _lastUpdate = null;

  const notifyRow = () => _rowListener?.();
  const requestRender = () => _viewer?.scene?.requestRender?.();

  // --- Pointer ownership (the next globe tap places a car) -----------------

  function releaseClaim() {
    if (_releaseTimer) {
      clearTimeout(_releaseTimer);
      _releaseTimer = null;
    }
    if (_pointerClaim) services.input.releasePointer(_pointerClaim);
    _pointerClaim = null;
  }

  function disarm({ afterDispatch = false } = {}) {
    _armed = null;
    if (!afterDispatch) return releaseClaim();
    // Hold the pointer until this click has reached every other handler, so a
    // car placed on top of an aircraft does not also select the aircraft.
    if (_releaseTimer) clearTimeout(_releaseTimer);
    _releaseTimer = setTimeout(() => {
      _releaseTimer = null;
      releaseClaim();
    }, 0);
  }

  function arm(next) {
    if (!services.input.isLeaseCurrent(_pointerClaim)) {
      const lease = services.input.claimPointer(MY_CARS_POINTER_OWNER);
      if (!lease) {
        _armed = null;
        _notice = msg('Another map tool is using taps — close it first');
        return false;
      }
      _pointerClaim = lease;
    }
    if (_releaseTimer) {
      clearTimeout(_releaseTimer);
      _releaseTimer = null;
    }
    _notice = null;
    _armed = next;
    return true;
  }

  // --- Phone-follow driving -------------------------------------------------

  function stopDriving() {
    if (!_drive) return;
    if (_drive.watchId != null) geolocation?.clearWatch?.(_drive.watchId);
    _drive = null;
  }

  function startDriving(id) {
    stopDriving();
    if (!garage.get(id)) return false;
    if (typeof geolocation?.watchPosition !== 'function') {
      _notice = msg('This browser cannot share its location');
      return false;
    }
    const drive = { id, watchId: null, last: null, error: null };
    _drive = drive;
    _notice = null;
    drive.watchId = geolocation.watchPosition(
      (position) => {
        if (_drive !== drive) return;
        const fix = {
          lat: position?.coords?.latitude,
          lon: position?.coords?.longitude,
          accuracy: position?.coords?.accuracy,
          at: now(),
        };
        drive.error = null;
        if (!shouldApplyDriveFix(fix, drive.last)) return notifyRow();
        if (!garage.move(id, fix)) return stopDriving();
        drive.last = { lat: fix.lat, lon: fix.lon, at: fix.at };
        render();
        notifyRow();
      },
      (error) => {
        if (_drive !== drive) return;
        // 1 = permission denied: nothing will ever arrive, so stop.
        if (error?.code === 1) {
          stopDriving();
          _notice = msg('Location permission was denied');
        } else {
          drive.error = msg('Waiting for a GPS fix');
        }
        notifyRow();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
    return true;
  }

  // --- Scene ---------------------------------------------------------------

  function render() {
    if (!_dataSource) return;
    const cars = garage.list();
    if (_selectedId && !garage.get(_selectedId)) _selectedId = null;
    _dataSource.entities.removeAll();
    const entries = [];
    for (const car of cars) {
      const driving = _drive?.id === car.id;
      const selected = car.id === _selectedId;
      const color = Cesium.Color.fromCssColorString(
        driving ? DRIVING_ACCENT : ACCENT,
      );
      const position = Cesium.Cartesian3.fromDegrees(car.lon, car.lat);
      _dataSource.entities.add({
        id: `${PICK_PREFIX}${car.id}`,
        position,
        point: {
          pixelSize: selected ? 18 : 14,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: selected ? 3 : 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entries.push(
        selected
          ? {
              id: `my-car-card:${car.id}`,
              position,
              selected: true,
              interactive: false,
              title: car.name,
              details: [carStatusText(car)],
              accent: driving ? DRIVING_ACCENT : ACCENT,
              priority: Number.MAX_SAFE_INTEGER,
              gapPx: 15,
              verticalOnly: true,
              placement: 'above',
            }
          : {
              id: `my-car-label:${car.id}`,
              position,
              variant: 'label',
              title: car.name,
              accent: ACCENT,
              priority: 1000,
              collisionGroup: 'ambient-label',
              paintLane: 'ambient-label',
              interactive: false,
              edgeFade: 'keyhole',
              horizonCull: true,
              terrainOcclusion: false,
              gapPx: 12,
              verticalOnly: true,
              placement: 'above',
            },
      );
    }
    if (_enabled)
      services.overlays.setOverlayEntries(MY_CARS_OVERLAY_SOURCE_ID, entries, {
        cohortLimit: 64,
        collisionCapacity: 64,
        moving: Boolean(_drive),
      });
    _lastUpdate = now();
    requestRender();
  }

  function carStatusText(car) {
    if (_drive?.id === car.id)
      return _drive.error
        ? t(_drive.error)
        : t('Following this phone while the app is open');
    return car.placedAt
      ? t('Placed {age}', { age: formatRelativeTime(car.placedAt) })
      : t('Placed by hand');
  }

  function select(id, { fly = false } = {}) {
    const car = id ? garage.get(id) : null;
    _selectedId = car ? car.id : null;
    render();
    notifyRow();
    if (car && fly)
      services.focus?.requestCarFocus?.({
        id: car.id,
        position: Cesium.Cartesian3.fromDegrees(car.lon, car.lat),
      });
  }

  function placeAt(point) {
    const armed = _armed;
    disarm({ afterDispatch: true });
    if (armed?.kind === 'move') {
      if (_drive?.id === armed.id) stopDriving();
      garage.move(armed.id, point);
      select(armed.id);
      return;
    }
    const count = garage.size + 1;
    const fallback = t('Car {count}', { count });
    const name = promptName(t('Nickname for this car'), fallback);
    if (name == null) {
      notifyRow();
      return;
    }
    const car = garage.add(String(name).trim() || fallback, point);
    if (!car) _notice = msg('Could not add that car');
    select(car?.id ?? _selectedId);
  }

  function pickGround(screenPosition) {
    const cartesian = services.scenePick.pickGroundPosition(
      _viewer,
      screenPosition,
    );
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  function pickedCarId(picked) {
    const pickId = services.picking?.resolvePickId?.(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return garage.get(id) ? id : null;
  }

  function onClick(click) {
    if (!_enabled || !_viewer) return;
    if (_armed && services.input.isLeaseCurrent(_pointerClaim)) {
      const point = pickGround(click.position);
      if (point) placeAt(point);
      return;
    }
    if (!services.input.isPointerFree()) return;
    let picked = null;
    try {
      picked = _viewer.scene.pick(click.position);
    } catch {
      picked = null;
    }
    const id = picked ? pickedCarId(picked) : null;
    if (id) return select(id);
    if (picked) {
      const pickId = services.picking?.resolvePickId?.(picked);
      if (pickId && services.picking?.isOwnedByOtherLayer?.(layer.id, pickId))
        return;
    }
    if (_selectedId) select(null);
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !_armed) return;
    disarm();
    notifyRow();
  }

  function installInput() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = services.createClickHandler?.(_viewer) ?? null;
    _clickHandler?.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    services.picking?.registerPickOwner?.(
      MY_CARS_LAYER_ID,
      (pickId) => typeof pickId === 'string' && pickId.startsWith(PICK_PREFIX),
    );
    globalThis.document?.addEventListener?.('keydown', onKeyDown);
  }

  function removeInput() {
    _clickHandler?.destroy?.();
    _clickHandler = null;
    services.picking?.unregisterPickOwner?.(MY_CARS_LAYER_ID);
    globalThis.document?.removeEventListener?.('keydown', onKeyDown);
  }

  // --- Commands (row chips and params) ------------------------------------

  function command(name) {
    const id = _selectedId;
    switch (name) {
      case 'add':
        if (_armed?.kind === 'add') disarm();
        else arm({ kind: 'add' });
        break;
      case 'move':
        if (!id) return false;
        if (_armed?.kind === 'move') disarm();
        else arm({ kind: 'move', id });
        break;
      case 'rename': {
        const car = id ? garage.get(id) : null;
        if (!car) return false;
        const name = promptName(t('Nickname for this car'), car.name);
        if (name != null) garage.rename(id, name);
        render();
        break;
      }
      case 'remove': {
        const car = id ? garage.get(id) : null;
        if (!car) return false;
        if (!confirmRemove(t('Remove {name}?', { name: car.name }))) break;
        if (_drive?.id === id) stopDriving();
        if (_armed?.kind === 'move' && _armed.id === id) disarm();
        garage.remove(id);
        _selectedId = null;
        render();
        break;
      }
      case 'drive':
        if (!id) return false;
        if (_drive?.id === id) stopDriving();
        else startDriving(id);
        render();
        break;
      default:
        return false;
    }
    notifyRow();
    return true;
  }

  const layer = {
    id: MY_CARS_LAYER_ID,
    name: 'My Cars',
    icon: '🚗',
    source: 'Placed by you',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('My cars layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(MY_CARS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      services.overlays.setOverlaySourceVisible(
        MY_CARS_OVERLAY_SOURCE_ID,
        true,
      );
      installInput();
      render();
    },

    disable() {
      _enabled = false;
      disarm();
      stopDriving();
      _notice = null;
      removeInput();
      if (_dataSource) _dataSource.show = false;
      services.overlays.clearOverlaySource(MY_CARS_OVERLAY_SOURCE_ID);
      services.overlays.setOverlaySourceVisible(
        MY_CARS_OVERLAY_SOURCE_ID,
        false,
      );
    },

    /** Refresh the "placed … ago" line; positions change only on commands. */
    async update() {
      if (!_enabled) return false;
      render();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _rowListener = null;
    },

    /**
     * `select` picks a car by id (null clears) and flies to it; `command`
     * runs one of add / move / rename / remove / drive on the selection.
     */
    setParams(params = {}) {
      if (Object.hasOwn(params, 'select')) {
        const id = params.select == null ? null : String(params.select);
        if (id && !garage.get(id)) return false;
        select(id, { fly: Boolean(id) });
      }
      if (params.command != null) return command(String(params.command));
      return true;
    },

    getParams() {
      return { select: _selectedId };
    },

    getRowControls() {
      const cars = garage.list();
      const selected = _selectedId ? garage.get(_selectedId) : null;
      const chips = [
        {
          id: 'add',
          label: _armed?.kind === 'add' ? t('Tap the map…') : t('Add car'),
          active: _armed?.kind === 'add',
          onClick: () => command('add'),
        },
      ];
      if (selected) {
        const driving = _drive?.id === selected.id;
        chips.push(
          {
            id: 'drive',
            label: driving ? t('Parked') : t('Driving'),
            active: driving,
            title: driving
              ? t('Stop following this phone and leave the pin here')
              : t('Move this pin with this phone while the app is open'),
            onClick: () => command('drive'),
          },
          {
            id: 'move',
            label: _armed?.kind === 'move' ? t('Tap the map…') : t('Move'),
            active: _armed?.kind === 'move',
            onClick: () => command('move'),
          },
          {
            id: 'rename',
            label: t('Rename'),
            onClick: () => command('rename'),
          },
          {
            id: 'remove',
            label: t('Remove'),
            onClick: () => command('remove'),
          },
        );
      }
      let info = '';
      if (_notice) info = t(_notice);
      else if (_armed?.kind === 'add')
        info = t('Tap the map where the car is parked');
      else if (_armed?.kind === 'move')
        info = t('Tap the map where {name} is now', {
          name: garage.get(_armed.id)?.name ?? '',
        });
      else if (!cars.length) info = t('No cars yet — press Add car');
      return {
        chips,
        info,
        list: {
          ariaLabel: t('My cars'),
          items: cars.map((car, index) => ({
            id: car.id,
            ordinal: index + 1,
            lead: _drive?.id === car.id ? '●' : '🚗',
            text: car.name,
            active: car.id === _selectedId,
            params: { select: car.id },
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** JSON-safe records for the analyst query engine. */
    getAnalystRecords(maxCount = 50) {
      if (!_enabled) return [];
      return garage
        .list()
        .slice(0, Math.max(1, Math.floor(maxCount) || 50))
        .map((car) => ({
          id: car.id,
          name: car.name,
          lat: car.lat,
          lon: car.lon,
          placedAtMs: car.placedAt,
          driving: _drive?.id === car.id,
        }));
    },

    getStats() {
      const count = garage.size;
      return {
        count,
        countLabel: count
          ? tn(count, '{count} car', '{count} cars', { count })
          : '',
        lastUpdate: _lastUpdate,
        error: null,
      };
    },
  };
  return layer;
}

import * as Cesium from 'cesium';
import { formatRelativeTime, msg, t, tn } from '../../i18n/index.js';
import {
  DETROIT_CATEGORIES,
  DETROIT_CATEGORY_LABEL,
  DETROIT_DATASETS,
  bboxParam,
  datasetsInCategory,
  normalizeFeature,
} from './datasets.js';
export * from './datasets.js';

export const DETROIT_LAYER_ID = 'detroit-open-data';
export const DETROIT_OVERLAY_SOURCE_ID = 'detroit-open-data';
const PICK_PREFIX = 'detroit:';
/** Only fetch when the view is this many degrees across or tighter. */
const MAX_VIEW_SPAN_DEG = 1.2;
/** Detroit-metro gate so the layer never queries for an unrelated view. */
const METRO = Object.freeze({
  west: -83.8,
  south: 42.0,
  east: -82.6,
  north: 42.75,
});

function rectIntersectsMetro(rect) {
  return !(
    rect.east < METRO.west ||
    rect.west > METRO.east ||
    rect.north < METRO.south ||
    rect.south > METRO.north
  );
}

/**
 * City of Detroit open data on the globe: traffic signals (civic), recent
 * crime and fire runs (incidents) and roadwork (road), toggled by category.
 *
 * Data is fetched for the current map area from `/api/detroit/<dataset>` only
 * while the view is over metro Detroit and zoomed in, so large city datasets
 * stay fast and relevant. Points render as coloured dots and roadwork as
 * lines; a click shows the record's details.
 */
export function createDetroitLayer({
  services,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  if (
    !services?.overlays ||
    !services?.picking ||
    !services?.createClickHandler
  )
    throw new TypeError('Detroit layer requires scene services');
  let _viewer = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _moveRemover = null;
  let _enabled = false;
  let _selectedId = null;
  let _rowListener = null;
  let _lastBbox = null;
  let _lastUpdate = null;
  let _note = null;
  let _debounce = null;
  const _on = new Set(DETROIT_CATEGORIES); // all categories on by default
  /** datasetId → Array<record> */
  const _features = new Map();
  const _requests = new Map();

  const notifyRow = () => _rowListener?.();
  const requestRender = () => _viewer?.scene?.requestRender?.();

  function enabledDatasets() {
    return Object.keys(DETROIT_DATASETS).filter((id) =>
      _on.has(DETROIT_DATASETS[id].category),
    );
  }

  function allRecords() {
    const out = [];
    for (const id of enabledDatasets())
      for (const rec of _features.get(id) || []) out.push(rec);
    return out;
  }

  function viewRect() {
    const rect = _viewer?.camera?.computeViewRectangle?.();
    if (!rect) return null;
    return {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
  }

  async function refresh() {
    if (!_enabled) return;
    const rect = viewRect();
    if (!rect || !rectIntersectsMetro(rect)) {
      _note = msg('Fly to Detroit to load city data');
      return notifyRow();
    }
    if (
      rect.east - rect.west > MAX_VIEW_SPAN_DEG ||
      rect.north - rect.south > MAX_VIEW_SPAN_DEG
    ) {
      _note = msg('Zoom in to load Detroit city data');
      return notifyRow();
    }
    _note = null;
    const bbox = bboxParam(rect);
    _lastBbox = bbox;
    await Promise.all(
      enabledDatasets().map((id) => fetchDataset(id, bbox, rect)),
    );
  }

  async function fetchDataset(datasetId, bbox, rect) {
    const key = `${datasetId}|${bbox}`;
    _requests.get(datasetId)?.abort();
    const controller = new AbortController();
    _requests.set(datasetId, controller);
    try {
      const params = new URLSearchParams({
        bbox: `${rect.west},${rect.south},${rect.east},${rect.north}`,
      });
      const response = await fetchImpl(`/api/detroit/${datasetId}?${params}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (controller.signal.aborted || !_enabled || _lastBbox !== bbox) return;
      const records = [];
      (payload?.features || []).forEach((feature, index) => {
        const rec = normalizeFeature(datasetId, feature, index);
        if (rec) records.push(rec);
      });
      _features.set(datasetId, records);
      _lastUpdate = now();
      render();
      notifyRow();
    } catch (error) {
      if (!controller.signal.aborted) _note = msg('A Detroit feed failed');
    } finally {
      if (_requests.get(datasetId) === controller) _requests.delete(datasetId);
    }
  }

  function render() {
    if (!_dataSource) return;
    const records = allRecords();
    const byId = new Map(records.map((r) => [r.id, r]));
    if (_selectedId && !byId.has(_selectedId)) _selectedId = null;
    _dataSource.entities.removeAll();
    const entries = [];
    for (const rec of records) {
      const color = Cesium.Color.fromCssColorString(
        DETROIT_DATASETS[rec.datasetId].color,
      );
      const selected = rec.id === _selectedId;
      if (rec.path) {
        _dataSource.entities.add({
          id: `${PICK_PREFIX}${rec.id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(rec.path.flat()),
            width: selected ? 6 : 4,
            material: color.withAlpha(selected ? 1 : 0.85),
            clampToGround: true,
          },
        });
        continue;
      }
      const position = Cesium.Cartesian3.fromDegrees(rec.lon, rec.lat);
      _dataSource.entities.add({
        id: `${PICK_PREFIX}${rec.id}`,
        position,
        point: {
          pixelSize: selected ? 14 : 8,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: selected ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      if (selected)
        entries.push({
          id: `detroit-card:${rec.id}`,
          position,
          selected: true,
          interactive: false,
          title: `${t(DETROIT_DATASETS[rec.datasetId].label)} · ${rec.title}`,
          details: rec.details.map((d) => String(d)),
          accent: DETROIT_DATASETS[rec.datasetId].color,
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 15,
          verticalOnly: true,
          placement: 'above',
        });
    }
    if (_enabled)
      services.overlays.setOverlayEntries(DETROIT_OVERLAY_SOURCE_ID, entries, {
        cohortLimit: 8,
        collisionCapacity: 8,
        moving: false,
      });
    requestRender();
  }

  function scheduleRefresh() {
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      _debounce = null;
      void refresh();
    }, 400);
  }

  function onClick(click) {
    if (!_enabled || !_viewer) return;
    if (!services.input?.isPointerFree?.()) return;
    let picked = null;
    try {
      picked = _viewer.scene.pick(click.position);
    } catch {
      picked = null;
    }
    const pickId = picked ? services.picking.resolvePickId?.(picked) : null;
    if (typeof pickId === 'string' && pickId.startsWith(PICK_PREFIX)) {
      _selectedId = pickId.slice(PICK_PREFIX.length);
      render();
      return notifyRow();
    }
    if (pickId && services.picking.isOwnedByOtherLayer?.(layer.id, pickId))
      return;
    if (_selectedId) {
      _selectedId = null;
      render();
      notifyRow();
    }
  }

  const layer = {
    id: DETROIT_LAYER_ID,
    name: 'Detroit Open Data',
    icon: '🏙️',
    source: 'City of Detroit · MDOT',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer) throw new Error('Detroit layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(DETROIT_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      services.overlays.setOverlaySourceVisible(
        DETROIT_OVERLAY_SOURCE_ID,
        true,
      );
      if (!_clickHandler && _viewer) {
        _clickHandler = services.createClickHandler(_viewer);
        _clickHandler.setInputAction(
          onClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
        services.picking.registerPickOwner?.(
          DETROIT_LAYER_ID,
          (id) => typeof id === 'string' && id.startsWith(PICK_PREFIX),
        );
      }
      if (!_moveRemover && _viewer)
        _moveRemover = _viewer.camera.moveEnd.addEventListener(scheduleRefresh);
      void refresh();
    },

    disable() {
      _enabled = false;
      if (_debounce) clearTimeout(_debounce);
      _debounce = null;
      for (const c of _requests.values()) c.abort();
      _requests.clear();
      _moveRemover?.();
      _moveRemover = null;
      _clickHandler?.destroy?.();
      _clickHandler = null;
      services.picking.unregisterPickOwner?.(DETROIT_LAYER_ID);
      if (_dataSource) _dataSource.show = false;
      services.overlays.clearOverlaySource(DETROIT_OVERLAY_SOURCE_ID);
      services.overlays.setOverlaySourceVisible(
        DETROIT_OVERLAY_SOURCE_ID,
        false,
      );
    },

    async update() {
      if (!_enabled) return false;
      await refresh();
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _rowListener = null;
    },

    /** `category:<civic|incidents|road>` toggles a category. */
    setParams(params = {}) {
      if (params.command != null) {
        const name = String(params.command);
        if (name.startsWith('category:')) {
          const cat = name.slice(9);
          if (!DETROIT_CATEGORIES.includes(cat)) return false;
          if (_on.has(cat)) _on.delete(cat);
          else _on.add(cat);
          render();
          void refresh();
          notifyRow();
          return true;
        }
        return false;
      }
      return true;
    },

    getRowControls() {
      const chips = DETROIT_CATEGORIES.map((cat) => ({
        id: `cat-${cat}`,
        label: t(DETROIT_CATEGORY_LABEL[cat]),
        active: _on.has(cat),
        onClick: () => layer.setParams({ command: `category:${cat}` }),
      }));
      const counts = enabledDatasets().reduce(
        (sum, id) => sum + (_features.get(id)?.length || 0),
        0,
      );
      let info;
      if (_note) info = t(_note);
      else if (_lastUpdate)
        info = t('{count} shown · updated {age}', {
          count: counts,
          age: formatRelativeTime(
            Math.round((_lastUpdate - now()) / 1000),
            'second',
          ),
        });
      else info = t('Fly to Detroit and zoom in');
      return { chips, info };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getAnalystRecords(maxCount = 300) {
      if (!_enabled) return [];
      return allRecords()
        .slice(0, Math.max(1, maxCount | 0))
        .map((rec) => ({
          id: rec.id,
          dataset: rec.datasetId,
          category: rec.category,
          title: rec.title,
          lat: rec.lat ?? null,
          lon: rec.lon ?? null,
        }));
    },

    getStats() {
      const count = allRecords().length;
      return {
        count,
        countLabel: count
          ? tn(count, '{count} feature', '{count} features', { count })
          : '',
        lastUpdate: _lastUpdate,
        error: null,
      };
    },
  };
  return layer;
}

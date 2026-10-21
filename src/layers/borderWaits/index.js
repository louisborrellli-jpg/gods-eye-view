import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import { headlineMinutes, waitColor } from './records.js';
export * from './records.js';

export const BORDER_WAITS_LAYER_ID = 'border-waits';
export const BORDER_WAITS_OVERLAY_SOURCE_ID = 'border-waits';
const PICK_PREFIX = 'border-crossing:';

/** Short wait label for a flow cell: "No delay", "25 min", "Closed", "—". */
function flowLabel(cell) {
  if (!cell) return t('—');
  if (cell.closed) return t('Closed');
  if (cell.minutes === 0) return t('No delay');
  if (Number.isFinite(cell.minutes))
    return t('{count} min', { count: cell.minutes });
  return t('—');
}

/**
 * Live Canada–U.S. border crossing wait times as pins on the globe.
 *
 * Positions and names come from the CBSA feed via `/api/border/waits`; each
 * pin is coloured by its longest reported wait, and a click shows the
 * commercial and travellers waits for both directions. CBSA reports entry into
 * Canada; the U.S. CBP direction reads as "—" until that feed is merged.
 */
export function createBorderWaitsLayer({
  services,
  endpoint = '/api/border/waits',
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  if (
    !services?.overlays ||
    !services?.picking ||
    !services?.createClickHandler
  )
    throw new TypeError('Border waits require scene services');
  let _viewer = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _enabled = false;
  let _request = null;
  let _selectedId = null;
  let _rows = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _feedTime = null;

  const requestRender = () => _viewer?.scene?.requestRender?.();

  function crossingById(id) {
    return _rows.find((row) => row.id === id) || null;
  }

  function detailLines(row) {
    return [
      t('Into Canada — cars {travellers}, trucks {commercial}', {
        travellers: flowLabel(row.canadaBound?.travellers),
        commercial: flowLabel(row.canadaBound?.commercial),
      }),
      t('Into U.S. — cars {travellers}, trucks {commercial}', {
        travellers: flowLabel(row.usBound?.travellers),
        commercial: flowLabel(row.usBound?.commercial),
      }),
    ];
  }

  function render() {
    if (!_dataSource) return;
    if (_selectedId && !crossingById(_selectedId)) _selectedId = null;
    _dataSource.entities.removeAll();
    const entries = [];
    for (const row of _rows) {
      const minutes = headlineMinutes(row);
      const accent = waitColor(minutes);
      const selected = row.id === _selectedId;
      const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
      _dataSource.entities.add({
        id: `${PICK_PREFIX}${row.id}`,
        position,
        point: {
          pixelSize: selected ? 16 : 11,
          color: Cesium.Color.fromCssColorString(accent),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: selected ? 3 : 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const headline =
        minutes === 0
          ? t('No delay')
          : Number.isFinite(minutes)
            ? t('{count} min', { count: minutes })
            : t('—');
      entries.push(
        selected
          ? {
              id: `border-card:${row.id}`,
              position,
              selected: true,
              interactive: false,
              title: row.name,
              details: [
                ...detailLines(row),
                row.updated ? t('Updated {when}', { when: row.updated }) : '',
              ].filter(Boolean),
              accent,
              priority: Number.MAX_SAFE_INTEGER,
              gapPx: 15,
              verticalOnly: true,
              placement: 'above',
            }
          : {
              id: `border-label:${row.id}`,
              position,
              variant: 'label',
              title: `${row.name} · ${headline}`,
              accent,
              priority: 3000 + (Number.isFinite(minutes) ? minutes : 0),
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
      services.overlays.setOverlayEntries(
        BORDER_WAITS_OVERLAY_SOURCE_ID,
        entries,
        { cohortLimit: 64, collisionCapacity: 64, moving: false },
      );
    requestRender();
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
      return;
    }
    if (pickId && services.picking.isOwnedByOtherLayer?.(layer.id, pickId))
      return;
    if (_selectedId) {
      _selectedId = null;
      render();
    }
  }

  const layer = {
    id: BORDER_WAITS_LAYER_ID,
    name: 'Border Crossings',
    icon: '🛂',
    source: 'CBSA',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer) throw new Error('Border waits layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(BORDER_WAITS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      services.overlays.setOverlaySourceVisible(
        BORDER_WAITS_OVERLAY_SOURCE_ID,
        true,
      );
      if (!_clickHandler && _viewer) {
        _clickHandler = services.createClickHandler(_viewer);
        _clickHandler.setInputAction(
          onClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
        services.picking.registerPickOwner?.(
          BORDER_WAITS_LAYER_ID,
          (id) => typeof id === 'string' && id.startsWith(PICK_PREFIX),
        );
      }
      render();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      _clickHandler?.destroy?.();
      _clickHandler = null;
      services.picking.unregisterPickOwner?.(BORDER_WAITS_LAYER_ID);
      if (_dataSource) _dataSource.show = false;
      services.overlays.clearOverlaySource(BORDER_WAITS_OVERLAY_SOURCE_ID);
      services.overlays.setOverlaySourceVisible(
        BORDER_WAITS_OVERLAY_SOURCE_ID,
        false,
      );
    },

    async update() {
      if (!_enabled) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const response = await fetchImpl(endpoint, {
          signal: request.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`border HTTP ${response.status}`);
        const payload = await response.json();
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _rows = Array.isArray(payload?.crossings) ? payload.crossings : [];
        _count = _rows.length;
        _feedTime = Number.isFinite(payload?.fetchedAt)
          ? payload.fetchedAt
          : now();
        _lastUpdate = now();
        _lastError = null;
        render();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || msg('Border feed unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
    },

    /** JSON-safe records for the analyst query engine. */
    getAnalystRecords(maxCount = 40) {
      if (!_enabled) return [];
      return _rows.slice(0, Math.max(1, maxCount | 0)).map((row) => ({
        id: row.id,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        intoCanadaCarsMin: row.canadaBound?.travellers?.minutes ?? null,
        intoCanadaTrucksMin: row.canadaBound?.commercial?.minutes ?? null,
        intoUsCarsMin: row.usBound?.travellers?.minutes ?? null,
        intoUsTrucksMin: row.usBound?.commercial?.minutes ?? null,
        updated: row.updated,
      }));
    },

    getStats() {
      return {
        count: _count,
        countLabel: _count
          ? tn(_count, '{count} crossing', '{count} crossings', {
              count: _count,
            })
          : '',
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}

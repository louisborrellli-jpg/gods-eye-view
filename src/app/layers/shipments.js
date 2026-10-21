import * as Cesium from 'cesium';
import { createShipmentsLayer } from '../../layers/shipments/index.js';
import { createShipmentVesselSource } from '../../layers/shipments/source.js';
import { createShipmentsBoard } from '../../ui/shipmentsBoard.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { browserWatchNotifier } from './watchZones.js';

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Wire Shipments to the scene owners, browser storage and its board dialog. */
export function createApplicationShipments(options = {}) {
  let board = null;
  const layer = createShipmentsLayer({
    services: {
      picking,
      input,
      overlays: {
        setOverlayEntries: overlays.setOverlayEntries,
        setOverlaySourceVisible: overlays.setOverlaySourceVisible,
        clearOverlaySource: overlays.clearOverlaySource,
      },
      createClickHandler: (viewer) =>
        new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    },
    storage: browserStorage(),
    source: createShipmentVesselSource(),
    notifier: browserWatchNotifier,
    openBoard: (target) => {
      if (!globalThis.document?.body) return;
      board ??= createShipmentsBoard({ board: layer.board });
      board.open(target);
    },
    ...options,
  });
  const destroy = layer.destroy;
  layer.destroy = (...args) => {
    board?.destroy();
    board = null;
    return destroy(...args);
  };
  return layer;
}

import * as Cesium from 'cesium';
import { createBorderWaitsLayer } from '../../layers/borderWaits/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire the Border Crossings layer to the application scene owners. */
export function createApplicationBorderWaits(options = {}) {
  return createBorderWaitsLayer({
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
    ...options,
  });
}

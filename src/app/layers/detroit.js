import * as Cesium from 'cesium';
import { createDetroitLayer } from '../../layers/detroit/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire the Detroit Open Data layer to the application scene owners. */
export function createApplicationDetroit(options = {}) {
  return createDetroitLayer({
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

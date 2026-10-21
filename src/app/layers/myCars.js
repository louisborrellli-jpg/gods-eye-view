import * as Cesium from 'cesium';
import { createMyCarsLayer } from '../../layers/myCars/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as scenePick from '../../data/scenePick.js';
import * as input from '../../data/inputOwnership.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { requestWorldFocus } from '../../worldFocus.js';

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Wire the operator's own car pins to the application scene owners. */
export function createApplicationMyCars(options = {}) {
  return createMyCarsLayer({
    services: {
      picking,
      scenePick,
      input,
      overlays: {
        setOverlayEntries: overlays.setOverlayEntries,
        setOverlaySourceVisible: overlays.setOverlaySourceVisible,
        clearOverlaySource: overlays.clearOverlaySource,
      },
      focus: {
        requestCarFocus: ({ id, position }) =>
          requestWorldFocus({ kind: 'car', id, position }),
      },
      createClickHandler: (viewer) =>
        new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    },
    storage: browserStorage(),
    geolocation: globalThis.navigator?.geolocation ?? null,
    promptName: (text, current) =>
      typeof globalThis.prompt === 'function'
        ? globalThis.prompt(text, current)
        : current,
    confirmRemove: (text) =>
      typeof globalThis.confirm === 'function'
        ? globalThis.confirm(text)
        : true,
    ...options,
  });
}

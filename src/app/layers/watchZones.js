import * as Cesium from 'cesium';
import { createWatchZonesLayer } from '../../layers/watchZones/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as scenePick from '../../data/scenePick.js';
import * as input from '../../data/inputOwnership.js';
import * as overlays from '../../overlays/worldOverlay.js';

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let audio = null;

/** A short two-tone chirp; louder and lower for higher severity. */
function chirp(severity) {
  try {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return;
    audio ??= new Context();
    const start = audio.currentTime;
    const tones = severity >= 3 ? [880, 660, 880, 660] : [988, 1319];
    tones.forEach((frequency, index) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = frequency;
      const at = start + index * 0.12;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(
        severity >= 3 ? 0.12 : 0.06,
        at + 0.01,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.11);
    });
  } catch {
    /* sound is a courtesy */
  }
}

/** Browser alerts: a chirp always, a system notification when the tab is hidden. */
export const browserWatchNotifier = Object.freeze({
  requestPermission() {
    try {
      // Called from a chip press, so the browser treats it as user-initiated.
      if (globalThis.Notification?.permission === 'default')
        void globalThis.Notification.requestPermission();
      audio?.resume?.();
    } catch {
      /* optional */
    }
  },
  notify(text, { severity = 1 } = {}) {
    chirp(severity);
    try {
      if (
        globalThis.document?.visibilityState === 'hidden' &&
        globalThis.Notification?.permission === 'granted'
      )
        new globalThis.Notification('God’s Eye View', { body: text }); // i18n-ignore: product name
    } catch {
      /* optional */
    }
  },
});

/** Wire watch zones to the application scene owners and browser services. */
export function createApplicationWatchZones(options = {}) {
  return createWatchZonesLayer({
    services: {
      picking,
      scenePick,
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
    notifier: browserWatchNotifier,
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

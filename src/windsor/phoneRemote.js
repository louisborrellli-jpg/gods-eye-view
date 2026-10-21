/**
 * Phone remote, globe side. When the dev server runs with GEV_REMOTE=1, this
 * listens for commands from a paired phone (over the loopback-only stream at
 * /api/remote/events), runs them through the app's public handles, and posts
 * a small state summary back so the phone can show what's on.
 *
 * Until a phone pairs, a badge on screen shows the address to open on the
 * phone and the PIN. It disappears once a phone is connected.
 */

import { t } from '../i18n/index.js';
import { WINDSOR_START } from './windsorMode.js';
import {
  localCameraOrder,
  nudgeView,
  stepCamera,
  viewCentre,
} from './phoneRemoteCore.js';
import { createRemoteMotion } from './remoteMotion.js';
import {
  VOICE_LAYER_MANIFEST,
  VOICE_TOGGLE_LAYER_IDS,
} from '../voice/layerManifest.js';

const CROSSING_VIEWS = Object.freeze({
  'ambassador-bridge': { lat: 42.3118, lon: -83.074 },
  'windsor-detroit-tunnel': { lat: 42.3213, lon: -83.0405 },
  'gordie-howe-bridge': { lat: 42.2893, lon: -83.0985 },
});
// Every layer the app can toggle (the same list the voice agent uses).
const REPORT_LAYERS = VOICE_TOGGLE_LAYER_IDS;
const STATE_EVERY_MS = 4000;
const INFO_EVERY_MS = 10_000;
// v2: smooth used to be on by default and saved itself at start, so every
// browser had it stored; the new key starts everyone at full quality.
const SMOOTH_KEY = 'gev:phone-remote:smooth.v2';
// Smooth mode: render at ~70% resolution and load slightly coarser 3D tiles.
// On a laptop that is also encoding a screen-mirror stream this roughly
// doubles the frame rate, and on a TV across the room it's hard to tell.
const SMOOTH_RESOLUTION = 0.7;
const SMOOTH_TILE_ERROR = 32;

const CSS = `
#phone-remote-badge {
  position: fixed; right: 24px; bottom: 24px; z-index: 70;
  padding: 12px 16px; border-radius: 12px;
  border: 1px solid rgba(120, 220, 255, 0.45);
  background: rgba(6, 14, 22, 0.88); color: #d9f7ff;
  font: 12px var(--font-mono, ui-monospace, monospace); line-height: 1.6;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
#phone-remote-badge b { color: #7fe3ff; letter-spacing: 2px; font-weight: 600; }
#phone-remote-badge .pr-pin { font-size: 22px; letter-spacing: 6px; color: #fff; }
#phone-remote-toast {
  position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
  z-index: 71; padding: 10px 16px; border-radius: 10px;
  background: rgba(6, 14, 22, 0.9); color: #d9f7ff;
  border: 1px solid rgba(120, 220, 255, 0.45);
  font: 12px var(--font-mono, ui-monospace, monospace);
  transition: opacity 0.4s; pointer-events: none;
}
body.ui-clean-view #windsor-panel,
body.ui-clean-view #windsor-simple-btn,
body.ui-clean-view #phone-remote-badge { display: none !important; }
`;

async function waitForApp(win, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const app = win.__godsEyeView;
    if (app?.styleManager && app?.dataManager) return app;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Friendly names for the layer list (falls back to the first spoken alias). */
const LAYER_NAMES = Object.freeze({
  cctv: 'Traffic cameras',
  flights: 'Flights',
  military: 'Military aircraft',
  'local-adsb': 'Local ADS-B',
  'ais-live-vessels': 'Ships',
  satellites: 'Satellites',
  'rocket-launches': 'Rocket launches',
  earthquakes: 'Earthquakes',
  'local-firms': 'Active fires',
  'fire-perimeters': 'Fire perimeters',
  'weather-cyclones': 'Hurricanes',
  'weather-radar': 'Rain radar',
  'weather-satellite': 'Weather satellite',
  'weather-lightning': 'Lightning',
  wind: 'Wind',
  'air-quality': 'Air quality',
  traffic: 'Traffic flow',
  transit: 'Transit',
  bikeshare: 'Bike share',
  'alpr-cameras': 'Plate-reader sites',
  radio: 'Radio',
  'street-level': 'Street level',
  'recent-imagery': 'Recent imagery',
  directions: 'Directions',
  'military-installations': 'Military bases',
  'local-datacenters': 'Data centres',
  'local-dams': 'Dams',
  'telegeography-submarine-cables': 'Undersea cables',
  'gnss-integrity': 'GPS interference',
});
export const REMOTE_LAYER_LIST = Object.freeze(
  VOICE_LAYER_MANIFEST.filter((e) => e.toggle).map((e) => ({
    id: e.id,
    name: LAYER_NAMES[e.id] ?? e.aliases?.[0] ?? e.id,
  })),
);

/** One short line for the phone from whatever the action runner returned. */
export function summarizeResult(result) {
  const pick = (...values) =>
    values.find((v) => typeof v === 'string' && v.trim())?.trim();
  if (!result || typeof result !== 'object') return { ok: true, text: 'Done' };
  // Overtaken by a newer request (a second tap): not a failure, and the newer
  // request reports for itself.
  if (result.cancelled) return { ok: true, quiet: true, text: 'Changed again' };
  const failed = result.ok === false || Boolean(result.error);
  const text =
    pick(
      failed ? result.error : null,
      result.say,
      result.display?.text,
      result.summary,
      result.message,
      failed ? 'That didn’t work' : 'Done',
    ) ?? 'Done';
  return {
    ok: !failed,
    text: text.length > 140 ? `${text.slice(0, 137)}…` : text,
  };
}

export async function startPhoneRemote({
  win = globalThis.window,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const doc = win.document;
  const getInfo = async () => {
    try {
      const response = await fetchImpl('/api/remote/info', {
        cache: 'no-store',
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const info = await getInfo();
  if (!info?.enabled) return () => {};
  const app = await waitForApp(win);
  if (!app) return () => {};
  const { styleManager, dataManager } = app;
  const timers = [];

  const style = doc.createElement('style');
  style.id = 'phone-remote-style';
  style.textContent = CSS;
  doc.head.append(style);

  // ── Pairing badge ───────────────────────────────────────
  const badge = doc.createElement('div');
  badge.id = 'phone-remote-badge';
  function renderBadge(i) {
    badge.replaceChildren();
    if (!i?.enabled || i.paired) {
      badge.remove();
      return;
    }
    const title = doc.createElement('b');
    title.textContent = `📱 ${t('Phone remote')}`;
    const url = doc.createElement('div');
    url.textContent = t('Open {address}', {
      address:
        (i.urls?.[0] ?? '').replace(/^http:\/\//, '') ||
        t('this computer, port 4180'),
    });
    const pin = doc.createElement('div');
    pin.className = 'pr-pin';
    pin.textContent = i.pin;
    badge.append(title, url, pin);
    if (!badge.isConnected) doc.body.append(badge);
  }
  renderBadge(info);
  const infoTimer = setInterval(async () => {
    const latest = await getInfo();
    renderBadge(latest);
    if (latest?.paired) clearInterval(infoTimer);
  }, INFO_EVERY_MS);
  timers.push(infoTimer);

  const toast = doc.createElement('div');
  toast.id = 'phone-remote-toast';
  toast.style.opacity = '0';
  doc.body.append(toast);
  let toastTimer = null;
  function say(text) {
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.opacity = '0'), 1800);
  }

  // ── Actions ─────────────────────────────────────────────
  const cctv = () => dataManager.layers?.get?.('cctv')?.module ?? null;

  function stopOrbit() {
    if (styleManager.orbitController?.active)
      styleManager.orbitController.stop();
  }

  const motion = app.viewer
    ? createRemoteMotion({
        viewer: app.viewer,
        beforeStart: () => {
          stopOrbit();
          styleManager.supersedeDeferredNavigation?.();
        },
      })
    : null;

  // ── Smooth mode ─────────────────────────────────────────
  const baseResolution = app.viewer?.resolutionScale ?? 1;
  const baseTileError = app.tileset?.maximumScreenSpaceError;
  let smooth = false;
  function setSmooth(on, { remember = true } = {}) {
    smooth = on;
    if (app.viewer)
      app.viewer.resolutionScale = on ? SMOOTH_RESOLUTION : baseResolution;
    if (app.tileset && typeof baseTileError === 'number')
      app.tileset.maximumScreenSpaceError = on
        ? Math.max(baseTileError, SMOOTH_TILE_ERROR)
        : baseTileError;
    if (remember)
      try {
        win.localStorage.setItem(SMOOTH_KEY, on ? '1' : '0');
      } catch {
        /* best effort */
      }
    app.requestRender?.('phone-remote-smooth');
  }
  // Full quality unless someone chose Smooth on the remote (Look tab): smooth
  // renders the whole map softer, on this screen as well as the TV.
  let smoothSaved = '0';
  try {
    smoothSaved = win.localStorage.getItem(SMOOTH_KEY) ?? '0';
  } catch {
    /* default */
  }
  if (smoothSaved === '1') setSmooth(true, { remember: false });

  function flyTo(view, duration = 2.4) {
    motion?.stop();
    motion?.stopPad();
    stopOrbit();
    const go = () => styleManager.applyCameraState(view, duration);
    if (typeof styleManager.runImmediateLocationNavigation === 'function')
      styleManager.runImmediateLocationNavigation(go);
    else go();
    keepRendering(duration);
  }

  // The globe renders on demand; a short flight started from outside its own
  // controls can otherwise sit unrendered until something else asks for a
  // frame. Ask for frames until the flight has landed.
  let renderUntil = 0;
  function keepRendering(seconds) {
    const wasIdle = renderUntil < performance.now();
    renderUntil = Math.max(
      renderUntil,
      performance.now() + seconds * 1000 + 300,
    );
    if (!wasIdle || typeof app.requestRender !== 'function') return;
    const tick = () => {
      app.requestRender('phone-remote');
      if (performance.now() < renderUntil) win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  }

  function toggleLayer(id) {
    const on = !(
      dataManager.isEffectivelyEnabled?.(id) ?? dataManager.isEnabled(id)
    );
    dataManager.setEnabled(id, on, { origin: 'user' });
    return on;
  }

  function stepCam(step) {
    const layer = cctv();
    if (!dataManager.isEnabled('cctv'))
      dataManager.setEnabled('cctv', true, { origin: 'user' });
    const ui = layer?.getUIState?.();
    const id = stepCamera(
      localCameraOrder(ui?.cameras),
      ui?.activeCameraId,
      step,
    );
    if (!id) return say(t('Cameras still loading…'));
    stopOrbit();
    styleManager.supersedeDeferredNavigation?.();
    if (layer.selectCamera(id)) layer.focusCamera(id, 1.8);
  }

  function nearestCam() {
    const layer = cctv();
    if (!layer) return;
    stopOrbit();
    styleManager.supersedeDeferredNavigation?.();
    const id = layer.focusNearest({ focus: false });
    if (id) layer.focusCamera(id, 1.8);
  }

  function toggleOrbit() {
    const orbit = styleManager.orbitController;
    if (!orbit) return;
    if (orbit.active) return orbit.stop();
    const viewer = app.viewer;
    const view = styleManager.getCameraState?.();
    if (!viewer || !view) return;
    const canvas = viewer.scene.canvas;
    const middle = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    let target = null;
    try {
      const ray = viewer.camera.getPickRay(middle);
      target = ray ? viewer.scene.globe.pick(ray, viewer.scene) : null;
    } catch {
      /* fall back below */
    }
    target ??= viewer.camera.pickEllipsoid(middle);
    if (!target) return;
    const p = viewer.camera.positionWC;
    const range = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
    orbit.start(target, {
      radius: range || viewCentre(view).range,
      pitch: view.pitch,
      speed: 4,
    });
  }

  /** Turn on the Shipments layer and fly to one container's ship. */
  async function showShipment(id) {
    stopOrbit();
    try {
      if (!dataManager.isEnabled('shipments'))
        await dataManager.setEnabled('shipments', true, { origin: 'user' });
      dataManager.setLayerParams?.('shipments', { select: id });
    } catch {
      say(t('That container is not on the map yet'));
    }
  }

  function run({ cmd, arg }) {
    switch (cmd) {
      case 'paired':
        renderBadge({ enabled: true, paired: true });
        return say(`📱 ${t('Remote connected')}`);
      case 'home':
        return flyTo(WINDSOR_START);
      case 'layer':
        return toggleLayer(arg);
      case 'crossing': {
        const c = CROSSING_VIEWS[arg];
        if (c)
          flyTo({
            lat: c.lat - 0.012,
            lon: c.lon,
            alt: 1400,
            heading: 0,
            pitch: -38,
          });
        return;
      }
      case 'cam':
        if (arg === 'nearest') return nearestCam();
        return stepCam(arg === 'prev' ? -1 : 1);
      case 'hold':
        return motion?.hold(arg);
      case 'pad':
        return motion?.pad(arg);
      case 'release':
        return motion?.release();
      case 'action':
        return runAction(arg);
      case 'shipment':
        return showShipment(arg);
      case 'advanced': {
        // Show or hide the full control surface on the TV.
        const simpleBtn = doc.getElementById('windsor-simple-btn');
        const advancedBtn = doc.querySelector('#windsor-panel .wm-advanced');
        if (doc.body.classList.contains('windsor-mode')) advancedBtn?.click();
        else simpleBtn?.click();
        return;
      }
      case 'smooth':
        setSmooth(!smooth);
        return say(smooth ? t('Smooth mode on') : t('Full quality'));
      case 'move':
      case 'zoom':
      case 'turn':
      case 'tilt': {
        const next = nudgeView(styleManager.getCameraState?.(), cmd, arg);
        if (next) flyTo(next, 0.8);
        return;
      }
      case 'orbit':
        return toggleOrbit();
      case 'style':
        return styleManager.setStyle(arg, { userInitiated: true });
      case 'clean':
        return styleManager.toggleCleanView();
    }
  }

  // App actions go through the voice agent's own runner, so the phone gets
  // place search, every layer, plane following, map styles and more without
  // re-implementing any of it here. The server already checked them against
  // the action schemas.
  let lastResult = null;
  async function runAction({ name, args }) {
    const runner = app.voiceCommands?.runner;
    if (typeof runner !== 'function') {
      lastResult = { ok: false, text: 'Not available in this build' };
      return;
    }
    if (name !== 'set_layer_visibility') {
      motion?.stop();
      motion?.stopPad();
      stopOrbit();
    }
    let result;
    try {
      result = await runner(name, args);
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    lastResult = summarizeResult(result);
    if (!lastResult.ok) say(lastResult.text);
    keepRendering(3);
    postState();
  }

  // ── State back to the phone ─────────────────────────────
  function snapshot() {
    const layers = {};
    for (const id of REPORT_LAYERS) {
      try {
        // A layer still starting up counts as on (its target), so the phone
        // button doesn't flip back to off while it loads.
        layers[id] = Boolean(
          dataManager.isEffectivelyEnabled?.(id) ?? dataManager.isEnabled(id),
        );
      } catch {
        layers[id] = false;
      }
    }
    const control = styleManager.getControlState?.() ?? {};
    const cctvUi = cctv()?.getUIState?.();
    const cam = cctvUi?.activeCamera ?? null;
    return {
      mapStack: control.mapStack ?? null,
      hud: Boolean(control.hud?.visible),
      autoHop: Boolean(cctvUi?.autoHop),
      tracking: Boolean(app.viewer?.trackedEntity),
      advanced: !doc.body.classList.contains('windsor-mode'),
      detection: Boolean(
        control.detection?.detectionMode &&
        String(control.detection.detectionMode).toUpperCase() !== 'OFF',
      ),
      result: lastResult,
      layers,
      layerList: REMOTE_LAYER_LIST,
      style: control.style ?? 'normal',
      orbit: Boolean(control.orbiting),
      clean: Boolean(control.cleanView),
      smooth,
      camera: cam ? { name: cam.name ?? '', city: cam.city ?? '' } : null,
    };
  }
  async function postState() {
    try {
      await fetchImpl('/api/remote/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot()),
      });
    } catch {
      /* server restarting */
    }
  }
  postState();
  timers.push(setInterval(postState, STATE_EVERY_MS));

  // ── Command stream ──────────────────────────────────────
  const events = new win.EventSource('/api/remote/events');
  events.onmessage = (event) => {
    let command = null;
    try {
      command = JSON.parse(event.data);
    } catch {
      return;
    }
    const continuous = ['hold', 'release', 'pad'].includes(command?.cmd);
    try {
      run(command);
      if (!continuous) keepRendering(1);
    } catch (error) {
      console.warn('[phone remote] command failed', command, error);
    }
    // Let the change land before reporting it.
    if (!continuous) setTimeout(postState, 400);
  };

  return () => {
    events.close();
    motion?.stop();
    motion?.stopPad();
    for (const t of timers) clearInterval(t);
    clearTimeout(toastTimer);
    badge.remove();
    toast.remove();
    style.remove();
  };
}

/**
 * Phone remote, globe side. When the dev server runs with GEV_REMOTE=1, this
 * listens for commands from a paired phone (over the loopback-only stream at
 * /api/remote/events), runs them through the app's public handles, and posts
 * a small state summary back so the phone can show what's on.
 *
 * Until a phone pairs, a badge on screen shows the address to open on the
 * phone and the PIN. It disappears once a phone is connected.
 */

import { WINDSOR_START } from './windsorMode.js';
import {
  localCameraOrder,
  nudgeView,
  stepCamera,
  viewCentre,
} from './phoneRemoteCore.js';

const CROSSING_VIEWS = Object.freeze({
  'ambassador-bridge': { lat: 42.3118, lon: -83.074 },
  'windsor-detroit-tunnel': { lat: 42.3213, lon: -83.0405 },
  'gordie-howe-bridge': { lat: 42.2893, lon: -83.0985 },
});
const REPORT_LAYERS = Object.freeze([
  'cctv',
  'flights',
  'weather-radar',
  'ais-live-vessels',
  'traffic',
  'weather-lightning',
]);
const STATE_EVERY_MS = 4000;
const INFO_EVERY_MS = 10_000;

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
    title.textContent = '📱 PHONE REMOTE';
    const url = doc.createElement('div');
    url.textContent = `Open ${(i.urls?.[0] ?? '').replace(/^http:\/\//, '') || 'this computer, port 4180'}`;
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

  function flyTo(view, duration = 2.4) {
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
    const on = !dataManager.isEnabled(id);
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
    if (!id) return say('Cameras still loading…');
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

  function run({ cmd, arg }) {
    switch (cmd) {
      case 'paired':
        renderBadge({ enabled: true, paired: true });
        return say('📱 Remote connected');
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

  // ── State back to the phone ─────────────────────────────
  function snapshot() {
    const layers = {};
    for (const id of REPORT_LAYERS) {
      try {
        layers[id] = Boolean(dataManager.isEnabled(id));
      } catch {
        layers[id] = false;
      }
    }
    const control = styleManager.getControlState?.() ?? {};
    const cam = cctv()?.getUIState?.()?.activeCamera ?? null;
    return {
      layers,
      style: control.style ?? 'normal',
      orbit: Boolean(control.orbiting),
      clean: Boolean(control.cleanView),
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
    try {
      run(command);
      keepRendering(1);
    } catch (error) {
      console.warn('[phone remote] command failed', command, error);
    }
    // Let the change land before reporting it.
    setTimeout(postState, 400);
  };

  return () => {
    events.close();
    for (const t of timers) clearInterval(t);
    clearTimeout(toastTimer);
    badge.remove();
    toast.remove();
    style.remove();
  };
}

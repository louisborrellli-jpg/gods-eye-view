/**
 * Windsor mode: a simplified shell over God's Eye View for everyday use in
 * Windsor–Detroit. It opens on Windsor with cameras, flights and rain radar
 * on, hides the full control surface, and shows one small panel with:
 *   - Home (fly back to Windsor), Cameras, Flights, Radar toggles
 *   - a live border-wait board (from /api/border-waits); click a crossing to
 *     fly to it
 *   - Advanced, which restores the full interface (and a Simple button to
 *     come back). The choice is remembered per browser.
 *
 * Self-contained: it drives the app only through its existing public
 * handles (window.__godsEyeView: styleManager, dataManager), so upstream
 * changes to the full UI don't need merging here. Turn it off with
 * VITE_WINDSOR_MODE=0.
 */

import { t } from '../i18n/index.js';

export const WINDSOR_START = Object.freeze({
  // Camera sits south of downtown, looking north over Windsor, the river
  // and the Detroit skyline.
  lat: 42.24,
  lon: -83.045,
  alt: 6000,
  heading: 0,
  pitch: -40,
});
// cctv, flights, weather-radar (tokens from src/data/layerState.js).
export const WINDSOR_START_LAYERS = 'c.f.v';

const LAYERS = Object.freeze([
  { id: 'cctv', label: () => t('Cameras'), icon: '◉' },
  { id: 'flights', label: () => t('Flights'), icon: '✈' },
  { id: 'weather-radar', label: () => t('Radar'), icon: '☂' },
]);

const CROSSINGS = Object.freeze([
  { id: 'ambassador-bridge', short: 'Ambassador', lat: 42.3118, lon: -83.074 },
  {
    id: 'windsor-detroit-tunnel',
    short: 'Tunnel',
    lat: 42.3213,
    lon: -83.0405,
  },
  {
    id: 'gordie-howe-bridge',
    short: 'Gordie Howe',
    lat: 42.2893,
    lon: -83.0985,
  },
]);

const CLOCK_FORMAT = Object.freeze({ hour: '2-digit', minute: '2-digit' });
const STORAGE_KEY = 'gev:windsor-mode:advanced';
const BORDER_REFRESH_MS = 3 * 60_000;

/** On unless explicitly turned off with VITE_WINDSOR_MODE=0. */
export function windsorModeEnabled(flag) {
  return String(flag ?? '').trim() !== '0';
}

/** The share hash that opens the app on Windsor with the start layers on. */
export function windsorStartHash(
  view = WINDSOR_START,
  layers = WINDSOR_START_LAYERS,
) {
  return (
    `#v=2&lat=${view.lat}&lon=${view.lon}&alt=${view.alt}` +
    `&heading=${view.heading}&pitch=${view.pitch}&l=${layers}`
  );
}

/**
 * Before the app starts: with no link of its own, open on Windsor instead of
 * the default Austin tour, through the app's own share-link restore.
 */
export function prepareWindsorStart(win = globalThis.window) {
  if (!win?.location || win.location.hash) return false;
  win.history.replaceState(null, '', windsorStartHash());
  return true;
}

/** Format a border lane for the board: "—", "0", "12". */
export function formatWait(lane) {
  if (!lane || lane.unavailable) return '—';
  const t = lane.travellers;
  if (!t || t.status === 'closed')
    return t?.status === 'closed' ? 'closed' : '—';
  return Number.isInteger(t.minutes) ? String(t.minutes) : '—';
}

/** Rows for the board from a /api/border-waits snapshot. */
export function borderBoardRows(snapshot) {
  const byId = new Map((snapshot?.crossings ?? []).map((c) => [c.id, c]));
  return CROSSINGS.map((c) => {
    const row = byId.get(c.id);
    return {
      ...c,
      toUS: formatWait(row?.toUS),
      toCanada: formatWait(row?.toCanada),
    };
  });
}

const CSS = `
body.windsor-mode #top-center-actions,
body.windsor-mode #style-indicator,
body.windsor-mode #key-setup-chip,
body.windsor-mode #command-dock,
body.windsor-mode #control-panel,
body.windsor-mode #data-panel,
body.windsor-mode #scene-panel,
body.windsor-mode #pp-toggles,
body.windsor-mode #param-slider-panel,
body.windsor-mode #weather-panel,
body.windsor-mode #recent-imagery-panel,
body.windsor-mode #global-context-panel,
body.windsor-mode #radio-panel,
body.windsor-mode #cctv-enable-btn,
body.windsor-mode #cctv-source-badge,
body.windsor-mode #cctv-coverage-btn,
body.windsor-mode #cctv-auto-hop-btn,
body.windsor-mode #cctv-projection-btn,
body.windsor-mode #cctv-quality-chip,
body.windsor-mode #cctv-adjust-btn,
body.windsor-mode #cctv-cal-readout,
body.windsor-mode #cctv-calib-save-btn,
body.windsor-mode #cctv-calib-reset-btn,
body.windsor-mode #cctv-summary {
  display: none !important;
}
#windsor-panel {
  position: fixed;
  top: 120px;
  left: 36px;
  z-index: 60;
  width: 248px;
  padding: 14px 14px 10px;
  border: 1px solid rgba(120, 220, 255, 0.28);
  border-radius: 14px;
  background: rgba(6, 14, 22, 0.82);
  backdrop-filter: blur(8px);
  color: #d9f7ff;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
body:not(.windsor-mode) #windsor-panel { display: none; }
#windsor-panel h2 {
  margin: 0 0 10px;
  font-size: 11px;
  letter-spacing: 3px;
  font-weight: 600;
  color: #7fe3ff;
}
#windsor-panel .wm-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
#windsor-panel button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border-radius: 9px;
  border: 1px solid rgba(120, 220, 255, 0.25);
  background: rgba(20, 40, 55, 0.6);
  padding: 9px 8px;
  text-align: left;
}
#windsor-panel button:hover { border-color: rgba(120, 220, 255, 0.6); }
#windsor-panel button[aria-pressed='true'] {
  background: rgba(0, 170, 220, 0.25);
  border-color: rgba(120, 220, 255, 0.75);
  color: #ffffff;
}
#windsor-panel .wm-border { margin-top: 12px; }
#windsor-panel .wm-border h3 {
  margin: 0 0 6px;
  font-size: 10px;
  letter-spacing: 2px;
  font-weight: 600;
  color: #7fe3ff;
  display: flex;
  justify-content: space-between;
}
#windsor-panel table { width: 100%; border-collapse: collapse; }
#windsor-panel th {
  font-weight: 400;
  font-size: 10px;
  color: rgba(217, 247, 255, 0.55);
  text-align: right;
  padding: 0 0 4px;
}
#windsor-panel th:first-child { text-align: left; }
#windsor-panel td { padding: 5px 0; border-top: 1px solid rgba(120, 220, 255, 0.12); text-align: right; }
#windsor-panel td:first-child { text-align: left; }
#windsor-panel tr.wm-crossing { cursor: pointer; }
#windsor-panel tr.wm-crossing:hover td { color: #ffffff; }
#windsor-panel .wm-slow { color: #ffb347; }
#windsor-panel .wm-bad { color: #ff6b6b; }
#windsor-panel .wm-note { margin-top: 6px; font-size: 10px; color: rgba(217, 247, 255, 0.5); }
#windsor-panel .wm-advanced {
  margin-top: 10px;
  width: 100%;
  text-align: center;
  background: transparent;
  border-style: dashed;
  font-size: 11px;
  letter-spacing: 1px;
}
#windsor-simple-btn {
  position: fixed;
  left: 36px;
  bottom: 24px;
  z-index: 60;
  font: 600 11px var(--font-mono, ui-monospace, monospace);
  letter-spacing: 1.5px;
  color: #d9f7ff;
  background: rgba(6, 14, 22, 0.85);
  border: 1px solid rgba(120, 220, 255, 0.45);
  border-radius: 10px;
  padding: 10px 14px;
  cursor: pointer;
}
body.windsor-mode #windsor-simple-btn { display: none; }
`;

function waitClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n >= 30) return 'wm-bad';
  if (n >= 15) return 'wm-slow';
  return '';
}

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Wait for the app's public handle (set during start). */
async function waitForApp(win, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const app = win.__godsEyeView;
    if (app?.styleManager && app?.dataManager) return app;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * After the app starts: mount the Windsor panel and apply the simple shell.
 * Returns a cleanup function.
 */
export async function startWindsorMode({
  win = globalThis.window,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const doc = win.document;
  const app = await waitForApp(win);
  if (!app) {
    console.warn('[Windsor mode] app handle unavailable; leaving the full UI');
    return () => {};
  }
  const { styleManager, dataManager } = app;
  const timers = [];

  const style = el(doc, 'style', { id: 'windsor-mode-style' });
  style.textContent = CSS;
  doc.head.append(style);

  let advanced = false;
  try {
    advanced = win.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    /* storage can be unavailable; default to simple */
  }
  const setAdvanced = (on) => {
    advanced = on;
    doc.body.classList.toggle('windsor-mode', !on);
    try {
      win.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* best effort */
    }
  };

  // ── Panel ───────────────────────────────────────────────
  const panel = el(doc, 'section', {
    id: 'windsor-panel',
    'aria-label': 'Windsor',
  });
  panel.append(el(doc, 'h2', {}, t('WINDSOR · LIVE')));

  const buttons = el(doc, 'div', { class: 'wm-buttons' });
  const home = el(
    doc,
    'button',
    { type: 'button', title: t('Fly back over Windsor') },
    `⌂ ${t('Windsor')}`,
  );
  home.addEventListener('click', () => flyTo(WINDSOR_START));
  buttons.append(home);

  const layerButtons = LAYERS.map((layer) => {
    const btn = el(
      doc,
      'button',
      { type: 'button', 'aria-pressed': 'false', 'data-layer': layer.id },
      `${layer.icon} ${layer.label()}`,
    );
    btn.addEventListener('click', () => {
      const on = !dataManager.isEnabled(layer.id);
      try {
        dataManager.setEnabled(layer.id, on, { origin: 'user' });
      } catch (error) {
        console.warn(`[Windsor mode] ${layer.id} toggle failed`, error);
      }
      syncButtons();
    });
    buttons.append(btn);
    return btn;
  });
  panel.append(buttons);

  const border = el(doc, 'div', { class: 'wm-border' });
  const borderTitle = el(doc, 'h3');
  borderTitle.append(
    el(doc, 'span', {}, t('BORDER WAIT')),
    el(doc, 'span', { class: 'wm-updated' }, ''),
  );
  const table = el(doc, 'table');
  const head = el(doc, 'tr');
  head.append(
    el(doc, 'th', {}, t('min')),
    el(doc, 'th', {}, `→ ${t('US')}`),
    el(doc, 'th', {}, `→ ${t('CA')}`),
  );
  const body = el(doc, 'tbody');
  table.append(el(doc, 'thead'), body);
  table.tHead.append(head);
  const note = el(
    doc,
    'div',
    { class: 'wm-note' },
    t('Cars, standard lanes. Click a crossing to fly there.'),
  );
  border.append(borderTitle, table, note);
  panel.append(border);

  const advancedBtn = el(
    doc,
    'button',
    { type: 'button', class: 'wm-advanced', title: t('Show every control') },
    `${t('ADVANCED')} ▸`,
  );
  advancedBtn.addEventListener('click', () => setAdvanced(true));
  panel.append(advancedBtn);

  const simpleBtn = el(
    doc,
    'button',
    {
      type: 'button',
      id: 'windsor-simple-btn',
      title: t('Back to the simple Windsor view'),
    },
    `◂ ${t('SIMPLE')}`,
  );
  simpleBtn.addEventListener('click', () => setAdvanced(false));

  doc.body.append(panel, simpleBtn);
  setAdvanced(advanced);

  // ── Behaviour ───────────────────────────────────────────
  function flyTo(view, duration = 2.4) {
    const go = () => styleManager.applyCameraState(view, duration);
    try {
      if (typeof styleManager.runImmediateLocationNavigation === 'function')
        styleManager.runImmediateLocationNavigation(go);
      else go();
    } catch (error) {
      console.warn('[Windsor mode] fly failed', error);
    }
  }

  function syncButtons() {
    for (const btn of layerButtons) {
      let on = false;
      try {
        on = Boolean(dataManager.isEnabled(btn.dataset.layer));
      } catch {
        /* unknown layer */
      }
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  syncButtons();
  timers.push(setInterval(syncButtons, 1500));

  function renderBorder(snapshot) {
    body.replaceChildren();
    for (const row of borderBoardRows(snapshot)) {
      const tr = el(doc, 'tr', {
        class: 'wm-crossing',
        title: t('Fly to the {crossing}', { crossing: row.short }),
      });
      tr.append(
        el(doc, 'td', {}, row.short),
        el(doc, 'td', { class: waitClass(row.toUS) }, row.toUS),
        el(doc, 'td', { class: waitClass(row.toCanada) }, row.toCanada),
      );
      tr.addEventListener('click', () =>
        flyTo({
          lat: row.lat - 0.012,
          lon: row.lon,
          alt: 1400,
          heading: 0,
          pitch: -38,
        }),
      );
      body.append(tr);
    }
    const at = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null;
    borderTitle.querySelector('.wm-updated').textContent =
      snapshot?.unavailable || !at
        ? t('No data')
        : at.toLocaleTimeString([], CLOCK_FORMAT) +
          (snapshot.stale ? ` ${t('(old)')}` : '');
  }

  async function refreshBorder() {
    try {
      const response = await fetchImpl('/api/border-waits', {
        cache: 'no-store',
      });
      renderBorder(response.ok ? await response.json() : { unavailable: true });
    } catch {
      renderBorder({ unavailable: true });
    }
  }
  renderBorder(null);
  refreshBorder();
  timers.push(setInterval(refreshBorder, BORDER_REFRESH_MS));

  // The camera viewer otherwise starts on the first catalog camera (Austin).
  // Once cameras load, ask it for the one nearest the view.
  let nearestTries = 0;
  const nearestTimer = setInterval(() => {
    nearestTries += 1;
    const select = doc.getElementById('cctv-camera-select');
    const nearest = doc.getElementById('cctv-nearest-btn');
    // Only once the view has settled over Windsor (NEAREST measures from the
    // view) and the local camera packs are in the list (Austin loads first).
    const pos = app.viewer?.camera?.positionCartographic;
    const lat = pos ? (pos.latitude * 180) / Math.PI : NaN;
    const lon = pos ? (pos.longitude * 180) / Math.PI : NaN;
    const overWindsor = lat > 41.9 && lat < 42.7 && lon > -83.5 && lon < -82.5;
    const localLoaded =
      select &&
      Array.from(select.options).some((o) => /^(on|mdot|ccg)-/.test(o.value));
    if (nearest && overWindsor && localLoaded && nearestTries >= 5) {
      clearInterval(nearestTimer);
      // NEAREST also flies down to that camera; keep its pick in the viewer
      // but put the overview back so you land on Windsor, not a tunnel.
      nearest.click();
      setTimeout(() => flyTo({ ...WINDSOR_START }, 0.6), 700);
    } else if (nearestTries > 120) clearInterval(nearestTimer);
  }, 1000);
  timers.push(nearestTimer);

  return () => {
    for (const t of timers) clearInterval(t);
    panel.remove();
    simpleBtn.remove();
    style.remove();
    doc.body.classList.remove('windsor-mode');
  };
}

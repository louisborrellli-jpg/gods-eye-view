// God's Eye phone remote. Served by the LAN remote server (server/remote).
(() => {
  const TOKEN_KEY = 'gev-remote-token';
  const TAB_KEY = 'gev-remote-tab';
  const CROSSINGS = [
    ['ambassador-bridge', 'Ambassador'],
    ['windsor-detroit-tunnel', 'Tunnel'],
    ['gordie-howe-bridge', 'Gordie Howe'],
  ];
  const STYLE_NAMES = {
    normal: 'Normal',
    surveillance: 'Night vision',
    thermal: 'Thermal',
    retro: 'Retro',
    noir: 'Noir',
    anime: 'Anime',
    snow: 'Snow',
  };
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        /* private mode */
      }
    },
  };

  let token = store.get(TOKEN_KEY);
  let state = null; // last state from the TV
  const saveToken = (value) => {
    token = value;
    store.set(TOKEN_KEY, value);
  };
  const buzz = () => navigator.vibrate?.(8);
  const showPair = (on) => document.body.classList.toggle('unpaired', on);

  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (response.status === 401 && path !== '/api/pair') {
      saveToken(null);
      showPair(true);
    }
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  // ── Pairing keypad ──────────────────────────────────────
  let entered = '';
  const boxes = Array.from($('pin-boxes').children);
  function drawPin() {
    boxes.forEach((box, i) => {
      box.textContent = entered[i] ? '•' : '';
      box.classList.toggle('filled', Boolean(entered[i]));
    });
  }
  async function submitPin() {
    const { ok, data } = await api('/api/pair', { pin: entered });
    entered = '';
    drawPin();
    if (ok && data.token) {
      saveToken(data.token);
      $('pair-error').textContent = '';
      showPair(false);
      refresh();
    } else {
      $('pair-error').textContent = data.error || 'Could not pair';
      navigator.vibrate?.([30, 40, 30]);
    }
  }
  for (const key of '123456789 0⌫') {
    const button = document.createElement('button');
    button.textContent = key.trim();
    if (key === ' ') button.style.visibility = 'hidden';
    button.addEventListener('click', () => {
      buzz();
      if (key === '⌫') entered = entered.slice(0, -1);
      else if (entered.length < 4) entered += key;
      drawPin();
      if (entered.length === 4) submitPin();
    });
    $('keys').append(button);
  }

  // ── Tabs ────────────────────────────────────────────────
  function showTab(name) {
    for (const b of document.querySelectorAll('#tabs [data-tab]'))
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const s of document.querySelectorAll('.tab'))
      s.classList.toggle('active', s.id === `tab-${name}`);
    store.set(TAB_KEY, name);
    window.scrollTo(0, 0);
  }
  for (const b of document.querySelectorAll('#tabs [data-tab]'))
    b.addEventListener('click', () => showTab(b.dataset.tab));
  showTab(store.get(TAB_KEY) || 'drive');

  // ── Sending ─────────────────────────────────────────────
  async function send(cmd, arg, { quiet = false } = {}) {
    if (!quiet) buzz();
    try {
      const { ok, data } = await api('/api/cmd', { cmd, arg: arg ?? null });
      if (data && data.tv === false) setTv(false);
      if (!ok && !quiet && data?.error) flash(data.error);
    } catch {
      setTv(false);
    }
    if (!quiet) setTimeout(refresh, 600);
  }
  const action = (name, args = {}) => send('action', { name, args });

  // Held buttons move the globe continuously: `hold` on press (repeated as a
  // keep-alive), `release` on lift. The TV stops by itself if keep-alives
  // stop, so a lost release can't leave it moving.
  for (const button of document.querySelectorAll('[data-hold]')) {
    const name = button.dataset.hold;
    let keepAlive = null;
    let pointer = null;
    const stop = (event) => {
      if (pointer === null || (event?.isTrusted && event.pointerId !== pointer))
        return;
      pointer = null;
      clearInterval(keepAlive);
      button.classList.remove('pressed');
      send('release', null, { quiet: true });
      setTimeout(refresh, 600);
    };
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      pointer = event.pointerId;
      button.setPointerCapture?.(event.pointerId);
      button.classList.add('pressed');
      send('hold', name);
      clearInterval(keepAlive);
      keepAlive = setInterval(() => send('hold', name, { quiet: true }), 300);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      button.addEventListener(type, stop);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden)
      for (const b of document.querySelectorAll('[data-hold].pressed'))
        b.dispatchEvent(new PointerEvent('pointercancel'));
  });

  // Simple buttons.
  document.addEventListener('click', (event) => {
    const b = event.target.closest('#main button');
    if (!b || b.hasAttribute('data-hold')) return;
    const d = b.dataset;
    if (d.cmd) return send(d.cmd, d.arg);
    if (d.place) return action('fly_to_location', { query: d.place });
    if (d.action) {
      let args = {};
      try {
        args = d.args ? JSON.parse(d.args) : {};
      } catch {
        /* none */
      }
      return action(d.action, args);
    }
    if (d.layer)
      return action('set_layer_visibility', {
        layerId: d.layer,
        enabled: !state?.layers?.[d.layer],
      });
    if (d.map) return action('set_map_stack', { stack: d.map });
    if ('hud' in d)
      return action('set_hud', { visible: state?.hud ? 'off' : 'on' });
    if ('detect' in d)
      return action('set_detection', { enabled: !state?.detection });
    if ('autohop' in d)
      return action('control_cctv', {
        action: 'autohop',
        enabled: !state?.autoHop,
      });
  });

  $('search').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = $('search-input').value.trim();
    if (!query) return;
    action('fly_to_location', { query });
    $('search-input').blur();
    flash(`Flying to ${query}…`);
  });

  // ── State ───────────────────────────────────────────────
  function setTv(on) {
    $('tv-dot').classList.toggle('on', on);
    $('tv-label').textContent = on ? 'TV' : 'TV offline';
  }

  let flashText = null;
  let flashUntil = 0;
  function flash(text) {
    flashText = text;
    flashUntil = Date.now() + 4000;
    drawNow();
  }

  const waitClass = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return n >= 30 ? 'bad' : n >= 15 ? 'slow' : '';
  };
  function lane(l) {
    if (!l || l.unavailable) return '—';
    const t = l.travellers;
    if (!t) return '—';
    if (t.status === 'closed') return 'closed';
    return Number.isInteger(t.minutes) ? String(t.minutes) : '—';
  }
  function drawBorder(snapshot) {
    const byId = new Map((snapshot?.crossings ?? []).map((c) => [c.id, c]));
    const body = $('border');
    body.replaceChildren();
    for (const [id, name] of CROSSINGS) {
      const row = byId.get(id);
      const tr = document.createElement('tr');
      tr.className = 'crossing';
      [name, lane(row?.toUS), lane(row?.toCanada)].forEach((value, i) => {
        const td = document.createElement('td');
        td.textContent = value;
        if (i) td.className = waitClass(value);
        tr.append(td);
      });
      tr.addEventListener('click', () => send('crossing', id));
      body.append(tr);
    }
    const at = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null;
    $('border-at').textContent = at
      ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
  }

  let tvOn = false;
  function drawNow() {
    const now = $('now');
    now.replaceChildren();
    if (!tvOn || !state) {
      now.className = 'now offline';
      now.textContent = tvOn
        ? 'Waiting for the globe…'
        : 'TV offline. Is the globe open in the browser on the computer?';
      return;
    }
    now.className = 'now';
    const line = (label, value) => {
      const div = document.createElement('div');
      div.append(label);
      const strong = document.createElement('strong');
      strong.textContent = value;
      div.append(strong);
      now.append(div);
    };
    const look = STYLE_NAMES[state.style] || state.style;
    line(
      'Look: ',
      look +
        (state.orbit ? ' · orbiting' : '') +
        (state.tracking ? ' · following' : ''),
    );
    if (state.camera) line('Camera: ', state.camera.name);
    const message =
      flashUntil > Date.now()
        ? { ok: true, text: flashText }
        : state.result && state.result.text !== 'Done'
          ? state.result
          : null;
    if (message) {
      const div = document.createElement('div');
      div.textContent = message.text;
      if (!message.ok) div.className = 'err';
      now.append(div);
    }
  }

  let builtLayers = '';
  function drawLayers() {
    const list = state?.layerList ?? [];
    const key = list.map((l) => l.id).join();
    const box = $('layers');
    if (key !== builtLayers) {
      builtLayers = key;
      box.replaceChildren();
      for (const l of list) {
        const b = document.createElement('button');
        b.dataset.layer = l.id;
        b.textContent = l.name;
        box.append(b);
      }
    }
    let on = 0;
    for (const b of box.children) {
      const active = Boolean(state?.layers?.[b.dataset.layer]);
      if (active) on += 1;
      b.setAttribute('aria-pressed', String(active));
    }
    $('layer-count').textContent = list.length ? `${on} ON` : '';
  }

  function drawState() {
    setTv(tvOn);
    drawNow();
    if (!state) return;
    drawLayers();
    const pressed = (sel, on) => {
      for (const b of document.querySelectorAll(sel))
        b.setAttribute('aria-pressed', String(Boolean(on(b))));
    };
    pressed('#styles [data-arg]', (b) => b.dataset.arg === state.style);
    pressed('#maps [data-map]', (b) => b.dataset.map === state.mapStack);
    pressed('[data-layer="cctv"]', () => state.layers?.cctv);
    pressed('#orbit-btn', () => state.orbit);
    pressed('#clean-btn', () => state.clean);
    pressed('#smooth-btn', () => state.smooth);
    pressed('#advanced-btn', () => state.advanced);
    pressed('#hud-btn', () => state.hud);
    pressed('#detect-btn', () => state.detection);
    pressed('#autohop-btn', () => state.autoHop);
  }

  let refreshing = false;
  async function refresh() {
    if (!token || refreshing || document.hidden) return;
    refreshing = true;
    try {
      const { ok, data } = await api('/api/state');
      if (ok) {
        tvOn = Boolean(data.tv);
        state = data.state;
        drawState();
        drawBorder(data.border);
      }
    } catch {
      tvOn = false;
      setTv(false);
    } finally {
      refreshing = false;
    }
  }

  drawBorder(null);
  showPair(!token);
  if (token) refresh();
  setInterval(refresh, 2500);
  document.addEventListener('visibilitychange', refresh);
})();

// God's Eye phone remote. Served by the LAN remote server (server/remote).
(() => {
  const TOKEN_KEY = 'gev-remote-token';
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

  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
  const saveToken = (value) => {
    token = value;
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode */
    }
  };

  const buzz = () => navigator.vibrate?.(8);

  function showPair(on) {
    document.body.classList.toggle('unpaired', on);
  }

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
  const keys = $('keys');
  for (const key of [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '',
    '0',
    '⌫',
  ]) {
    const button = document.createElement('button');
    button.textContent = key;
    if (!key) button.style.visibility = 'hidden';
    button.addEventListener('click', () => {
      buzz();
      if (key === '⌫') entered = entered.slice(0, -1);
      else if (entered.length < 4) entered += key;
      drawPin();
      if (entered.length === 4) submitPin();
    });
    keys.append(button);
  }

  // ── Commands ────────────────────────────────────────────
  async function send(cmd, arg) {
    buzz();
    try {
      const { data } = await api('/api/cmd', { cmd, arg: arg ?? null });
      if (data && data.tv === false) setTv(false);
    } catch {
      setTv(false);
    }
    setTimeout(refresh, 500);
  }

  for (const button of document.querySelectorAll('#main [data-cmd]')) {
    const { cmd, arg } = button.dataset;
    if (button.hasAttribute('data-repeat')) {
      // Hold to keep going.
      let timer = null;
      const stop = () => {
        clearInterval(timer);
        timer = null;
        button.classList.remove('pressed');
      };
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        button.classList.add('pressed');
        send(cmd, arg);
        clearInterval(timer);
        timer = setInterval(() => send(cmd, arg), 650);
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
        button.addEventListener(type, stop);
      button.addEventListener('contextmenu', (e) => e.preventDefault());
    } else {
      button.addEventListener('click', () => send(cmd, arg));
    }
  }

  // ── State ───────────────────────────────────────────────
  function setTv(on) {
    $('tv-dot').classList.toggle('on', on);
    $('tv-label').textContent = on ? 'TV' : 'TV offline';
  }

  function waitClass(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n >= 30 ? 'bad' : n >= 15 ? 'slow' : '';
  }
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
      const cells = [name, lane(row?.toUS), lane(row?.toCanada)];
      cells.forEach((value, i) => {
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

  function drawState(state, tv) {
    setTv(tv);
    const now = $('now');
    now.replaceChildren();
    if (!tv || !state) {
      now.className = 'now offline';
      now.textContent = tv
        ? 'Waiting for the globe…'
        : 'TV offline. Is the globe open in the browser on the computer?';
      return;
    }
    now.className = 'now';
    const look = document.createElement('div');
    look.append('Look: ');
    const strong = document.createElement('strong');
    strong.textContent = STYLE_NAMES[state.style] || state.style;
    look.append(strong);
    if (state.orbit) look.append('  ·  orbiting');
    now.append(look);
    if (state.camera) {
      const cam = document.createElement('div');
      cam.append('Camera: ');
      const name = document.createElement('strong');
      name.textContent = state.camera.name;
      cam.append(name);
      now.append(cam);
    }
    for (const button of document.querySelectorAll('#layers [data-arg]'))
      button.setAttribute(
        'aria-pressed',
        String(Boolean(state.layers?.[button.dataset.arg])),
      );
    for (const button of document.querySelectorAll('#styles [data-arg]'))
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.arg === state.style),
      );
    $('orbit-btn').setAttribute('aria-pressed', String(Boolean(state.orbit)));
    $('clean-btn').setAttribute('aria-pressed', String(Boolean(state.clean)));
  }

  let refreshing = false;
  async function refresh() {
    if (!token || refreshing || document.hidden) return;
    refreshing = true;
    try {
      const { ok, data } = await api('/api/state');
      if (ok) {
        drawState(data.state, data.tv);
        drawBorder(data.border);
      }
    } catch {
      setTv(false);
    } finally {
      refreshing = false;
    }
  }

  drawBorder(null);
  if (token) {
    showPair(false);
    refresh();
  } else {
    showPair(true);
  }
  setInterval(refresh, 2500);
  document.addEventListener('visibilitychange', refresh);
})();

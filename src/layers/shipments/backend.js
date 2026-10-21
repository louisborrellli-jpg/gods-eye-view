/**
 * Where the shipments list lives: on this app's server when it offers the
 * shared list (/api/shipments/store), so everyone sees the same containers
 * and tracking runs with no page open; otherwise in this browser, as before.
 *
 * Both modes expose the same `store` and `tracker` shapes the layer and the
 * pages already use. In server mode the store is a local copy kept in step
 * with the server: reads are immediate, changes go to the server and the
 * copy is reloaded from its answer, and a poll picks up other people's
 * changes. Tracking is the server's job; "refresh" asks it to run now.
 */
import { createShipmentStore, SHIPMENTS_STORAGE_KEY } from './store.js';
import { createShipmentTracker } from './tracker.js';

const POLL_MS = 60_000;
/** The browser's own list is kept under this key once copied to the server. */
export const SHIPMENTS_MIGRATED_KEY = 'gev.shipments.v1.copied-to-server';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/**
 * @param {{storage?: Storage|null, now?: () => number,
 *   fetchImpl?: Function, trackingSource?: object,
 *   endpoint?: string, onChange?: () => void,
 *   setTimer?: Function, clearTimer?: Function,
 *   visible?: () => boolean}} options
 * @returns {{store: object, tracker: object, ready: Promise<string>,
 *   mode: () => string, reload: () => Promise<void>,
 *   subscribe: (listener: () => void) => () => void,
 *   reread: () => void, stop: () => void}}
 */
export function createShipmentsBackend({
  storage = null,
  now = () => Date.now(),
  // The list's address is relative, so only a page can reach it.
  fetchImpl = globalThis.location
    ? (...args) => globalThis.fetch(...args)
    : async () => {
        throw new Error('no page, so no shared list');
      },
  trackingSource,
  endpoint = '/api/shipments/store',
  onChange = () => {},
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (timer) => clearInterval(timer),
  visible = () => globalThis.document?.visibilityState !== 'hidden',
} = {}) {
  let local = createShipmentStore({ storage, now });
  let localTracker = createShipmentTracker({
    store: local,
    source: trackingSource,
    now,
  });
  const copy = createShipmentStore({ storage: memoryStorage(), now });
  let mode = 'loading';
  let revision = 0;
  let remote = { keyMissing: false, busy: false, notes: {} };
  let timer = null;
  let saveError = false;
  let refreshing = null;
  const listeners = new Set();
  const changed = () => {
    onChange();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* one screen must not break another */
      }
    }
  };

  async function call(method, path = '', body) {
    const response = await fetchImpl(`${endpoint}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || !payload)
      throw Object.assign(
        new Error(payload?.error || `HTTP ${response.status}`),
        {
          status: response.status,
          payload,
        },
      );
    return payload;
  }

  function apply(snapshot) {
    if (!snapshot || snapshot.mode !== 'server') return false;
    revision = snapshot.revision ?? revision;
    remote = snapshot.tracking ?? remote;
    copy.hydrate(snapshot.shipments, snapshot.defaults);
    return true;
  }

  async function reload() {
    if (mode !== 'server') return;
    try {
      const snapshot = await call('GET');
      if (
        snapshot.revision !== revision ||
        snapshot.tracking?.busy !== remote.busy
      ) {
        apply(snapshot);
        changed();
      }
      saveError = false;
    } catch {
      saveError = true;
    }
  }

  /** Copy containers this browser kept before the server list existed. */
  async function migrate() {
    const own = local.list();
    if (!own.length) return;
    try {
      await call('POST', '/merge', {
        shipments: own.map(({ defaults, dates, ...record }) => record),
      });
      storage?.setItem?.(
        SHIPMENTS_MIGRATED_KEY,
        storage.getItem(SHIPMENTS_STORAGE_KEY),
      );
      storage?.removeItem?.(SHIPMENTS_STORAGE_KEY);
      apply(await call('GET'));
    } catch {
      /* try again next time; nothing is lost */
    }
  }

  const ready = (async () => {
    try {
      if (!apply(await call('GET'))) throw new Error('no shared list');
      mode = 'server';
      await migrate();
      timer = setTimer(() => {
        if (visible()) void reload();
      }, POLL_MS);
    } catch {
      mode = 'local';
    }
    changed();
    return mode;
  })();

  const inServer = () => mode === 'server';

  /** Send a change, then take the server's version of the list. */
  async function push(method, path, body) {
    try {
      await call(method, path, body);
      saveError = false;
      apply(await call('GET'));
    } catch (error) {
      saveError = true;
      // A refused change: put the server's list back.
      try {
        apply(await call('GET'));
      } catch {
        /* offline: keep the local copy until the next poll */
      }
      throw error;
    } finally {
      changed();
    }
  }

  const bare = ({ defaults, dates, ...record }) => record;

  const store = {
    get size() {
      return inServer() ? copy.size : local.size;
    },
    get saveError() {
      return inServer() ? saveError : local.saveError;
    },
    get defaults() {
      return inServer() ? copy.defaults : local.defaults;
    },
    list: () => (inServer() ? copy.list() : local.list()),
    get: (id) => (inServer() ? copy.get(id) : local.get(id)),
    save(input) {
      if (!inServer()) return local.save(input);
      const saved = copy.save(input);
      if (saved)
        void push('PUT', '/item', { shipment: bare(saved) }).catch(() => {});
      return saved;
    },
    remove(id) {
      if (!inServer()) return local.remove(id);
      const removed = copy.remove(id);
      if (removed)
        void push('DELETE', `/item?id=${encodeURIComponent(id)}`).catch(
          () => {},
        );
      return removed;
    },
    setLastSeen(id, lastSeen) {
      if (!inServer()) return local.setLastSeen(id, lastSeen);
      const next = copy.setLastSeen(id, lastSeen);
      if (next)
        void push('PUT', '/item', { shipment: bare(next) }).catch(() => {});
      return next;
    },
    /** The server owns tracking in server mode; a browser answer is ignored. */
    setAuto(id, auto) {
      return inServer() ? copy.get(id) : local.setAuto(id, auto);
    },
    setDefaults(value) {
      if (!inServer()) return local.setDefaults(value);
      const next = copy.setDefaults(value);
      void push('PUT', '/defaults', { defaults: next }).catch(() => {});
      return next;
    },
    replaceAll(entries) {
      if (!inServer()) return local.replaceAll(entries);
      const list = Array.isArray(entries) ? entries : [];
      void push('POST', '/merge', { shipments: list }).catch(() => {});
      return list.length;
    },
    // Alerts are announced per person, so their keys stay in this browser.
    hasNotified: (key) => local.hasNotified(key),
    markNotified: (key) => local.markNotified(key),
  };

  const tracker = {
    get keyMissing() {
      return inServer() ? Boolean(remote.keyMissing) : localTracker.keyMissing;
    },
    get busy() {
      return inServer()
        ? Boolean(refreshing || remote.busy)
        : localTracker.busy;
    },
    note(id) {
      return inServer() ? (remote.notes?.[id] ?? null) : localTracker.note(id);
    },
    forget(id) {
      if (!inServer()) localTracker.forget(id);
    },
    /**
     * Local mode: track due containers from this browser. Server mode: the
     * server's job tracks on its own; a forced refresh asks it to run now,
     * otherwise this only reloads the list.
     */
    async refresh({ force = false, onlyId = null, signal } = {}) {
      await ready;
      if (!inServer()) return localTracker.refresh({ force, onlyId, signal });
      if (!force) return reload();
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          const query = onlyId ? `?id=${encodeURIComponent(onlyId)}` : '';
          apply(await call('POST', `/refresh${query}`));
        } catch {
          /* the next poll tries again */
        }
      })().finally(() => {
        refreshing = null;
        changed();
      });
      return refreshing;
    },
  };

  return {
    store,
    tracker,
    ready,
    mode: () => mode,
    reload,
    /** Call `listener` whenever the list or its tracking changes. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Browser mode: read the list again after another tab changed it. */
    reread() {
      if (inServer()) return;
      local = createShipmentStore({ storage, now });
      localTracker = createShipmentTracker({
        store: local,
        source: trackingSource,
        now,
      });
      changed();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

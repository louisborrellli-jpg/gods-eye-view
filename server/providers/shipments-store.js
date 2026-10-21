import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseContainerNumber } from '../../src/layers/shipments/containers.js';
import { createShipmentStore } from '../../src/layers/shipments/store.js';
import { createShipmentTracker } from '../../src/layers/shipments/tracker.js';

/**
 * The shared shipments list, kept by this server so everyone who opens the
 * app sees the same containers and tracking keeps running with no page open.
 *
 * Records are the same normalized shipments the browser keeps, stored in one
 * JSON file (`.gev-data/shipments.json` by default) through the browser
 * store's own code: a tiny file-backed stand-in for localStorage. Tracking
 * is the browser tracker too, fed by the server's FindTEU service, and runs
 * every JOB_INTERVAL_MS for whatever is due.
 *
 * Routes, under /api/shipments/store (same-site callers only):
 *   GET  /            → {mode, revision, shipments, defaults, tracking}
 *   PUT  /item        {shipment} → add or update one container
 *   DELETE /item?id=  → remove one container
 *   PUT  /defaults    {defaults} → board-wide free time
 *   POST /merge       {shipments} → add containers not on the list yet
 *   POST /refresh[?id=] → track now (one container, or every one)
 */
export const SHIPMENTS_DATA_FILE = 'shipments.json';
const JOB_INTERVAL_MS = 20 * 60_000;
const FIRST_JOB_DELAY_MS = 15_000;
const MAX_BODY_BYTES = 512 * 1024;

/**
 * A localStorage stand-in backed by one JSON file. Writes go to a temporary
 * file first and are renamed into place, so a crash never leaves half a file.
 */
export function createFileStorage(file) {
  let data = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {
    data = {};
  }
  const flush = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 1));
    renameSync(temporary, file);
  };
  return {
    getItem: (key) => (Object.hasOwn(data, key) ? data[key] : null),
    setItem(key, value) {
      data[key] = String(value);
      flush();
    },
    removeItem(key) {
      delete data[key];
      flush();
    },
  };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/**
 * @param {{service: {track: Function}, now?: () => number,
 *   dataDir?: string, storage?: object, setTimer?: Function,
 *   clearTimer?: Function}} options
 */
export function createShipmentsServerStore({
  service,
  now = () => Date.now(),
  dataDir = path.join(process.cwd(), '.gev-data'),
  storage = createFileStorage(path.join(dataDir, SHIPMENTS_DATA_FILE)),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (timer) => clearInterval(timer),
} = {}) {
  const store = createShipmentStore({ storage, now });
  const tracker = createShipmentTracker({
    store,
    now,
    source: {
      async trackContainer(container, { carrier } = {}) {
        const answer = await service.track(container, carrier);
        return {
          configured: answer.body?.configured !== false,
          tracking: answer.body?.tracking ?? null,
          error: answer.body?.error ?? null,
        };
      },
    },
  });
  let revision = 1;
  let timer = null;
  let firstRun = null;
  const bump = () => {
    revision += 1;
  };

  // The browser keeps `defaults` on each listed record; the list sent out
  // carries them once, beside the records.
  const bare = ({ defaults, dates, ...record }) => record;

  function snapshot() {
    const notes = {};
    for (const shipment of store.list()) {
      const note = tracker.note(shipment.id);
      if (note) notes[shipment.id] = note;
    }
    return {
      mode: 'server',
      revision,
      shipments: store.list().map(bare),
      defaults: store.defaults,
      tracking: { keyMissing: tracker.keyMissing, busy: tracker.busy, notes },
    };
  }

  async function runJob(options = {}) {
    const before = JSON.stringify(store.list().map((item) => item.auto));
    await tracker.refresh(options);
    if (JSON.stringify(store.list().map((item) => item.auto)) !== before)
      bump();
  }

  /** Save one container from a browser; tracking stays the server's. */
  function saveItem(input) {
    const parsed = parseContainerNumber(input?.container);
    if (!parsed.wellFormed)
      return { status: 400, body: { error: parsed.problem } };
    const existing = input?.id ? store.get(input.id) : null;
    const duplicate = store
      .list()
      .find(
        (item) => item.container === parsed.number && item.id !== input?.id,
      );
    if (duplicate)
      return {
        status: 409,
        body: {
          error: 'That container is already on the board',
          id: duplicate.id,
        },
      };
    const shipment = store.save({
      ...input,
      container: parsed.number,
      carrier: input.carrier || parsed.carrier || '',
      auto: existing?.auto ?? null,
    });
    if (!shipment) return { status: 507, body: { error: 'The board is full' } };
    bump();
    return { status: 200, body: { shipment: bare(shipment), revision } };
  }

  async function handle(req, route, send) {
    const url = new URL(req.url || '', 'http://localhost');
    try {
      if (req.method === 'GET' && route === '/') return send(200, snapshot());
      if (req.method === 'PUT' && route === '/item') {
        const body = await readJson(req);
        const result = saveItem(body?.shipment);
        if (result.status === 200 && !store.get(result.body.shipment.id)?.auto)
          void runJob({ force: true, onlyId: result.body.shipment.id });
        return send(result.status, result.body);
      }
      if (req.method === 'DELETE' && route === '/item') {
        const id = String(url.searchParams.get('id') || '');
        const removed = store.remove(id);
        if (removed) {
          tracker.forget(id);
          bump();
        }
        return send(removed ? 200 : 404, { removed, revision });
      }
      if (req.method === 'PUT' && route === '/defaults') {
        const body = await readJson(req);
        store.setDefaults(body?.defaults ?? {});
        bump();
        return send(200, { defaults: store.defaults, revision });
      }
      if (req.method === 'POST' && route === '/merge') {
        const body = await readJson(req);
        const known = new Set(store.list().map((item) => item.container));
        let added = 0;
        for (const entry of Array.isArray(body?.shipments)
          ? body.shipments
          : []) {
          const parsed = parseContainerNumber(entry?.container);
          if (!parsed.wellFormed || known.has(parsed.number)) continue;
          if (store.save({ ...entry, container: parsed.number })) {
            known.add(parsed.number);
            added += 1;
          }
        }
        if (added) bump();
        return send(200, { added, revision });
      }
      if (req.method === 'POST' && route === '/refresh') {
        const id = url.searchParams.get('id');
        await runJob({ force: true, onlyId: id || null });
        return send(200, snapshot());
      }
      return send(route === '/' || route === '/item' ? 405 : 404, {
        error: 'not_found',
      });
    } catch (error) {
      return send(400, { error: error?.message || 'bad_request' });
    }
  }

  return {
    handle,
    snapshot,
    runJob,
    store,
    /** Track due containers now and then every JOB_INTERVAL_MS. */
    start() {
      if (timer) return;
      timer = setTimer(() => void runJob(), JOB_INTERVAL_MS);
      timer?.unref?.();
      firstRun = setTimeout(() => void runJob(), FIRST_JOB_DELAY_MS);
      firstRun?.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      if (firstRun) clearTimeout(firstRun);
      timer = null;
      firstRun = null;
    },
  };
}

/**
 * Phone remote for the TV.
 *
 * Opt in with GEV_REMOTE=1. The globe server itself stays on localhost (it
 * brokers your API keys); instead this plugin starts a second, tiny server on
 * the LAN (GEV_REMOTE_PORT, default 4180) that only serves the remote page
 * and accepts whitelisted commands from a phone paired with the PIN shown on
 * the TV. The globe tab on this machine receives those commands over a
 * loopback-only event stream at /api/remote/events.
 *
 *   phone ──LAN──▶ :4180 remote server ──▶ hub ──loopback SSE──▶ globe tab
 */

import http from 'node:http';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { isSharingEnabled } from '../../src/keySetupCore.mjs';
import { isLocalMcpRequest } from '../mcp/plugin.js';
import { summarizeShipments } from './shipments.js';
import {
  createRemoteHub,
  lanAddresses,
  parseRemoteCommand,
  remoteEnabled,
} from './hub.js';

const DEFAULT_PORT = 4180;
const MAX_BODY = 16 * 1024;
const STATE_FRESH_MS = 20_000;
const BORDER_CACHE_MS = 60_000;
const SSE_PING_MS = 20_000;

const PAGES = {
  '/': ['remote.html', 'text/html; charset=utf-8'],
  '/remote.js': ['remote.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Vite plugin: loopback endpoints for the globe tab + the LAN remote server. */
export function phoneRemotePlugin({ env = process.env } = {}) {
  const hub = createRemoteHub();
  const listeners = new Set(); // SSE responses from globe tabs
  let lastState = null;
  let lastStateAt = 0;
  let border = null;
  let borderAt = 0;
  let mainPort = null;
  let remoteServer = null;
  let commandSeq = 0;

  const enabled = () => remoteEnabled(env, isSharingEnabled(env));
  const remotePort = () => {
    const n = Number.parseInt(env.GEV_REMOTE_PORT ?? '', 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  };
  const urls = () =>
    lanAddresses(os.networkInterfaces()).map(
      (ip) => `http://${ip}:${remotePort()}`,
    );

  const pages = Object.fromEntries(
    Object.entries(PAGES).map(([route, [file, type]]) => [
      route,
      [readFileSync(new URL(file, import.meta.url)), type],
    ]),
  );

  function broadcast(command) {
    const data = `data: ${JSON.stringify({ ...command, id: ++commandSeq })}\n\n`;
    for (const res of listeners) res.write(data);
    return listeners.size > 0;
  }

  async function borderSnapshot() {
    if (!mainPort) return null;
    if (border && Date.now() - borderAt < BORDER_CACHE_MS) return border;
    try {
      const response = await fetch(
        `http://localhost:${mainPort}/api/border-waits`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (response.ok) {
        border = await response.json();
        borderAt = Date.now();
      }
    } catch {
      /* keep the last snapshot */
    }
    return border;
  }

  /**
   * The app's shared shipments list, asked over loopback like a browser on
   * this machine would. Returns {status, body}.
   */
  async function shipmentsCall(method, path = '', body) {
    if (!mainPort) return { status: 503, body: { error: 'App not ready' } };
    try {
      const response = await fetch(
        `http://localhost:${mainPort}/api/shipments/store${path}`,
        {
          method,
          headers: {
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(8000),
        },
      );
      return {
        status: response.status,
        body: await response.json().catch(() => ({})),
      };
    } catch {
      return { status: 503, body: { error: 'Shipments unavailable' } };
    }
  }

  // ── LAN server: what the phone talks to ─────────────────
  async function handleRemote(req, res) {
    const url = new URL(req.url || '/', 'http://remote');
    const client = req.socket?.remoteAddress || 'unknown';

    if (req.method === 'GET' && Object.hasOwn(pages, url.pathname)) {
      const [body, type] = pages[url.pathname];
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
      return res.end(body);
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const body = await readJson(req);
      const result = hub.pair(client, body?.pin);
      if (result.ok) {
        console.log(`[remote] phone paired (${client})`);
        broadcast({ cmd: 'paired', arg: null });
        return sendJson(res, 200, { token: result.token });
      }
      return sendJson(res, result.status, { error: result.error });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!hub.authorized(req.headers.authorization))
        return sendJson(res, 401, { error: 'Pair with the PIN on the TV' });

      if (req.method === 'POST' && url.pathname === '/api/cmd') {
        const command = parseRemoteCommand(await readJson(req));
        if (!command) return sendJson(res, 400, { error: 'Unknown command' });
        const delivered = broadcast(command);
        return sendJson(res, 200, { ok: true, tv: delivered });
      }

      // Containers: read the shared list; add one by its number. Removing
      // and editing stay on the Shipments page.
      if (req.method === 'GET' && url.pathname === '/api/shipments') {
        const { status, body } = await shipmentsCall('GET');
        if (status !== 200 || body?.mode !== 'server')
          return sendJson(res, 503, {
            error: 'The shared shipments list is not available',
          });
        return sendJson(res, 200, {
          shipments: summarizeShipments(body),
          keyMissing: Boolean(body.tracking?.keyMissing),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/shipments') {
        const input = await readJson(req);
        const container = String(input?.container ?? '').slice(0, 20);
        const reference = String(input?.reference ?? '').slice(0, 60);
        const { status, body } = await shipmentsCall('PUT', '/item', {
          shipment: { container, reference },
        });
        if (status === 200) console.log(`[remote] container added (${client})`);
        return sendJson(res, status === 200 ? 200 : status || 502, {
          ok: status === 200,
          id: body?.shipment?.id ?? body?.id ?? null,
          error: status === 200 ? null : body?.error || 'Could not add it',
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const fresh = Date.now() - lastStateAt < STATE_FRESH_MS;
        return sendJson(res, 200, {
          tv: listeners.size > 0,
          state: fresh ? lastState : null,
          border: await borderSnapshot(),
        });
      }
    }

    res.writeHead(404, SECURITY_HEADERS);
    res.end();
  }

  function startRemoteServer(retry = true) {
    if (remoteServer || !enabled()) return;
    const host = env.GEV_REMOTE_HOST?.trim() || '0.0.0.0';
    const server = http.createServer((req, res) => {
      handleRemote(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'Remote error' });
        else res.destroy();
      });
    });
    server.on('error', (error) => {
      remoteServer = null;
      if (error?.code === 'EADDRINUSE' && retry) {
        setTimeout(() => startRemoteServer(false), 800);
        return;
      }
      console.warn(
        `[remote] could not start on port ${remotePort()}:`,
        error.message,
      );
    });
    server.listen(remotePort(), host, () => {
      const where = urls();
      console.log(
        `\n  📱 Phone remote: ${where[0] ?? `http://<this-computer>:${remotePort()}`}` +
          `   PIN ${hub.pin}\n`,
      );
    });
    remoteServer = server;
  }

  function stopRemoteServer() {
    for (const res of listeners) res.end();
    listeners.clear();
    remoteServer?.close();
    remoteServer = null;
  }

  // ── Loopback endpoints on the globe server ──────────────
  const install = (server) => {
    server.httpServer?.once('listening', () => {
      const address = server.httpServer.address();
      mainPort = typeof address === 'object' ? address?.port : null;
      startRemoteServer();
    });
    server.httpServer?.once('close', stopRemoteServer);

    server.middlewares.use('/api/remote', async (req, res, next) => {
      const local = isLocalMcpRequest({
        remoteAddress: req.socket?.remoteAddress,
        localPort: req.socket?.localPort,
        host: req.headers.host || '',
        origin: req.headers.origin,
        headers: req.headers,
        env,
      });
      if (!local) return sendJson(res, 403, { error: 'Local only' });
      const path = (req.url || '/').split('?')[0];

      if (req.method === 'GET' && path === '/info') {
        return sendJson(res, 200, {
          enabled: enabled() && !!remoteServer,
          urls: urls(),
          pin: hub.pin,
          paired: hub.paired,
        });
      }
      if (!enabled()) return sendJson(res, 404, { error: 'Remote is off' });

      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
        req.on('close', () => {
          clearInterval(ping);
          listeners.delete(res);
        });
        return;
      }
      if (req.method === 'POST' && path === '/state') {
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Bad state' });
        lastState = body;
        lastStateAt = Date.now();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/reset') {
        hub.reset();
        console.log(`[remote] phones signed out. New PIN ${hub.pin}`);
        return sendJson(res, 200, { pin: hub.pin });
      }
      next();
    });
  };

  return {
    name: 'phone-remote',
    configureServer: install,
    configurePreviewServer: install,
  };
}

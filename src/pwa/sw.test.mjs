import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { registerServiceWorker } from './register.js';

// Load the real strategy from the service worker file, so the test exercises
// the shipped code rather than a copy. The self/module blocks guard on globals
// that are absent in this evaluated scope, so only strategyFor is defined.
const swSource = readFileSync(
  new URL('../../public/sw.js', import.meta.url),
  'utf8',
);
const strategyFor = new Function(`${swSource}\nreturn strategyFor;`)();

const ORIGIN = 'https://globe.example';
const req = (over) => ({
  method: 'GET',
  url: `${ORIGIN}/`,
  mode: 'cors',
  destination: '',
  ...over,
});

test('live data and cross-origin never touch the cache', () => {
  // The key-brokering proxies and feeds.
  assert.equal(
    strategyFor(req({ url: `${ORIGIN}/api/cctv/sources` }), ORIGIN),
    'passthrough',
  );
  // Map tiles / external feeds on another origin.
  assert.equal(
    strategyFor(
      req({ url: 'https://tiles.example/1/2/3.png', destination: 'image' }),
      ORIGIN,
    ),
    'passthrough',
  );
  // Anything that writes.
  assert.equal(
    strategyFor(req({ method: 'POST', url: `${ORIGIN}/api/x` }), ORIGIN),
    'passthrough',
  );
  // Dev-server internals, if ever active in dev.
  assert.equal(
    strategyFor(req({ url: `${ORIGIN}/@vite/client` }), ORIGIN),
    'passthrough',
  );
});

test('the document is network-first (navigate) and static assets are cached', () => {
  assert.equal(
    strategyFor(
      req({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'document' }),
      ORIGIN,
    ),
    'navigate',
  );
  assert.equal(
    strategyFor(
      req({ url: `${ORIGIN}/assets/app.4f3c.js`, destination: 'script' }),
      ORIGIN,
    ),
    'asset',
  );
  assert.equal(
    strategyFor(
      req({ url: `${ORIGIN}/icons/icon-192.png`, destination: 'image' }),
      ORIGIN,
    ),
    'asset',
  );
});

test('the shipped worker keeps its safety guards (drift check)', () => {
  assert.match(swSource, /\/api\//, 'guards the /api/ prefix');
  assert.match(swSource, /url\.origin !== selfOrigin/, 'guards cross-origin');
  assert.match(swSource, /req\.method !== 'GET'/, 'guards non-GET');
});

test('registration is gated on production + secure context + support', () => {
  const sw = { register: () => Promise.resolve() };
  // All gates open → attempts.
  assert.equal(
    registerServiceWorker({
      enabled: true,
      serviceWorker: sw,
      secureContext: true,
    }),
    true,
  );
  // Dev build → never.
  assert.equal(
    registerServiceWorker({
      enabled: false,
      serviceWorker: sw,
      secureContext: true,
    }),
    false,
  );
  // Insecure context → never.
  assert.equal(
    registerServiceWorker({
      enabled: true,
      serviceWorker: sw,
      secureContext: false,
    }),
    false,
  );
  // Unsupported → never.
  assert.equal(
    registerServiceWorker({
      enabled: true,
      serviceWorker: null,
      secureContext: true,
    }),
    false,
  );
});

test('a throwing register never propagates', () => {
  assert.doesNotThrow(() =>
    registerServiceWorker({
      enabled: true,
      serviceWorker: {},
      secureContext: true,
      register: () => {
        throw new Error('boom');
      },
    }),
  );
  // A rejected promise is swallowed too.
  assert.equal(
    registerServiceWorker({
      enabled: true,
      serviceWorker: {},
      secureContext: true,
      register: () => Promise.reject(new Error('later')),
    }),
    true,
  );
});

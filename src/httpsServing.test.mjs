import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserViteConfig, resolveServerTls } from '../build/vite.js';

test('resolveServerTls stays off unless BOTH cert and key are set', () => {
  const readFile = (p) => `CONTENTS:${p}`;
  assert.equal(resolveServerTls({}, { readFile }), undefined);
  assert.equal(
    resolveServerTls({ GEV_TLS_CERT: '/c.pem' }, { readFile }),
    undefined,
    'cert alone is not enough',
  );
  assert.equal(
    resolveServerTls({ GEV_TLS_KEY: '/k.pem' }, { readFile }),
    undefined,
    'key alone is not enough',
  );
  assert.equal(
    resolveServerTls({ GEV_TLS_CERT: '  ', GEV_TLS_KEY: '  ' }, { readFile }),
    undefined,
    'blank paths are off',
  );
});

test('resolveServerTls reads the PEM files when both are set', () => {
  const reads = [];
  const readFile = (p) => {
    reads.push(p);
    return `PEM:${p}`;
  };
  const tls = resolveServerTls(
    { GEV_TLS_CERT: '/etc/cert.pem', GEV_TLS_KEY: '/etc/key.pem' },
    { readFile },
  );
  assert.deepEqual(tls, { cert: 'PEM:/etc/cert.pem', key: 'PEM:/etc/key.pem' });
  assert.deepEqual(reads, ['/etc/cert.pem', '/etc/key.pem']);
});

test('a set-but-unreadable cert/key falls back to plain HTTP with a warning, not a crash', () => {
  const warnings = [];
  const readFile = (p) => {
    if (p === '/bad/cert.pem') {
      throw Object.assign(new Error('ENOENT: no such file'), { path: p });
    }
    return `PEM:${p}`;
  };
  const tls = resolveServerTls(
    { GEV_TLS_CERT: '/bad/cert.pem', GEV_TLS_KEY: '/etc/key.pem' },
    { readFile, warn: (m) => warnings.push(m) },
  );
  assert.equal(tls, undefined, 'startup does not crash; TLS stays off');
  assert.equal(warnings.length, 1, 'the failure is reported, not silent');
  assert.match(warnings[0], /TLS disabled/);
  assert.match(warnings[0], /\/bad\/cert\.pem/, 'names the offending path');
});

test('TLS threads into both the dev server and the preview server', () => {
  const https = { cert: 'C', key: 'K' };
  const config = createBrowserViteConfig({ https });
  assert.deepEqual(config.server.https, https);
  assert.deepEqual(config.preview.https, https);
});

test('without TLS, neither server declares https (plain HTTP)', () => {
  const config = createBrowserViteConfig();
  assert.equal('https' in config.server, false);
  assert.equal('https' in config.preview, false);
  // The CSP/framing headers are still present on both.
  assert.ok(config.server.headers);
  assert.ok(config.preview.headers);
});

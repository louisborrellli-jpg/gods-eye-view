import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeResult } from './phoneRemote.js';

test('a request overtaken by a newer tap is not shown as a failure', () => {
  const result = summarizeResult({
    ok: false,
    action: 'set_layer_visibility',
    layerId: 'weather-satellite',
    cancelled: true,
    cancellationReason: 'superseded',
  });
  assert.equal(result.ok, true);
  assert.equal(result.quiet, true);
});

test('a real failure still says why', () => {
  const result = summarizeResult({
    ok: false,
    error: 'Could not enable the requested layer',
  });
  assert.deepEqual(result, {
    ok: false,
    text: 'Could not enable the requested layer',
  });
  assert.equal(summarizeResult({ ok: true, say: 'Wind on.' }).text, 'Wind on.');
});

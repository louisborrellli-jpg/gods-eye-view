import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COASTGUARD_IMAGE_ORIGIN,
  loadCoastGuardSources,
} from './coastguard.js';
import { normalizeSourceItem } from './normalize.js';

test('every Coast Guard camera is placed and pinned to the official host', () => {
  const rows = loadCoastGuardSources();
  assert.ok(rows.length >= 2, 'ships at least Windsor and Livingstone Channel');
  for (const row of rows) {
    const camera = normalizeSourceItem(row);
    assert.ok(camera.id, 'has a stable id');
    assert.ok(
      camera.snapshotUrl.startsWith(COASTGUARD_IMAGE_ORIGIN),
      `${camera.id} frame stays on the CCG host`,
    );
    assert.equal(camera.feedType, 'image');
    assert.ok(Number.isFinite(camera.lat) && Math.abs(camera.lat - 42.3) < 1);
    assert.ok(Number.isFinite(camera.lon) && Math.abs(camera.lon + 83) < 1);
    assert.match(camera.provider, /Coast Guard/);
  }
  assert.ok(rows.some((r) => r.id === 'ccg-windsor'));
  assert.ok(rows.some((r) => r.id === 'ccg-livingstone-channel'));
});

test('the source cap bounds how many cameras load', () => {
  const prev = process.env.CCTV_COASTGUARD_MAX_SOURCES;
  process.env.CCTV_COASTGUARD_MAX_SOURCES = '1';
  try {
    assert.equal(loadCoastGuardSources().length, 1);
  } finally {
    if (prev === undefined) delete process.env.CCTV_COASTGUARD_MAX_SOURCES;
    else process.env.CCTV_COASTGUARD_MAX_SOURCES = prev;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CCG_CAMERAS, ccgCameraToSource, loadCcgSources } from './ccg.js';

test('Coast Guard cameras pin frames to the official still host', async () => {
  const cameras = await loadCcgSources();
  assert.equal(cameras.length, CCG_CAMERAS.length);
  for (const c of cameras) {
    assert.match(
      c.url,
      /^https:\/\/e-nav\.ccg-gcc\.gc\.ca\/nvss-svsn\/sequences\/[A-Za-z0-9%()_-]+\.jpg$/,
    );
    assert.equal(c.snapshotUrl, c.url);
    assert.match(c.id, /^ccg-[a-z0-9-]+$/);
    assert.equal(c.provider, 'Canadian Coast Guard');
  }
  const windsor = cameras.find((c) => c.id === 'ccg-windsor');
  assert.equal(
    windsor.url,
    'https://e-nav.ccg-gcc.gc.ca/nvss-svsn/sequences/Windsor.jpg',
  );
  assert.equal(
    cameras.find((c) => c.id === 'ccg-lakesaintclair-x32').url,
    'https://e-nav.ccg-gcc.gc.ca/nvss-svsn/sequences/LakeSaintClair(X32).jpg',
  );
});

test('a camera file name outside the allowed pattern is rejected', () => {
  assert.equal(ccgCameraToSource({ ...CCG_CAMERAS[0], file: '../evil' }), null);
});

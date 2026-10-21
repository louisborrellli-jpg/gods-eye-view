import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetOntarioKeyWarningForTest,
  loadOntarioSourcesFromOpenData,
} from './sources.js';

const ROW = {
  Id: '42',
  Latitude: 43.6532,
  Longitude: -79.3832,
  Location: 'Hwy 401 near Yonge St',
  Direction: 'Eastbound',
  Views: [
    {
      Status: 'Enabled',
      Url: 'https://511on.ca/map/Cctv/4201',
      Description: 'Eastbound',
    },
  ],
};

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

test.beforeEach(() => _resetOntarioKeyWarningForTest());

test('without ONTARIO_511_API_KEY the Ontario pack is skipped, logged once', async (t) => {
  const lines = captureConsole(t);
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return Response.json([ROW]);
  });
  assert.deepEqual(await loadOntarioSourcesFromOpenData({}, {}), []);
  assert.deepEqual(
    await loadOntarioSourcesFromOpenData({}, { ONTARIO_511_API_KEY: '   ' }),
    [],
  );
  assert.equal(fetches, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ONTARIO_511_API_KEY/);
});

test('with a key the camera list is requested with it and parsed', async (t) => {
  const lines = captureConsole(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([ROW]);
  });
  const cameras = await loadOntarioSourcesFromOpenData(
    { sourceRoot: '/ignored' },
    { ONTARIO_511_API_KEY: ' test-key ' },
  );
  assert.equal(requested.length, 1);
  const url = new URL(requested[0]);
  assert.equal(url.host, '511on.ca');
  assert.equal(url.searchParams.get('key'), 'test-key');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'on-42');
  assert.equal(cameras[0].url, 'https://511on.ca/map/Cctv/4201');
  // The records go to the browser through /api/cctv; the key must stay on
  // the server-side catalog request.
  assert.doesNotMatch(JSON.stringify(cameras), /test-key/);
  assert.doesNotMatch(lines.join('\n'), /test-key/);
});

test('every enabled view of a camera becomes its own source', async (t) => {
  captureConsole(t);
  const row = {
    Id: '649',
    Latitude: 42.3,
    Longitude: -82.9,
    Location: 'Highway 401 at Puce Road',
    Direction: 'Unknown',
    Views: [
      {
        Id: 1173,
        Status: 'Enabled',
        Url: 'https://511on.ca/map/Cctv/1173',
        Description: 'Looking Down',
      },
      {
        Id: 1172,
        Status: 'Enabled',
        Url: 'https://511on.ca/map/Cctv/1172',
        Description: 'Looking East',
      },
      {
        Id: 1174,
        Status: 'Enabled',
        Url: 'https://511on.ca/map/Cctv/1174',
        Description: 'Looking West',
      },
      {
        Id: 1175,
        Status: 'Disabled',
        Url: 'https://511on.ca/map/Cctv/1175',
        Description: 'Looking North',
      },
    ],
  };
  t.mock.method(globalThis, 'fetch', async () => Response.json([row]));
  const cameras = await loadOntarioSourcesFromOpenData(
    {},
    { ONTARIO_511_API_KEY: 'test-key' },
  );
  // The best (non-down) view keeps the camera's historical id; the down view
  // is last; the disabled view is dropped.
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['on-649', 'on-649-1174', 'on-649-1173'],
  );
  assert.deepEqual(
    cameras.map((camera) => camera.name),
    [
      'Highway 401 at Puce Road - Looking East',
      'Highway 401 at Puce Road - Looking West',
      'Highway 401 at Puce Road - Looking Down',
    ],
  );
  // Each view aims along its own "Looking X", not the shared row direction.
  assert.equal(cameras[0].headingDeg, 90);
  assert.equal(cameras[1].headingDeg, 270);
  assert.equal(cameras[0].headingConfidence, 'high');
  assert.equal(cameras[2].url, 'https://511on.ca/map/Cctv/1173');
});

test('the source cap is read from the same environment as the key', async (t) => {
  captureConsole(t);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...ROW,
    Id: String(100 + i),
    Latitude: ROW.Latitude + i * 0.01,
    Views: [{ ...ROW.Views[0], Url: `https://511on.ca/map/Cctv/${100 + i}` }],
  }));
  t.mock.method(globalThis, 'fetch', async () => Response.json(rows));
  const cameras = await loadOntarioSourcesFromOpenData(
    {},
    { ONTARIO_511_API_KEY: 'test-key', CCTV_ONTARIO_MAX_SOURCES: '8' },
  );
  assert.equal(cameras.length, 8);
});

for (const status of [400, 401, 403]) {
  test(`a ${status} points at the key by name, never by value`, async (t) => {
    const lines = captureConsole(t);
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ Message: 'Invalid Key' }, { status }),
    );
    const cameras = await loadOntarioSourcesFromOpenData(
      {},
      { ONTARIO_511_API_KEY: 'secret-key-value' },
    );
    assert.deepEqual(cameras, []);
    assert.match(
      lines.join('\n'),
      new RegExp(`failed: ${status} \\(check ONTARIO_511_API_KEY\\)`),
    );
    assert.doesNotMatch(lines.join('\n'), /secret-key-value/);
  });
}

for (const status of [429, 500, 503]) {
  test(`a ${status} is reported without blaming the key`, async (t) => {
    const lines = captureConsole(t);
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({}, { status }),
    );
    const cameras = await loadOntarioSourcesFromOpenData(
      {},
      { ONTARIO_511_API_KEY: 'secret-key-value' },
    );
    assert.deepEqual(cameras, []);
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      `[CCTV] Ontario 511 camera download failed: ${status}`,
    );
    assert.doesNotMatch(lines[0], /secret-key-value/);
  });
}

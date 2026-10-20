import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuroraLayer } from './index.js';
import { AURORA_GRID_HEIGHT, AURORA_GRID_WIDTH } from './records.js';

const snapshot = (peak = 40) => {
  const probabilities = new Uint8Array(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT);
  probabilities[0] = peak;
  return {
    probabilities,
    peak,
    litCells: 1,
    observedAt: 1000,
    forecastAt: 2000,
  };
};

/**
 * A viewer and Cesium stand-in that records every imagery add and remove, so
 * the tests can assert what the layer leaves behind rather than what it says.
 */
function harness(source) {
  const added = [];
  const removed = [];
  const collection = {
    addImageryProvider(provider) {
      const imagery = { provider, show: true, alpha: 1 };
      added.push(imagery);
      return imagery;
    },
    remove(imagery, destroy) {
      removed.push({ imagery, destroy });
    },
  };
  let renders = 0;
  const viewer = {
    imageryLayers: collection,
    scene: {
      requestRender() {
        renders += 1;
      },
    },
  };
  const cesium = {
    SingleTileImageryProvider: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Rectangle: { MAX_VALUE: 'max' },
  };
  const layer = createAuroraLayer({ source, cesium });
  return { layer, viewer, added, removed, renders: () => renders };
}

// jsdom is not a dependency here, so the canvas the layer paints into is
// stubbed. The pixel work itself is covered by model.test.mjs.
const withCanvas = (t) => {
  const original = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      toDataURL: () => 'data:image/png;base64,stub',
    }),
  };
  t.after(() => {
    globalThis.document = original;
  });
};

test('a refresh swaps the overlay and destroys the image it replaces', async (t) => {
  withCanvas(t);
  const h = harness({ getSnapshot: async () => snapshot(40) });
  h.layer.init(h.viewer);
  h.layer.enable();

  assert.equal(await h.layer.update(), true);
  assert.equal(h.added.length, 1);
  assert.equal(h.removed.length, 0);

  assert.equal(await h.layer.update(), true);
  assert.equal(h.added.length, 2, 'the replacement is added before the swap');
  assert.deepEqual(
    h.removed.map((r) => r.destroy),
    [true],
    'the replaced texture is destroyed, not leaked',
  );
  assert.equal(h.removed[0].imagery, h.added[0]);
});

test('stats report what is drawn, with the forecast window it describes', async (t) => {
  withCanvas(t);
  const h = harness({ getSnapshot: async () => snapshot(46) });
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();

  const stats = h.layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.peakProbability, 46);
  assert.equal(stats.observedAt, 1000);
  assert.equal(stats.forecastAt, 2000);
  assert.equal(stats.error, null);
  assert.ok(Number.isFinite(stats.lastUpdate));
});

test('a disabled layer refuses to fetch and leaves no overlay behind', async (t) => {
  withCanvas(t);
  const h = harness({
    getSnapshot: async () => {
      throw new Error('a disabled layer must not reach the network');
    },
  });
  h.layer.init(h.viewer);
  assert.equal(await h.layer.update(), false);
  assert.equal(h.added.length, 0);
});

test('disable removes the overlay; destroy leaves nothing attached', async (t) => {
  withCanvas(t);
  const h = harness({ getSnapshot: async () => snapshot() });
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();

  h.layer.disable();
  assert.equal(h.removed.length, 1);
  assert.equal(h.layer.getStats().count, 1, 'disable keeps the last reading');

  h.layer.enable();
  await h.layer.update();
  h.layer.destroy();
  assert.equal(h.removed.length, 2);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getStats().lastUpdate, null);
});

test('a late refresh cannot publish after the layer is disabled', async (t) => {
  withCanvas(t);
  let release;
  const h = harness({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = () => resolve(snapshot());
      }),
  });
  h.layer.init(h.viewer);
  h.layer.enable();
  const pending = h.layer.update();
  h.layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(h.added.length, 0, 'nothing is drawn after disable');
  assert.equal(h.layer.getStats().error, null, 'an abort is not an error');
});

test('a failed refresh reports the error and keeps the last good overlay', async (t) => {
  withCanvas(t);
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('NOAA SWPC HTTP 503');
      return snapshot();
    },
  });
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();

  fail = true;
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().error, 'NOAA SWPC HTTP 503');
  // The overlay from the good refresh is still on the globe.
  assert.equal(h.removed.length, 0);
  assert.equal(h.layer.getStats().count, 1);
});

test('a layer cannot be initialized twice, and needs a real source', () => {
  assert.throws(() => createAuroraLayer({}), TypeError);
  assert.throws(() => createAuroraLayer({ source: {} }), TypeError);
  const h = harness({ getSnapshot: async () => snapshot() });
  h.layer.init(h.viewer);
  assert.throws(() => h.layer.init(h.viewer), /already initialized/);
});

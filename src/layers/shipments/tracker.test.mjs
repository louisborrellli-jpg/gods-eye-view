import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShipmentStore } from './store.js';
import { TRACK_INTERVAL_MS, createShipmentTracker } from './tracker.js';

function setup(answer) {
  let clock = Date.UTC(2026, 9, 21);
  const now = () => clock;
  const store = createShipmentStore({
    storage: null,
    now,
    makeId: () => `id${clock++}`,
  });
  const calls = [];
  const source = {
    async trackContainer(container, options) {
      calls.push([container, options.carrier]);
      return answer(container);
    },
  };
  const tracker = createShipmentTracker({ store, source, now });
  return { store, tracker, calls, advance: (ms) => (clock += ms) };
}

test('due containers are tracked once per interval and results are stored', async () => {
  const { store, tracker, calls, advance } = setup(() => ({
    configured: true,
    tracking: {
      source: 'FindTEU',
      dates: { portEta: '2026-11-09' },
      fetchedAt: 1,
    },
  }));
  const saved = store.save({ container: 'MSCU1234566', carrier: 'msc' });
  await tracker.refresh();
  assert.deepEqual(calls, [['MSCU1234566', 'msc']]);
  assert.equal(store.get(saved.id).dates.portEta, '2026-11-09');
  await tracker.refresh();
  assert.equal(calls.length, 1, 'not due again yet');
  advance(TRACK_INTERVAL_MS);
  await tracker.refresh();
  assert.equal(calls.length, 2);
  await tracker.refresh({ force: true, onlyId: saved.id });
  assert.equal(calls.length, 3);
});

test('a missing key stops the round and failures leave a note', async () => {
  const missing = setup(() => ({ configured: false, tracking: null }));
  missing.store.save({ container: 'MSCU1234566' });
  missing.store.save({ container: 'MSKU1234567' });
  await missing.tracker.refresh();
  assert.equal(missing.tracker.keyMissing, true);
  assert.equal(missing.calls.length, 1);

  const failing = setup(() => ({
    configured: true,
    tracking: null,
    error: 'limit reached',
  }));
  const box = failing.store.save({ container: 'MSCU1234566' });
  await failing.tracker.refresh();
  assert.deepEqual(failing.tracker.note(box.id), {
    text: 'Automatic tracking unavailable',
    reason: 'limit reached',
  });
});

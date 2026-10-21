import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WINDSOR_START,
  borderBoardRows,
  formatWait,
  prepareWindsorStart,
  windsorModeEnabled,
  windsorStartHash,
} from './windsorMode.js';

test('Windsor mode is on unless explicitly turned off', () => {
  assert.equal(windsorModeEnabled(undefined), true);
  assert.equal(windsorModeEnabled(''), true);
  assert.equal(windsorModeEnabled('1'), true);
  assert.equal(windsorModeEnabled('0'), false);
  assert.equal(windsorModeEnabled(' 0 '), false);
});

test('the start hash opens Windsor with cameras, flights and radar', () => {
  assert.equal(
    windsorStartHash(),
    `#v=2&lat=${WINDSOR_START.lat}&lon=${WINDSOR_START.lon}&alt=6000&heading=0&pitch=-40&l=c.f.v`,
  );
});

test('the start hash is only applied when the URL has no link of its own', () => {
  const calls = [];
  const win = (hash) => ({
    location: { hash },
    history: { replaceState: (...args) => calls.push(args) },
  });
  assert.equal(prepareWindsorStart(win('')), true);
  assert.equal(calls[0][2], windsorStartHash());
  assert.equal(prepareWindsorStart(win('#v=2&lat=1&lon=2')), false);
  assert.equal(calls.length, 1);
});

test('the border board shows car waits for the three Windsor crossings', () => {
  const lane = (minutes, status = 'open') => ({
    travellers: { minutes, status },
  });
  const rows = borderBoardRows({
    crossings: [
      { id: 'ambassador-bridge', toUS: lane(25), toCanada: lane(0) },
      {
        id: 'windsor-detroit-tunnel',
        toUS: { unavailable: true },
        toCanada: lane(null, 'closed'),
      },
      { id: 'blue-water-bridge', toUS: lane(0), toCanada: lane(0) },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.short, r.toUS, r.toCanada]),
    [
      ['Ambassador', '25', '0'],
      ['Tunnel', '—', 'closed'],
      ['Gordie Howe', '—', '—'],
    ],
  );
  assert.equal(formatWait(null), '—');
});

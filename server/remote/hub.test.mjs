import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRemoteHub,
  lanAddresses,
  newPin,
  parseRemoteCommand,
  remoteEnabled,
} from './hub.js';

test('only whitelisted commands and arguments get through', () => {
  assert.deepEqual(parseRemoteCommand({ cmd: 'home' }), {
    cmd: 'home',
    arg: null,
  });
  assert.deepEqual(parseRemoteCommand({ cmd: 'layer', arg: 'cctv' }), {
    cmd: 'layer',
    arg: 'cctv',
  });
  assert.deepEqual(parseRemoteCommand({ cmd: 'zoom', arg: 'in' }), {
    cmd: 'zoom',
    arg: 'in',
  });
  assert.deepEqual(parseRemoteCommand({ cmd: 'hold', arg: 'zoom-in' }), {
    cmd: 'hold',
    arg: 'zoom-in',
  });
  assert.deepEqual(parseRemoteCommand({ cmd: 'release' }), {
    cmd: 'release',
    arg: null,
  });
  assert.equal(parseRemoteCommand({ cmd: 'hold', arg: 'spin' }), null);
  assert.equal(parseRemoteCommand({ cmd: 'layer', arg: 'everything' }), null);
  assert.equal(parseRemoteCommand({ cmd: 'eval', arg: 'x' }), null);
  assert.equal(parseRemoteCommand({ cmd: '__proto__' }), null);
  assert.equal(parseRemoteCommand({ cmd: 'zoom' }), null);
  assert.equal(parseRemoteCommand(null), null);
  assert.equal(parseRemoteCommand('home'), null);
});

test('app actions are checked against the voice schemas and an allowlist', () => {
  assert.deepEqual(
    parseRemoteCommand({
      cmd: 'action',
      arg: { name: 'fly_to_location', args: { query: 'Belle Isle' } },
    }),
    {
      cmd: 'action',
      arg: { name: 'fly_to_location', args: { query: 'Belle Isle' } },
    },
  );
  assert.ok(
    parseRemoteCommand({
      cmd: 'action',
      arg: {
        name: 'set_layer_visibility',
        args: { layerId: 'satellites', enabled: true },
      },
    }),
  );
  // Wrong argument types, unknown args, and actions left out on purpose.
  assert.equal(
    parseRemoteCommand({
      cmd: 'action',
      arg: {
        name: 'set_layer_visibility',
        args: { layerId: 'nope', enabled: true },
      },
    }),
    null,
  );
  assert.equal(
    parseRemoteCommand({
      cmd: 'action',
      arg: { name: 'fly_to_location', args: { query: 'x', evil: 1 } },
    }),
    null,
  );
  assert.equal(
    parseRemoteCommand({
      cmd: 'action',
      arg: { name: 'analyst_query', args: {} },
    }),
    null,
  );
  assert.equal(
    parseRemoteCommand({
      cmd: 'action',
      arg: { name: 'control_cctv', args: { action: 'adjust' } },
    }),
    null,
  );
  assert.ok(
    parseRemoteCommand({
      cmd: 'action',
      arg: { name: 'control_cctv', args: { action: 'autohop', enabled: true } },
    }),
  );
  assert.equal(
    parseRemoteCommand({ cmd: 'action', arg: 'fly_to_location' }),
    null,
  );
});

test('PINs are four digits', () => {
  assert.equal(
    newPin(() => 7),
    '0007',
  );
  assert.equal(
    newPin(() => 9999),
    '9999',
  );
});

function hub(pins = ['1234', '5678', '9012']) {
  let clock = 0;
  let n = 0;
  const h = createRemoteHub({
    now: () => clock,
    pinFactory: () => pins.shift(),
    tokenFactory: () => `tok${++n}`,
  });
  return { h, advance: (ms) => (clock += ms) };
}

test('the right PIN pairs and the token authorizes requests', () => {
  const { h } = hub();
  assert.equal(h.paired, false);
  const result = h.pair('phone', '1234');
  assert.deepEqual(result, { ok: true, token: 'tok1' });
  assert.equal(h.paired, true);
  assert.equal(h.authorized('Bearer tok1'), true);
  assert.equal(h.authorized('Bearer nope'), false);
  assert.equal(h.authorized(undefined), false);
  assert.equal(h.authorized('tok1'), false);
});

test('a wrong PIN is refused, and repeated guesses lock the client out', () => {
  const { h, advance } = hub();
  for (let i = 0; i < 4; i += 1)
    assert.equal(h.pair('guesser', '0000').status, 401);
  assert.equal(h.pair('guesser', '0000').status, 401); // 5th trips the lock
  assert.equal(h.pair('guesser', '1234').status, 429); // even the right PIN
  assert.equal(h.pair('other', '1234').ok, true); // others unaffected
  advance(61_000);
  assert.equal(h.pair('guesser', '1234').ok, true);
});

test('many wrong guesses across clients change the PIN', () => {
  const { h } = hub();
  for (let i = 0; i < 20; i += 1) h.pair(`client${i}`, '0000');
  assert.equal(h.pin, '5678');
  assert.equal(h.pair('phone', '1234').ok, false);
  assert.equal(h.pair('phone', '5678').ok, true);
});

test('reset signs every phone out with a new PIN', () => {
  const { h } = hub();
  h.pair('phone', '1234');
  h.reset();
  assert.equal(h.paired, false);
  assert.equal(h.authorized('Bearer tok1'), false);
  assert.equal(h.pin, '5678');
});

test('LAN addresses prefer home-network ranges and skip loopback', () => {
  assert.deepEqual(
    lanAddresses({
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      vpn: [{ family: 'IPv4', address: '100.64.1.2', internal: false }],
      wifi: [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.1.23', internal: false },
      ],
    }),
    ['192.168.1.23', '100.64.1.2'],
  );
});

test('the remote is opt-in and never runs while sharing', () => {
  assert.equal(remoteEnabled({}), false);
  assert.equal(remoteEnabled({ GEV_REMOTE: '0' }), false);
  assert.equal(remoteEnabled({ GEV_REMOTE: '1' }), true);
  assert.equal(remoteEnabled({ GEV_REMOTE: 'true' }), true);
  assert.equal(remoteEnabled({ GEV_REMOTE: '1' }, true), false);
});

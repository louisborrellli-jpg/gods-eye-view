/**
 * Phone remote hub: the pure, testable part of the TV remote.
 *
 * The phone never talks to the globe server directly. A small separate
 * server on the LAN (see plugin.js) accepts remote commands, and the globe
 * tab on this machine picks them up over a loopback-only event stream. This
 * module owns pairing (a 4-digit PIN shown on the TV, traded for a random
 * token), brute-force limits, and the command whitelist.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { validateValue } from '../../src/tools/schema.js';
import { GEV_ACTION_SCHEMAS } from '../../src/voice/actionSchemas.js';
import { VOICE_TOGGLE_LAYER_IDS } from '../../src/voice/layerManifest.js';

/** Every layer the app can switch on and off. */
export const REMOTE_LAYERS = VOICE_TOGGLE_LAYER_IDS;

/**
 * App actions the phone may run, through the same runner (and the same
 * argument schemas) the voice agent uses. Left out on purpose: anything that
 * edits saved data (camera calibration, annotations, scenes) or calls a paid
 * model (analyst_query).
 */
const REMOTE_ACTIONS = Object.freeze({
  fly_to_location: null,
  set_layer_visibility: null,
  set_map_stack: null,
  set_hud: null,
  set_detection: null,
  set_context_mode: null,
  select_nearest_aircraft: null,
  frame_overhead: null,
  track_entity: null,
  stop_tracking: null,
  zoom_to_globe: null,
  next_iss_pass: null,
  control_radio: null,
  control_cctv: {
    action: [
      'enable',
      'disable',
      'select',
      'next',
      'prev',
      'nearest',
      'focus',
      'autohop',
    ],
  },
});
const ACTION_SCHEMAS = new Map(
  GEV_ACTION_SCHEMAS.filter((s) => Object.hasOwn(REMOTE_ACTIONS, s.name)).map(
    (s) => [s.name, s.parameters],
  ),
);

/** Validate an app action from the phone: {name, args} or null. */
export function parseRemoteAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = typeof value.name === 'string' ? value.name : '';
  const schema = ACTION_SCHEMAS.get(name);
  if (!schema) return null;
  const args = value.args ?? {};
  if (validateValue(schema, args).length) return null;
  const narrower = REMOTE_ACTIONS[name];
  for (const [key, allowed] of Object.entries(narrower ?? {}))
    if (Object.hasOwn(args, key) && !allowed.includes(args[key])) return null;
  return { name, args };
}

export const REMOTE_CROSSINGS = Object.freeze([
  'ambassador-bridge',
  'windsor-detroit-tunnel',
  'gordie-howe-bridge',
]);

export const REMOTE_STYLES = Object.freeze([
  'normal',
  'surveillance',
  'thermal',
  'retro',
  'noir',
  'anime',
  'snow',
]);

/** Each command and the arguments it accepts (null = no argument). */
const COMMANDS = Object.freeze({
  home: null,
  layer: REMOTE_LAYERS,
  crossing: REMOTE_CROSSINGS,
  cam: ['next', 'prev', 'nearest'],
  move: ['forward', 'back', 'left', 'right'],
  zoom: ['in', 'out'],
  turn: ['left', 'right'],
  tilt: ['up', 'down'],
  orbit: null,
  style: REMOTE_STYLES,
  clean: null,
  // Continuous motion: `hold` on press and as a keep-alive, `release` on lift.
  hold: [
    'zoom-in',
    'zoom-out',
    'forward',
    'back',
    'left',
    'right',
    'turn-left',
    'turn-right',
    'tilt-up',
    'tilt-down',
  ],
  release: null,
  smooth: null,
  advanced: null,
});

const MAX_FAILS_PER_CLIENT = 5;
const CLIENT_LOCK_MS = 60_000;
const MAX_FAILS_BEFORE_NEW_PIN = 20;
const MAX_TOKENS = 16;

/** Validate a command from the phone. Returns {cmd, arg} or null. */
export function parseRemoteCommand(body) {
  if (!body || typeof body !== 'object') return null;
  const cmd = typeof body.cmd === 'string' ? body.cmd : '';
  if (!Object.hasOwn(COMMANDS, cmd) && cmd !== 'action' && cmd !== 'pad')
    return null;
  const allowed = COMMANDS[cmd];
  if (cmd === 'action') {
    const action = parseRemoteAction(body.arg);
    return action ? { cmd, arg: action } : null;
  }
  if (cmd === 'pad') {
    const pad = parsePadDelta(body.arg);
    return pad ? { cmd, arg: pad } : null;
  }
  if (allowed === null) return { cmd, arg: null };
  const arg = typeof body.arg === 'string' ? body.arg : '';
  return allowed.includes(arg) ? { cmd, arg } : null;
}

/**
 * Touch-pad gesture delta: x/y are fractions of the pad's width, zoom is
 * ln(pinch scale), turn and tilt are radians. Clamped so one update can't
 * throw the camera across the planet.
 */
const PAD_LIMITS = Object.freeze({
  x: 2,
  y: 2,
  zoom: 2,
  turn: Math.PI,
  tilt: 1.2,
});
export function parsePadDelta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, limit] of Object.entries(PAD_LIMITS)) {
    const n = value[key] ?? 0;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[key] = Math.max(-limit, Math.min(limit, n));
  }
  return out;
}

/** A fresh 4-digit PIN, zero-padded. */
export function newPin(rand = randomInt) {
  return String(rand(0, 10_000)).padStart(4, '0');
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Pairing state. `now` and the generators are injectable for tests.
 */
export function createRemoteHub({
  now = () => Date.now(),
  pinFactory = newPin,
  tokenFactory = () => randomBytes(24).toString('base64url'),
} = {}) {
  let pin = pinFactory();
  let globalFails = 0;
  const tokens = new Set();
  const fails = new Map(); // client -> {count, lockedUntil}

  return {
    get pin() {
      return pin;
    },
    get paired() {
      return tokens.size > 0;
    },

    /**
     * Trade the PIN for a token. Returns
     * {ok:true, token} | {ok:false, status, error}.
     */
    pair(client, attempt) {
      const t = now();
      const entry = fails.get(client) ?? { count: 0, lockedUntil: 0 };
      if (entry.lockedUntil > t) {
        return {
          ok: false,
          status: 429,
          error: 'Too many tries. Wait a minute.',
        };
      }
      if (typeof attempt === 'string' && sameString(attempt.trim(), pin)) {
        fails.delete(client);
        const token = tokenFactory();
        tokens.add(token);
        // Keep the newest few phones; the oldest gets signed out.
        while (tokens.size > MAX_TOKENS)
          tokens.delete(tokens.values().next().value);
        return { ok: true, token };
      }
      entry.count += 1;
      if (entry.count >= MAX_FAILS_PER_CLIENT) {
        entry.count = 0;
        entry.lockedUntil = t + CLIENT_LOCK_MS;
      }
      fails.set(client, entry);
      globalFails += 1;
      if (globalFails >= MAX_FAILS_BEFORE_NEW_PIN) {
        // Someone is guessing from many addresses: change the PIN on the TV.
        globalFails = 0;
        pin = pinFactory();
      }
      return { ok: false, status: 401, error: 'Wrong PIN' };
    },

    /** Whether an Authorization header carries a paired token. */
    authorized(header) {
      const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
      if (!match) return false;
      for (const token of tokens) if (sameString(token, match[1])) return true;
      return false;
    },

    /** Sign every phone out and show a new PIN. */
    reset() {
      tokens.clear();
      fails.clear();
      globalFails = 0;
      pin = pinFactory();
    },
  };
}

/** LAN IPv4 addresses for the "open this on your phone" hint. */
export function lanAddresses(interfaces) {
  const out = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const addr of list ?? []) {
      const v4 = addr.family === 'IPv4' || addr.family === 4;
      if (v4 && !addr.internal) out.push(addr.address);
    }
  }
  const rank = (ip) =>
    ip.startsWith('192.168.')
      ? 0
      : ip.startsWith('10.')
        ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
          ? 2
          : 3;
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Opt-in with GEV_REMOTE=1, and never while launcher sharing is on. */
export function remoteEnabled(env = {}, sharing = false) {
  if (sharing) return false;
  return /^(1|true|on)$/i.test(String(env.GEV_REMOTE ?? '').trim());
}

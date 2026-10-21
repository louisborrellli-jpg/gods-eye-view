/**
 * Continuous camera motion for the phone remote: press and hold a button on
 * the phone and the globe keeps moving every frame until you let go, instead
 * of queuing one short flight per tap.
 *
 * The phone sends `hold <action>` on press and every ~300 ms while held, and
 * `release` on lift. Motion stops on release, or on its own if keep-alives
 * stop arriving (a dropped release can never leave the globe spinning).
 * A quick tap still gives a small, deliberate nudge (MIN_HOLD_MS).
 */

import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

export const HOLD_ACTIONS = Object.freeze([
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
]);

const ZOOM_PER_SEC = 0.9; // fraction of the current height per second
const MOVE_PER_SEC = 0.8; // of the current height per second, horizontally
const TURN_DEG_PER_SEC = 45;
const TILT_DEG_PER_SEC = 28;
const RAMP_MS = 600; // start gentle, reach full speed after this
const MIN_HOLD_MS = 220;
const KEEPALIVE_MS = 900;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 2_000_000;
const MIN_PITCH = Cesium.Math.toRadians(-89);
const MAX_PITCH = Cesium.Math.toRadians(-6);
const RENDER_OWNER = 'phone-remote';

export function createRemoteMotion({ viewer, beforeStart = () => {} }) {
  const camera = viewer.camera;
  const scene = viewer.scene;
  let action = null;
  let startedAt = 0;
  let lastSeen = 0;
  let lastFrame = 0;
  let releaseAt = Infinity;
  let removeListener = null;
  let pivot = null; // { target, heading, pitch, range } while turning/tilting

  const now = () => performance.now();

  function pickPivot() {
    const canvas = scene.canvas;
    const middle = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    let target;
    try {
      const ray = camera.getPickRay(middle);
      target = ray ? scene.globe.pick(ray, scene) : undefined;
    } catch {
      target = undefined;
    }
    target ??= camera.pickEllipsoid(middle);
    if (!target) return null;
    return {
      target,
      heading: camera.heading,
      pitch: Cesium.Math.clamp(camera.pitch, MIN_PITCH, MAX_PITCH),
      range: Cesium.Cartesian3.distance(camera.positionWC, target),
    };
  }

  function horizontalMove(angle, metres) {
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC);
    const east = Cesium.Cartesian3.fromCartesian4(
      Cesium.Matrix4.getColumn(frame, 0, new Cesium.Cartesian4()),
    );
    const north = Cesium.Cartesian3.fromCartesian4(
      Cesium.Matrix4.getColumn(frame, 1, new Cesium.Cartesian4()),
    );
    const h = camera.heading + angle;
    const dir = Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(north, Math.cos(h), north),
      Cesium.Cartesian3.multiplyByScalar(east, Math.sin(h), east),
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(dir, dir);
    camera.move(dir, metres);
  }

  function step() {
    const t = now();
    if (t >= releaseAt || t - lastSeen > KEEPALIVE_MS) {
      stop();
      return;
    }
    // Cap generously so a struggling laptop (few fps) still moves at full speed.
    const dt = Math.min(0.35, (t - lastFrame) / 1000);
    lastFrame = t;
    const ramp = Math.min(1, 0.35 + (t - startedAt) / RAMP_MS);
    const height = camera.positionCartographic?.height ?? 1000;

    switch (action) {
      case 'zoom-in':
        if (height > MIN_HEIGHT)
          camera.zoomIn(height * ZOOM_PER_SEC * ramp * dt);
        break;
      case 'zoom-out':
        if (height < MAX_HEIGHT)
          camera.zoomOut(height * ZOOM_PER_SEC * ramp * dt);
        break;
      case 'forward':
      case 'back':
      case 'left':
      case 'right': {
        const angle = {
          forward: 0,
          back: Math.PI,
          left: -Math.PI / 2,
          right: Math.PI / 2,
        }[action];
        horizontalMove(angle, Math.max(height, 250) * MOVE_PER_SEC * ramp * dt);
        break;
      }
      case 'turn-left':
      case 'turn-right':
      case 'tilt-up':
      case 'tilt-down': {
        if (!pivot) break;
        const sign =
          action.endsWith('left') || action.endsWith('down') ? -1 : 1;
        if (action.startsWith('turn'))
          pivot.heading +=
            sign * Cesium.Math.toRadians(TURN_DEG_PER_SEC) * ramp * dt;
        else
          pivot.pitch = Cesium.Math.clamp(
            pivot.pitch +
              sign * Cesium.Math.toRadians(TILT_DEG_PER_SEC) * ramp * dt,
            MIN_PITCH,
            MAX_PITCH,
          );
        camera.lookAt(
          pivot.target,
          new Cesium.HeadingPitchRange(pivot.heading, pivot.pitch, pivot.range),
        );
        break;
      }
    }
  }

  function stop() {
    if (!action) return;
    removeListener?.();
    removeListener = null;
    if (pivot) camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    pivot = null;
    action = null;
    releaseAt = Infinity;
    releaseContinuousRender(RENDER_OWNER);
    scene.requestRender?.();
  }

  // ── Touch pad ─────────────────────────────────────────
  // Gesture deltas from the phone are added to `pending` and eased in over
  // the next few frames, so a 20-per-second stream of small updates still
  // glides instead of stepping.
  const pending = { x: 0, y: 0, zoom: 0, turn: 0, tilt: 0 };
  let padListener = null;
  let padFrame = 0;
  let padPivot = null;
  const PAD_EASE_PER_SEC = 14;
  const PAD_OWNER = 'phone-remote-pad';
  const tiny = () =>
    Math.abs(pending.x) + Math.abs(pending.y) < 1e-4 &&
    Math.abs(pending.zoom) < 1e-4 &&
    Math.abs(pending.turn) < 1e-4 &&
    Math.abs(pending.tilt) < 1e-4;

  function stopPad() {
    padListener?.();
    padListener = null;
    padPivot = null;
    for (const k of Object.keys(pending)) pending[k] = 0;
    releaseContinuousRender(PAD_OWNER);
    scene.requestRender?.();
  }

  function padStep() {
    const t = now();
    const dt = Math.min(0.35, (t - padFrame) / 1000);
    padFrame = t;
    if (tiny()) return stopPad();
    const k = 1 - Math.exp(-PAD_EASE_PER_SEC * dt);
    const take = {};
    for (const key of Object.keys(pending)) {
      take[key] = pending[key] * k;
      pending[key] -= take[key];
    }
    const height = Math.max(
      camera.positionCartographic?.height ?? 1000,
      MIN_HEIGHT,
    );
    const pitch = Cesium.Math.clamp(camera.pitch, MIN_PITCH, MAX_PITCH);
    // Distance to the point in the middle of the view.
    const range = height / Math.sin(-pitch);

    if (take.turn || take.tilt) {
      padPivot ??= pickPivot();
      if (padPivot) {
        padPivot.heading += take.turn;
        padPivot.pitch = Cesium.Math.clamp(
          padPivot.pitch + take.tilt,
          MIN_PITCH,
          MAX_PITCH,
        );
        camera.lookAt(
          padPivot.target,
          new Cesium.HeadingPitchRange(
            padPivot.heading,
            padPivot.pitch,
            padPivot.range,
          ),
        );
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }
    }
    if (take.x || take.y) {
      // The pad spans roughly the width of the view on the ground.
      const across = range * 1.4;
      if (take.y) horizontalMove(0, -take.y * across); // drag up = go forward
      if (take.x) horizontalMove(Math.PI / 2, -take.x * across);
      padPivot = null;
    }
    if (take.zoom) {
      // zoom = ln(scale): pinch out (scale > 1) moves toward the middle.
      const scale = Math.exp(take.zoom);
      const move = range * (1 - 1 / scale);
      if (move > 0 && height > MIN_HEIGHT) camera.zoomIn(move);
      else if (move < 0 && height < MAX_HEIGHT) camera.zoomOut(-move);
      if (padPivot)
        padPivot.range = Math.max(padPivot.range / scale, MIN_HEIGHT);
    }
  }

  return {
    /** Add a touch-pad gesture delta: {x, y, zoom, turn, tilt}. */
    pad(delta) {
      for (const key of Object.keys(pending))
        if (Number.isFinite(delta?.[key])) pending[key] += delta[key];
      if (padListener) return;
      stop();
      beforeStart();
      camera.cancelFlight?.();
      padFrame = now();
      holdContinuousRender(PAD_OWNER);
      padListener = scene.preRender.addEventListener(padStep);
    },
    stopPad,
    /** Start (or keep alive) a held action. */
    hold(name) {
      if (!HOLD_ACTIONS.includes(name)) return;
      const t = now();
      lastSeen = t;
      if (action === name) {
        releaseAt = Infinity;
        return;
      }
      stop();
      stopPad();
      beforeStart();
      camera.cancelFlight?.();
      action = name;
      startedAt = t;
      lastFrame = t;
      releaseAt = Infinity;
      if (name.startsWith('turn') || name.startsWith('tilt'))
        pivot = pickPivot();
      holdContinuousRender(RENDER_OWNER);
      removeListener = scene.preRender.addEventListener(step);
    },
    /** Let go: a tap still runs for MIN_HOLD_MS so it visibly nudges. */
    release() {
      if (action) releaseAt = Math.max(now(), startedAt + MIN_HOLD_MS);
    },
    stop,
    get active() {
      return action;
    },
  };
}

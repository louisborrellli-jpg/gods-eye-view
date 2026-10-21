import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distanceKm,
  localCameraOrder,
  nudgeView,
  stepCamera,
  viewCentre,
} from './phoneRemoteCore.js';

const VIEW = { lat: 42.24, lon: -83.045, alt: 6000, heading: 0, pitch: -40 };
const close = (a, b, tol) => Math.abs(a - b) <= tol;

test('zoom moves along the line of sight and keeps the same centre', () => {
  const before = viewCentre(VIEW);
  const zin = nudgeView(VIEW, 'zoom', 'in');
  assert.ok(zin.alt < VIEW.alt);
  const after = viewCentre(zin);
  assert.ok(distanceKm(before, after) < 0.05);
  const zout = nudgeView(VIEW, 'zoom', 'out');
  assert.ok(zout.alt > VIEW.alt);
});

test('turning pivots around the point being looked at', () => {
  const before = viewCentre(VIEW);
  const turned = nudgeView(VIEW, 'turn', 'right');
  assert.equal(turned.heading, 30);
  assert.ok(distanceKm(before, viewCentre(turned)) < 0.05);
  assert.equal(nudgeView(VIEW, 'turn', 'left').heading, 330);
});

test('tilt stays between straight down and just above the horizon', () => {
  let v = VIEW;
  for (let i = 0; i < 20; i += 1) v = nudgeView(v, 'tilt', 'up');
  assert.equal(v.pitch, -12);
  for (let i = 0; i < 20; i += 1) v = nudgeView(v, 'tilt', 'down');
  assert.equal(v.pitch, -89);
});

test('moves slide the view relative to where it faces', () => {
  const fwd = nudgeView(VIEW, 'move', 'forward');
  assert.ok(fwd.lat > VIEW.lat && close(fwd.lon, VIEW.lon, 1e-9));
  const right = nudgeView({ ...VIEW, heading: 90 }, 'move', 'right');
  assert.ok(right.lat < VIEW.lat); // facing east, right is south
  assert.equal(nudgeView(VIEW, 'move', 'up'), null);
  assert.equal(nudgeView(null, 'zoom', 'in'), null);
});

test('local cameras are ordered nearest downtown first; far ones dropped', () => {
  const cams = [
    { id: 'toronto', lat: 43.65, lon: -79.38 },
    { id: 'detroit', lat: 42.33, lon: -83.05 },
    { id: 'windsor', lat: 42.3, lon: -83.03 },
    { id: 'tecumseh', lat: 42.3, lon: -82.87 },
    { id: 'broken', lat: null, lon: -83 },
  ];
  assert.deepEqual(localCameraOrder(cams), ['windsor', 'detroit', 'tecumseh']);
});

test('camera stepping wraps and starts sensibly', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(stepCamera(order, 'a', 1), 'b');
  assert.equal(stepCamera(order, 'c', 1), 'a');
  assert.equal(stepCamera(order, 'a', -1), 'c');
  assert.equal(stepCamera(order, 'austin', 1), 'a');
  assert.equal(stepCamera(order, null, -1), 'c');
  assert.equal(stepCamera([], 'a', 1), null);
});

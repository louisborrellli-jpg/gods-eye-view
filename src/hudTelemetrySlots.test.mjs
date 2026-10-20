import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUD_OPTICS_LINE,
  HUD_PROVENANCE_BANNER,
  feedFreshness,
  feedStatusLine,
  formatAge,
  formatAltitude,
  formatImageryLabel,
  formatNiirs,
  imageryStripLines,
  shortImageryLabel,
} from './hudTelemetrySlots.js';

const NOW = 1_700_000_000_000;
const layer = (id, enabled, stats) => ({ id, name: id, enabled, stats });

test('the banner and optics line describe what this view actually is', () => {
  assert.equal(HUD_PROVENANCE_BANNER, 'OPEN SOURCE // PUBLIC DATA // UNCLASSIFIED');
  // The slot exists so a reader knows GSD/NIIRS come from a synthetic camera.
  assert.match(HUD_OPTICS_LINE, /SYNTHETIC/);
});

test('imagery readouts name the active stack and never invent one', () => {
  assert.equal(formatImageryLabel({ label: 'Esri Satellite' }), 'ESRI SATELLITE');
  assert.equal(formatImageryLabel({ id: 'osm' }), 'OSM');
  assert.equal(formatImageryLabel({ label: '   ' }), 'UNKNOWN');
  assert.equal(formatImageryLabel(null), 'UNKNOWN');

  // The strip is rotated down the screen edge, so it carries the vendor only.
  assert.equal(shortImageryLabel({ label: 'Esri Satellite' }), 'ESRI');
  assert.equal(shortImageryLabel({ label: 'Bing Aerial' }), 'BING');
  assert.equal(shortImageryLabel({ id: 'osm' }), 'OSM');
  assert.equal(shortImageryLabel(null), 'UNKNOWN');

  assert.deepEqual(imageryStripLines({ label: 'Google 3D' }, { terrain: true }), [
    'SRC: GOOGLE',
    'PROJ: WGS84',
    'TERR: ON',
  ]);
  assert.deepEqual(imageryStripLines(null), [
    'SRC: UNKNOWN',
    'PROJ: WGS84',
    'TERR: OFF',
  ]);
});

test('only a nominal feed counts as live', () => {
  const layers = [
    layer('flights', true, { count: 40, lastUpdate: NOW - 5_000 }),
    layer('traffic', true, { count: 10, lastUpdate: NOW - 20_000, mode: 'sim' }),
    layer('vessels', true, { count: 3, lastUpdate: NOW - 90_000, stale: true }),
    layer('fires', false, { count: 0, lastUpdate: null }),
  ];
  const freshness = feedFreshness(layers, { now: NOW });
  // Three enabled; the simulated and the stale one are not live.
  assert.deepEqual(freshness, { enabled: 3, live: 1, oldestAgeSec: 90 });
});

test('the oldest enabled feed bounds the reading, disabled feeds aside', () => {
  const layers = [
    layer('a', true, { count: 1, lastUpdate: NOW - 1_000 }),
    layer('b', true, { count: 1, lastUpdate: NOW - 7_200_000 }),
    // A disabled feed is older still and must not drag the reading down.
    layer('c', false, { count: 1, lastUpdate: NOW - 99_999_999 }),
  ];
  assert.equal(feedFreshness(layers, { now: NOW }).oldestAgeSec, 7200);
});

test('a feed that has never reported leaves the age unknown, not zero', () => {
  const layers = [layer('a', true, { count: 0, lastUpdate: null })];
  const freshness = feedFreshness(layers, { now: NOW });
  assert.equal(freshness.enabled, 1);
  assert.equal(freshness.oldestAgeSec, null);
  assert.equal(feedStatusLine(layers, { now: NOW }), 'FEEDS: 1/1 LIVE');
});

test('age formatting stays inside the corner width', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(59), '59s');
  assert.equal(formatAge(60), '1m');
  assert.equal(formatAge(3599), '59m');
  assert.equal(formatAge(3600), '1h');
  assert.equal(formatAge(null), '--');
  assert.equal(formatAge(-1), '--');
});

test('the feed line reports the real tally, and says when nothing is on', () => {
  assert.equal(feedStatusLine([], { now: NOW }), 'FEEDS: NONE ENABLED');
  assert.equal(
    feedStatusLine([layer('x', false, { count: 5, lastUpdate: NOW })], { now: NOW }),
    'FEEDS: NONE ENABLED',
  );
  assert.equal(
    feedStatusLine(
      [
        layer('a', true, { count: 2, lastUpdate: NOW - 12_000 }),
        layer('b', true, { count: 2, lastUpdate: NOW - 3_000 }),
      ],
      { now: NOW },
    ),
    'FEEDS: 2/2 LIVE · OLDEST 12s',
  );
});

test('altitude stays legible across the camera\'s whole range', () => {
  assert.equal(formatAltitude(600), '600m');
  assert.equal(formatAltitude(9_999), '9999m');
  // Above the metre range a globe standoff reads as kilometres, not as the
  // eight-digit metre count the HUD used to print.
  assert.equal(formatAltitude(10_000), '10km');
  assert.equal(formatAltitude(18_000_000), '18000km');
  assert.equal(formatAltitude(-30), '-30m');
  assert.equal(formatAltitude(null), '--');
  assert.equal(formatAltitude(Number.NaN), '--');
});

test('NIIRS reports a rating only where the scale actually applies', () => {
  // A street-level view: the rating the GIQE form genuinely yields.
  assert.equal(formatNiirs(0.23), '7.1');
  // Past ~31 m GSD the form goes negative. That must read unknown rather
  // than the clamped "0.0" the HUD used to assert from orbit-scale altitude.
  assert.equal(formatNiirs(6750), '--');
  assert.equal(formatNiirs(100), '--');
  assert.equal(formatNiirs(31), '0.0');
  // The top of the scale stays clamped: 9 is the best rating it defines.
  assert.equal(formatNiirs(0.01), '9.0');
  assert.equal(formatNiirs(0), '--');
  assert.equal(formatNiirs(null), '--');
});

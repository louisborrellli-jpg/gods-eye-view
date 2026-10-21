import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeNwsAlerts,
  normalizeEcccAlerts,
  mergeAlertRecords,
  severityStyle,
  ringsCentroid,
  SEVERITY,
} from './records.js';

const SQUARE = [
  [-83.1, 42.2],
  [-83.0, 42.2],
  [-83.0, 42.3],
  [-83.1, 42.3],
  [-83.1, 42.2],
];

function nwsFeature(overrides = {}) {
  return {
    geometry: { type: 'Polygon', coordinates: [SQUARE] },
    properties: {
      id: 'urn:oid:1',
      event: 'Flood Warning',
      severity: 'Severe',
      areaDesc: 'Wayne, MI',
      headline: 'Flood Warning issued',
      expires: '2999-01-01T00:00:00Z',
      ...overrides,
    },
  };
}

test('NWS: polygon alerts normalize; zone-only (null geometry) are dropped', () => {
  const payload = {
    features: [
      nwsFeature(),
      { geometry: null, properties: { id: 'z', event: 'Heat Advisory' } },
    ],
  };
  const out = normalizeNwsAlerts(payload);
  assert.equal(out.length, 1, 'the null-geometry zone alert is skipped');
  assert.equal(out[0].source, 'NWS');
  assert.equal(out[0].event, 'Flood Warning');
  assert.equal(out[0].severityRank, SEVERITY.SEVERE);
  assert.equal(out[0].rings.length, 1);
});

test('NWS severity words map to ranks, unknown falls to 0', () => {
  const rank = (sev) =>
    normalizeNwsAlerts({ features: [nwsFeature({ severity: sev })] })[0]
      .severityRank;
  assert.equal(rank('Extreme'), SEVERITY.EXTREME);
  assert.equal(rank('Moderate'), SEVERITY.MODERATE);
  assert.equal(rank('Minor'), SEVERITY.MINOR);
  assert.equal(rank('bogus'), SEVERITY.UNKNOWN);
});

test('ECCC: alert_type maps to severity and every feature keeps its polygon', () => {
  const payload = {
    features: [
      {
        geometry: { type: 'Polygon', coordinates: [SQUARE] },
        properties: {
          feature_id: 'f1',
          alert_code: 'c1',
          alert_type: 'warning',
          alert_name_en: 'Snowfall Warning',
          feature_name_en: 'Windsor',
          expiration_datetime: '2999-01-01T00:00:00Z',
        },
      },
    ],
  };
  const out = normalizeEcccAlerts(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'ECCC');
  assert.equal(out[0].event, 'Snowfall Warning');
  assert.equal(out[0].severityRank, SEVERITY.SEVERE); // warning
});

test('merge dedupes, drops expired, sorts by severity, and caps', () => {
  const now = 1_000_000;
  const a = {
    id: 'a',
    severityRank: SEVERITY.MINOR,
    expires: now + 1000,
    rings: [SQUARE],
  };
  const b = {
    id: 'b',
    severityRank: SEVERITY.EXTREME,
    expires: now + 1000,
    rings: [SQUARE],
  };
  const expired = {
    id: 'c',
    severityRank: SEVERITY.SEVERE,
    expires: now - 1,
    rings: [SQUARE],
  };
  const dup = { ...a };
  const merged = mergeAlertRecords(
    [
      [a, expired],
      [b, dup],
    ],
    { cap: 10, now },
  );
  assert.deepEqual(
    merged.map((r) => r.id),
    ['b', 'a'],
    'extreme first, expired dropped, duplicate id collapsed',
  );
  assert.equal(mergeAlertRecords([[a, b]], { cap: 1, now }).length, 1, 'cap');
});

test('MultiPolygon yields one ring per polygon; bad rings are rejected', () => {
  const multi = {
    features: [
      {
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[SQUARE], [SQUARE]],
        },
        properties: { id: 'm', event: 'Winter Storm Warning' },
      },
      {
        geometry: { type: 'Polygon', coordinates: [[[0, 0]]] }, // too few points
        properties: { id: 'bad', event: 'x' },
      },
    ],
  };
  const out = normalizeNwsAlerts(multi);
  assert.equal(out.length, 1);
  assert.equal(out[0].rings.length, 2);
});

test('severityStyle and ringsCentroid are sane', () => {
  assert.equal(severityStyle(SEVERITY.SEVERE).label, 'Severe');
  assert.equal(severityStyle(999).label, 'Unknown');
  const c = ringsCentroid([SQUARE]);
  assert.ok(c.lon < -82.9 && c.lon > -83.2 && c.lat > 42.1 && c.lat < 42.4);
});

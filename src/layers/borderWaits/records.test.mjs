import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CROSSINGS,
  headlineMinutes,
  parseCbpFeed,
  parseCbpLane,
  parseCbsaCsv,
  parseWaitCell,
  waitColor,
} from './records.js';

const CBSA = [
  'Customs Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Commercial Flow - U.S. bound;; Travellers Flow - Canada bound;; Travellers Flow - U.S. bound;;',
  'Ambassador Bridge;; Windsor, ON/Detroit, MI;; 2026-10-20 19:45 EDT;; 40 minutes;; --;; No Delay;; --;; ',
  'Nowhere Crossing;; X;; t;; No Delay;; --;; No Delay;; --;; ',
].join('\n');

test('CBSA cells and colours parse as expected', () => {
  assert.deepEqual(parseWaitCell('No Delay'), {
    minutes: 0,
    closed: false,
    text: 'No Delay',
  });
  assert.equal(parseWaitCell('40 minutes').minutes, 40);
  assert.equal(parseWaitCell('1 hour 10 minutes').minutes, 70);
  assert.equal(parseWaitCell('--').minutes, null);
  assert.equal(parseWaitCell('Closed').closed, true);
  assert.equal(waitColor(null), '#9e9e9e');
  assert.equal(waitColor(0), '#43a047');
  assert.equal(waitColor(90), '#e53935');
});

test('only crossings with a coordinate are placed', () => {
  const rows = parseCbsaCsv(CBSA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ambassador Bridge');
  assert.equal(rows[0].canadaBound.commercial.minutes, 40);
  assert.equal(rows[0].canadaBound.travellers.minutes, 0);
  // Without CBP, the U.S. direction is "--" (not reported).
  assert.equal(rows[0].usBound.travellers.minutes, null);
  assert.equal(parseCbsaCsv('').length, 0);
});

test('CBP merges into the U.S.-bound direction by port number', () => {
  const cbp = parseCbpFeed([
    {
      port_number: '380001',
      border: 'Canadian Border',
      passenger_vehicle_lanes: {
        standard_lanes: { delay_minutes: '25', operational_status: 'delay' },
      },
      commercial_vehicle_lanes: {
        standard_lanes: {
          delay_minutes: '',
          operational_status: 'Lanes Closed',
        },
      },
    },
    {
      port_number: '999999',
      border: 'Mexican Border',
      passenger_vehicle_lanes: {},
    },
  ]);
  assert.ok(cbp.has('380001'));
  assert.ok(!cbp.has('999999'), 'Mexican-border ports are excluded');
  const rows = parseCbsaCsv(CBSA, cbp);
  const amb = rows.find((r) => r.name === 'Ambassador Bridge');
  assert.equal(amb.usBound.travellers.minutes, 25);
  assert.equal(amb.usBound.commercial.closed, true);
  // Headline is the worse of the two traveller directions (US 25 > CA 0).
  assert.equal(headlineMinutes(amb), 25);
});

test('CBP lane statuses map correctly', () => {
  assert.equal(
    parseCbpLane({ operational_status: 'Lanes Closed' }).closed,
    true,
  );
  assert.equal(
    parseCbpLane({ delay_minutes: '0', operational_status: 'no delay' })
      .minutes,
    0,
  );
  assert.equal(parseCbpLane({ delay_minutes: '15' }).minutes, 15);
  assert.equal(
    parseCbpLane({ operational_status: 'Update Pending' }).minutes,
    null,
  );
});

test('every Windsor crossing is placed and mapped to a CBP port', () => {
  for (const name of [
    'Windsor and Detroit Tunnel',
    'Ambassador Bridge',
    'Gordie Howe International Bridge',
  ]) {
    assert.ok(CROSSINGS[name], `${name} placed`);
    assert.match(CROSSINGS[name].cbp, /^\d{6}$/, `${name} has a CBP port`);
  }
});

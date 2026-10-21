import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  carrierForContainer,
  carrierTrackingUrl,
  containerCheckDigit,
  normalizeContainerNumber,
  parseContainerNumber,
} from './containers.js';

test('the ISO 6346 check digit matches the standard example', () => {
  assert.equal(containerCheckDigit('CSQU305438'), 3);
  assert.equal(containerCheckDigit('MSCU123456'), 6);
  assert.equal(containerCheckDigit('MSCU12345'), null);
});

test('typed numbers are normalized before checking', () => {
  assert.equal(normalizeContainerNumber(' mscu 123456-6 '), 'MSCU1234566');
  const parsed = parseContainerNumber('mscu 123456 6');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.carrier, 'msc');
  assert.equal(parsed.problem, null);
});

test('a wrong check digit is well formed but flagged as a likely typo', () => {
  const parsed = parseContainerNumber('MSCU1234565');
  assert.equal(parsed.wellFormed, true);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.expectedCheckDigit, 6);
  assert.match(parsed.problem, /typo/);
});

test('malformed and empty numbers cannot be saved', () => {
  assert.equal(parseContainerNumber('').wellFormed, false);
  assert.equal(parseContainerNumber('MSC1234567').wellFormed, false);
  assert.equal(parseContainerNumber('MSCX1234566').wellFormed, false);
});

test('owner codes name the line; lessor boxes do not', () => {
  assert.equal(carrierForContainer('MEDU1234567'), 'msc');
  assert.equal(carrierForContainer('MSKU1234567'), 'maersk');
  assert.equal(carrierForContainer('HLXU1234567'), 'hapag');
  assert.equal(carrierForContainer('CMAU1234567'), 'cma');
  assert.equal(carrierForContainer('TGHU1234567'), null);
  const leased = parseContainerNumber(
    `TGHU123456${containerCheckDigit('TGHU123456')}`,
  );
  assert.equal(leased.valid, true);
  assert.equal(leased.leased, true);
  assert.equal(leased.carrier, null);
});

test('tracking links carry the encoded number, or none for an unknown line', () => {
  assert.equal(
    carrierTrackingUrl('maersk', 'msku 1234567'),
    'https://www.maersk.com/tracking/MSKU1234567',
  );
  assert.match(
    carrierTrackingUrl('msc', 'MSCU1234566'),
    /trackingNumber=MSCU1234566$/,
  );
  assert.equal(carrierTrackingUrl('', 'MSCU1234566'), null);
});

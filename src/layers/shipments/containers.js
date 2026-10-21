/**
 * Container numbers (ISO 6346), the shipping line that owns the box, and the
 * public tracking pages for each line. Pure data: no DOM, no network.
 */
import { msg } from '../../i18n/marker.js';

// ISO 6346 letter values: A=10 upward, skipping multiples of 11.
const LETTER_VALUES = (() => {
  const values = {};
  let value = 10;
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (value % 11 === 0) value++;
    values[letter] = value++;
  }
  return Object.freeze(values);
})();

/**
 * Shipping lines with their owner codes (first four letters of the box
 * number) and the public tracking page. `{n}` is replaced by the container
 * number; lines whose page cannot take the number in the address open the
 * plain search page instead.
 */
export const CARRIERS = Object.freeze({
  msc: Object.freeze({
    name: 'MSC',
    prefixes: ['MSCU', 'MEDU', 'MSDU', 'MSMU'],
    trackUrl: 'https://www.msc.com/en/track-a-shipment?trackingNumber={n}',
  }),
  maersk: Object.freeze({
    name: 'Maersk',
    prefixes: ['MAEU', 'MSKU', 'MRKU', 'MRSU', 'SUDU'],
    trackUrl: 'https://www.maersk.com/tracking/{n}',
  }),
  hapag: Object.freeze({
    name: 'Hapag-Lloyd',
    prefixes: ['HLXU', 'HLBU', 'HAMU', 'UACU'],
    trackUrl:
      'https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container={n}',
  }),
  cma: Object.freeze({
    name: 'CMA CGM',
    prefixes: ['CMAU', 'CGMU', 'ECMU', 'APZU', 'APHU'],
    trackUrl:
      'https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference={n}',
  }),
  cosco: Object.freeze({
    name: 'COSCO',
    prefixes: ['CSNU', 'CBHU', 'CCLU'],
    trackUrl:
      'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number={n}',
  }),
  one: Object.freeze({
    name: 'ONE',
    prefixes: ['ONEU', 'NYKU', 'MOLU', 'KKFU'],
    trackUrl:
      'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam={n}',
  }),
  evergreen: Object.freeze({
    name: 'Evergreen',
    prefixes: ['EGHU', 'EISU', 'EMCU', 'EGSU'],
    trackUrl: 'https://www.shipmentlink.com/servlet/TDB1_CargoTracking.do',
  }),
  oocl: Object.freeze({
    name: 'OOCL',
    prefixes: ['OOLU', 'OOCU'],
    trackUrl:
      'https://www.oocl.com/eng/ourservices/eservices/cargotracking/Pages/cargotracking.aspx',
  }),
  zim: Object.freeze({
    name: 'ZIM',
    prefixes: ['ZIMU', 'ZCSU'],
    trackUrl: 'https://www.zim.com/tools/track-a-shipment?consnumber={n}',
  }),
  hmm: Object.freeze({
    name: 'HMM',
    prefixes: ['HDMU', 'HMMU'],
    trackUrl:
      'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do',
  }),
  yangming: Object.freeze({
    name: 'Yang Ming',
    prefixes: ['YMLU', 'YMMU'],
    trackUrl:
      'https://www.yangming.com/e-service/Track_Trace/track_trace_cargo_tracking.aspx',
  }),
});

export const CARRIER_IDS = Object.freeze(Object.keys(CARRIERS));

// Leasing companies own many boxes that lines then use, so the number alone
// cannot name the line.
const LESSOR_PREFIXES = new Set([
  'TCNU',
  'TGHU',
  'TRHU',
  'TCLU',
  'TEMU',
  'TGBU',
  'TTNU',
  'FSCU',
  'FCIU',
  'CAIU',
  'SEGU',
  'GESU',
  'BMOU',
  'DFSU',
  'BEAU',
  'CRSU',
  'TLLU',
  'TRLU',
]);

const PREFIX_TO_CARRIER = (() => {
  const map = new Map();
  for (const [id, carrier] of Object.entries(CARRIERS))
    for (const prefix of carrier.prefixes) map.set(prefix, id);
  return map;
})();

/**
 * Uppercase a typed container number and drop spaces, dashes and slashes:
 * "mscu 123456-6" → "MSCU1234566".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeContainerNumber(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[\s\-/.]/g, '');
}

/**
 * The ISO 6346 check digit for the first ten characters, or null when they
 * are not four letters and six digits.
 * @param {string} first10
 * @returns {number|null}
 */
export function containerCheckDigit(first10) {
  if (!/^[A-Z]{4}\d{6}$/.test(first10)) return null;
  let sum = 0;
  for (let index = 0; index < 10; index++) {
    const char = first10[index];
    const value = index < 4 ? LETTER_VALUES[char] : Number(char);
    sum += value * 2 ** index;
  }
  return (sum % 11) % 10;
}

/**
 * Check a typed container number.
 *
 * `problem` is English for the UI to translate: a malformed number cannot be
 * tracked, while a wrong check digit usually means a typo and is worth a
 * second look, so it stays saveable (`valid` false, `wellFormed` true).
 *
 * @param {unknown} value
 * @returns {{number:string, valid:boolean, wellFormed:boolean,
 *   expectedCheckDigit:number|null, owner:string, carrier:string|null,
 *   leased:boolean, problem:string|null}}
 */
export function parseContainerNumber(value) {
  const number = normalizeContainerNumber(value);
  const owner = number.slice(0, 4);
  const base = {
    number,
    valid: false,
    wellFormed: false,
    expectedCheckDigit: null,
    owner: /^[A-Z]{4}$/.test(owner) ? owner : '',
    carrier: null,
    leased: false,
    problem: null,
  };
  if (!number) return { ...base, problem: msg('Enter a container number') };
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(number))
    return {
      ...base,
      problem: msg('Container numbers are 4 letters and 7 digits'),
    };
  const expected = containerCheckDigit(number.slice(0, 10));
  const carrier = PREFIX_TO_CARRIER.get(owner) ?? null;
  const result = {
    ...base,
    wellFormed: true,
    expectedCheckDigit: expected,
    carrier,
    leased: LESSOR_PREFIXES.has(owner),
  };
  if (expected !== Number(number[10]))
    return {
      ...result,
      problem: msg('The last digit does not match — check for a typo'),
    };
  return { ...result, valid: true };
}

/**
 * The shipping line that owns a box, from its owner code.
 * @param {string} number Normalized container number.
 * @returns {string|null} Carrier id.
 */
export function carrierForContainer(number) {
  return (
    PREFIX_TO_CARRIER.get(normalizeContainerNumber(number).slice(0, 4)) ?? null
  );
}

/**
 * The line's public tracking page for this box, or null for an unknown line.
 * @param {string} carrierId
 * @param {string} number
 * @returns {string|null}
 */
export function carrierTrackingUrl(carrierId, number) {
  const carrier = CARRIERS[carrierId];
  if (!carrier) return null;
  return carrier.trackUrl.replace(
    '{n}',
    encodeURIComponent(normalizeContainerNumber(number)),
  );
}

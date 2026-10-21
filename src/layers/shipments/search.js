/**
 * Finding a container by whatever the person remembers: part of the number,
 * their own reference, the ship or the shipping line. Pure, no DOM.
 */
import { CARRIERS } from './containers.js';

function fold(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Text a search can match for one shipment. */
function haystack(shipment) {
  return [
    shipment.container,
    shipment.reference,
    shipment.notes,
    shipment.vessel?.query,
    shipment.lastSeen?.name,
    shipment.auto?.vessel?.name,
    CARRIERS[shipment.carrier]?.name,
    shipment.auto?.pol?.port,
    shipment.auto?.pod?.port,
    shipment.auto?.destination?.port,
  ]
    .map(fold)
    .filter(Boolean);
}

/**
 * Whether a shipment matches a typed search. Every word must appear
 * somewhere; container numbers also match with the spaces left out
 * ("MSCU 123" finds MSCU1234566).
 * @param {object} shipment
 * @param {string} query
 */
export function matchesSearch(shipment, query) {
  const words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const fields = haystack(shipment);
  const joined = fields.join(' ');
  const compactQuery = words.join('');
  if (fold(shipment.container).replace(/ /g, '').includes(compactQuery))
    return true;
  return words.every((word) => joined.includes(word));
}

/**
 * The shipments a search finds, best first: an exact container number,
 * then numbers that start with the search, then everything else.
 */
export function searchShipments(shipments, query) {
  const compact = fold(query).replace(/ /g, '');
  const rank = (shipment) => {
    const number = fold(shipment.container).replace(/ /g, '');
    if (number === compact) return 0;
    if (number.startsWith(compact)) return 1;
    return 2;
  };
  return shipments
    .filter((shipment) => matchesSearch(shipment, query))
    .sort((a, b) => rank(a) - rank(b));
}

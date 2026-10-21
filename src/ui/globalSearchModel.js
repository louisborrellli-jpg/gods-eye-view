/**
 * One search for everything in the app: containers, what each map layer
 * lists (zones, ships, flights, cameras…), the layers themselves, and finally
 * places on the map. Pure: the caller supplies the data and runs the action.
 */
import { searchShipments } from '../layers/shipments/search.js';

const MAX_CONTAINERS = 5;
const MAX_ITEMS = 6;
const MAX_LAYERS = 4;

export function foldText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9а-яё]+/g, ' ')
    .trim();
}

/** Every typed word appears somewhere in `text`. */
export function matchesWords(text, query) {
  const words = foldText(query).split(' ').filter(Boolean);
  if (!words.length) return false;
  const hay = foldText(text);
  const squeezed = hay.replace(/ /g, '');
  return words.every((word) => hay.includes(word) || squeezed.includes(word));
}

/**
 * @param {string} query
 * @param {{shipments?: Array<object>,
 *   layers?: Array<{id: string, name: string, enabled: boolean}>,
 *   items?: Array<{layerId: string, layerName: string, id: string,
 *     text: string, params: object}>,
 *   shipmentsLayerId?: string}} sources
 * @returns {Array<{kind: 'container'|'item'|'layer'|'place', key: string,
 *   title: string, detail: string, target: object}>}
 */
export function searchEverything(query, sources = {}) {
  const text = String(query ?? '').trim();
  if (foldText(text).length < 2) return [];
  const results = [];

  for (const shipment of searchShipments(sources.shipments ?? [], text).slice(
    0,
    MAX_CONTAINERS,
  ))
    results.push({
      kind: 'container',
      key: `container:${shipment.id}`,
      title: shipment.container,
      detail: [shipment.reference, shipment.auto?.vessel?.name]
        .filter(Boolean)
        .join(' · '),
      target: { id: shipment.id, container: shipment.container },
    });

  const seen = new Set();
  for (const item of sources.items ?? []) {
    if (results.filter((r) => r.kind === 'item').length >= MAX_ITEMS) break;
    if (item.layerId === sources.shipmentsLayerId) continue;
    const key = `item:${item.layerId}:${item.id}`;
    if (seen.has(key) || !matchesWords(item.text, text)) continue;
    seen.add(key);
    results.push({
      kind: 'item',
      key,
      title: item.text,
      detail: item.layerName,
      target: { layerId: item.layerId, params: item.params },
    });
  }

  for (const layer of sources.layers ?? []) {
    if (results.filter((r) => r.kind === 'layer').length >= MAX_LAYERS) break;
    if (!matchesWords(layer.name, text)) continue;
    results.push({
      kind: 'layer',
      key: `layer:${layer.id}`,
      title: layer.name,
      detail: '',
      target: { layerId: layer.id, enabled: Boolean(layer.enabled) },
    });
  }

  results.push({
    kind: 'place',
    key: 'place',
    title: text,
    detail: '',
    target: { query: text },
  });
  return results;
}

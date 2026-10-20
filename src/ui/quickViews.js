import { msg } from '../i18n/index.js';

/**
 * Quick views: one click for "I want to see X".
 *
 * The Data Layers panel answers "which feeds exist"; it does not answer "what
 * do I turn on to watch traffic". These do, and they are deliberately small —
 * each is a couple of layers a newcomer would otherwise have to find among
 * thirty rows and know to combine.
 *
 * A view is exact, not additive: picking one enables its layers and disables
 * every other toggleable layer, so the same click always produces the same
 * globe. Anything else makes two clicks of the same button mean two different
 * things.
 *
 * Only keyless-or-already-free feeds appear here. A view whose layers need a
 * key the operator has not added still works — the layer itself reports what
 * it needs, exactly as it does when switched on by hand.
 */
export const QUICK_VIEWS = Object.freeze([
  Object.freeze({
    id: 'traffic',
    label: msg('Traffic & cameras'),
    layerIds: Object.freeze(['traffic', 'cctv']),
  }),
  Object.freeze({
    id: 'aircraft',
    label: msg('Aircraft'),
    layerIds: Object.freeze(['flights', 'military']),
  }),
  Object.freeze({
    id: 'ships',
    label: msg('Ships'),
    layerIds: Object.freeze(['ais-live-vessels']),
  }),
  Object.freeze({
    id: 'weather',
    label: msg('Weather'),
    layerIds: Object.freeze(['weather-radar', 'wind', 'aurora']),
  }),
  Object.freeze({
    id: 'events',
    label: msg('Earth events'),
    layerIds: Object.freeze(['earthquakes', 'local-firms']),
  }),
]);

/** @param {string} id @returns {object|null} */
export function quickView(id) {
  return QUICK_VIEWS.find((view) => view.id === id) || null;
}

/**
 * The exact enable/disable plan for a view, against the layers that exist.
 *
 * A layer the view names but the catalog does not carry is simply absent from
 * the plan rather than enabled blindly, and a layer the panel never shows
 * (hidden coordinators) is left alone entirely: it is not the operator's to
 * see, so a view must not switch it off underneath the layers that depend
 * on it.
 *
 * @param {string} viewId
 * @param {Array<{id: string, showInTogglePanel?: boolean}>} [layers]
 * @returns {{enable: string[], disable: string[]}|null} Null for an unknown view.
 */
export function planQuickView(viewId, layers = []) {
  const view = quickView(viewId);
  if (!view) return null;
  const wanted = new Set(view.layerIds);
  const enable = [];
  const disable = [];
  for (const layer of layers) {
    const id = layer?.id;
    if (!id || layer.showInTogglePanel === false) continue;
    if (wanted.has(id)) enable.push(id);
    else disable.push(id);
  }
  return { enable, disable };
}

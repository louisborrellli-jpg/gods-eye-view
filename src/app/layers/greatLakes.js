import { createGreatLakesLayer } from '../../layers/greatLakes/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire the Great Lakes layer to its reference source and overlay host. */
export function createApplicationGreatLakes(options) {
  return createGreatLakesLayer({ overlayHost, ...options });
}

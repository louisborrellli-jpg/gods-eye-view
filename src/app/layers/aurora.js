import { createAuroraLayer } from '../../layers/aurora/index.js';
/** Wire the aurora nowcast overlay to the application viewer. */
export function createApplicationAurora(options) {
  return createAuroraLayer(options);
}

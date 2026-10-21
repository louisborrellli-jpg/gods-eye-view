import { createMeLayer } from '../../layers/me/index.js';

function browserGeolocation() {
  try {
    return globalThis.navigator?.geolocation ?? null;
  } catch {
    return null;
  }
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Wire the device-local "Me" location layer to the browser's services. */
export function createApplicationMe(options = {}) {
  return createMeLayer({
    geolocation: browserGeolocation(),
    storage: browserStorage(),
    ...options,
  });
}

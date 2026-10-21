/**
 * Register the service worker, but only where it is safe and useful:
 *   - production only (never the dev server, whose module URLs must not be
 *     cached),
 *   - a secure context (HTTPS or localhost; the browser requires it),
 *   - and only when the browser supports service workers.
 *
 * Registration failure is swallowed — the app works fine without the worker,
 * so a blocked or unsupported registration must never surface to the user.
 *
 * @param {object} [deps]
 * @param {boolean} [deps.enabled] Gate (pass import.meta.env.PROD).
 * @param {ServiceWorkerContainer} [deps.serviceWorker]
 * @param {boolean} [deps.secureContext]
 * @param {(sw: ServiceWorkerContainer, url: string) => Promise<unknown>} [deps.register]
 * @param {string} [deps.url]
 * @returns {boolean} true when registration was attempted (all gates passed).
 */
export function registerServiceWorker({
  enabled,
  serviceWorker = globalThis.navigator?.serviceWorker,
  secureContext = globalThis.isSecureContext,
  register = (sw, url) => sw.register(url),
  url = '/sw.js',
} = {}) {
  if (!enabled || !serviceWorker || !secureContext) return false;
  try {
    Promise.resolve(register(serviceWorker, url)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

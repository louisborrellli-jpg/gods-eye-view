import { createWeatherAlertsLayer } from '../../layers/weatherAlerts/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire the weather-alerts layer to its reference source and overlay host. */
export function createApplicationWeatherAlerts(options) {
  return createWeatherAlertsLayer({ overlayHost, ...options });
}

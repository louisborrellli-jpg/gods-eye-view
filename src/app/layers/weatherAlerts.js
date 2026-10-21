import { createWeatherAlertsLayer } from '../../layers/weatherAlerts/index.js';

/** Wire the weather-alerts layer to its reference source. */
export function createApplicationWeatherAlerts(options) {
  return createWeatherAlertsLayer(options);
}

import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import {
  prepareWindsorStart,
  startWindsorMode,
  windsorModeEnabled,
} from './windsor/windsorMode.js';
import { startPhoneRemote } from './windsor/phoneRemote.js';

// Windsor mode (on unless VITE_WINDSOR_MODE=0): open on Windsor with the
// simple panel. Must run before the app reads the start view.
const windsorMode = windsorModeEnabled(import.meta.env.VITE_WINDSOR_MODE);
if (windsorMode) prepareWindsorStart();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application
  .start()
  .then(() => {
    // Phone remote (only when the server runs with GEV_REMOTE=1).
    startPhoneRemote().catch((error) =>
      console.warn('[phone remote] unavailable', error),
    );
    if (windsorMode) return startWindsorMode();
  })
  .catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = t('Error: {message}', {
      message: describeError(error),
    });
    loaderStatus.style.color = '#ff4444';
  });

export { application };

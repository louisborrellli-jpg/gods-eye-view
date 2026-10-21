/**
 * Entry for /shipments.html: the Shipments page on its own, without the
 * globe. It shares the browser storage and server routes with the Shipments
 * layer, so containers added in either place show in both.
 */
import { applyDocumentLanguage, resolveLocale } from './i18n/locale.js';
import { setLocale } from './i18n/index.js';
import { createShipmentsDashboard } from './ui/shipmentsDashboard.js';

const locale = resolveLocale();
setLocale(locale);
applyDocumentLanguage(document, locale);

const root = document.getElementById('shipments-app');
if (root) createShipmentsDashboard({ root });

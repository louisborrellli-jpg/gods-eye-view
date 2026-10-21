/**
 * Entry for /home.html: the simple start page for people who only need to
 * find a container, see the list, add one or look at the map.
 */
import { applyDocumentLanguage, resolveLocale } from './i18n/locale.js';
import { setLocale } from './i18n/index.js';
import { createSimpleHome } from './ui/simpleHome.js';

const locale = resolveLocale();
setLocale(locale);
applyDocumentLanguage(document, locale);

const root = document.getElementById('simple-home');
if (root) createSimpleHome({ root });

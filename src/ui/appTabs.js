/**
 * The three sections of the app as tabs — Home, Shipments, Map — shown at
 * the top of every page so nobody has to hunt for the way back.
 */
import { msg, t } from '../i18n/index.js';

export const APP_TABS = Object.freeze([
  ['home', '/home.html', msg('Home')],
  ['shipments', '/shipments.html', msg('Shipments')],
  ['map', '/', msg('Map')],
]);

/**
 * @param {Document} doc
 * @param {'home'|'shipments'|'map'} current
 * @returns {HTMLElement}
 */
export function createAppTabs(doc, current) {
  const nav = doc.createElement('nav');
  nav.className = 'app-tabs-inline';
  nav.setAttribute('aria-label', t('Sections'));
  for (const [id, href, label] of APP_TABS) {
    const link = doc.createElement('a');
    link.className = `app-tab${id === current ? ' is-current' : ''}`;
    link.href = href;
    link.textContent = t(label);
    if (id === current) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  return nav;
}

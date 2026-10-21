/**
 * The simple home page (/home.html): one question, one search box and four
 * large buttons, for someone who only needs to find a container, see the
 * list, add one or look at the map, without learning the globe application.
 */
import { formatDate, msg, t, tn } from '../i18n/index.js';
import { CARRIERS } from '../layers/shipments/containers.js';
import {
  STAGE_LABELS,
  localDay,
  shipmentAlerts,
  shipmentStage,
} from '../layers/shipments/model.js';
import { searchShipments } from '../layers/shipments/search.js';
import { createShipmentsBackend } from '../layers/shipments/backend.js';
import { createAppTabs } from './appTabs.js';
import { createShipmentTrackingSource } from '../layers/shipments/source.js';
import { SHIPMENTS_FOCUS_KEY } from '../layers/shipments/store.js';
import {
  describeShipmentAlert,
  describeShipmentStatus,
  displayDay,
} from '../layers/shipments/text.js';

/** The value of SHIPMENTS_FOCUS_KEY that asks the map for every container. */
export const SHOW_ALL_SHIPMENTS = '*';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = Object.freeze({
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  plus: 'M12 5v14M5 12h14',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  chevron: 'M9 6l6 6-6 6',
});

/** Words a new user meets on these pages, in plain language. */
const GLOSSARY = Object.freeze([
  [
    msg('ETA'),
    msg('Estimated time of arrival: the day the ship or train is expected.'),
  ],
  [
    msg('Last free day'),
    msg(
      'The last day the container can stay before storage charges start. Pick it up by then.',
    ),
  ],
  [
    msg('Off the rail'),
    msg(
      'The container has come off the train at the Toronto rail yard. Free days are counted from here.',
    ),
  ],
  [
    msg('Rail ramp'),
    msg('The rail yard where the train drops the container (Toronto).'),
  ],
  [
    msg('Empty return'),
    msg(
      'After unloading, the empty container goes back to the shipping line by this day, or charges start.',
    ),
  ],
  [
    msg('est.'),
    msg(
      'Estimated: worked out from the latest ETA. It turns into an exact date once the container arrives.',
    ),
  ],
]);

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{root: HTMLElement, storage?: Storage|null, now?: () => number,
 *   navigate?: (href: string) => void, backend?: object}} options
 */
export function createSimpleHome({
  root,
  storage = browserStorage(),
  now = () => Date.now(),
  navigate = (href) => globalThis.location.assign(href),
  backend = createShipmentsBackend({
    storage,
    now,
    trackingSource: createShipmentTrackingSource(),
  }),
}) {
  const doc = root.ownerDocument;
  const { store, tracker } = backend;
  let query = '';
  let resultsHost = null;

  function el(tag, className, ...children) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(
        typeof child === 'string' ? doc.createTextNode(child) : child,
      );
    }
    return node;
  }

  function icon(name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'sp-icon');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function bigButton(iconName, title, detail, onClick, tone = '') {
    const node = el(
      'button',
      `hm-action ${tone}`.trim(),
      el('span', 'hm-action-icon', icon(iconName)),
      el(
        'span',
        'hm-action-text',
        el('strong', '', title),
        el('span', '', detail),
      ),
      el('span', 'hm-action-chevron', icon('chevron')),
    );
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function showOnMap() {
    try {
      storage?.setItem?.(SHIPMENTS_FOCUS_KEY, SHOW_ALL_SHIPMENTS);
    } catch {
      /* the map still opens */
    }
    navigate('/');
  }

  function find() {
    const value = query.trim();
    navigate(
      value
        ? `/shipments.html?q=${encodeURIComponent(value)}`
        : '/shipments.html',
    );
  }

  // --- Page -----------------------------------------------------------------

  function render() {
    const day = localDay(now());
    const shipments = store.list();
    root.replaceChildren();
    root.append(createAppTabs(doc, 'home'));

    root.append(
      el(
        'header',
        'hm-header',
        el(
          'p',
          'sp-date',
          formatDate(now(), { weekday: 'long', month: 'long', day: 'numeric' }),
        ),
        el('h1', 'hm-title', t('What do you want to do?')),
      ),
    );

    // 1. Find a container.
    const form = el('form', 'hm-search');
    form.setAttribute('role', 'search');
    const label = el('label', 'hm-search-label', t('Find a container'));
    const input = el('input', 'hm-search-input');
    input.id = 'hm-search-input';
    label.htmlFor = input.id;
    input.type = 'search';
    input.value = query;
    input.placeholder = t('Container number, your reference or ship name');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.enterKeyHint = 'search';
    const go = el(
      'button',
      'sp-button sp-button-primary hm-search-go',
      icon('search'),
      el('span', '', t('Find')),
    );
    go.type = 'submit';
    form.append(label, el('div', 'hm-search-row', input, go));
    resultsHost = el('div', 'hm-results');
    form.append(resultsHost);
    input.addEventListener('input', () => {
      query = input.value;
      renderResults();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      find();
    });
    root.append(form);
    renderResults();

    // 2. What needs attention today, in sentences.
    // One line per container: its most urgent alert.
    const urgent = [];
    for (const shipment of shipments) {
      const alert = shipmentAlerts(shipment, day)[0];
      if (alert && alert.severity >= 2) urgent.push({ shipment, alert });
    }
    urgent.sort((a, b) => b.alert.severity - a.alert.severity);
    const today = el('section', 'hm-today');
    today.append(
      el(
        'h2',
        'hm-section-title',
        urgent.length
          ? tn(
              urgent.length,
              '{count} container needs attention',
              '{count} containers need attention',
              { count: urgent.length },
            )
          : t('Nothing needs attention right now'),
      ),
    );
    if (urgent.length) {
      const list = el('div', 'sp-group-list');
      for (const { shipment, alert } of urgent.slice(0, 4)) {
        const item = el(
          'button',
          `hm-urgent severity-${alert.severity}`,
          el('span', 'sp-dot'),
          el(
            'span',
            'hm-urgent-text',
            el('strong', '', shipment.container),
            el('span', '', describeShipmentAlert(alert)),
          ),
          el('span', 'hm-action-chevron', icon('chevron')),
        );
        item.type = 'button';
        item.addEventListener('click', () =>
          navigate(
            `/shipments.html?q=${encodeURIComponent(shipment.container)}`,
          ),
        );
        list.append(item);
      }
      today.append(list);
      if (urgent.length > 4)
        today.append(
          el(
            'p',
            'sp-hint hm-more',
            tn(urgent.length - 4, 'and {count} more', 'and {count} more', {
              count: urgent.length - 4,
            }),
          ),
        );
    } else
      today.append(
        el(
          'p',
          'sp-hint hm-calm',
          shipments.length
            ? t('Every container is on time with free days left.')
            : t('Add your first container to start tracking.'),
        ),
      );
    root.append(today);

    // 3. The big buttons.
    const active = shipments.filter((item) => shipmentStage(item) !== 'done');
    root.append(
      el(
        'section',
        'hm-actions',
        bigButton(
          'list',
          t('See all shipments'),
          active.length
            ? tn(
                active.length,
                '{count} container on the way',
                '{count} containers on the way',
                {
                  count: active.length,
                },
              )
            : t('Your list of containers'),
          () => navigate('/shipments.html'),
        ),
        bigButton(
          'map',
          t('Show ships on the map'),
          t('Where each container is right now'),
          showOnMap,
        ),
        bigButton(
          'plus',
          t('Add a container'),
          t('Type the number; everything else fills in by itself'),
          () => navigate('/shipments.html?add=1'),
          'is-primary',
        ),
      ),
    );

    // 4. Help.
    const help = el('details', 'hm-help');
    help.append(el('summary', '', t('What do these words mean?')));
    const terms = el('dl', 'hm-terms');
    for (const [term, meaning] of GLOSSARY)
      terms.append(el('dt', '', t(term)), el('dd', '', t(meaning)));
    help.append(terms);
    root.append(help);

    root.append(
      el(
        'p',
        'sp-footer sp-footer-link',
        linkTo('/', t('Open the full map (advanced)')),
      ),
    );
    return input;
  }

  function linkTo(href, label) {
    const link = el('a', 'sp-link', label);
    link.href = href;
    return link;
  }

  /** Up to five matches under the search box, each one tap away. */
  function renderResults() {
    if (!resultsHost) return;
    resultsHost.replaceChildren();
    const value = query.trim();
    if (!value) return;
    const day = localDay(now());
    const found = searchShipments(store.list(), value);
    // Anything else (a ship, a zone, a layer, a place): the map's search.
    const onMap = el(
      'button',
      'hm-result hm-result-map',
      el('span', 'hm-action-icon', icon('globe')),
      el(
        'span',
        'hm-result-text',
        el('strong', '', t('Search the map for “{query}”', { query: value })),
        el('span', '', t('Ships, zones, map layers and places')),
      ),
      el('span', 'hm-action-chevron', icon('chevron')),
    );
    onMap.type = 'button';
    onMap.addEventListener('click', () =>
      navigate(`/?search=${encodeURIComponent(value)}`),
    );
    if (!found.length) {
      resultsHost.append(
        el(
          'p',
          'sp-hint hm-noresult',
          t('No container matches “{query}”. Check the number, or add it.', {
            query: value,
          }),
        ),
      );
      resultsHost.append(el('div', 'sp-group-list', onMap));
      return;
    }
    const list = el('div', 'sp-group-list');
    for (const shipment of found.slice(0, 5)) {
      const stage = shipmentStage(shipment);
      const item = el(
        'button',
        'hm-result',
        el(
          'span',
          'hm-result-text',
          el(
            'strong',
            '',
            shipment.container,
            CARRIERS[shipment.carrier]
              ? el(
                  'span',
                  'hm-result-line',
                  ` · ${CARRIERS[shipment.carrier].name}`,
                )
              : null,
          ),
          el('span', '', describeShipmentStatus(shipment, day)),
          shipment.auto?.dates?.loaded
            ? el(
                'span',
                'hm-result-loaded',
                t('Loaded {day}', {
                  day: displayDay(shipment.auto.dates.loaded),
                }),
              )
            : null,
        ),
        el('span', `sp-pill stage-${stage}`, t(STAGE_LABELS[stage])),
        el('span', 'hm-action-chevron', icon('chevron')),
      );
      item.type = 'button';
      item.addEventListener('click', () =>
        navigate(`/shipments.html?q=${encodeURIComponent(shipment.container)}`),
      );
      list.append(item);
    }
    list.append(onMap);
    resultsHost.append(list);
  }

  const input = render();
  input?.focus?.();
  // Draw again whenever the list changes (it arrives from the server a moment
  // after the page), keeping the cursor in the search box.
  const redraw = () => {
    const focused =
      doc.activeElement === root.querySelector('.hm-search-input');
    const next = render();
    if (focused) next?.focus?.();
  };
  const unsubscribe = backend.subscribe?.(redraw) ?? (() => {});
  // Keep the "needs attention" list current without anyone pressing a button.
  void tracker.refresh().then(redraw);

  return {
    render,
    destroy() {
      unsubscribe();
      backend.stop?.();
    },
  };
}

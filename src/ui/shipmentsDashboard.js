/**
 * The Shipments page (/shipments.html): every container on one screen, one
 * row each, in a plain iOS-style look meant for daily use rather than the
 * globe's HUD. Records, arithmetic and tracking live in
 * src/layers/shipments/; this module only owns DOM.
 */
import { formatDate, formatRelativeTime, msg, t, tn } from '../i18n/index.js';
import {
  CARRIERS,
  carrierTrackingUrl,
  parseContainerNumber,
} from '../layers/shipments/containers.js';
import {
  CLOCK_LABELS,
  DATE_LABELS,
  HOLD_KINDS,
  HOLD_LABELS,
  STAGE_LABELS,
  STANDARD_FREE_TIME,
  daysBetween,
  latestPortEta,
  localDay,
  rampEtaFor,
  shipmentAlerts,
  shipmentClocks,
  shipmentStage,
} from '../layers/shipments/model.js';
import { searchShipments } from '../layers/shipments/search.js';
import {
  describePendingRule,
  describePendingShort,
  describeShipmentAlert,
  displayDay,
  relativeDays,
} from '../layers/shipments/text.js';
import { createShipmentsBackend } from '../layers/shipments/backend.js';
import { SHIPMENTS_FOCUS_KEY } from '../layers/shipments/store.js';
import { createShipmentTrackingSource } from '../layers/shipments/source.js';
import { TRACKING_KEY_NOTE } from '../layers/shipments/tracker.js';

const AUTO_REFRESH_MS = 30 * 60_000;
const FILTERS = Object.freeze([
  ['all', msg('All')],
  ['action', msg('Needs action')],
  ['sea', msg('At sea')],
  ['inland', msg('Rail & ramp')],
  ['done', msg('Done')],
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = Object.freeze({
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  chevron: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
});

/** Milestones in journey order: which are only ever recorded once done. */
const TIMELINE = Object.freeze([
  ['loaded', false],
  ['departed', false],
  ['portEta', false],
  ['discharged', true],
  ['railDeparted', true],
  ['rampEta', false],
  ['rampArrived', true],
  ['pickedUp', true],
  ['emptyReturned', true],
]);

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{root: HTMLElement, storage?: Storage|null,
 *   trackingSource?: object, now?: () => number, backend?: object,
 *   confirm?: (text: string) => boolean}} options
 */
export function createShipmentsDashboard({
  root,
  storage = browserStorage(),
  trackingSource = createShipmentTrackingSource(),
  now = () => Date.now(),
  backend = createShipmentsBackend({ storage, now, trackingSource }),
  confirm = (text) =>
    typeof globalThis.confirm === 'function' ? globalThis.confirm(text) : true,
}) {
  const doc = root.ownerDocument;
  const { store, tracker } = backend;
  let filter = 'all';
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  let query = String(params.get('q') ?? '').slice(0, 60);
  if (FILTERS.some(([id]) => id === params.get('filter')))
    filter = params.get('filter');
  let listHost = null;
  let lastRefresh = null;
  let status = '';
  let sheet = null;
  let timer = null;

  // --- Small DOM helpers ----------------------------------------------------

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

  function button(className, label, onClick, iconName = null) {
    const node = el('button', className);
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    if (label) {
      if (iconName && className.includes('sp-icon-button')) {
        node.setAttribute('aria-label', label);
        node.title = label;
      } else node.append(el('span', '', label));
    }
    node.addEventListener('click', onClick);
    return node;
  }

  const today = () => localDay(now());
  const carrierName = (id) => CARRIERS[id]?.name ?? '';

  // --- Derived views --------------------------------------------------------

  function severityOf(shipment, day) {
    return shipmentAlerts(shipment, day)[0]?.severity ?? 0;
  }

  /**
   * The open clock that runs out first; a pending one (the box is not off
   * the rail yet) only when nothing has started.
   */
  function nearestClock(shipment, day) {
    const open = shipmentClocks(shipment, day).filter((clock) => !clock.closed);
    const running = open
      .filter((clock) => !clock.pending)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return running[0] ?? open.find((clock) => clock.pending);
  }

  function matchesFilter(shipment, day) {
    const stage = shipmentStage(shipment);
    if (filter === 'action') return severityOf(shipment, day) >= 2;
    if (filter === 'sea') return stage === 'at-sea';
    if (filter === 'inland')
      return ['at-port', 'on-rail', 'at-ramp'].includes(stage);
    if (filter === 'done') return stage === 'done' || stage === 'with-you';
    return true;
  }

  function sorted(shipments, day) {
    return [...shipments].sort((a, b) => {
      const doneA = shipmentStage(a) === 'done' ? 1 : 0;
      const doneB = shipmentStage(b) === 'done' ? 1 : 0;
      if (doneA !== doneB) return doneA - doneB;
      const severity = severityOf(b, day) - severityOf(a, day);
      if (severity) return severity;
      const clockA = nearestClock(a, day)?.daysLeft ?? 999;
      const clockB = nearestClock(b, day)?.daysLeft ?? 999;
      // Pending clocks have no days left yet (null sorts as 999).
      return clockA - clockB;
    });
  }

  function route(shipment) {
    const auto = shipment.auto;
    if (auto?.pod?.port) {
      const stops = [auto.pol?.port, auto.pod.port];
      if (auto.destination?.port && auto.destination.code !== auto.pod.code)
        stops.push(auto.destination.port);
      return stops.filter(Boolean).join(' → ');
    }
    return t('{port} → {ramp}', { port: shipment.port, ramp: shipment.ramp });
  }

  function shipName(shipment) {
    return (
      shipment.lastSeen?.name ||
      shipment.vessel.query ||
      shipment.auto?.vessel?.name ||
      ''
    );
  }

  function when(day, base) {
    if (!day) return '';
    return t('{day} · {when}', {
      day: displayDay(day),
      when: relativeDays(daysBetween(base, day)),
    });
  }

  function age(ms) {
    const minutes = Math.round((ms - now()) / 60_000);
    if (Math.abs(minutes) < 60) return formatRelativeTime(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) return formatRelativeTime(hours, 'hour');
    return formatRelativeTime(Math.round(hours / 24), 'day');
  }

  // --- Page -----------------------------------------------------------------

  function render() {
    const day = today();
    const shipments = store.list();
    // A refresh re-renders the page; keep the search box where it was.
    const searching = doc.activeElement?.classList?.contains('sp-search');
    root.replaceChildren();

    const header = el('header', 'sp-header');
    const titles = el(
      'div',
      'sp-titles',
      el(
        'p',
        'sp-date',
        formatDate(now(), { weekday: 'long', month: 'long', day: 'numeric' }),
      ),
      el('h1', 'sp-title', t('Shipments')),
    );
    const tools = el(
      'div',
      'sp-tools',
      button(
        'sp-icon-button',
        t('Refresh tracking'),
        () => refresh({ force: true }),
        'refresh',
      ),
      button('sp-icon-button', t('Free time rules'), openSettings, 'gear'),
      button(
        'sp-icon-button sp-icon-button-primary',
        t('Add container'),
        openAdd,
        'plus',
      ),
    );
    header.append(titles, tools);
    root.append(header);

    if (tracker.keyMissing)
      root.append(el('p', 'sp-banner', t(TRACKING_KEY_NOTE)));

    root.append(summary(shipments, day));

    const segments = el('div', 'sp-segments');
    segments.setAttribute('role', 'tablist');
    for (const [id, label] of FILTERS) {
      const count = shipments.filter((item) => {
        const saved = filter;
        filter = id;
        const ok = matchesFilter(item, day);
        filter = saved;
        return ok;
      }).length;
      const tab = button(
        `sp-segment${filter === id ? ' is-active' : ''}`,
        '',
        () => {
          filter = id;
          render();
        },
      );
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(filter === id));
      tab.append(el('span', '', t(label)));
      if (id !== 'all' && count)
        tab.append(el('span', 'sp-segment-count', String(count)));
      segments.append(tab);
    }
    root.append(segments);

    if (shipments.length) {
      const search = el('input', 'sp-search');
      search.type = 'search';
      search.value = query;
      search.placeholder = t(
        'Search: container number, your reference or ship',
      );
      search.setAttribute('aria-label', t('Find a container'));
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.addEventListener('input', () => {
        query = search.value;
        renderList();
      });
      root.append(el('div', 'sp-search-wrap', search));
      if (searching) {
        search.focus();
        search.setSelectionRange?.(search.value.length, search.value.length);
      }
    }

    listHost = el('div', 'sp-list-host');
    root.append(listHost);
    renderList();

    const footer = [];
    if (status) footer.push(status);
    else if (tracker.busy) footer.push(t('Checking every container…'));
    else if (lastRefresh)
      footer.push(t('Updated {age}', { age: age(lastRefresh) }));
    footer.push(
      backend.mode?.() === 'server'
        ? t(
            'Shared with everyone on this server, and tracked even with no page open. Before the box is off the rail, its last free day is estimated from the expected rail arrival.',
          )
        : t(
            'Saved in this browser only. Before the box is off the rail, its last free day is estimated from the expected rail arrival.',
          ),
    );
    root.append(el('p', 'sp-footer', footer.join(' · ')));
    root.append(
      el(
        'p',
        'sp-footer sp-footer-link',
        linkTo('/home.html', t('Home')),
        ' · ',
        linkTo('/', t('Open the map')),
      ),
    );
  }

  /** The rows: the current filter, then the search, most urgent first. */
  function renderList() {
    if (!listHost) return;
    const day = today();
    const shipments = store.list();
    listHost.replaceChildren();
    let visible = sorted(
      shipments.filter((item) => matchesFilter(item, day)),
      day,
    );
    if (query.trim()) visible = searchShipments(visible, query);
    if (!shipments.length) {
      listHost.append(emptyState());
      return;
    }
    if (!visible.length) {
      listHost.append(
        el(
          'p',
          'sp-empty-filter',
          query.trim()
            ? t('No container matches “{query}”.', { query: query.trim() })
            : t('Nothing here right now.'),
        ),
      );
      return;
    }
    const table = el('section', 'sp-table');
    table.setAttribute('aria-label', t('Your containers'));
    table.append(
      el(
        'div',
        'sp-table-head',
        el('span', '', t('Container')),
        el('span', '', t('Status')),
        el('span', '', t('Loaded')),
        el('span', '', t('Port ETA')),
        el('span', '', t('Ramp ETA')),
        el('span', '', t('Last free day')),
        el('span', '', t('Next step')),
        el('span', ''),
      ),
    );
    for (const shipment of visible) table.append(row(shipment, day));
    listHost.append(table);
  }

  function linkTo(href, label) {
    const link = el('a', 'sp-link', label);
    link.href = href;
    return link;
  }

  function summary(shipments, day) {
    const active = shipments.filter((item) => shipmentStage(item) !== 'done');
    const action = active.filter((item) => severityOf(item, day) >= 2).length;
    const arriving = active.filter((item) => {
      if (shipmentStage(item) !== 'at-sea' || !item.dates.portEta) return false;
      const days = daysBetween(day, item.dates.portEta);
      return days >= 0 && days <= 7;
    }).length;
    const inland = active.filter((item) =>
      ['at-port', 'on-rail', 'at-ramp'].includes(shipmentStage(item)),
    ).length;
    const tile = (value, label, tone, target) => {
      const node = button(`sp-tile tone-${tone}`, '', () => {
        filter = target;
        render();
      });
      node.append(
        el('span', 'sp-tile-value', String(value)),
        el('span', 'sp-tile-label', label),
      );
      return node;
    };
    return el(
      'section',
      'sp-summary',
      tile(action, t('Need action'), action ? 'red' : 'grey', 'action'),
      tile(arriving, t('Arriving in 7 days'), 'blue', 'sea'),
      tile(inland, t('Port, rail or ramp'), 'indigo', 'inland'),
      tile(active.length, t('Active'), 'grey', 'all'),
    );
  }

  function emptyState() {
    return el(
      'section',
      'sp-empty',
      el('h2', '', t('No containers yet')),
      el(
        'p',
        '',
        t(
          'Add a container number. The board finds its ship, ETAs, unloading, rail move and pickup by itself, counts down every free-time deadline and warns you before charges start.',
        ),
      ),
      button('sp-button sp-button-primary', t('Add container'), openAdd),
    );
  }

  function stagePill(shipment) {
    const stage = shipmentStage(shipment);
    return el('span', `sp-pill stage-${stage}`, t(STAGE_LABELS[stage]));
  }

  function row(shipment, day) {
    const alerts = shipmentAlerts(shipment, day);
    const severity = alerts[0]?.severity ?? 0;
    const stage = shipmentStage(shipment);
    const item = button(`sp-row severity-${severity}`, '', () =>
      openDetail(shipment.id),
    );
    item.setAttribute(
      'aria-label',
      t('{container}, open details', { container: shipment.container }),
    );

    const container = el(
      'span',
      'sp-cell sp-cell-container',
      el('strong', 'sp-number', shipment.container),
      el(
        'span',
        'sp-sub',
        [carrierName(shipment.carrier), shipment.reference]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    container.querySelector('.sp-number').setAttribute('translate', 'no');

    const statusCell = el(
      'span',
      'sp-cell sp-cell-status',
      stagePill(shipment),
      el('span', 'sp-sub', route(shipment)),
    );

    const loadedDay = shipment.auto?.dates?.loaded || '';
    const loaded = el(
      'span',
      'sp-cell sp-cell-date',
      el('span', 'sp-cell-label', t('Loaded')),
      el('span', 'sp-date-value', loadedDay ? displayDay(loadedDay) : '—'),
      el(
        'span',
        'sp-sub',
        loadedDay
          ? daysBetween(loadedDay, day) >= 0
            ? relativeDays(daysBetween(day, loadedDay))
            : t('planned')
          : '',
      ),
    );

    const portDay = shipment.dates.discharged || latestPortEta(shipment);
    const port = el(
      'span',
      'sp-cell sp-cell-date',
      el('span', 'sp-cell-label', t('Port ETA')),
      el('span', 'sp-date-value', portDay ? displayDay(portDay) : '—'),
      el(
        'span',
        'sp-sub',
        shipment.dates.discharged
          ? t('Unloaded')
          : portDay
            ? relativeDays(daysBetween(day, portDay))
            : '',
      ),
    );

    const rampEta = rampEtaFor(shipment);
    const ramp = el(
      'span',
      'sp-cell sp-cell-date',
      el('span', 'sp-cell-label', t('Ramp ETA')),
      el('span', 'sp-date-value', rampEta.day ? displayDay(rampEta.day) : '—'),
      el(
        'span',
        'sp-sub',
        shipment.dates.rampArrived
          ? t('Arrived')
          : rampEta.day
            ? rampEta.estimated
              ? t('est. {when}', {
                  when: relativeDays(daysBetween(day, rampEta.day)),
                })
              : relativeDays(daysBetween(day, rampEta.day))
            : '',
      ),
    );

    const clock = nearestClock(shipment, day);
    const lfd = el('span', 'sp-cell sp-cell-date');
    lfd.append(el('span', 'sp-cell-label', t('Last free day')));
    if (clock?.pending) {
      // Not off the rail yet: the expected rail arrival plus the free days.
      lfd.append(
        clock.day
          ? el(
              'span',
              'sp-date-value',
              displayDay(clock.day),
              el('span', 'sp-est', t('est.')),
            )
          : el('span', 'sp-date-value', '—'),
        el('span', 'sp-sub', describePendingShort(clock)),
      );
    } else if (clock) {
      lfd.append(
        el(
          'span',
          `sp-date-value clock-${clock.state}`,
          displayDay(clock.day),
          clock.estimated ? el('span', 'sp-est', t('est.')) : null,
        ),
        el(
          'span',
          `sp-countdown clock-${clock.state}`,
          clock.daysLeft < 0
            ? tn(-clock.daysLeft, '{count} day over', '{count} days over', {
                count: -clock.daysLeft,
              })
            : clock.daysLeft === 0
              ? t('Today')
              : tn(clock.daysLeft, '{count} day left', '{count} days left', {
                  count: clock.daysLeft,
                }),
        ),
      );
    } else
      lfd.append(
        el('span', 'sp-date-value', '—'),
        el('span', 'sp-sub', stage === 'done' ? t('Returned') : ''),
      );

    const next = el(
      'span',
      'sp-cell sp-cell-next',
      el('span', 'sp-cell-label', t('Next step')),
      alerts[0]
        ? el(
            'span',
            `sp-next severity-${alerts[0].severity}`,
            describeShipmentAlert(alerts[0]),
          )
        : el('span', 'sp-next is-quiet', t('Nothing to do')),
    );

    item.append(
      container,
      statusCell,
      loaded,
      port,
      ramp,
      lfd,
      next,
      el('span', 'sp-cell sp-chevron', icon('chevron')),
    );
    return item;
  }

  // --- Sheets ---------------------------------------------------------------

  function openSheet(title, build) {
    closeSheet();
    const dialog = el('dialog', 'sp-sheet');
    dialog.setAttribute('aria-label', title);
    const head = el(
      'header',
      'sp-sheet-head',
      el('h2', 'sp-sheet-title', title),
      button('sp-icon-button', t('Close'), closeSheet, 'close'),
    );
    const body = el('div', 'sp-sheet-body');
    dialog.append(head, body);
    build(body);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeSheet();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeSheet();
    });
    doc.body.append(dialog);
    sheet = dialog;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return body;
  }

  function closeSheet() {
    if (!sheet) return;
    if (sheet.open && typeof sheet.close === 'function') sheet.close();
    sheet.remove();
    sheet = null;
  }

  function group(title, ...rows) {
    const list = el('div', 'sp-group-list', rows);
    return el(
      'section',
      'sp-group',
      title ? el('h3', 'sp-group-title', title) : null,
      list,
    );
  }

  function line(label, value, extra = null, className = '') {
    return el(
      'div',
      `sp-line ${className}`.trim(),
      el('span', 'sp-line-label', label),
      el('span', 'sp-line-value', value, extra),
    );
  }

  function openAdd() {
    openSheet(t('Add container'), (body) => {
      const form = el('form', 'sp-form');
      form.noValidate = true;
      const number = el('input', 'sp-input sp-input-number');
      number.name = 'container';
      number.autocomplete = 'off';
      number.spellcheck = false;
      number.maxLength = 16;
      number.placeholder = 'MSCU1234566'; // i18n-ignore: sample container number
      number.setAttribute('translate', 'no');
      const hint = el('p', 'sp-hint');
      const update = () => {
        const parsed = parseContainerNumber(number.value);
        hint.classList.toggle(
          'is-problem',
          Boolean(parsed.problem && number.value),
        );
        if (!number.value)
          hint.textContent = t(
            '4 letters and 7 digits, from the booking or arrival notice',
          );
        else if (parsed.problem) hint.textContent = t(parsed.problem);
        else if (parsed.carrier)
          hint.textContent = t('Valid · {carrier} box', {
            carrier: carrierName(parsed.carrier),
          });
        else hint.textContent = t('Valid number');
      };
      number.addEventListener('input', update);
      update();
      const reference = el('input', 'sp-input');
      reference.name = 'reference';
      reference.maxLength = 80;
      reference.autocomplete = 'off';
      const problem = el('p', 'sp-problem');
      problem.setAttribute('role', 'alert');
      const submit = el(
        'button',
        'sp-button sp-button-primary sp-button-wide',
        t('Add to board'),
      );
      submit.type = 'submit';
      form.append(
        el('label', 'sp-field', el('span', '', t('Container number')), number),
        hint,
        el(
          'label',
          'sp-field',
          el('span', '', t('Your reference (optional)')),
          reference,
        ),
        el(
          'p',
          'sp-hint',
          t(
            'That is all: the ship, dates and rail move fill in by themselves.',
          ),
        ),
        problem,
        submit,
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const parsed = parseContainerNumber(number.value);
        if (!parsed.wellFormed) {
          problem.textContent = t(parsed.problem);
          return;
        }
        if (store.list().some((item) => item.container === parsed.number)) {
          problem.textContent = t('That container is already on the board');
          return;
        }
        const saved = store.save({
          container: parsed.number,
          carrier: parsed.carrier || '',
          reference: reference.value,
        });
        if (!saved) {
          problem.textContent = t('The board is full');
          return;
        }
        closeSheet();
        status = t('{container} saved', { container: saved.container });
        render();
        void refresh({ force: true, onlyId: saved.id });
      });
      body.append(form);
      number.focus?.();
    });
  }

  function openSettings() {
    openSheet(t('Free time rules'), (body) => {
      const defaults = store.defaults;
      body.append(
        el(
          'p',
          'sp-hint sp-hint-block',
          t(
            'The ramp’s last free day is counted from the day the box comes off the rail (CN: 1 free day). The empty must be back 4 working days after pickup (MSC). Rail takes about 4 days. Port days count only if you set them. Change a number only if your contract differs.',
          ),
        ),
      );
      const rows = [
        ['portFreeDays', t('Port free days (working days)')],
        ['rampFreeDays', t('Ramp free days')],
        ['returnFreeDays', t('Days to return the empty (working days)')],
        ['railDays', t('Usual rail days, port to ramp')],
      ].map(([name, label]) => {
        const input = el('input', 'sp-input sp-input-small');
        input.type = 'number';
        input.min = '0';
        input.max = '60';
        input.inputMode = 'numeric';
        input.value = defaults[name] ?? '';
        input.placeholder = String(STANDARD_FREE_TIME[name] ?? '—');
        input.setAttribute('aria-label', label);
        input.addEventListener('change', () => {
          store.setDefaults({ [name]: input.value });
          status = t('Free time saved');
          render();
        });
        return el(
          'label',
          'sp-line sp-line-input',
          el('span', 'sp-line-label', label),
          input,
        );
      });
      body.append(group('', rows));
    });
  }

  function openDetail(id) {
    const shipment = store.get(id);
    if (!shipment) return;
    const day = today();
    openSheet(shipment.container, (body) => {
      const stage = shipmentStage(shipment);
      const ship = shipName(shipment);
      body.append(
        el(
          'div',
          'sp-detail-top',
          stagePill(shipment),
          el(
            'span',
            'sp-sub',
            [carrierName(shipment.carrier), route(shipment)]
              .filter(Boolean)
              .join(' · '),
          ),
          ship ? el('span', 'sp-sub', t('Ship {name}', { name: ship })) : null,
        ),
      );

      const alerts = shipmentAlerts(shipment, day);
      if (alerts.length)
        body.append(
          group(
            t('Needs attention'),
            alerts.map((alert) =>
              el(
                'div',
                `sp-line sp-alert severity-${alert.severity}`,
                el('span', 'sp-dot'),
                el('span', 'sp-line-label', describeShipmentAlert(alert)),
              ),
            ),
          ),
        );

      const clocks = shipmentClocks(shipment, day);
      if (clocks.length)
        body.append(
          group(
            t('Free time'),
            clocks.map((clock) =>
              line(
                t(CLOCK_LABELS[clock.id]),
                clock.pending
                  ? clock.day
                    ? t('{day} · {when}', {
                        day: displayDay(clock.day),
                        when: describePendingShort(clock),
                      })
                    : describePendingRule(clock)
                  : clock.closed
                    ? t('{day} · done', { day: displayDay(clock.day) })
                    : when(clock.day, day),
                clock.estimated ? el('span', 'sp-est', t('est.')) : null,
                `clock-${clock.state}`,
              ),
            ),
          ),
        );

      const rampEta = rampEtaFor(shipment);
      body.append(
        group(
          t('Journey'),
          TIMELINE.map(([field, actualOnly]) => {
            let value =
              shipment.dates[field] || shipment.auto?.dates?.[field] || '';
            let estimated = false;
            if (field === 'rampEta' && !value && rampEta.day) {
              value = rampEta.day;
              estimated = rampEta.estimated;
            }
            const done =
              Boolean(value) && (actualOnly || daysBetween(value, day) > 0);
            const node = line(
              t(DATE_LABELS[field]),
              value ? when(value, day) : '—',
              estimated ? el('span', 'sp-est', t('est.')) : null,
              done ? 'is-done' : '',
            );
            node.prepend(el('span', 'sp-step', done ? icon('check') : null));
            return node;
          }),
        ),
      );

      const holds = HOLD_KINDS.map((kind) => {
        const toggle = el('input', 'sp-switch');
        toggle.type = 'checkbox';
        toggle.checked = Boolean(shipment.holds[kind]);
        toggle.setAttribute('role', 'switch');
        toggle.addEventListener('change', () => {
          const current = store.get(id);
          store.save({
            ...current,
            holds: { ...current.holds, [kind]: toggle.checked },
          });
          render();
        });
        return el(
          'label',
          'sp-line sp-line-input',
          el('span', 'sp-line-label', t(HOLD_LABELS[kind])),
          toggle,
        );
      });
      body.append(group(t('Holds'), holds));

      const notes = el('textarea', 'sp-input sp-notes');
      notes.rows = 3;
      notes.maxLength = 600;
      notes.value = shipment.notes;
      notes.setAttribute('aria-label', t('Notes'));
      notes.addEventListener('change', () => {
        store.save({ ...store.get(id), notes: notes.value });
      });
      body.append(group(t('Notes'), notes));

      const note = tracker.note(id);
      const facts = [];
      if (note)
        facts.push(
          note.reason
            ? t('The tracking service says: {reason}', { reason: note.reason })
            : t(note.text),
        );
      if (shipment.auto?.fetchedAt)
        facts.push(
          t('Tracked by {source} · updated {age}', {
            source: shipment.auto.source || 'FindTEU', // i18n-ignore: provider name
            age: age(shipment.auto.fetchedAt),
          }),
        );
      if (stage === 'at-sea' && !shipment.lastSeen)
        facts.push(
          t(
            'Mid-ocean ships drop off coastal tracking; their position returns near the coast.',
          ),
        );
      if (facts.length)
        body.append(el('p', 'sp-hint sp-hint-block', facts.join(' ')));

      const actions = el('div', 'sp-actions');
      if (!['with-you', 'done'].includes(stage))
        actions.append(
          button(
            'sp-button sp-button-primary',
            t('Show on map'),
            () => {
              try {
                storage?.setItem?.(SHIPMENTS_FOCUS_KEY, id);
              } catch {
                /* the map still opens */
              }
              globalThis.location.assign('/');
            },
            'globe',
          ),
        );
      actions.append(
        button('sp-button', t('Refresh tracking'), async () => {
          closeSheet();
          await refresh({ force: true, onlyId: id });
          openDetail(id);
        }),
      );
      const url = carrierTrackingUrl(shipment.carrier, shipment.container);
      if (url) {
        const link = el(
          'a',
          'sp-button',
          t('Track on {carrier}', { carrier: carrierName(shipment.carrier) }),
        );
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.append(link);
      }
      actions.append(
        button('sp-button sp-button-danger', t('Remove'), () => {
          if (
            !confirm(
              t('Remove {container} from the board?', {
                container: shipment.container,
              }),
            )
          )
            return;
          store.remove(id);
          tracker.forget(id);
          closeSheet();
          render();
        }),
      );
      body.append(actions);
    });
  }

  // --- Tracking and alerts --------------------------------------------------

  async function refresh(options = {}) {
    status = '';
    const pending = tracker.refresh(options);
    render();
    await pending;
    lastRefresh = now();
    announce();
    if (!sheet) render();
    else render();
  }

  /** Same once-a-day keys as the globe layer, so a box is never announced twice. */
  function announce() {
    const day = today();
    const fresh = [];
    for (const shipment of store.list())
      for (const alert of shipmentAlerts(shipment, day)) {
        if (alert.severity < 2) continue;
        const key = `${shipment.id}|${alert.code}|${alert.clock ?? ''}|${day}`;
        if (store.hasNotified(key)) continue;
        store.markNotified(key);
        fresh.push({ shipment, alert });
      }
    if (!fresh.length) return;
    fresh.sort((a, b) => b.alert.severity - a.alert.severity);
    const top = fresh[0];
    const text = t('{container} — {what}', {
      container: top.shipment.container,
      what: describeShipmentAlert(top.alert),
    });
    try {
      if (
        doc.visibilityState === 'hidden' &&
        globalThis.Notification?.permission === 'granted'
      )
        new globalThis.Notification(t('Shipments'), { body: text });
    } catch {
      /* optional */
    }
  }

  // Another tab (or the globe) changed the list kept in this browser.
  const onStorage = (event) => {
    if (event.key && !event.key.startsWith('gev.shipments')) return;
    backend.reread?.();
  };
  // The list changed: a re-read, another person's edit, the server's tracking.
  const unsubscribe =
    backend.subscribe?.(() => {
      if (!sheet) render();
    }) ?? (() => {});
  globalThis.addEventListener?.('storage', onStorage);
  const onVisible = () => {
    if (doc.visibilityState === 'visible') void refresh();
  };
  doc.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => void refresh(), AUTO_REFRESH_MS);
  try {
    if (globalThis.Notification?.permission === 'default')
      root.addEventListener(
        'click',
        () => void globalThis.Notification.requestPermission(),
        { once: true },
      );
  } catch {
    /* optional */
  }

  render();
  // Links from the home page: ?q= opens a search (and the box itself when
  // exactly one matches), ?add=1 opens the add sheet.
  // The shared list arrives a moment after the page, so wait for it.
  void Promise.resolve(backend.ready).then(() => {
    if (sheet) return;
    if (params.get('add')) openAdd();
    else if (query.trim()) {
      const found = searchShipments(store.list(), query);
      if (found.length === 1) openDetail(found[0].id);
    }
  });
  void refresh();

  return {
    render,
    refresh,
    destroy() {
      clearInterval(timer);
      closeSheet();
      globalThis.removeEventListener?.('storage', onStorage);
      unsubscribe();
      backend.stop?.();
      doc.removeEventListener('visibilitychange', onVisible);
      root.replaceChildren();
    },
  };
}

/**
 * The Shipments board: a dialog listing the operator's containers with their
 * free-time clocks and alerts, and the form that adds or edits one.
 *
 * It owns only DOM. Records, arithmetic and ship lookups live in the layer
 * (src/layers/shipments/), reached through `layer.board`.
 */
import { t, tn } from '../i18n/index.js';
import {
  CARRIER_IDS,
  CLOCK_LABELS,
  DATE_FIELDS,
  DATE_LABELS,
  HOLD_KINDS,
  HOLD_LABELS,
  STAGE_LABELS,
  daysBetween,
  describeShipmentAlert,
  displayDay,
  parseContainerNumber,
  relativeDays,
  shipmentAlerts,
  shipmentClocks,
  shipmentStage,
} from '../layers/shipments/index.js';

const DIALOG_ID = 'shipments-board';

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function urgency(shipment, today) {
  const alerts = shipmentAlerts(shipment, today);
  const clocks = shipmentClocks(shipment, today).filter(
    (clock) => !clock.closed,
  );
  return {
    severity: alerts[0]?.severity ?? 0,
    nearest: Math.min(...clocks.map((clock) => clock.daysLeft), 9999),
  };
}

/**
 * @param {object} options
 * @param {object} options.board The layer's `board` API.
 * @param {Document} [options.document]
 * @param {(text: string) => boolean} [options.confirm]
 * @returns {{open: (target?: string|null) => void, close: () => void,
 *   destroy: () => void}}
 */
export function createShipmentsBoard({
  board,
  document: doc = globalThis.document,
  confirm = (text) =>
    typeof globalThis.confirm === 'function' ? globalThis.confirm(text) : true,
}) {
  if (!board || !doc)
    throw new TypeError('Shipments board needs the layer board API');
  let dialog = null;
  let body = null;
  let status = null;
  let view = { name: 'list', id: null };
  let unsubscribe = null;
  let notice = '';

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = element(doc, 'dialog', 'shipments-board');
    dialog.id = DIALOG_ID;
    dialog.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
    const header = element(doc, 'header', 'shipments-board-header');
    const title = element(doc, 'h2', 'shipments-board-title', t('SHIPMENTS'));
    title.id = `${DIALOG_ID}-title`;
    const close = element(doc, 'button', 'shipments-board-close');
    close.type = 'button';
    close.setAttribute('aria-label', t('Close the shipments board'));
    const icon = element(doc, 'span', 'material-symbols-outlined', 'close');
    icon.setAttribute('aria-hidden', 'true');
    close.append(icon);
    close.addEventListener('click', () => api.close());
    header.append(title, close);
    body = element(doc, 'div', 'shipments-board-body');
    status = element(doc, 'p', 'shipments-board-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const privacy = element(
      doc,
      'p',
      'shipments-board-privacy',
      t(
        'Saved only in this browser and never put in share links. Only a ship name or number is sent, to this app’s own server, to find the ship. Export to keep a copy.',
      ),
    );
    dialog.append(header, status, body, privacy);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (view.name === 'form') showList();
      else api.close();
    });
    doc.body.append(dialog);
    return dialog;
  }

  function setStatus(text) {
    notice = text || '';
    if (status) status.textContent = notice;
  }

  function button(label, onClick, className = 'shipments-btn') {
    const node = element(doc, 'button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  // --- List ----------------------------------------------------------------

  function showList() {
    view = { name: 'list', id: null };
    renderList();
  }

  function renderList() {
    if (!body) return;
    const today = board.today();
    body.replaceChildren();
    const actions = element(doc, 'div', 'shipments-board-actions');
    actions.append(
      button(
        t('Add container'),
        () => showForm(null),
        'shipments-btn shipments-btn-primary',
      ),
    );
    const shipments = board.list();
    if (
      shipments.some(
        (item) => item.vessel.query || item.vessel.mmsi || item.vessel.imo,
      )
    )
      actions.append(
        button(t('Find ships now'), () => {
          setStatus(t('Looking for ships…'));
          void board.check().then(() => {
            const note = board.feedNote();
            setStatus(note ? t(note) : t('Ship positions updated'));
          });
        }),
      );
    actions.append(
      button(t('Export'), exportAll),
      button(t('Import'), importAll),
    );
    body.append(actions);

    if (!shipments.length) {
      const empty = element(doc, 'div', 'shipments-empty');
      empty.append(
        element(doc, 'strong', '', t('No containers yet')),
        element(
          doc,
          'p',
          '',
          t(
            'Add a container number and, if you know it, the ship it is on. Then fill in dates as they come: ship ETA, unloading, rail, ramp arrival and the last free days. The board counts down every deadline and warns you before charges start.',
          ),
        ),
      );
      body.append(empty);
      return;
    }
    const sorted = [...shipments].sort((a, b) => {
      const ua = urgency(a, today);
      const ub = urgency(b, today);
      return ub.severity - ua.severity || ua.nearest - ub.nearest;
    });
    const list = element(doc, 'ul', 'shipments-list');
    list.setAttribute('aria-label', t('Your containers'));
    for (const shipment of sorted) list.append(card(shipment, today));
    body.append(list);
  }

  function card(shipment, today) {
    const stage = shipmentStage(shipment);
    const alerts = shipmentAlerts(shipment, today);
    const severity = alerts[0]?.severity ?? 0;
    const item = element(doc, 'li', `shipment-card severity-${severity}`);
    if (stage === 'done') item.classList.add('is-done');

    const top = element(doc, 'div', 'shipment-card-top');
    const number = element(
      doc,
      'strong',
      'shipment-card-number',
      shipment.container,
    );
    number.setAttribute('translate', 'no');
    top.append(number);
    const carrier = board.carrierName(shipment.carrier);
    if (carrier) {
      const chip = element(doc, 'span', 'shipment-card-carrier', carrier);
      chip.setAttribute('translate', 'no');
      top.append(chip);
    }
    top.append(
      element(
        doc,
        'span',
        `shipment-stage stage-${stage}`,
        t(STAGE_LABELS[stage]),
      ),
    );
    item.append(top);

    const route = [
      t('{port} → {ramp}', { port: shipment.port, ramp: shipment.ramp }),
    ];
    if (shipment.reference)
      route.push(t('Ref {reference}', { reference: shipment.reference }));
    const ship = shipment.lastSeen?.name || shipment.vessel.query;
    if (ship) route.push(t('Ship {name}', { name: ship }));
    item.append(element(doc, 'p', 'shipment-card-route', route.join(' · ')));

    const clocks = shipmentClocks(shipment, today);
    if (clocks.length) {
      const row = element(doc, 'div', 'shipment-clocks');
      for (const clock of clocks) {
        const chip = element(
          doc,
          'span',
          `shipment-clock clock-${clock.state}`,
        );
        chip.append(
          element(
            doc,
            'span',
            'shipment-clock-label',
            t(CLOCK_LABELS[clock.id]),
          ),
          element(
            doc,
            'span',
            'shipment-clock-day',
            clock.closed
              ? t('{day} · done', { day: displayDay(clock.day) })
              : clock.estimated
                ? t('{day} (est.) · {when}', {
                    day: displayDay(clock.day),
                    when: relativeDays(clock.daysLeft),
                  })
                : t('{day} · {when}', {
                    day: displayDay(clock.day),
                    when: relativeDays(clock.daysLeft),
                  }),
          ),
        );
        row.append(chip);
      }
      item.append(row);
    }

    const next = nextMilestone(shipment, today);
    if (next) item.append(element(doc, 'p', 'shipment-card-next', next));

    if (alerts.length) {
      const list = element(doc, 'ul', 'shipment-alerts');
      for (const alert of alerts)
        list.append(
          element(
            doc,
            'li',
            `shipment-alert severity-${alert.severity}`,
            describeShipmentAlert(alert),
          ),
        );
      item.append(list);
    }
    const lookup = board.lookupNote(shipment.id);
    if (lookup && stage !== 'done')
      item.append(element(doc, 'p', 'shipment-card-note', t(lookup)));
    if (shipment.notes)
      item.append(element(doc, 'p', 'shipment-card-notes', shipment.notes));

    const actions = element(doc, 'div', 'shipment-card-actions');
    actions.append(button(t('Edit'), () => showForm(shipment.id)));
    const url = board.trackingUrl(shipment);
    if (url) {
      const link = element(
        doc,
        'a',
        'shipments-btn',
        t('Track on {carrier}', { carrier }),
      );
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    if (shipment.lastSeen)
      actions.append(
        button(t('Show ship on globe'), () => {
          if (board.showOnGlobe(shipment.id)) api.close();
        }),
      );
    actions.append(
      button(
        t('Remove'),
        () => {
          if (
            confirm(
              t('Remove {container} from the board?', {
                container: shipment.container,
              }),
            )
          )
            board.remove(shipment.id);
        },
        'shipments-btn shipments-btn-quiet',
      ),
    );
    item.append(actions);
    return item;
  }

  function nextMilestone(shipment, today) {
    const d = shipment.dates;
    const stage = shipmentStage(shipment);
    const at = (field, place) =>
      d[field]
        ? t('{what}: {day} ({when})', {
            what: place,
            day: displayDay(d[field]),
            when: relativeDays(daysBetween(today, d[field])),
          })
        : '';
    if (stage === 'at-sea')
      return at('portEta', t('Ship ETA at {place}', { place: shipment.port }));
    if (stage === 'on-rail')
      return at('rampEta', t('Rail ETA at {place}', { place: shipment.ramp }));
    if (stage === 'at-ramp' && d.pickupPlanned)
      return at('pickupPlanned', t('Truck booked'));
    return '';
  }

  // --- Form ----------------------------------------------------------------

  function showForm(id) {
    view = { name: 'form', id };
    renderForm(id ? board.get(id) : null);
  }

  function field(labelText, control, hint) {
    const wrap = element(doc, 'label', 'shipments-field');
    wrap.append(
      element(doc, 'span', 'shipments-field-label', labelText),
      control,
    );
    if (hint) wrap.append(hint);
    return wrap;
  }

  function input(type, name, value, attributes = {}) {
    const node = doc.createElement('input');
    node.type = type;
    node.name = name;
    node.value = value ?? '';
    for (const [key, attr] of Object.entries(attributes))
      node.setAttribute(key, attr);
    return node;
  }

  function renderForm(shipment) {
    if (!body) return;
    body.replaceChildren();
    setStatus('');
    const form = element(doc, 'form', 'shipments-form');
    form.noValidate = true;
    form.append(
      element(
        doc,
        'h3',
        'shipments-form-title',
        shipment
          ? t('Edit {container}', { container: shipment.container })
          : t('Add a container'),
      ),
    );

    const container = input('text', 'container', shipment?.container, {
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '16',
      placeholder: 'MSCU1234566', // i18n-ignore: sample container number
      translate: 'no',
    });
    container.classList.add('shipments-mono');
    const containerHint = element(doc, 'span', 'shipments-hint');
    const carrier = doc.createElement('select');
    carrier.name = 'carrier';
    const auto = element(doc, 'option', '', t('Detect from the number'));
    auto.value = '';
    carrier.append(auto);
    for (const id of CARRIER_IDS) {
      const option = element(doc, 'option', '', board.carrierName(id));
      option.value = id;
      option.setAttribute('translate', 'no');
      carrier.append(option);
    }
    carrier.value = shipment?.carrier ?? '';
    const updateHint = () => {
      const parsed = parseContainerNumber(container.value);
      containerHint.classList.toggle(
        'is-problem',
        Boolean(parsed.problem) && Boolean(container.value),
      );
      if (!container.value)
        containerHint.textContent = t(
          '4 letters and 7 digits, from the booking or arrival notice',
        );
      else if (parsed.problem) containerHint.textContent = t(parsed.problem);
      else if (parsed.carrier)
        containerHint.textContent = t('Valid · {carrier} box', {
          carrier: board.carrierName(parsed.carrier),
        });
      else if (parsed.leased)
        containerHint.textContent = t(
          'Valid · leased box, so pick the shipping line below',
        );
      else
        containerHint.textContent = t('Valid · pick the shipping line below');
    };
    container.addEventListener('input', updateHint);
    updateHint();

    const top = element(doc, 'div', 'shipments-grid');
    top.append(
      field(t('Container number'), container, containerHint),
      field(t('Shipping line'), carrier),
      field(
        t('Booking or B/L number'),
        input('text', 'reference', shipment?.reference, {
          maxlength: '80',
          autocomplete: 'off',
        }),
      ),
      field(
        t('Ship name or IMO number'),
        input('text', 'vessel', shipment?.vessel.query, {
          maxlength: '80',
          autocomplete: 'off',
        }),
        element(
          doc,
          'span',
          'shipments-hint',
          t(
            'From the line’s tracking page: the ship name, or better its 7-digit IMO number',
          ),
        ),
      ),
      field(
        t('Arrival port'),
        input('text', 'port', shipment?.port ?? 'Montreal', {
          maxlength: '80',
        }),
      ),
      field(
        t('Rail ramp'),
        input('text', 'ramp', shipment?.ramp ?? 'Toronto', { maxlength: '80' }),
      ),
    );
    form.append(top);

    const datesHeading = element(
      doc,
      'h4',
      'shipments-form-section',
      t('Dates'),
    );
    const datesHint = element(
      doc,
      'p',
      'shipments-hint',
      t(
        'Fill in what you know; leave the rest empty. Expected dates are fine and can be changed later.',
      ),
    );
    const dates = element(doc, 'div', 'shipments-grid shipments-dates');
    for (const name of DATE_FIELDS)
      dates.append(
        field(
          t(DATE_LABELS[name]),
          input('date', `date:${name}`, shipment?.dates[name]),
        ),
      );
    form.append(datesHeading, datesHint, dates);

    const freeHeading = element(
      doc,
      'h4',
      'shipments-form-section',
      t('Free days'),
    );
    const freeHint = element(
      doc,
      'p',
      'shipments-hint',
      t(
        'Optional. If you have no last free day yet, the board estimates one: ramp free days count from the ramp arrival (or rail ETA), empty-return days from the pickup.',
      ),
    );
    const free = element(doc, 'div', 'shipments-grid');
    free.append(
      field(
        t('Free days at the ramp'),
        input('number', 'free:ramp', shipment?.freeDays.ramp ?? '', {
          min: '0',
          max: '60',
          inputmode: 'numeric',
        }),
      ),
      field(
        t('Free days to return the empty'),
        input('number', 'free:return', shipment?.freeDays.return ?? '', {
          min: '0',
          max: '60',
          inputmode: 'numeric',
        }),
      ),
    );
    form.append(freeHeading, freeHint, free);

    const holdsHeading = element(
      doc,
      'h4',
      'shipments-form-section',
      t('Holds'),
    );
    const holds = element(doc, 'div', 'shipments-holds');
    for (const kind of HOLD_KINDS) {
      const wrap = element(doc, 'label', 'shipments-check');
      const box = input('checkbox', `hold:${kind}`, '');
      box.checked = Boolean(shipment?.holds[kind]);
      wrap.append(box, element(doc, 'span', '', t(HOLD_LABELS[kind])));
      holds.append(wrap);
    }
    form.append(holdsHeading, holds);

    const notes = doc.createElement('textarea');
    notes.name = 'notes';
    notes.rows = 2;
    notes.maxLength = 600;
    notes.value = shipment?.notes ?? '';
    form.append(field(t('Notes'), notes));

    const problem = element(doc, 'p', 'shipments-problem');
    problem.setAttribute('role', 'alert');
    const actions = element(doc, 'div', 'shipments-board-actions');
    const save = element(
      doc,
      'button',
      'shipments-btn shipments-btn-primary',
      shipment ? t('Save') : t('Add to board'),
    );
    save.type = 'submit';
    actions.append(save, button(t('Cancel'), showList));
    form.append(problem, actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = (name) => form.elements.namedItem(name)?.value ?? '';
      const input = {
        id: shipment?.id,
        container: value('container'),
        carrier: value('carrier'),
        reference: value('reference'),
        port: value('port'),
        ramp: value('ramp'),
        vessel: { query: value('vessel') },
        dates: Object.fromEntries(
          DATE_FIELDS.map((name) => [name, value(`date:${name}`)]),
        ),
        freeDays: { ramp: value('free:ramp'), return: value('free:return') },
        holds: Object.fromEntries(
          HOLD_KINDS.map((kind) => [
            kind,
            Boolean(form.elements.namedItem(`hold:${kind}`)?.checked),
          ]),
        ),
        notes: value('notes'),
      };
      const result = board.save(input);
      if (!result.shipment) {
        problem.textContent = result.problem
          ? t(result.problem)
          : t('Could not save');
        return;
      }
      showList();
      setStatus(
        result.problem
          ? t(result.problem)
          : t('{container} saved', { container: result.shipment.container }),
      );
    });
    body.append(form);
    container.focus?.();
  }

  // --- Export / import -----------------------------------------------------

  function exportAll() {
    const data = JSON.stringify(
      { kind: 'gev-shipments', version: 1, shipments: board.exportAll() },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([data], { type: 'application/json' }),
    );
    const link = element(doc, 'a');
    link.href = url;
    link.download = `shipments-${board.today()}.json`;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(t('Exported {count}', { count: board.list().length }));
  }

  function importAll() {
    const picker = input('file', 'import', '', {
      accept: 'application/json,.json',
    });
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const entries = Array.isArray(parsed) ? parsed : parsed?.shipments;
        if (!Array.isArray(entries)) throw new Error('not a shipments file');
        if (
          board.list().length &&
          !confirm(t('Replace the containers on this board with the file?'))
        )
          return;
        const count = board.importAll(entries);
        setStatus(
          tn(
            count,
            'Imported {count} container',
            'Imported {count} containers',
            { count },
          ),
        );
      } catch {
        setStatus(t('That file is not a shipments export'));
      }
    });
    picker.click();
  }

  const api = {
    /** `null` opens the list; `'new'` the add form; an id that shipment's form. */
    open(target = null) {
      ensureDialog();
      unsubscribe ??= board.subscribe(() => {
        if (dialog?.open && view.name === 'list') renderList();
      });
      if (target === 'new') showForm(null);
      else if (target && board.get(target)) showForm(target);
      else showList();
      setStatus(notice);
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
    },
    close() {
      if (dialog?.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      notice = '';
    },
    destroy() {
      api.close();
      unsubscribe?.();
      unsubscribe = null;
      dialog?.remove();
      dialog = null;
      body = null;
      status = null;
    },
  };
  return api;
}

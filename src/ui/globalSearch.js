/**
 * The search box at the top of the map: type anything — a container number,
 * your reference, a ship, a zone, a flight, a layer or a place — and pick it.
 * Results come from src/ui/globalSearchModel.js; this file is the DOM.
 */
import { t } from '../i18n/index.js';
import { shownLayerName } from './layerNames.js';
import { searchEverything } from './globalSearchModel.js';

const SHIPMENTS_LAYER_ID = 'shipments';
const ICONS = Object.freeze({
  container: '▣',
  item: '•',
  layer: '◧',
  place: '⌖',
});

/**
 * @param {{doc?: Document, host?: HTMLElement|null,
 *   dataManager: object, navigate?: (href: string) => void,
 *   findPlace?: (query: string) => void}} options
 */
export function mountGlobalSearch({
  doc = globalThis.document,
  host = doc?.getElementById?.('global-search'),
  dataManager,
  navigate = (href) => globalThis.location.assign(href),
  findPlace = (query) => {
    const input = doc.getElementById('location-search');
    if (!input) return;
    input.value = query;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  },
} = {}) {
  if (!host || !dataManager) return { destroy() {} };
  const removers = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    removers.push(() => target.removeEventListener(type, fn, options));
  };

  host.replaceChildren();
  const form = doc.createElement('form');
  form.className = 'global-search-form';
  form.setAttribute('role', 'search');
  const input = doc.createElement('input');
  input.type = 'search';
  input.id = 'global-search-input';
  input.className = 'global-search-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = t('Search containers, ships, zones, layers or places');
  input.setAttribute('aria-label', t('Search everything'));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'global-search-results');
  input.setAttribute('aria-autocomplete', 'list');
  const list = doc.createElement('div');
  list.id = 'global-search-results';
  list.className = 'global-search-results';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  form.append(input, list);
  host.append(form);

  let results = [];
  let active = -1;

  function layerRows() {
    const layers = [];
    const items = [];
    for (const layer of dataManager.getAll?.() ?? []) {
      if (layer.showInTogglePanel === false) continue;
      const name = shownLayerName(layer.name, layer.id);
      layers.push({ id: layer.id, name, enabled: layer.enabled });
      let controls = null;
      try {
        controls = dataManager.layers
          ?.get?.(layer.id)
          ?.module?.getRowControls?.();
      } catch {
        controls = null;
      }
      for (const item of controls?.list?.items ?? [])
        if (item?.text && item.params)
          items.push({
            layerId: layer.id,
            layerName: name,
            id: String(item.id ?? item.text),
            text: String(item.text),
            params: item.params,
          });
    }
    return { layers, items };
  }

  function shipments() {
    try {
      return (
        dataManager.layers
          ?.get?.(SHIPMENTS_LAYER_ID)
          ?.module?.board?.list?.() ?? []
      );
    } catch {
      return [];
    }
  }

  function describe(result) {
    if (result.kind === 'container')
      return [t('Container'), result.detail].filter(Boolean).join(' · ');
    if (result.kind === 'item') return result.detail;
    if (result.kind === 'layer')
      return result.target.enabled
        ? t('Map layer · on — choose to turn off')
        : t('Map layer · choose to turn on');
    return t('Find this place on the map');
  }

  function render() {
    list.replaceChildren();
    results.forEach((result, index) => {
      const option = doc.createElement('button');
      option.type = 'button';
      option.id = `global-search-option-${index}`;
      option.className = `global-search-option kind-${result.kind}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      const icon = doc.createElement('span');
      icon.className = 'global-search-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = ICONS[result.kind];
      const text = doc.createElement('span');
      text.className = 'global-search-text';
      const title = doc.createElement('strong');
      title.textContent =
        result.kind === 'place'
          ? t('Find “{query}” on the map', { query: result.title })
          : result.title;
      const detail = doc.createElement('span');
      detail.textContent = describe(result);
      text.append(title, detail);
      option.append(icon, text);
      if (result.kind === 'container') {
        const listLink = doc.createElement('span');
        listLink.className = 'global-search-link';
        listLink.textContent = t('Open in list');
        listLink.addEventListener('click', (event) => {
          event.stopPropagation();
          close();
          navigate(
            `/shipments.html?q=${encodeURIComponent(result.target.container)}`,
          );
        });
        option.append(listLink);
      }
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => void choose(result));
      list.append(option);
    });
    const open = results.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0)
      input.setAttribute(
        'aria-activedescendant',
        `global-search-option-${active}`,
      );
    else input.removeAttribute('aria-activedescendant');
  }

  function update() {
    const { layers, items } = layerRows();
    results = searchEverything(input.value, {
      shipments: shipments(),
      layers,
      items,
      shipmentsLayerId: SHIPMENTS_LAYER_ID,
    });
    active = results.length ? 0 : -1;
    render();
  }

  function close() {
    results = [];
    active = -1;
    render();
  }

  async function choose(result) {
    close();
    input.blur();
    try {
      if (result.kind === 'container') {
        await dataManager.setEnabled?.(SHIPMENTS_LAYER_ID, true);
        dataManager.setLayerParams?.(SHIPMENTS_LAYER_ID, {
          select: result.target.id,
        });
      } else if (result.kind === 'item') {
        await dataManager.setEnabled?.(result.target.layerId, true);
        dataManager.setLayerParams?.(
          result.target.layerId,
          result.target.params,
        );
      } else if (result.kind === 'layer') {
        await dataManager.setEnabled?.(
          result.target.layerId,
          !result.target.enabled,
        );
      } else {
        findPlace(result.target.query);
      }
    } catch {
      /* the layer reports its own problem in its row */
    }
  }

  on(input, 'input', update);
  on(input, 'focus', () => {
    if (input.value.trim()) update();
  });
  on(input, 'blur', () => setTimeout(close, 120));
  on(input, 'keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
      render();
    } else if (event.key === 'Escape') {
      close();
      input.blur();
    }
  });
  on(form, 'submit', (event) => {
    event.preventDefault();
    const pick = results[active] ?? results[0];
    if (pick) void choose(pick);
  });
  // "/" or Ctrl/⌘+K jumps to the search box from anywhere on the map.
  on(doc, 'keydown', (event) => {
    const typing = event.target?.matches?.(
      'input, textarea, select, [contenteditable="true"]',
    );
    if (
      (event.key === '/' && !typing) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')
    ) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });

  // /?search=… (from the home page) opens the map with the search filled in.
  const preset = new URLSearchParams(globalThis.location?.search ?? '').get(
    'search',
  );
  if (preset) {
    input.value = preset.slice(0, 80);
    setTimeout(() => {
      input.focus();
      update();
    }, 600);
  }

  return {
    input,
    update,
    destroy() {
      for (const remove of removers.splice(0)) remove();
      host.replaceChildren();
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_VIEWS, planQuickView, quickView } from './quickViews.js';

const roster = (...ids) => ids.map((id) => ({ id }));

test('every view names at least one layer and has a unique id', () => {
  const ids = new Set();
  for (const view of QUICK_VIEWS) {
    assert.ok(view.id, 'a view needs an id');
    assert.ok(!ids.has(view.id), `duplicate view id: ${view.id}`);
    ids.add(view.id);
    assert.ok(view.layerIds.length > 0, `${view.id} names no layers`);
    assert.ok(view.label, `${view.id} has no label`);
  }
});

test('a view is exact: its layers on, every other panel layer off', () => {
  const plan = planQuickView(
    'ships',
    roster('ais-live-vessels', 'flights', 'traffic'),
  );
  assert.deepEqual(plan, {
    enable: ['ais-live-vessels'],
    disable: ['flights', 'traffic'],
  });
});

test('a layer the catalog does not carry is not enabled blindly', () => {
  // 'cctv' is absent from this roster, so the plan cannot name it.
  const plan = planQuickView('traffic', roster('traffic', 'flights'));
  assert.deepEqual(plan.enable, ['traffic']);
  assert.ok(!plan.enable.includes('cctv'));
});

test('a hidden coordinator is never switched off by a view', () => {
  // Hidden layers back other layers; a view must not pull them out from under
  // the feeds that depend on them.
  const plan = planQuickView('ships', [
    { id: 'ais-live-vessels' },
    { id: 'military-awareness', showInTogglePanel: false },
    { id: 'flights' },
  ]);
  assert.deepEqual(plan.enable, ['ais-live-vessels']);
  assert.deepEqual(plan.disable, ['flights']);
});

test('the same view twice plans the same thing', () => {
  const layers = roster('traffic', 'cctv', 'flights');
  assert.deepEqual(
    planQuickView('traffic', layers),
    planQuickView('traffic', layers),
  );
});

test('an unknown view plans nothing rather than clearing the globe', () => {
  assert.equal(planQuickView('nope', roster('flights')), null);
  assert.equal(quickView('nope'), null);
  assert.equal(quickView('ships').id, 'ships');
});

test('an empty roster yields an empty plan, not a throw', () => {
  assert.deepEqual(planQuickView('ships'), { enable: [], disable: [] });
  assert.deepEqual(planQuickView('ships', []), { enable: [], disable: [] });
});

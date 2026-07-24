'use strict';
const assert = require('node:assert/strict');
require('../js/model-v2.js');
const M = globalThis.ShoppingModel;

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

test('default state is valid', () => {
  const state = M.createDefaultState();
  assert.deepEqual(M.validateState(state), []);
  assert.equal(state.schemaVersion, 2);
});

test('migrates v1 order and settings', () => {
  const state = M.migrateState({
    schemaVersion: 1,
    categories: [
      { id: 'b', name: 'B', color: '#112233', order: 1 },
      { id: 'a', name: 'A', color: '#445566', order: 0 }
    ],
    products: [{ id: 'p', name: 'P', categoryId: 'b', selected: true, bought: true }],
    settings: { checkboxSide: 'left', theme: 'light' }
  });
  assert.deepEqual(state.categories.map(x => x.id), ['a', 'b']);
  assert.equal(state.settings.checkboxesRight, false);
  assert.equal(state.settings.theme, 'light');
  assert.equal(state.products[0].bought, true);
});

test('recovers orphaned products', () => {
  const state = M.migrateState({ categories: [], products: [{ id: 'p', name: 'Product', categoryId: 'missing' }] });
  assert.equal(state.categories.length, 1);
  assert.equal(state.products[0].categoryId, state.categories[0].id);
  assert.deepEqual(M.validateState(state), []);
});

test('unselect clears bought', () => {
  let state = M.createDefaultState();
  const product = state.products.find(x => x.selected);
  state = M.setProductBought(state, product.id, true);
  state = M.setProductSelected(state, product.id, false);
  const changed = M.productById(state, product.id);
  assert.equal(changed.selected, false);
  assert.equal(changed.bought, false);
});

test('category movement uses array order', () => {
  let state = M.createDefaultState();
  const first = state.categories[0].id;
  state = M.moveCategory(state, first, 'down');
  assert.equal(state.categories[1].id, first);
});

test('duplicate product is rejected case-insensitively', () => {
  const state = M.createDefaultState();
  const product = state.products[0];
  assert.throws(() => M.addProduct(state, { name: product.name.toUpperCase(), categoryId: product.categoryId }), error => error.code === 'duplicate_product');
});

test('delete category removes its products only', () => {
  const state = M.createDefaultState();
  const category = state.categories[0];
  const otherCount = state.products.filter(x => x.categoryId !== category.id).length;
  const next = M.deleteCategory(state, category.id);
  assert.equal(next.products.length, otherCount);
  assert.equal(next.categories.some(x => x.id === category.id), false);
});

console.log('All model tests passed');

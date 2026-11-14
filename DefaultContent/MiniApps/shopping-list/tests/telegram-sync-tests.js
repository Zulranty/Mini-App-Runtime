'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
require('../js/model-v2.js');
require('../js/telegram-sync.js');

const M = globalThis.ShoppingModel;
const Sync = globalThis.ShoppingTelegramSync;
const defaults = M.createDefaultState();
const clone = value => structuredClone(value);
const baseOf = state => Sync.project(state);

function channel() {
  let sequence = 0;
  const records = new Map();
  const removed = [];
  const forAccount = account => ({
    async read() {
      return [...records].map(([id, row]) => ({ id, text: row.text, owned: row.account === account }));
    },
    async publishPurchases(text, preview) { records.set(++sequence, { text, account, preview }); return sequence; },
    async remove(ids, keep) {
      assert(records.has(keep));
      for (const id of ids) {
        assert.notEqual(id, keep);
        assert.equal(records.get(id)?.account, account, "only the publishing account may delete");
        records.delete(id);
        removed.push(id);
      }
      return ids.length;
    }
  });
  return { records, removed, transport: forAccount("default"), forAccount };
}

function reconcile(transport, local, base, initial, actor) {
  return Sync.reconcile(transport, baseOf(local), base, baseOf(initial), actor);
}

function applied(result) {
  return Sync.materialize(result.snapshot);
}

test('independently added products and categories collapse before publishing and keep purchase marks', async () => {
  const { transport, records } = channel();
  const home = { id: 'cat-a', name: 'Дом', color: '#65C18C' };
  const kitchen = { id: 'cat-k', name: 'Кухня', color: '#65C18C' };
  const product = { id: 'prd-a', name: 'Молоко  2%', categoryId: home.id, selected: true, bought: false };
  const a = { ...defaults, categories: [home, kitchen], products: [product,
    { ...product, id: 'prd-k', categoryId: kitchen.id }] };
  const b = { ...defaults, categories: [{ ...home, id: 'cat-b', name: 'дом' }],
    products: [{ ...product, id: 'prd-b', name: 'молоко 2%', categoryId: 'cat-b', bought: true }] };
  await reconcile(transport, a, null, defaults, 'first');
  const result = await reconcile(transport, b, { categories: [], products: [] }, defaults, 'second');
  const merged = applied(result);
  assert.deepEqual(merged.categories.map(category => category.name).sort(), ['Дом', 'Кухня']);
  assert.deepEqual(merged.products.map(item => [item.id, item.selected, item.bought]), [
    ['prd-a', true, true], ['prd-k', true, false]
  ]);
  assert.equal(await result.cleanUp(), true);
  assert.equal(result.snapshot.products['prd-b'].present[2], false);
  const repeat = await reconcile(transport, merged, baseOf(merged), defaults, 'third');
  assert.equal(applied(repeat).products.length, 2);
  assert.equal(records.size, 1);
});

test('concurrent merges of overlapping duplicate IDs converge and keep the purchased mark', async () => {
  const first = channel();
  const second = channel();
  const combined = channel();
  const category = { id: 'groceries', name: 'Groceries', color: '#65C18C' };
  const product = { name: 'Tea', categoryId: category.id, selected: true, bought: false };
  const state = (...items) => ({ ...defaults, categories: [category], products: items });
  const a = state({ ...product, id: 'prd-a' }, { ...product, id: 'prd-c' });
  const b = state({ ...product, id: 'prd-b', bought: true }, { ...product, id: 'prd-c' });
  await reconcile(first.transport, a, null, defaults, 'first');
  await reconcile(second.transport, b, null, defaults, 'second');
  for (const source of [first, second]) {
    await combined.transport.publishPurchases(source.records.get(1).text);
  }
  const merged = await reconcile(combined.transport, a, baseOf(a), defaults, 'third');
  assert.deepEqual(applied(merged).products, [{ ...product, id: 'prd-a', bought: true }]);
  await merged.cleanUp();
  assert.equal(combined.records.size, 1);
});

test('first sync publishes existing local data and repeat sync leaves the one confirmed message', async () => {
  const { records, transport } = channel();
  const local = M.setProductBought(defaults, 'prd-milk', true);
  const initial = await reconcile(transport, local, null, defaults, 'first');
  assert.equal(applied(initial).products.find(row => row.id === 'prd-milk').bought, true);
  assert.equal(records.size, 1);

  const second = await reconcile(transport, defaults, null, defaults, 'second');
  assert.equal(applied(second).products.find(row => row.id === 'prd-milk').bought, true);
  assert.equal(await second.cleanUp(), true);
  assert.deepEqual([...records.keys()], [1]);
});

test('concurrent edits to different fields of one product survive compaction', async () => {
  const { records, transport, removed } = channel();
  await reconcile(transport, defaults, null, defaults, 'seed');
  let firstPublications = 0;
  let release;
  const bothPublished = new Promise(resolve => { release = resolve; });
  const racing = {
    ...transport,
    async publishPurchases(text) {
      const id = await transport.publishPurchases(text);
      if (++firstPublications === 2) release();
      await bothPublished;
      return id;
    }
  };
  const renamed = M.renameProduct(defaults, 'prd-milk', 'Oat milk');
  const bought = M.setProductBought(defaults, 'prd-milk', true);
  const both = await Promise.all([
    Sync.reconcile(racing, renamed, baseOf(defaults), defaults, 'phone-a'),
    Sync.reconcile(racing, bought, baseOf(defaults), defaults, 'phone-b')
  ]);
  assert.equal(removed.length, 0, 'cleanup requires caller to first store the merged list');
  await both[0].cleanUp();
  const final = await reconcile(transport, defaults, baseOf(defaults), defaults, 'phone-c');
  const product = applied(final).products.find(row => row.id === 'prd-milk');
  assert.equal(product.name, 'Oat milk');
  assert.equal(product.bought, true);
  assert.equal(await final.cleanUp(), true);
  assert.equal(records.size, 1);
});

test('deletions remain deleted when the other device comes online with a stale rename', async () => {
  const { transport, records } = channel();
  await reconcile(transport, defaults, null, defaults, 'seed');
  const deleted = M.deleteProduct(defaults, 'prd-milk');
  const deletion = await reconcile(transport, deleted, baseOf(defaults), defaults, 'first');
  await deletion.cleanUp();
  const edited = M.renameProduct(defaults, 'prd-milk', 'Old local rename');
  const late = await reconcile(transport, edited, baseOf(defaults), defaults, 'second');
  assert(!applied(late).products.some(row => row.id === 'prd-milk'));
  const staleWithoutBase = await reconcile(transport, edited, null, defaults, 'no-base');
  assert(!applied(staleWithoutBase).products.some(row => row.id === 'prd-milk'));
  await late.cleanUp();
  assert.equal(records.size, 1);
});

test('sharing purchases adds missing items to the catalog and links existing ones by name and category', async () => {
  const { transport, records } = channel();
  const sender = { ...defaults, products: [
    { id: 'local-a', name: 'Honey', categoryId: 'cat-grocery', selected: true, bought: true },
    { id: 'local-b', name: 'Tea', categoryId: 'cat-grocery', selected: true, bought: false },
    { id: 'local-secret', name: 'Private unselected product', categoryId: 'cat-home', selected: false, bought: false }
  ] };
  const receiver = { ...defaults, products: [
    { id: 'local-honey', name: 'honey', categoryId: 'cat-grocery', selected: false, bought: false },
    { id: 'local-pear', name: 'Pear', categoryId: 'cat-produce', selected: false, bought: false }
  ] };
  const baseline = { categories: [], products: [] };
  await reconcile(transport, sender, baseline, defaults, 'sender');
  const payload = JSON.parse(records.get(1).text);
  assert.equal(payload.scope, 'purchases');
  assert.deepEqual(Object.keys(payload.products), ['local-a', 'local-b']);
  assert.deepEqual(Object.keys(payload.categories), ['cat-grocery']);
  assert.equal(payload.categories['cat-grocery'].color, undefined);
  assert.deepEqual(records.get(1).preview, ['✓ Honey', '☐ Tea']);
  const received = await reconcile(transport, receiver, baseline, defaults, 'receiver');
  const local = Sync.applyToLocal(receiver, applied(received), baseline);
  assert.deepEqual(local.state.categories, receiver.categories);
  assert.deepEqual(local.state.products.map(row => [row.id, row.name, row.selected, row.bought]), [
    ['local-honey', 'honey', true, true], ['local-pear', 'Pear', false, false],
    ['local-b', 'Tea', true, false]
  ]);
  assert.deepEqual(Sync.project(local.state, local.base).products.map(row => row.id).sort(), ['local-a', 'local-b']);
  const removed = M.setProductSelected(local.state, 'local-b', false);
  assert.equal(M.productById(removed, 'local-b').name, 'Tea');
  const afterRemoval = await Sync.reconcile(transport, Sync.project(removed, local.base), local.base, baseline, 'remove-tea');
  assert.deepEqual(applied(afterRemoval).products.map(row => row.id), ['local-a']);
  assert.deepEqual(Object.keys(afterRemoval.snapshot.products['local-b']), ['present']);
  const late = await Sync.reconcile(transport, Sync.project(sender), Sync.project(sender), baseline, 'stale-sender');
  assert.deepEqual(applied(late).products.map(row => row.id), ['local-a']);
  const acknowledged = Sync.applyToLocal(sender, applied(late), Sync.project(sender));
  const reselected = M.setProductSelected(acknowledged.state, 'local-b', true);
  const withRemoval = { ...acknowledged.base, removedIds: ['local-b'] };
  const readded = await Sync.reconcile(transport, Sync.project(reselected, withRemoval), withRemoval, baseline, 'reselect');
  assert.deepEqual(applied(readded).products.map(row => row.id), ['local-a', 'local-b']);
  const stable = Sync.applyToLocal(local.state, applied(readded), local.base);
  assert.deepEqual(stable.state.products.map(row => row.id), ['local-honey', 'local-pear', 'local-b']);
});

test('a locally matched product can be selected again using its original shared ID', async () => {
  const { transport } = channel();
  const seed = { ...defaults, products: [
    { id: 'remote-honey', name: 'Honey', categoryId: 'cat-grocery', selected: true, bought: false }
  ] };
  const empty = { categories: [], products: [] };
  const result = await reconcile(transport, seed, empty, defaults, 'seed');
  const receiver = { ...defaults, products: [
    { id: 'local-honey', name: 'honey', categoryId: 'cat-grocery', selected: false, bought: false }
  ] };
  const linked = Sync.applyToLocal(receiver, applied(result), empty);
  const deselected = M.setProductSelected(linked.state, 'local-honey', false);
  const removed = await Sync.reconcile(transport, Sync.project(deselected, linked.base), linked.base, empty, 'drop');
  const local = Sync.applyToLocal(linked.state, applied(removed), linked.base);
  const confirmed = Sync.rememberRemovals(local.base, removed.snapshot, linked.base);
  assert.equal(M.productById(local.state, 'local-honey').selected, false);
  const changed = M.setProductSelected(local.state, 'local-honey', true);
  const select = Sync.project(changed, confirmed);
  assert.equal(select.products[0].id, 'remote-honey');
  const restored = await Sync.reconcile(transport, select, confirmed, empty, 'reselect');
  assert.deepEqual(applied(restored).products.map(row => row.id), ['remote-honey']);
});

test('removing the last purchase in a group drops that group from the attachment', async () => {
  const { transport, records } = channel();
  await reconcile(transport, defaults, null, defaults, 'first');
  const empty = { ...defaults, products: defaults.products.map(row => ({ ...row, selected: false, bought: false })) };
  const removed = await reconcile(transport, empty, baseOf(defaults), defaults, 'remove-all');
  assert.deepEqual(applied(removed).products, []);
  assert.equal(await removed.cleanUp(), true);
  const attachment = JSON.parse([...records.values()][0].text);
  assert.deepEqual(attachment.categories, {});
  assert(Object.values(attachment.products).every(row => Object.keys(row).join() === 'present'));
});

test('lost acknowledgement preserves the prior snapshot and the retry discovers the new one', async () => {
  const { records, removed, transport } = channel();
  await reconcile(transport, defaults, null, defaults, 'seed');
  const local = M.setProductBought(defaults, 'prd-milk', true);
  const unreliable = {
    ...transport,
    async publishPurchases(text) {
      await transport.publishPurchases(text);
      throw new Error('response lost');
    }
  };
  await assert.rejects(reconcile(unreliable, local, baseOf(defaults), defaults, 'first'), /response lost/);
  assert.equal(removed.length, 0);
  assert.equal(records.size, 2);
  const retry = await reconcile(transport, local, baseOf(defaults), defaults, 'first');
  assert.equal(applied(retry).products.find(row => row.id === 'prd-milk').bought, true);
  await retry.cleanUp();
  assert.deepEqual([...records.keys()], [2]);
});

test('each person removes only their own previous post after the other person publishes', async () => {
  const { records, removed, forAccount } = channel();
  const a = forAccount('a');
  const b = forAccount('b');
  await reconcile(a, defaults, null, defaults, 'first');
  const bought = M.setProductBought(defaults, 'prd-milk', true);
  const fromB = await reconcile(b, bought, null, defaults, 'second');
  await fromB.cleanUp();
  assert.deepEqual([...records.keys()], [1, 2]);
  assert.deepEqual(removed, []);
  const fromA = await reconcile(a, defaults, baseOf(defaults), defaults, 'first');
  assert.equal(applied(fromA).products.find(row => row.id === 'prd-milk').bought, true);
  await fromA.cleanUp();
  assert.deepEqual([...records.keys()], [2]);
  assert.deepEqual(removed, [1]);
});

test('an empty channel is reseeded with selected purchases', async () => {
  const { transport } = channel();
  const result = await reconcile(transport, defaults, baseOf(defaults), defaults, 'first');
  assert.equal(applied(result).products.length, M.selectedProducts(defaults).length);
});

test('an old or malformed payload with the current caption aborts before publish or delete', async () => {
  for (const text of ['{"version": 2}', '{"version":1,"categories":{},"products":{}}']) {
    const { transport, records, removed } = channel();
    await transport.publishPurchases(text);
    await assert.rejects(reconcile(transport, defaults, null, defaults, 'first'), /SYNC_INVALID_SNAPSHOT/);
    assert.equal(records.size, 1);
    assert.deepEqual(removed, []);
  }
});

test('pending edits during network calls can be reapplied without changing the remote baseline', async () => {
  const { transport } = channel();
  const remote = M.renameProduct(defaults, 'prd-milk', 'Oat milk');
  await reconcile(transport, remote, null, defaults, 'remote');
  const result = await reconcile(transport, defaults, null, defaults, 'local');
  const local = M.setProductBought(clone(defaults), 'prd-milk', true);
  const reapplied = Sync.applyChanges(result.snapshot, baseOf(defaults), baseOf(local), 'local');
  const product = Sync.materialize(reapplied).products.find(row => row.id === 'prd-milk');
  assert.equal(product.name, 'Oat milk');
  assert.equal(product.bought, true);
  assert.equal(applied(result).products.find(row => row.id === 'prd-milk').bought, false);
});

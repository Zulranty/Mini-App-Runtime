(() => {
  'use strict';

  const fields = {
    categories: ['present', 'name'],
    products: ['present', 'name', 'categoryId', 'selected', 'bought']
  };
  const kinds = Object.keys(fields);
  const namesEqual = globalThis.ShoppingModel.namesEqual;
  const maxBytes = 1024 * 1024;
  const empty = () => ({ version: 2, scope: 'purchases', categories: {}, products: {}, aliases: { categories: {}, products: {} } });
  const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
  const compare = (a, b) => a === b ? 0 : a > b ? 1 : -1;

  function project(state, base) {
    const categories = new Map();
    const products = [];
    const links = new Map();
    for (const row of base?.products ?? []) {
      if (row.localId && !links.has(row.localId)) links.set(row.localId, row);
    }
    for (const row of base?.removedLinks ?? []) {
      if (!links.has(row.localId)) links.set(row.localId, row);
    }
    const localCategories = new Map(state.categories.map(row => [row.id, row]));
    const priorCategories = new Map((base?.categories ?? []).map(row => [row.id, row]));
    for (const local of state.products) {
      if (!local.selected) continue;
      const linked = links.get(local.id);
      const category = (linked && (priorCategories.get(linked.categoryId) ?? {
        id: linked.categoryId, name: linked.categoryName
      })) ?? localCategories.get(local.categoryId);
      if (!category) continue;
      categories.set(category.id, { id: category.id, name: category.name });
      const sharedName = linked && (linked.localName ?? linked.name) === local.name ? linked.name : local.name;
      const product = {
        id: linked?.id ?? local.id, name: sharedName, categoryId: category.id,
        localId: local.id, localName: local.name, selected: true, bought: local.bought
      };
      products.push(product);
    }
    return { categories: [...categories.values()], products };
  }

  function applyToLocal(state, list, previous) {
    const localCategories = new Map(state.categories.map(row => [row.id, row]));
    const groups = new Map(list.categories.map(row => [row.id, row]));
    const localProducts = new Map(state.products.map(row => [row.id, row]));
    const prior = new Map([...(previous?.removedLinks ?? []), ...(previous?.products ?? [])]
      .filter(row => row.localId).map(row => [row.id, row.localId]));
    const mapped = new Map();
    const linked = [];
    const { normalizeName, DEFAULT_COLORS } = globalThis.ShoppingModel;
    for (const row of list.products) {
      const name = normalizeName(row.name);
      if (!name) continue;
      let product = localProducts.get(prior.get(row.id)) ?? localProducts.get(row.id);
      if (!product) {
        const group = groups.get(row.categoryId);
        const groupName = normalizeName(group?.name, globalThis.translateShoppingList?.('Uncategorized') ?? 'Uncategorized');
        const categoryId = group?.id ?? 'cat-sync-uncategorized';
        let category = localCategories.get(categoryId) ??
          [...localCategories.values()].find(item => namesEqual(item.name, groupName));
        if (!category) {
          category = { id: categoryId, name: groupName, color: DEFAULT_COLORS[localCategories.size % DEFAULT_COLORS.length] };
          localCategories.set(category.id, category);
        }
        product = [...localProducts.values()].find(item => item.categoryId === category.id && namesEqual(item.name, name));
        if (!product) {
          product = { id: row.id, name, categoryId: category.id, selected: false, bought: false };
          localProducts.set(product.id, product);
        }
      }
      mapped.set(product.id, mapped.get(product.id) === true || row.bought === true);
      linked.push({ ...row, localId: product.id, localName: product.name });
    }
    return {
      base: { categories: list.categories, products: linked },
      state: {
        ...state,
        categories: [...localCategories.values()],
        products: [...localProducts.values()].map(row => ({
          ...row,
          selected: mapped.has(row.id),
          bought: mapped.get(row.id) === true
        }))
      }
    };
  }

  function rememberRemovals(base, snapshot, ...previous) {
    const removedIds = Object.entries(snapshot.products)
      .filter(([id, row]) => row.present?.[2] === false && !own(snapshot.aliases.products, id))
      .map(([id]) => id);
    const removed = new Set(removedIds);
    const links = new Map();
    for (const list of previous) {
      const categories = new Map((list?.categories ?? []).map(row => [row.id, row.name]));
      for (const row of [...(list?.removedLinks ?? []), ...(list?.products ?? [])]) {
        const id = resolveId(snapshot, 'products', row.id);
        if (row.localId && removed.has(id)) {
          links.set(row.localId, {
            ...row, id, categoryName: categories.get(row.categoryId) ?? row.categoryName
          });
        }
      }
    }
    return { ...base, removedIds, removedLinks: [...links.values()] };
  }

  function rows(state, kind) {
    return new Map(state[kind].map(({ id, ...row }) => [id, { present: true, ...row }]));
  }

  function newer(left, right) {
    if (!left) return right;
    if (!right) return left;
    const order = compare(left[0], right[0]) || compare(left[1], right[1]) ||
      compare(JSON.stringify(left[2]), JSON.stringify(right[2]));
    return order >= 0 ? left : right;
  }

  function mergeAliases(left, right) {
    const targets = new Map();
    function root(id) {
      if (!targets.has(id)) return id;
      const path = [];
      while (targets.has(id)) {
        path.push(id);
        id = targets.get(id);
      }
      for (const member of path) targets.set(member, id);
      return id;
    }
    for (const aliases of [left, right]) {
      for (const [id, target] of Object.entries(aliases ?? {})) {
        const a = root(id);
        const b = root(target);
        if (a < b) targets.set(b, a);
        if (b < a) targets.set(a, b);
      }
    }
    const merged = Object.create(null);
    for (const id of [...targets.keys()].sort()) merged[id] = root(id);
    return merged;
  }

  function merge(left, right) {
    const result = empty();
    for (const kind of kinds) {
      const ids = new Set([...Object.keys(left[kind]), ...Object.keys(right[kind])]);
      result[kind] = Object.fromEntries([...ids].sort().map(id => {
        const a = own(left[kind], id) ?? {};
        const b = own(right[kind], id) ?? {};
        const registers = fields[kind].flatMap(field => {
          const value = newer(a[field], b[field]);
          return value ? [[field, value]] : [];
        });
        return [id, Object.fromEntries(registers)];
      }));
      result.aliases[kind] = mergeAliases(left.aliases?.[kind], right.aliases?.[kind]);
    }
    return result;
  }

  function dominates(left, right) {
    return kinds.every(kind => Object.entries(right.aliases?.[kind] ?? {}).every(([id, target]) => {
      const canonical = resolveId(left, kind, id);
      return canonical !== id && canonical === resolveId(left, kind, target);
    }) && Object.entries(right[kind]).every(([id, record]) =>
      Object.entries(record).every(([field, stamp]) => {
        const row = own(left[kind], id);
        const deletion = kind === 'products' && row?.present?.[2] === false ? row.present : null;
        if (field !== 'present' && deletion &&
            (deletion[0] > stamp[0] || (deletion[0] === stamp[0] && deletion[1] >= stamp[1]))) return true;
        const current = row?.[field];
        return current && newer(current, stamp) === current;
      })
    ));
  }

  function coversPurchases(left, right) {
    // Group metadata is represented only while a purchase in that group survives.
    const used = new Set(Object.entries(right.products).filter(([id, row]) => row.present?.[2] === true && row.categoryId &&
      own(left.products, resolveId(left, 'products', id))?.present?.[2] !== false)
      .map(([, row]) => resolveId(right, 'categories', row.categoryId[2])));
    const categories = Object.fromEntries(Object.entries(right.categories)
      .filter(([id]) => used.has(resolveId(right, 'categories', id))));
    const aliases = Object.fromEntries(Object.entries(right.aliases?.categories ?? {})
      .filter(([id]) => own(categories, id)));
    return dominates(left, { ...right, categories, aliases: { ...right.aliases, categories: aliases } });
  }

  function resolveId(snapshot, kind, id) {
    const aliases = snapshot.aliases?.[kind] ?? {};
    while (own(aliases, id)) id = aliases[id];
    return id;
  }

  function clock(snapshot) {
    let counter = 0;
    for (const kind of kinds) {
      for (const row of Object.values(snapshot[kind])) {
        for (const stamp of Object.values(row)) counter = Math.max(counter, stamp[0]);
      }
    }
    return counter;
  }

  function applyChanges(snapshot, base, state, actor) {
    const delta = empty();
    const counter = clock(snapshot) + 1;
    if (!Number.isSafeInteger(counter)) throw new Error('SYNC_INVALID_SNAPSHOT');
    for (const kind of kinds) {
      const before = rows(base, kind);
      const after = rows(state, kind);
      const edits = new Map();
      const retainedIds = new Set(Object.values(snapshot.aliases?.[kind] ?? {})
        .map(id => resolveId(snapshot, kind, id)));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(id);
        const next = after.get(id) ?? { present: false };
        if (kind === 'categories' && !after.has(id)) continue;
        const target = resolveId(snapshot, kind, id);
        const remote = own(snapshot[kind], target) ?? {};
        const original = own(snapshot[kind], id);
        const readded = kind === 'products' && remote.present?.[2] === false && !previous && after.has(id) &&
          (base.removedIds ?? []).includes(target);
        if (target !== id && remote.present?.[2] !== true && !readded) continue;
        if (kind === 'products' && remote.present?.[2] === false && after.has(id) && !readded) continue;
        // A device without a baseline cannot distinguish a stale retained copy from an edit.
        if (!previous && retainedIds.has(id) && !readded) continue;
        for (const field of fields[kind]) {
          const value = next[field];
          const baseline = previous ? previous[field] : target !== id && !readded ? original?.[field]?.[2] : undefined;
          if (value === undefined || value === baseline ||
              (target !== id && field === 'present' && after.has(id) && !readded)) continue;
          const resolved = field === 'categoryId' ? resolveId(snapshot, 'categories', value) : value;
          if (resolved === remote[field]?.[2]) continue;
          const row = edits.get(target) ?? {};
          row[field] = newer(row[field], [counter, actor, resolved]);
          edits.set(target, row);
        }
      }
      delta[kind] = Object.fromEntries(edits);
    }
    return compactRemoved(collapseDuplicates(merge(snapshot, delta), actor));
  }

  function compactRemoved(snapshot) {
    for (const [id, row] of Object.entries(snapshot.products)) {
      // Aliases retain the last values needed to recognize edits from older local copies.
      if (row.present?.[2] === false && !own(snapshot.aliases.products, id)) {
        const kept = Object.entries(row).filter(([field, stamp]) => field === 'present' ||
          stamp[0] > row.present[0] || (stamp[0] === row.present[0] && stamp[1] > row.present[1]));
        snapshot.products[id] = Object.fromEntries(kept);
      }
    }
    return snapshot;
  }

  function pruneGroups(snapshot) {
    const used = new Set(Object.values(snapshot.products).filter(row => row.present?.[2] === true && row.categoryId)
      .map(row => resolveId(snapshot, 'categories', row.categoryId[2])));
    snapshot.categories = Object.fromEntries(Object.entries(snapshot.categories)
      .filter(([id]) => used.has(resolveId(snapshot, 'categories', id))));
    snapshot.aliases.categories = Object.fromEntries(Object.entries(snapshot.aliases?.categories ?? {})
      .filter(([id]) => own(snapshot.categories, id)));
    return snapshot;
  }

  function collapseDuplicates(snapshot, actor) {
    const counter = clock(snapshot) + 1;
    let fallbackCategory;
    function set(row, field, value) {
      if (row[field]?.[2] === value) return;
      if (!Number.isSafeInteger(counter)) throw new Error('SYNC_INVALID_SNAPSHOT');
      row[field] = [counter, actor, value];
    }

    for (const kind of kinds) {
      const groups = new Map();
      const rows = Object.entries(snapshot[kind]).sort(([a], [b]) => compare(a, b));
      const aliases = snapshot.aliases[kind];
      for (const [id, row] of rows) {
        const target = resolveId(snapshot, kind, id);
        if (target === id) continue;
        const retained = own(snapshot[kind], target);
        // A newer write from an old device can still target an absorbed ID.
        // Forward it only while the canonical record is live.
        if (retained?.present?.[2] === true) {
          for (const field of fields[kind]) {
            if (field === 'present' || !row[field]) continue;
            if (row.present?.[2] === true || row[field][0] >= (row.present?.[0] ?? 0)) {
              retained[field] = newer(retained[field], row[field]);
            }
          }
        }
        set(row, 'present', false);
      }

      for (const [id, row] of rows) {
        if (row.present?.[2] !== true) continue;
        if (kind === 'products' && row.categoryId) {
          set(row, 'categoryId', resolveId(snapshot, 'categories', row.categoryId[2]));
        }
        if (!row.name) continue;
        const categoryId = row.categoryId?.[2];
        const category = kind === 'products'
          ? (own(snapshot.categories, categoryId)?.present?.[2] === true ? categoryId : fallbackCategory)
          : '';
        const group = groups.get(category) ?? [];
        const existing = group.find(entry => namesEqual(entry.row.name[2], row.name[2]));
        if (!existing) {
          group.push({ id, row });
          groups.set(category, group);
          continue;
        }
        if (kind === 'products') {
          const selected = existing.row.selected?.[2] === true || row.selected?.[2] === true;
          const bought = existing.row.bought?.[2] === true || row.bought?.[2] === true;
          set(existing.row, 'selected', selected);
          set(existing.row, 'bought', selected && bought);
        }
        aliases[id] = existing.id;
        set(row, 'present', false);
      }
      if (kind === 'categories') {
        fallbackCategory = rows.find(([, row]) => row.present?.[2] === true)?.[0];
      }
    }
    return snapshot;
  }

  function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
  }

  function validValue(field, value) {
    switch (field) {
      case 'present':
      case 'selected':
      case 'bought': return typeof value === 'boolean';
      case 'categoryId': return validId(value);
      case 'name': return typeof value === 'string' && value.trim() !== '' && value.length <= 1024;
      default: return false;
    }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function decode(text) {
    try {
      const snapshot = JSON.parse(text);
      if (snapshot?.version !== 2 || snapshot.scope !== 'purchases' || !isObject(snapshot.aliases)) return null;
      for (const kind of kinds) {
        if (!isObject(snapshot[kind])) return null;
        const aliases = snapshot.aliases[kind];
        if (!isObject(aliases) || Object.entries(aliases).some(([id, target]) =>
          !validId(id) || !validId(target) || target >= id || !own(snapshot[kind], id) || !own(snapshot[kind], target))) return null;
        for (const [id, row] of Object.entries(snapshot[kind])) {
          if (!validId(id) || !isObject(row) || !Object.keys(row).length) return null;
          for (const [field, stamp] of Object.entries(row)) {
            if (!fields[kind].includes(field) || !Array.isArray(stamp) || stamp.length !== 3 ||
                !Number.isSafeInteger(stamp[0]) || stamp[0] < 1 ||
                typeof stamp[1] !== 'string' || !/^[a-z\d-]{1,80}$/i.test(stamp[1]) ||
                !validValue(field, stamp[2])) return null;
          }
        }
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  function materialize(snapshot) {
    const read = kind => Object.entries(snapshot[kind]).flatMap(([id, row]) => row.present?.[2] === true
      ? [{ id, ...Object.fromEntries(fields[kind].slice(1).map(field => [field, row[field]?.[2]])) }]
      : []);
    const categories = read('categories').sort((a, b) => compare(a.id, b.id));
    const products = read('products').filter(row => row.selected === true).sort((a, b) => compare(a.id, b.id));
    if (products.some(row => !categories.some(category => category.id === row.categoryId))) {
      let id = 'cat-sync-uncategorized';
      while (own(snapshot.categories, id)) id += '-';
      const name = globalThis.translateShoppingList?.('Uncategorized') ?? 'Uncategorized';
      categories.push({ id, name, color: '#8B7CFF' });
      for (const row of products) {
        if (!categories.some(category => category.id === row.categoryId)) row.categoryId = id;
      }
    }
    return { categories, products };
  }

  async function reconcile(transport, state, base, defaults, actor) {
    const observed = new Map();
    let remote = empty();
    let receivedBytes = 0;
    const encoder = new TextEncoder();
    function consume(message) {
      if (observed.has(message.id)) return;
      receivedBytes += encoder.encode(message.text).length;
      if (receivedBytes > 8 * maxBytes) throw new Error('SHOPPING_HISTORY_TOO_LARGE');
      const snapshot = decode(message.text);
      if (!snapshot) throw new Error('SYNC_INVALID_SNAPSHOT');
      const entry = { snapshot: pruneGroups(snapshot), owned: message.owned === true };
      observed.set(message.id, entry);
      remote = merge(remote, entry.snapshot);
    }
    async function read() {
      // Older modules and local transports return snapshots as an array.
      for (const message of await transport.read(consume) ?? []) consume(message);
    }
    await read();
    // A device without a sync baseline cannot prove that an old local
    // selection was made after an existing channel deletion.
    const incoming = !base && observed.size ? { ...state, products: state.products.filter(row =>
      own(remote.products, resolveId(remote, 'products', row.id))?.present?.[2] !== false) } : state;
    let snapshot = pruneGroups(applyChanges(remote, observed.size ? base ?? defaults : plainEmpty, incoming, actor));
    const covering = () => [...observed].filter(([, candidate]) => dominates(candidate.snapshot, snapshot))
      .sort(([a], [b]) => b - a)[0];

    let keep = covering();
    for (let attempt = 0; !keep && attempt < 3; attempt++) {
      const text = JSON.stringify(snapshot);
      if (new TextEncoder().encode(text).length > maxBytes) throw new Error('SYNC_LIST_TOO_LARGE');
      if (!decode(text)) throw new Error('SYNC_INVALID_LOCAL_DATA');
      const selected = Object.values(snapshot.products).filter(product =>
        product.present?.[2] && product.selected?.[2] && product.name);
      const preview = selected.map(product =>
        (product.bought?.[2] ? '✓ ' : '☐ ') + product.name[2].replace(/\s+/g, ' ').trim());
      const id = await transport.publishPurchases(text, preview.length ? preview
        : [globalThis.translateShoppingList?.('The list is empty') ?? 'The list is empty']);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('SYNC_SEND_UNCONFIRMED');
      observed.set(id, { snapshot, owned: true });
      remote = merge(remote, snapshot);
      await read();
      snapshot = pruneGroups(compactRemoved(collapseDuplicates(remote, actor)));
      keep = covering();
    }

    const removable = keep ? [...observed].flatMap(([id, candidate]) =>
      id !== keep[0] && candidate.owned && coversPurchases(keep[1].snapshot, candidate.snapshot) ? [id] : []) : [];
    return {
      snapshot,
      async cleanUp() {
        if (!keep) return false;
        if (!removable.length) return true;
        return await transport.remove(removable, keep[0]) === removable.length;
      }
    };
  }

  const plainEmpty = { categories: [], products: [] };
  globalThis.ShoppingTelegramSync = Object.freeze({
    project, applyToLocal, rememberRemovals, applyChanges, materialize, reconcile
  });
})();

(() => {
  'use strict';

  const SCHEMA_VERSION = 2;
  const DEFAULT_COLORS = Object.freeze([
    '#65C18C', '#5DA9E9', '#F4A261', '#C58AF9', '#E76F8A', '#8B7CFF',
    '#45B7D1', '#E9C46A', '#F28482', '#78C6A3', '#A3A380', '#FF8FAB'
  ]);
  const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

  class DomainError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'DomainError';
      this.code = code;
    }
  }

  function clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function makeId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeName(value, fallback = '') {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || fallback;
  }

  function isHexColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value ?? ''));
  }

  function normalizeColor(value, fallback) {
    return isHexColor(value) ? String(value).toUpperCase() : fallback;
  }

  function namesEqual(left, right) {
    return collator.compare(normalizeName(left), normalizeName(right)) === 0;
  }

  function createDefaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      categories: [
        { id: 'cat-produce', name: 'Vegetables and fruits', color: '#65C18C' },
        { id: 'cat-dairy', name: 'Dairy', color: '#5DA9E9' },
        { id: 'cat-grocery', name: 'Grocery', color: '#F4A261' },
        { id: 'cat-home', name: 'For home', color: '#C58AF9' }
      ],
      products: [
        { id: 'prd-tomatoes', name: 'Tomatoes', categoryId: 'cat-produce', selected: true, bought: false },
        { id: 'prd-bananas', name: 'Bananas', categoryId: 'cat-produce', selected: false, bought: false },
        { id: 'prd-apples', name: 'Apples', categoryId: 'cat-produce', selected: false, bought: false },
        { id: 'prd-potatoes', name: 'Potato', categoryId: 'cat-produce', selected: false, bought: false },
        { id: 'prd-milk', name: 'Milk', categoryId: 'cat-dairy', selected: true, bought: false },
        { id: 'prd-eggs', name: 'Eggs', categoryId: 'cat-dairy', selected: true, bought: false },
        { id: 'prd-cheese', name: 'Cheese', categoryId: 'cat-dairy', selected: false, bought: false },
        { id: 'prd-yogurt', name: 'Yogurt', categoryId: 'cat-dairy', selected: false, bought: false },
        { id: 'prd-bread', name: 'Bread', categoryId: 'cat-grocery', selected: true, bought: false },
        { id: 'prd-rice', name: 'Rice', categoryId: 'cat-grocery', selected: false, bought: false },
        { id: 'prd-pasta', name: 'Pasta', categoryId: 'cat-grocery', selected: false, bought: false },
        { id: 'prd-coffee', name: 'Coffee', categoryId: 'cat-grocery', selected: false, bought: false },
        { id: 'prd-bags', name: 'Garbage bags', categoryId: 'cat-home', selected: false, bought: false },
        { id: 'prd-paper', name: 'Paper towels', categoryId: 'cat-home', selected: false, bought: false },
        { id: 'prd-dishsoap', name: 'Dish detergent', categoryId: 'cat-home', selected: false, bought: false }
      ],
      settings: {
        checkboxesRight: true,
        theme: 'dark'
      },
      updatedAt: null
    };
  }

  function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return createDefaultState();

    const sourceCategories = Array.isArray(raw.categories) ? [...raw.categories] : [];
    if (Number(raw.schemaVersion) < 2) {
      sourceCategories.sort((a, b) => {
        const left = Number.isFinite(a?.order) ? a.order : Number.MAX_SAFE_INTEGER;
        const right = Number.isFinite(b?.order) ? b.order : Number.MAX_SAFE_INTEGER;
        return left - right;
      });
    }

    const categoryIds = new Set();
    const categories = [];
    sourceCategories.forEach((source, index) => {
      if (!source || typeof source !== 'object') return;
      let id = normalizeName(source.id);
      if (!id || categoryIds.has(id)) id = makeId('cat');
      categoryIds.add(id);
      const baseName = normalizeName(source.name, `Category ${categories.length + 1}`);
      let name = baseName;
      let suffix = 2;
      while (categories.some(category => namesEqual(category.name, name))) name = `${baseName} (${suffix++})`;
      categories.push({
        id,
        name,
        color: normalizeColor(source.color, DEFAULT_COLORS[index % DEFAULT_COLORS.length])
      });
    });

    const sourceProducts = Array.isArray(raw.products) ? raw.products : [];
    if (categories.length === 0 && sourceProducts.length > 0) {
      const recoveredId = makeId('cat-recovered');
      categories.push({ id: recoveredId, name: 'Uncategorized', color: DEFAULT_COLORS[0] });
      categoryIds.add(recoveredId);
    }

    const fallbackCategoryId = categories[0]?.id ?? null;
    const productIds = new Set();
    const products = [];
    sourceProducts.forEach(source => {
      if (!source || typeof source !== 'object' || fallbackCategoryId === null) return;
      const name = normalizeName(source.name);
      if (!name) return;
      let id = normalizeName(source.id);
      if (!id || productIds.has(id)) id = makeId('prd');
      productIds.add(id);
      const categoryId = categoryIds.has(source.categoryId) ? source.categoryId : fallbackCategoryId;
      const selected = Boolean(source.selected);
      const baseName = name;
      let uniqueName = baseName;
      let suffix = 2;
      while (products.some(product => product.categoryId === categoryId && namesEqual(product.name, uniqueName))) {
        uniqueName = `${baseName} (${suffix++})`;
      }
      products.push({
        id,
        name: uniqueName,
        categoryId,
        selected,
        bought: selected && Boolean(source.bought)
      });
    });

    const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const checkboxesRight = typeof settings.checkboxesRight === 'boolean'
      ? settings.checkboxesRight
      : settings.checkboxSide !== 'left';

    return {
      schemaVersion: SCHEMA_VERSION,
      categories,
      products,
      settings: {
        checkboxesRight,
        theme: settings.theme === 'light' ? 'light' : 'dark'
      },
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
    };
  }

  function withTimestamp(state) {
    return { ...state, updatedAt: new Date().toISOString() };
  }

  function categoryById(state, categoryId) {
    return state.categories.find(category => category.id === categoryId) ?? null;
  }

  function productById(state, productId) {
    return state.products.find(product => product.id === productId) ?? null;
  }

  function productsForCategory(state, categoryId, selectedOnly = false) {
    return state.products
      .filter(product => product.categoryId === categoryId && (!selectedOnly || product.selected))
      .sort((a, b) => collator.compare(a.name, b.name));
  }

  function selectedProducts(state) {
    return state.products.filter(product => product.selected);
  }

  function boughtProducts(state) {
    return state.products.filter(product => product.selected && product.bought);
  }

  function duplicateCategory(state, name, exceptId = null) {
    return state.categories.some(category => category.id !== exceptId && namesEqual(category.name, name));
  }

  function duplicateProduct(state, categoryId, name, exceptId = null) {
    return state.products.some(product =>
      product.id !== exceptId && product.categoryId === categoryId && namesEqual(product.name, name)
    );
  }

  function requireName(value, emptyMessage) {
    const name = normalizeName(value);
    if (!name) throw new DomainError('empty_name', emptyMessage);
    return name;
  }

  function addCategory(state, payload) {
    const name = requireName(payload?.name, 'Enter category name');
    if (duplicateCategory(state, name)) throw new DomainError('duplicate_category', 'There is already a category with this name');
    const color = normalizeColor(payload?.color, DEFAULT_COLORS[state.categories.length % DEFAULT_COLORS.length]);
    return withTimestamp({
      ...state,
      categories: [...state.categories, { id: makeId('cat'), name, color }]
    });
  }

  function renameCategory(state, categoryId, nextName) {
    const category = categoryById(state, categoryId);
    if (!category) throw new DomainError('category_not_found', 'Category not found');
    const name = requireName(nextName, 'Enter category name');
    if (duplicateCategory(state, name, categoryId)) throw new DomainError('duplicate_category', 'There is already a category with this name');
    return withTimestamp({
      ...state,
      categories: state.categories.map(item => item.id === categoryId ? { ...item, name } : item)
    });
  }

  function setCategoryColor(state, categoryId, nextColor) {
    const category = categoryById(state, categoryId);
    if (!category) throw new DomainError('category_not_found', 'Category not found');
    const color = normalizeColor(nextColor, category.color);
    return withTimestamp({
      ...state,
      categories: state.categories.map(item => item.id === categoryId ? { ...item, color } : item)
    });
  }

  function deleteCategory(state, categoryId) {
    if (!categoryById(state, categoryId)) throw new DomainError('category_not_found', 'Category not found');
    return withTimestamp({
      ...state,
      categories: state.categories.filter(category => category.id !== categoryId),
      products: state.products.filter(product => product.categoryId !== categoryId)
    });
  }

  function moveCategory(state, categoryId, direction) {
    const index = state.categories.findIndex(category => category.id === categoryId);
    if (index < 0) throw new DomainError('category_not_found', 'Category not found');
    const nextIndex = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : index;
    if (nextIndex < 0 || nextIndex >= state.categories.length || nextIndex === index) return state;
    const categories = [...state.categories];
    [categories[index], categories[nextIndex]] = [categories[nextIndex], categories[index]];
    return withTimestamp({ ...state, categories });
  }

  function addProduct(state, payload) {
    const name = requireName(payload?.name, 'Enter the product name');
    const categoryId = normalizeName(payload?.categoryId);
    if (!categoryById(state, categoryId)) throw new DomainError('category_not_found', 'Selected category not found');
    if (duplicateProduct(state, categoryId, name)) throw new DomainError('duplicate_product', 'There is already such a product in this category');
    return withTimestamp({
      ...state,
      products: [...state.products, {
        id: makeId('prd'),
        name,
        categoryId,
        selected: false,
        bought: false
      }]
    });
  }

  function renameProduct(state, productId, nextName) {
    const product = productById(state, productId);
    if (!product) throw new DomainError('product_not_found', 'Product not found');
    const name = requireName(nextName, 'Enter the product name');
    if (duplicateProduct(state, product.categoryId, name, productId)) {
      throw new DomainError('duplicate_product', 'There is already such a product in this category');
    }
    return withTimestamp({
      ...state,
      products: state.products.map(item => item.id === productId ? { ...item, name } : item)
    });
  }

  function moveProduct(state, productId, categoryId) {
    const product = productById(state, productId);
    if (!product) throw new DomainError('product_not_found', 'Product not found');
    if (!categoryById(state, categoryId)) throw new DomainError('category_not_found', 'Selected category not found');
    if (categoryId === product.categoryId) return state;
    if (duplicateProduct(state, categoryId, product.name, productId)) {
      throw new DomainError('duplicate_product', 'There is already a product with the same name in the selected category');
    }
    return withTimestamp({
      ...state,
      products: state.products.map(item => item.id === productId ? { ...item, categoryId } : item)
    });
  }

  function deleteProduct(state, productId) {
    if (!productById(state, productId)) throw new DomainError('product_not_found', 'Product not found');
    return withTimestamp({ ...state, products: state.products.filter(product => product.id !== productId) });
  }

  function setProductSelected(state, productId, selected) {
    if (!productById(state, productId)) throw new DomainError('product_not_found', 'Product not found');
    return withTimestamp({
      ...state,
      products: state.products.map(product => product.id === productId
        ? { ...product, selected: Boolean(selected), bought: Boolean(selected) ? product.bought : false }
        : product)
    });
  }

  function setProductBought(state, productId, bought) {
    const product = productById(state, productId);
    if (!product) throw new DomainError('product_not_found', 'Product not found');
    if (!product.selected) return state;
    return withTimestamp({
      ...state,
      products: state.products.map(item => item.id === productId ? { ...item, bought: Boolean(bought) } : item)
    });
  }

  function resetBought(state) {
    if (!state.products.some(product => product.bought)) return state;
    return withTimestamp({
      ...state,
      products: state.products.map(product => product.bought ? { ...product, bought: false } : product)
    });
  }

  function updateSettings(state, patch) {
    const settings = {
      checkboxesRight: typeof patch?.checkboxesRight === 'boolean' ? patch.checkboxesRight : state.settings.checkboxesRight,
      theme: patch?.theme === 'light' ? 'light' : patch?.theme === 'dark' ? 'dark' : state.settings.theme
    };
    if (settings.checkboxesRight === state.settings.checkboxesRight && settings.theme === state.settings.theme) return state;
    return withTimestamp({ ...state, settings });
  }

  function validateState(state) {
    const issues = [];
    const categoryIds = new Set();
    const categoryNames = [];
    state.categories.forEach(category => {
      if (categoryIds.has(category.id)) issues.push(`duplicate category id: ${category.id}`);
      categoryIds.add(category.id);
      if (!normalizeName(category.name)) issues.push(`empty category name: ${category.id}`);
      if (categoryNames.some(name => namesEqual(name, category.name))) issues.push(`duplicate category name: ${category.name}`);
      categoryNames.push(category.name);
      if (!isHexColor(category.color)) issues.push(`invalid category color: ${category.id}`);
    });
    const productIds = new Set();
    const productNamesByCategory = new Map();
    state.products.forEach(product => {
      if (productIds.has(product.id)) issues.push(`duplicate product id: ${product.id}`);
      productIds.add(product.id);
      if (!categoryIds.has(product.categoryId)) issues.push(`orphan product: ${product.id}`);
      const names = productNamesByCategory.get(product.categoryId) ?? [];
      if (names.some(name => namesEqual(name, product.name))) issues.push(`duplicate product name: ${product.name}`);
      names.push(product.name);
      productNamesByCategory.set(product.categoryId, names);
      if (product.bought && !product.selected) issues.push(`bought product is not selected: ${product.id}`);
    });
    return issues;
  }

  globalThis.ShoppingModel = Object.freeze({
    SCHEMA_VERSION,
    DEFAULT_COLORS,
    DomainError,
    clone,
    createDefaultState,
    migrateState,
    normalizeName,
    isHexColor,
    namesEqual,
    categoryById,
    productById,
    productsForCategory,
    selectedProducts,
    boughtProducts,
    addCategory,
    renameCategory,
    setCategoryColor,
    deleteCategory,
    moveCategory,
    addProduct,
    renameProduct,
    moveProduct,
    deleteProduct,
    setProductSelected,
    setProductBought,
    resetBought,
    updateSettings,
    validateState
  });
})();

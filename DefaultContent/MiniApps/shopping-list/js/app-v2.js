(() => {
  'use strict';

  const M = globalThis.ShoppingModel;
  if (!M) throw new Error('ShoppingModel is not loaded');

  const STORAGE_KEY = 'shoppingListState';
  const ICONS = Object.freeze({
    add: '<path d="M12 5v14M5 12h14"></path>',
    category: '<path d="M4 7h7v7H4zM13 7h7v7h-7zM4 16h7v4H4z"></path><path d="M16.5 16v4M14.5 18h4"></path>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-3v-.08a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.03H5v-3h.44A1.7 1.7 0 0 0 7 9.94a1.7 1.7 0 0 0-.34-1.88L6.6 8l2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.69 4.7V4h3v.7a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.78 8l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.94 11H21v3h-.06A1.7 1.7 0 0 0 19.4 15Z"></path>',
    reset: '<path d="M4 4v6h6"></path><path d="M5.6 15a7 7 0 1 0 .7-7.8L4 10"></path>',
    delete: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path>',
    rename: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path>',
    move: '<path d="M4 7h7v7H4zM13 7h7v7h-7zM4 16h7v4H4z"></path><path d="m14 18 2 2 4-4"></path>',
    color: '<path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-.7a1.7 1.7 0 0 1 0-3.4H15a6 6 0 0 0 0-12h-3Z"></path><circle cx="7.5" cy="10" r="1"></circle><circle cx="10" cy="6.8" r="1"></circle><circle cx="15" cy="7.2" r="1"></circle>'
  });

  const elements = {
    header: document.getElementById('appHeader'),
    title: document.getElementById('screenTitle'),
    subtitle: document.getElementById('screenSubtitle'),
    headerMenuButton: document.getElementById('headerMenuButton'),
    content: document.getElementById('content'),
    bottomTabs: document.getElementById('bottomTabs'),
    mainMenu: document.getElementById('mainMenu'),
    itemMenu: document.getElementById('itemMenu'),
    modalBackdrop: document.getElementById('modalBackdrop'),
    modalSheet: document.getElementById('modalSheet'),
    modalEyebrow: document.getElementById('modalEyebrow'),
    modalTitle: document.getElementById('modalTitle'),
    modalForm: document.getElementById('modalForm'),
    toast: document.getElementById('toast'),
    themeColor: document.querySelector('meta[name="theme-color"]')
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function svg(path) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  }

  function pluralizeProducts(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'product';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'goods';
    return 'goods';
  }

  function colorToRgb(hex) {
    const value = M.isHexColor(hex) ? hex.slice(1) : '8B7CFF';
    return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
  }

  function categoryStyle(color) {
    const [r, g, b] = colorToRgb(color);
    return `--category-color:${escapeHtml(color)};--category-rgb:${r},${g},${b}`;
  }

  class StorageRepository {
    constructor(key) {
      this.key = key;
      this.pendingSnapshot = null;
      this.flushPromise = null;
      this.lastError = null;
    }

    async load() {
      if (globalThis.mini?.storage?.public) {
        return await mini.storage.public.get(this.key);
      }
      const value = localStorage.getItem(this.key);
      return value ? JSON.parse(value) : null;
    }

    save(state) {
      this.pendingSnapshot = M.clone(state);
      if (!this.flushPromise) this.flushPromise = this.flush();
      return this.flushPromise;
    }

    async flush() {
      try {
        while (this.pendingSnapshot) {
          const snapshot = this.pendingSnapshot;
          this.pendingSnapshot = null;
          if (globalThis.mini?.storage?.public) {
            await mini.storage.public.set(this.key, snapshot);
          } else {
            localStorage.setItem(this.key, JSON.stringify(snapshot));
          }
        }
        this.lastError = null;
      } catch (error) {
        this.lastError = error;
        throw error;
      } finally {
        this.flushPromise = null;
        if (this.pendingSnapshot) this.flushPromise = this.flush();
      }
    }
  }

  class RuntimeAdapter {
    constructor(onAction, getViewState) {
      this.onAction = onAction;
      this.getViewState = getViewState;
      this.syncTimer = null;
      this.nativeTopBar = false;
      this.lastSignature = '';
      this.unsubscribers = [];
    }

    async init() {
      try { await globalThis.mini?.app?.setWindowTitle?.('Shopping list'); } catch (error) { console.warn(error); }
      const on = globalThis.mini?.events?.on;
      if (typeof on === 'function') {
        this.unsubscribers.push(on('ui.topBarAction', actionId => this.onAction(actionId)));
        this.unsubscribers.push(on('app.resume', () => this.scheduleSync(true)));
      }
      this.scheduleSync(true);
      window.addEventListener('load', () => this.scheduleSync(true), { once: true });
    }

    scheduleSync(force = false) {
      const viewState = this.getViewState();
      const signature = `${viewState.screen}:${viewState.theme}`;
      if (!force && signature === this.lastSignature) return;
      this.lastSignature = signature;
      clearTimeout(this.syncTimer);
      void this.sync();
      this.syncTimer = setTimeout(() => { void this.sync(); }, 450);
    }

    async sync() {
      if (!globalThis.mini?.ui?.setTopBar) {
        this.setNativeTopBar(false);
        return false;
      }
      const viewState = this.getViewState();
      const light = viewState.theme === 'light';
      try {
        await mini.ui.setTopBar({
          visible: true,
          height: 60,
          title: viewState.screen === 'settings' ? 'Settings' : 'Shopping list',
          background: light ? '#F7F8FC' : '#151927',
          foreground: light ? '#171A22' : '#F7F8FB',
          accent: '#5271FF',
          paddingX: 14,
          paddingY: 10,
          titleFontSize: 11,
          showBack: true,
          backText: '← Back',
          backButton: {
            radius: 20,
            paddingX: 16,
            background: '#5271FF',
            hoverBackground: '#6B86FF',
            foreground: '#FFFFFF',
            border: '#8DA2FF',
            borderOpacity: 90,
            fontSize: 9.5
          },
          actions: viewState.screen === 'settings'
            ? [{ id: 'settings-back', label: 'Ready', accent: false }]
            : [{ id: 'app-menu', label: '⋮', accent: false }]
        });
        this.setNativeTopBar(true);
        return true;
      } catch (error) {
        console.warn('Native top bar is unavailable:', error);
        this.setNativeTopBar(false);
        return false;
      }
    }

    setNativeTopBar(enabled) {
      this.nativeTopBar = enabled;
      document.body.classList.toggle('has-native-menu', enabled);
    }
  }

  class ShoppingApplication {
    constructor() {
      this.repository = new StorageRepository(STORAGE_KEY);
      this.state = M.createDefaultState();
      this.view = { screen: 'main', tab: 'shopping' };
      this.runtime = new RuntimeAdapter(
        actionId => this.handleRuntimeAction(actionId),
        () => ({ screen: this.view.screen, theme: this.state.settings.theme })
      );
      this.modal = null;
      this.lastModalFocus = null;
      this.lastMenuFocus = null;
      this.toastTimer = null;
    }

    async init() {
      this.bindGlobalEvents();
      try {
        this.state = M.migrateState(await this.repository.load());
      } catch (error) {
        console.error('State load failed:', error);
        this.state = M.createDefaultState();
        this.showToast('Failed to read saved list', true);
      }
      const issues = M.validateState(this.state);
      if (issues.length) console.warn('State was normalized:', issues);
      this.view = { screen: 'main', tab: 'shopping' };
      this.applyPreferences();
      this.render();
      await this.runtime.init();
    }

    bindGlobalEvents() {
      document.addEventListener('click', event => this.onClick(event));
      document.addEventListener('change', event => this.onChange(event));
      elements.modalForm.addEventListener('submit', event => this.onModalSubmit(event));
      document.addEventListener('keydown', event => this.onKeyDown(event));
      window.addEventListener('resize', () => this.closeMenus());
      window.addEventListener('scroll', () => this.closeMenus(), { passive: true });
      globalThis.mini?.events?.on?.('app.pause', () => { void this.repository.save(this.state); });
      globalThis.mini?.events?.on?.('app.destroy', () => { void this.repository.save(this.state); });
    }

    async commit(nextState, message = '') {
      if (nextState === this.state) return false;
      this.state = nextState;
      this.applyPreferences();
      this.render({ preserveScroll: true });
      try {
        await this.repository.save(this.state);
        if (message) this.showToast(message);
      } catch (error) {
        console.error('State save failed:', error);
        this.showToast('The change was not written to storage.json', true);
      }
      return true;
    }

    applyPreferences() {
      const theme = this.state.settings.theme === 'light' ? 'light' : 'dark';
      const side = this.state.settings.checkboxesRight ? 'right' : 'left';
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.checkboxSide = side;
      elements.themeColor.setAttribute('content', theme === 'light' ? '#F4F6FB' : '#0B0D12');
    }

    render(options = {}) {
      const scrollY = options.preserveScroll ? window.scrollY : null;
      this.closeMenus(false);
      const settings = this.view.screen === 'settings';
      document.body.classList.toggle('settings-view', settings);
      elements.bottomTabs.hidden = settings;
      elements.headerMenuButton.hidden = settings;

      if (settings) {
        elements.title.textContent = 'Settings';
        elements.subtitle.textContent = 'Appearance and arrangement of elements';
        elements.content.innerHTML = this.renderSettings();
      } else {
        const shopping = this.view.tab === 'shopping';
        const selectedCount = M.selectedProducts(this.state).length;
        const boughtCount = M.boughtProducts(this.state).length;
        elements.title.textContent = shopping ? 'Purchases' : 'Goods';
        elements.subtitle.textContent = shopping
          ? selectedCount ? `${boughtCount} from ${selectedCount} has already been taken` : 'The list is still empty'
          : `${this.state.products.length} products · ${this.state.categories.length} categories`;
        elements.bottomTabs.querySelectorAll('[data-tab]').forEach(button => {
          const active = button.dataset.tab === this.view.tab;
          button.classList.toggle('is-active', active);
          if (active) button.setAttribute('aria-current', 'page');
          else button.removeAttribute('aria-current');
        });
        elements.content.innerHTML = shopping ? this.renderShopping() : this.renderProducts();
      }

      if (scrollY !== null) requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
      this.runtime.scheduleSync();
    }

    renderShopping() {
      const selected = M.selectedProducts(this.state);
      if (!selected.length) return this.emptyState('shopping');
      const cards = this.state.categories.map(category => {
        const products = M.productsForCategory(this.state, category.id, true);
        if (!products.length) return '';
        const bought = products.filter(product => product.bought).length;
        return this.renderCategoryCard(category, products, 'shopping', `${bought} from ${products.length} taken`);
      }).join('');
      return `<div class="category-list">${cards}</div>`;
    }

    renderProducts() {
      if (!this.state.categories.length) return this.emptyState('categories');
      const cards = this.state.categories.map((category, index) => {
        const products = M.productsForCategory(this.state, category.id);
        const selected = products.filter(product => product.selected).length;
        const meta = products.length ? `${selected} from ${products.length} in the list` : 'No products';
        return this.renderCategoryCard(category, products, 'products', meta, index);
      }).join('');
      return `<div class="category-list">${cards}</div>`;
    }

    renderSettings() {
      const right = this.state.settings.checkboxesRight;
      const theme = this.state.settings.theme;
      return `<div class="settings-page">
          <button class="settings-back-button" type="button" data-action="settings-back">
            ${svg('<path d="m14.5 6-6 6 6 6"></path>')}<span>Back to products</span>
          </button>
          <section class="settings-card" aria-labelledby="layoutSettingsTitle">
            <div class="settings-card-header"><p class="settings-eyebrow">Layout</p><h2 id="layoutSettingsTitle">List Items</h2></div>
            <label class="settings-row" for="checkboxSideToggle">
              <span class="settings-row-copy"><strong>Checkboxes on the right side</strong><small>Turn off to return the checkboxes on the left.</small></span>
              <span class="toggle-switch"><input id="checkboxSideToggle" data-setting="checkbox-side" type="checkbox" ${right ? 'checked' : ''}><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span></span>
            </label>
          </section>
          <section class="settings-card" aria-labelledby="themeSettingsTitle">
            <div class="settings-card-header"><p class="settings-eyebrow">Design</p><h2 id="themeSettingsTitle">Application theme</h2></div>
            <div class="theme-choice" role="group" aria-label="App Theme">
              <button class="theme-choice-button${theme === 'dark' ? ' is-active' : ''}" type="button" data-action="set-theme" data-theme="dark" aria-pressed="${theme === 'dark'}">
                ${svg('<path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"></path>')}<span>Dark</span>
              </button>
              <button class="theme-choice-button${theme === 'light' ? ' is-active' : ''}" type="button" data-action="set-theme" data-theme="light" aria-pressed="${theme === 'light'}">
                ${svg('<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>')}<span>Light</span>
              </button>
            </div>
            <p class="settings-note">Default is dark theme.</p>
          </section>
        </div>`;
    }

    emptyState(kind) {
      if (kind === 'shopping') {
        return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${svg('<path d="M3.5 5.5h2l1.7 9.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.4l1.8-6.3H7"></path><path d="M9 20h.01M17 20h.01"></path>')}</div><h2>The list is empty</h2><p>Open “Products” and check the boxes for what you want to buy.</p><button class="primary-inline-button" type="button" data-action="change-tab" data-tab="products">Select products</button></div></div>`;
      }
      return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${svg('<path d="M4 7h16M4 12h16M4 17h10"></path><path d="M18 15v6M15 18h6"></path>')}</div><h2>No categories</h2><p>Create the first category, and then add products to it.</p><button class="primary-inline-button" type="button" data-action="open-modal" data-modal="add-category">Create category</button></div></div>`;
    }

    renderCategoryCard(category, products, mode, meta, index = -1) {
      const tools = mode === 'products' ? this.renderCategoryTools(category, index) : '';
      const rows = products.length
        ? products.map(product => this.renderProductRow(product, category, mode)).join('')
        : '<div class="empty-category">Add the first product here via the menu ⋮</div>';
      return `<section class="category-card" data-category-id="${escapeHtml(category.id)}" style="${categoryStyle(category.color)}"><header class="category-header"><span class="category-dot" aria-hidden="true"></span><div class="category-meta"><h2 class="category-name">${escapeHtml(category.name)}</h2><p class="category-count">${escapeHtml(meta)}</p></div>${tools}</header><div class="product-list">${rows}</div></section>`;
    }

    renderCategoryTools(category, index) {
      const top = index <= 0;
      const bottom = index >= this.state.categories.length - 1;
      return `<div class="category-tools"><button class="item-menu-button" type="button" data-action="open-item-menu" data-kind="category" data-id="${escapeHtml(category.id)}" aria-label="Edit category ${escapeHtml(category.name)}" aria-haspopup="menu" aria-expanded="false">${svg('<circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="12" cy="19" r="1.7"></circle>')}</button><div class="category-order-controls" aria-label="Category order ${escapeHtml(category.name)}"><button class="category-order-button" type="button" data-action="move-category" data-id="${escapeHtml(category.id)}" data-direction="up" aria-label="Move category higher" ${top ? 'disabled' : ''}>${svg('<path d="M6.5 14.5 12 9l5.5 5.5"></path>')}</button><button class="category-order-button" type="button" data-action="move-category" data-id="${escapeHtml(category.id)}" data-direction="down" aria-label="Move category lower" ${bottom ? 'disabled' : ''}>${svg('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"></path>')}</button></div></div>`;
    }

    renderProductRow(product, category, mode) {
      const checked = mode === 'shopping' ? product.bought : product.selected;
      const rowClass = mode === 'shopping' && product.bought ? ' is-bought' : '';
      const checkboxId = `product-${mode}-${product.id}`;
      const label = mode === 'shopping'
        ? `Mark "${product.name}" as taken`
        : `${product.selected ? 'Put away' : 'Add'} "${product.name}" ${product.selected ? 'from' : 'V'} shopping list`;
      const checkbox = `<label class="checkbox-wrap" for="${escapeHtml(checkboxId)}" style="${categoryStyle(category.color)}"><input id="${escapeHtml(checkboxId)}" type="checkbox" data-product-toggle data-id="${escapeHtml(product.id)}" data-mode="${mode}" ${checked ? 'checked' : ''} aria-label="${escapeHtml(label)}"><span class="custom-checkbox">${svg('<path d="M5.5 12.5l4 4L18.8 7"></path>')}</span></label>`;
      if (mode === 'shopping') {
        return `<div class="product-row shopping-product-row${rowClass}" data-product-id="${escapeHtml(product.id)}"><label class="product-title" for="${escapeHtml(checkboxId)}">${escapeHtml(product.name)}</label>${checkbox}</div>`;
      }
      return `<div class="product-row editable-product-row" data-product-id="${escapeHtml(product.id)}"><label class="product-title" for="${escapeHtml(checkboxId)}">${escapeHtml(product.name)}</label><button class="item-menu-button" type="button" data-action="open-item-menu" data-kind="product" data-id="${escapeHtml(product.id)}" aria-label="Edit product ${escapeHtml(product.name)}" aria-haspopup="menu" aria-expanded="false">${svg('<circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="12" cy="19" r="1.7"></circle>')}</button>${checkbox}</div>`;
    }

    onClick(event) {
      const actionTarget = event.target.closest('[data-action]');
      if (!actionTarget) {
        if (!event.target.closest('#mainMenu') && !event.target.closest('#itemMenu') && !event.target.closest('#headerMenuButton')) this.closeMenus();
        return;
      }
      const action = actionTarget.dataset.action;
      if (action === 'change-tab') this.changeTab(actionTarget.dataset.tab);
      else if (action === 'open-main-menu') this.toggleMainMenu(actionTarget);
      else if (action === 'open-item-menu') this.toggleItemMenu(actionTarget);
      else if (action === 'main-menu-item') this.handleMainMenuAction(actionTarget.dataset.menuAction);
      else if (action === 'item-menu-item') this.handleItemMenuAction(actionTarget.dataset.kind, actionTarget.dataset.id, actionTarget.dataset.itemAction);
      else if (action === 'move-category') void this.moveCategory(actionTarget.dataset.id, actionTarget.dataset.direction);
      else if (action === 'open-modal') this.openModal(actionTarget.dataset.modal, actionTarget.dataset.id ?? null);
      else if (action === 'close-modal') this.closeModal();
      else if (action === 'settings-back') this.closeSettings();
      else if (action === 'set-theme') void this.setTheme(actionTarget.dataset.theme);
    }

    onChange(event) {
      const productToggle = event.target.closest('[data-product-toggle]');
      if (productToggle) {
        const next = productToggle.dataset.mode === 'shopping'
          ? M.setProductBought(this.state, productToggle.dataset.id, productToggle.checked)
          : M.setProductSelected(this.state, productToggle.dataset.id, productToggle.checked);
        void this.commit(next);
        return;
      }
      if (event.target.matches('[data-setting="checkbox-side"]')) {
        const right = event.target.checked;
        void this.commit(M.updateSettings(this.state, { checkboxesRight: right }), right ? 'Checkboxes moved to the right' : 'Checkboxes moved to the left');
      }
      if (event.target.matches('[data-color-radio], [data-color-custom]')) this.updateColorPreview(event.target);
    }

    onKeyDown(event) {
      if (event.key === 'Escape') {
        if (!elements.modalBackdrop.hidden) this.closeModal();
        else this.closeMenus();
        return;
      }
      if (event.key === 'Tab' && !elements.modalBackdrop.hidden) this.trapModalFocus(event);
    }

    handleRuntimeAction(actionId) {
      if (actionId === 'settings-back') this.closeSettings();
      if (actionId === 'app-menu' && this.view.screen === 'main') this.toggleMainMenu(null);
    }

    changeTab(tab) {
      if (!['shopping', 'products'].includes(tab)) return;
      this.view = { screen: 'main', tab };
      this.render();
    }

    closeSettings() {
      this.view = { screen: 'main', tab: 'products' };
      this.render();
    }

    async setTheme(theme) {
      const nextTheme = theme === 'light' ? 'light' : 'dark';
      await this.commit(M.updateSettings(this.state, { theme: nextTheme }), nextTheme === 'light' ? 'Light theme included' : 'Dark theme enabled');
    }

    toggleMainMenu(anchor) {
      if (!elements.mainMenu.hidden) { this.closeMenus(); return; }
      this.closeMenus(false);
      this.lastMenuFocus = anchor ?? document.activeElement;
      const shopping = this.view.tab === 'shopping';
      const items = shopping
        ? [{ action: 'reset', label: 'Reset marks', icon: ICONS.reset, danger: true, disabled: M.boughtProducts(this.state).length === 0 }]
        : [
            { action: 'add-product', label: 'Add product', icon: ICONS.add },
            { action: 'add-category', label: 'Create a category', icon: ICONS.category },
            { separator: true },
            { action: 'settings', label: 'Settings', icon: ICONS.settings }
          ];
      elements.mainMenu.innerHTML = this.renderMenuItems(items, 'main');
      elements.mainMenu.hidden = false;
      elements.headerMenuButton.setAttribute('aria-expanded', 'true');
      this.positionMenu(elements.mainMenu, anchor);
      elements.mainMenu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    }

    toggleItemMenu(anchor) {
      if (!elements.itemMenu.hidden && anchor.getAttribute('aria-expanded') === 'true') { this.closeMenus(); return; }
      this.closeMenus(false);
      this.lastMenuFocus = anchor;
      const kind = anchor.dataset.kind;
      const id = anchor.dataset.id;
      const items = kind === 'product'
        ? [
            { action: 'delete', label: 'Delete', icon: ICONS.delete, danger: true },
            { action: 'rename', label: 'Rename', icon: ICONS.rename },
            { action: 'move', label: 'Change category', icon: ICONS.move }
          ]
        : [
            { action: 'delete', label: 'Delete', icon: ICONS.delete, danger: true },
            { action: 'rename', label: 'Rename', icon: ICONS.rename },
            { action: 'color', label: 'Change color', icon: ICONS.color }
          ];
      elements.itemMenu.innerHTML = this.renderMenuItems(items, 'item', kind, id);
      elements.itemMenu.hidden = false;
      anchor.setAttribute('aria-expanded', 'true');
      this.positionMenu(elements.itemMenu, anchor);
      elements.itemMenu.querySelector('[role="menuitem"]')?.focus();
    }

    renderMenuItems(items, scope, kind = '', id = '') {
      return items.map(item => item.separator
        ? '<div class="menu-separator" role="separator"></div>'
        : `<button class="menu-item${item.danger ? ' danger' : ''}" type="button" role="menuitem" data-action="${scope === 'main' ? 'main-menu-item' : 'item-menu-item'}" ${scope === 'main' ? `data-menu-action="${escapeHtml(item.action)}"` : `data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(id)}" data-item-action="${escapeHtml(item.action)}"`} ${item.disabled ? 'disabled' : ''}>${svg(item.icon)}<span>${escapeHtml(item.label)}</span></button>`
      ).join('');
    }

    positionMenu(menu, anchor) {
      menu.style.left = '';
      menu.style.right = '';
      menu.style.top = '';
      const edge = 10;
      if (!anchor || !anchor.isConnected || anchor.hidden) {
        menu.style.right = `${edge}px`;
        menu.style.top = `${edge}px`;
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      let left = Math.min(Math.max(edge, rect.right - menuRect.width), window.innerWidth - menuRect.width - edge);
      let top = rect.bottom + 7;
      if (top + menuRect.height > window.innerHeight - edge) top = Math.max(edge, rect.top - menuRect.height - 7);
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    }

    closeMenus(restoreFocus = true) {
      elements.mainMenu.hidden = true;
      elements.itemMenu.hidden = true;
      elements.headerMenuButton.setAttribute('aria-expanded', 'false');
      document.querySelectorAll('[data-action="open-item-menu"][aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      if (restoreFocus && this.lastMenuFocus instanceof HTMLElement && this.lastMenuFocus.isConnected) this.lastMenuFocus.focus({ preventScroll: true });
      this.lastMenuFocus = null;
    }

    handleMainMenuAction(action) {
      this.closeMenus(false);
      if (action === 'reset') void this.commit(M.resetBought(this.state), 'All "accepted" marks are cleared');
      if (action === 'add-product') this.openModal('add-product');
      if (action === 'add-category') this.openModal('add-category');
      if (action === 'settings') { this.view = { screen: 'settings', tab: 'products' }; this.render(); }
    }

    handleItemMenuAction(kind, id, action) {
      this.closeMenus(false);
      const modal = kind === 'product'
        ? { delete: 'delete-product', rename: 'rename-product', move: 'move-product' }[action]
        : { delete: 'delete-category', rename: 'rename-category', color: 'color-category' }[action];
      if (modal) this.openModal(modal, id);
    }

    async moveCategory(id, direction) {
      await this.commit(M.moveCategory(this.state, id, direction), 'The order of the categories is preserved');
    }

    openModal(type, id = null) {
      this.closeMenus(false);
      if (type === 'add-product' && this.state.categories.length === 0) {
        this.showToast('First create a category', true);
        type = 'add-category';
        id = null;
      }
      const context = this.buildModal(type, id);
      if (!context) return;
      this.modal = { type, id };
      this.lastModalFocus = document.activeElement;
      elements.modalEyebrow.textContent = context.eyebrow;
      elements.modalTitle.textContent = context.title;
      elements.modalForm.dataset.form = type;
      elements.modalForm.dataset.id = id ?? '';
      elements.modalForm.innerHTML = context.html;
      elements.modalBackdrop.hidden = false;
      document.body.classList.add('modal-open');
      requestAnimationFrame(() => elements.modalForm.querySelector('input:not([type="radio"]), select, button[type="submit"]')?.focus());
    }

    buildModal(type, id) {
      if (type === 'add-product') return this.addProductModal();
      if (type === 'add-category') return this.addCategoryModal();
      const product = id ? M.productById(this.state, id) : null;
      const category = id ? M.categoryById(this.state, id) : null;
      if (type.endsWith('product') && !product) { this.showToast('Product not found', true); return null; }
      if (type.endsWith('category') && !category) { this.showToast('Category not found', true); return null; }
      if (type === 'rename-product') return this.renameProductModal(product);
      if (type === 'move-product') return this.moveProductModal(product);
      if (type === 'delete-product') return this.deleteProductModal(product);
      if (type === 'rename-category') return this.renameCategoryModal(category);
      if (type === 'color-category') return this.colorCategoryModal(category);
      if (type === 'delete-category') return this.deleteCategoryModal(category);
      return null;
    }

    addProductModal() {
      return { eyebrow: 'New element', title: 'Add product', html: `${this.textField('productName', 'Product name', '', 'For example, olive oil', 80)}${this.categorySelect('productCategory')}<p class="form-error" data-form-error></p>${this.modalActions('Add')}` };
    }

    addCategoryModal() {
      const color = M.DEFAULT_COLORS[this.state.categories.length % M.DEFAULT_COLORS.length];
      return { eyebrow: 'New group', title: 'Create a category', html: `${this.textField('categoryName', 'Category name', '', 'For example, Freeze', 60)}${this.colorField(color)}<p class="form-error" data-form-error></p>${this.modalActions('Create')}` };
    }

    renameProductModal(product) {
      return { eyebrow: 'Editing a product', title: 'Rename', html: `${this.textField('productName', 'Product name', product.name, '', 80)}<p class="form-error" data-form-error></p>${this.modalActions('Save')}` };
    }

    moveProductModal(product) {
      if (this.state.categories.length < 2) {
        this.showToast('To transfer you need one more category', true);
        return null;
      }
      return { eyebrow: 'Editing a product', title: 'Change category', html: `<div class="form-summary"><strong>${escapeHtml(product.name)}</strong><span>Select a new category for the product.</span></div>${this.categorySelect('productCategory', product.categoryId)}<p class="form-error" data-form-error></p>${this.modalActions('Postpone')}` };
    }

    deleteProductModal(product) {
      return { eyebrow: 'Removing a product', title: 'Delete a product?', html: `${this.deleteWarning(`Product<strong>«${escapeHtml(product.name)}»</strong> will be removed from the catalog and shopping list.`)}${this.modalActions('Delete', true)}` };
    }

    renameCategoryModal(category) {
      return { eyebrow: 'Editing a category', title: 'Rename', html: `${this.textField('categoryName', 'Category name', category.name, '', 60)}<p class="form-error" data-form-error></p>${this.modalActions('Save')}` };
    }

    colorCategoryModal(category) {
      return { eyebrow: 'Editing a category', title: 'Change color', html: `<div class="category-edit-preview" data-color-preview style="${categoryStyle(category.color)}"><span class="category-dot"></span><strong>${escapeHtml(category.name)}</strong></div>${this.colorField(category.color)}<p class="form-error" data-form-error></p>${this.modalActions('Save')}` };
    }

    deleteCategoryModal(category) {
      const products = this.state.products.filter(product => product.categoryId === category.id);
      const selected = products.filter(product => product.selected).length;
      const detail = `${products.length} ${pluralizeProducts(products.length)}${selected ?`, including${selected} from the shopping list` : ''}.`;
      return { eyebrow: 'Delete a category', title: 'Delete category?', html: `${this.deleteWarning(`Category<strong>«${escapeHtml(category.name)}»</strong> will be deleted.<span class="delete-warning-detail">${escapeHtml(detail)}</span>`)}${this.modalActions('Delete everything', true)}` };
    }

    textField(name, label, value = '', placeholder = '', maxlength = 80) {
      return `<div class="form-group"><label class="form-label" for="${name}">${escapeHtml(label)}</label><input class="text-input" id="${name}" name="${name}" type="text" maxlength="${maxlength}" autocomplete="off" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" required></div>`;
    }

    categorySelect(name, selectedId = '') {
      const options = this.state.categories.map(category => `<option value="${escapeHtml(category.id)}" ${category.id === selectedId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
      return `<div class="form-group"><label class="form-label" for="${name}">Category</label><select class="select-input" id="${name}" name="${name}" required>${options}</select></div>`;
    }

    colorField(selectedColor) {
      const radios = M.DEFAULT_COLORS.map(color => `<label class="color-option" title="${color}"><input type="radio" name="categoryColor" data-color-radio value="${color}" ${color.toLowerCase() === selectedColor.toLowerCase() ? 'checked' : ''}><span class="color-swatch" style="--swatch:${color}"></span></label>`).join('');
      return `<div class="form-group"><span class="form-label">Category color</span><div class="color-grid">${radios}</div><label class="custom-color-row"><span>Custom color</span><input name="customColor" data-color-custom type="color" value="${escapeHtml(selectedColor)}" aria-label="Choose your color"></label></div>`;
    }

    deleteWarning(content) {
      return `<div class="delete-warning"><div class="delete-warning-icon">${svg(ICONS.delete)}</div><p>${content}</p></div>`;
    }

    modalActions(label, danger = false) {
      return `<div class="modal-actions"><button class="secondary-button" type="button" data-action="close-modal">Cancel</button><button class="${danger ? 'danger-button' : 'primary-button'}" type="submit">${escapeHtml(label)}</button></div>`;
    }

    closeModal() {
      if (elements.modalBackdrop.hidden) return;
      elements.modalBackdrop.hidden = true;
      document.body.classList.remove('modal-open');
      elements.modalForm.innerHTML = '';
      elements.modalForm.removeAttribute('data-form');
      elements.modalForm.removeAttribute('data-id');
      this.modal = null;
      if (this.lastModalFocus instanceof HTMLElement && this.lastModalFocus.isConnected) this.lastModalFocus.focus({ preventScroll: true });
      this.lastModalFocus = null;
    }

    trapModalFocus(event) {
      const focusable = [...elements.modalSheet.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(node => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    updateColorPreview(target) {
      const form = elements.modalForm;
      const custom = form.elements.customColor;
      if (!custom) return;
      if (target.matches('[data-color-radio]')) custom.value = target.value;
      if (target.matches('[data-color-custom]')) form.querySelectorAll('[data-color-radio]').forEach(input => { input.checked = false; });
      const preview = form.querySelector('[data-color-preview]');
      if (preview) preview.setAttribute('style', categoryStyle(custom.value));
    }

    async onModalSubmit(event) {
      event.preventDefault();
      const type = elements.modalForm.dataset.form;
      const id = elements.modalForm.dataset.id || null;
      const data = new FormData(elements.modalForm);
      try {
        let next = this.state;
        let message = '';
        if (type === 'add-product') {
          next = M.addProduct(this.state, { name: data.get('productName'), categoryId: data.get('productCategory') });
          message = `Product "${M.normalizeName(data.get('productName'))}" added`;
        } else if (type === 'add-category') {
          next = M.addCategory(this.state, { name: data.get('categoryName'), color: data.get('categoryColor') || data.get('customColor') });
          message = `Category "${M.normalizeName(data.get('categoryName'))}" created`;
        } else if (type === 'rename-product') {
          next = M.renameProduct(this.state, id, data.get('productName'));
          message = 'Product name saved';
        } else if (type === 'move-product') {
          const category = M.categoryById(this.state, data.get('productCategory'));
          next = M.moveProduct(this.state, id, data.get('productCategory'));
          message = `Product moved to “${category?.name ?? 'category'}”`;
        } else if (type === 'delete-product') {
          const product = M.productById(this.state, id);
          next = M.deleteProduct(this.state, id);
          message = `Product "${product?.name ?? ''}" removed`;
        } else if (type === 'rename-category') {
          next = M.renameCategory(this.state, id, data.get('categoryName'));
          message = 'Category name saved';
        } else if (type === 'color-category') {
          next = M.setCategoryColor(this.state, id, data.get('categoryColor') || data.get('customColor'));
          message = 'Category color changed';
        } else if (type === 'delete-category') {
          const category = M.categoryById(this.state, id);
          next = M.deleteCategory(this.state, id);
          message = `Category "${category?.name ?? ''}" removed`;
        } else {
          return;
        }
        this.closeModal();
        await this.commit(next, message);
      } catch (error) {
        const field = elements.modalForm.querySelector('[data-form-error]');
        if (field) field.textContent = error instanceof M.DomainError ? error.message : 'Action failed';
        if (!(error instanceof M.DomainError)) console.error(error);
      }
    }

    showToast(message, error = false) {
      clearTimeout(this.toastTimer);
      elements.toast.textContent = message;
      elements.toast.classList.toggle('is-error', error);
      elements.toast.classList.add('is-visible');
      this.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2300);
    }
  }

  const app = new ShoppingApplication();
  globalThis.shoppingApp = app;
  elements.headerMenuButton.dataset.action = 'open-main-menu';
  elements.modalBackdrop.addEventListener('click', event => {
    if (event.target === elements.modalBackdrop) app.closeModal();
  });
  void app.init();
})();

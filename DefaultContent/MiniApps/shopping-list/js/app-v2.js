(() => {
  'use strict';

  const translate = globalThis.translateShoppingList;

  const M = globalThis.ShoppingModel;
  if (!M) throw new Error('ShoppingModel is not loaded');

  const STORAGE_KEY = 'shoppingListState';
  const SYNC_BASE_KEY = 'telegramSyncBase';
  const CHANNEL_KEY = 'telegramShoppingChannel';
  const Sync = globalThis.ShoppingTelegramSync;
  const TELEGRAM_ICONS = {
    plane: '<path d="m21 4-4 16-5-5-4 3v-5L21 4 3 11l5 2m4 2 5-6"></path>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"></path>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"></circle><path d="m15 15 4 4"></path>',
    check: '<path d="m5 12 4 4L19 6"></path>'
  };
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
    telegramSyncButton: document.getElementById('telegramSyncButton'),
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
    if (mod10 === 1 && mod100 !== 11) return translate("product");
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return translate("goods (few)");
    return translate("goods");
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
      this.syncBase = null;
    }

    async load() {
      if (globalThis.mini?.storage?.public) {
        return await mini.storage.public.get(this.key);
      }
      const value = localStorage.getItem(this.key);
      return value ? JSON.parse(value) : null;
    }

    save(state, syncBase = this.syncBase) {
      this.syncBase = syncBase;
      this.pendingSnapshot = M.clone({ state, syncBase });
      // The browser fallback completes synchronously, so publish the pending
      // promise before flush can clear it.
      if (!this.flushPromise) this.flushPromise = Promise.resolve().then(() => this.flush());
      return this.flushPromise;
    }

    async flush() {
      try {
        while (this.pendingSnapshot) {
          const snapshot = this.pendingSnapshot;
          this.pendingSnapshot = null;
          if (globalThis.mini?.storage?.public) {
            if (snapshot.syncBase) {
              await mini.storage.transaction({ scope: 'public', operations: [
                { type: 'set', key: this.key, value: snapshot.state },
                { type: 'set', key: SYNC_BASE_KEY, value: snapshot.syncBase }
              ] });
            } else {
              await mini.storage.public.set(this.key, snapshot.state);
            }
          } else {
            localStorage.setItem(this.key, JSON.stringify(snapshot.state));
          }
        }
        this.lastError = null;
      } catch (error) {
        this.lastError = error;
        throw error;
      } finally {
        this.flushPromise = null;
        if (this.pendingSnapshot) this.flushPromise = Promise.resolve().then(() => this.flush());
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
      try { await globalThis.mini?.app?.setWindowTitle?.(translate("Shopping list")); } catch (error) { console.warn(error); }
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
          title: viewState.screen === 'settings' ? translate("Settings") : translate("Shopping list"),
          background: light ? '#F7F8FC' : '#151927',
          foreground: light ? '#171A22' : '#F7F8FB',
          accent: '#5271FF',
          paddingX: 14,
          paddingY: 10,
          titleFontSize: 11,
          showBack: true,
          backText: translate("← Back"),
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
            ? [{ id: 'settings-back', label: translate("Ready"), accent: false }]
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
      this.telegramOperation = null;
      this.telegramNotice = null;
      this.channel = null;
      this.channelPicker = null;
      this.reauthenticate = false;
    }

    async init() {
      this.bindGlobalEvents();
      try {
        this.state = M.normalizeState(await this.repository.load());
      } catch (error) {
        console.error('State load failed:', error);
        this.state = M.createDefaultState();
        this.showToast(translate("Failed to read saved list"), true);
      }
      if (globalThis.mini?.storage?.private) {
        try {
          this.channel = await mini.storage.private.get(CHANNEL_KEY);
          this.repository.syncBase = await mini.storage.public.get(SYNC_BASE_KEY);
        } catch (error) {
          console.warn('Telegram settings could not be read:', error?.code);
        }
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
      elements.content.addEventListener('input', event => {
        if (event.target.id !== 'telegramChannelSearch' || !this.channelPicker) return;
        this.channelPicker.query = event.target.value;
        this.filterTelegramChannels();
      });
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
        this.showToast(translate("The change was not written to storage.json"), true);
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
      elements.telegramSyncButton.hidden = settings;
      elements.telegramSyncButton.disabled = Boolean(this.telegramOperation);
      elements.telegramSyncButton.textContent = this.telegramOperation === 'sync' ? translate("Syncing…") : translate("Sync");

      if (settings) {
        elements.title.textContent = translate("Settings");
        elements.subtitle.textContent = translate("Appearance and Telegram sync");
        elements.content.innerHTML = this.renderSettings();
      } else {
        const shopping = this.view.tab === 'shopping';
        const selectedCount = M.selectedProducts(this.state).length;
        const boughtCount = M.boughtProducts(this.state).length;
        elements.title.textContent = shopping ? translate("Purchases") : translate("Goods");
        elements.subtitle.textContent = shopping
          ? selectedCount ? `${boughtCount} ${translate("from")} ${selectedCount} ${translate("has already been taken")}` : translate("The list is still empty")
          : `${this.state.products.length} ${translate("products")} · ${this.state.categories.length} ${translate("categories")}`;
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
        return this.renderCategoryCard(category, products, 'shopping', `${bought} ${translate("from")} ${products.length} ${translate("taken")}`);
      }).join('');
      return `<div class="category-list">${cards}</div>`;
    }

    renderProducts() {
      if (!this.state.categories.length) return this.emptyState('categories');
      const cards = this.state.categories.map((category, index) => {
        const products = M.productsForCategory(this.state, category.id);
        const selected = products.filter(product => product.selected).length;
        const meta = products.length ? `${selected} ${translate("from")} ${products.length} ${translate("in the list")}` : translate("No products");
        return this.renderCategoryCard(category, products, 'products', meta, index);
      }).join('');
      return `<div class="category-list">${cards}</div>`;
    }

    renderSettings() {
      const right = this.state.settings.checkboxesRight;
      const theme = this.state.settings.theme;
      return `<div class="settings-page">
          <button class="settings-back-button" type="button" data-action="settings-back">
            ${svg('<path d="m14.5 6-6 6 6 6"></path>')}<span>${translate("Back to list")}</span>
          </button>
          ${this.renderTelegramSettings()}
          <section class="settings-card" aria-labelledby="layoutSettingsTitle">
            <div class="settings-card-header"><p class="settings-eyebrow">${translate("Layout")}</p><h2 id="layoutSettingsTitle">${translate("List Items")}</h2></div>
            <label class="settings-row" for="checkboxSideToggle">
              <span class="settings-row-copy"><strong>${translate("Checkboxes on the right side")}</strong><small>${translate("Turn off to return the checkboxes on the left")}.</small></span>
              <span class="toggle-switch"><input id="checkboxSideToggle" data-setting="checkbox-side" type="checkbox" ${right ? 'checked' : ''}><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span></span>
            </label>
          </section>
          <section class="settings-card" aria-labelledby="themeSettingsTitle">
            <div class="settings-card-header"><p class="settings-eyebrow">${translate("Design")}</p><h2 id="themeSettingsTitle">${translate("Application theme")}</h2></div>
            <div class="theme-choice" role="group" aria-label="${translate("App Theme")}">
              <button class="theme-choice-button${theme === 'dark' ? ' is-active' : ''}" type="button" data-action="set-theme" data-theme="dark" aria-pressed="${theme === 'dark'}">
                ${svg('<path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"></path>')}<span>${translate("Dark")}</span>
              </button>
              <button class="theme-choice-button${theme === 'light' ? ' is-active' : ''}" type="button" data-action="set-theme" data-theme="light" aria-pressed="${theme === 'light'}">
                ${svg('<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>')}<span>${translate("Light")}</span>
              </button>
            </div>
            <p class="settings-note">${translate("Default is dark theme")}.</p>
          </section>
        </div>`;
    }

    renderTelegramSettings() {
      const channel = this.channel;
      const picker = this.channelPicker;
      const busy = Boolean(this.telegramOperation);
      const progress = this.telegramOperation === 'channels' ? translate("Loading channels…")
        : this.telegramOperation === 'save' ? translate("Checking channel…")
        : this.telegramOperation === 'sync' ? translate("Syncing…") : '';
      const notice = this.telegramNotice;
      return `<section class="settings-card telegram-settings" aria-labelledby="telegramSettingsTitle">
        <div class="telegram-heading">
          <span class="telegram-icon">${svg(TELEGRAM_ICONS.plane)}</span>
          <div><h2 id="telegramSettingsTitle" tabindex="-1">${translate("Telegram sync")}</h2>
            <p>${channel ? translate("Sync on demand with the button at the top of the list.")
              : translate("Share your shopping list through a private Telegram channel.")}</p></div>
        </div>
        ${channel ? `<div class="telegram-destination">
          <span class="telegram-channel-icon">${svg(TELEGRAM_ICONS.lock)}</span>
          <div><span>${translate("Selected channel")}</span><strong dir="auto">${escapeHtml(channel.title)}</strong></div>
        </div>` : ''}
        ${progress ? `<p class="telegram-feedback" role="status"><span class="telegram-spinner" aria-hidden="true"></span>${progress}</p>` : ''}
        ${notice ? `<p class="telegram-feedback ${notice.error ? 'is-error' : ''}" role="${notice.error ? 'alert' : 'status'}">${escapeHtml(notice.text)}</p>` : ''}
        ${picker?.items.length && !this.reauthenticate ? this.renderChannelPicker(picker, busy) : `
          <button class="${channel && !this.reauthenticate ? 'secondary-button' : 'primary-button'} telegram-action" type="button"
            data-action="telegram-connect" ${busy ? 'disabled' : ''}>${this.reauthenticate
              ? translate("Sign in again") : picker ? translate("Reload channels")
              : channel ? translate("Change channel") : translate("Connect Telegram")}</button>
          <p class="telegram-hint">${channel ? translate("Choose the same channel on each device that shares the list.")
            : translate("You can use the list on this device without connecting Telegram.")}</p>
        `}
        <details class="telegram-help" ${picker && !picker.items.length ? 'open' : ''}>
          <summary>${translate("How to prepare a channel")}</summary>
          <p>${translate("Create a private channel in Telegram. Give everyone who shares the list permission to post, and turn off auto-delete and content protection.")}</p>
        </details>
      </section>`;
    }

    renderChannelPicker(picker, busy) {
      return `<fieldset class="telegram-picker" ${busy ? 'disabled' : ''}>
        <legend id="telegramPickerTitle" tabindex="-1">${translate("Choose a channel")}</legend>
        <label class="telegram-search">
          ${svg(TELEGRAM_ICONS.search)}
          <input id="telegramChannelSearch" type="search" autocomplete="off"
            aria-label="${translate("Search channels")}" placeholder="${translate("Search channels")}" value="${escapeHtml(picker.query)}">
        </label>
        <div class="telegram-channel-list" id="telegramChannelList">
          ${picker.items.map(item => `<label class="telegram-channel" ${this.matchesChannel(item, picker.query) ? '' : 'hidden'}>
            <input type="radio" name="telegramChannel" value="${escapeHtml(item.id)}" ${picker.selected?.id === item.id ? 'checked' : ''}>
            <span class="telegram-channel-icon">${svg(TELEGRAM_ICONS.lock)}</span>
            <span class="telegram-channel-name" dir="auto">${escapeHtml(item.title)}</span>
            <span class="telegram-channel-check">${svg(TELEGRAM_ICONS.check)}</span>
          </label>`).join('')}
        </div>
        <p class="telegram-hint" id="telegramSearchEmpty" role="status" ${picker.items.some(item => this.matchesChannel(item, picker.query)) ? 'hidden' : ''}>${translate("No channels match your search.")}</p>
        <div class="telegram-picker-actions">
          <button class="secondary-button telegram-action" type="button" data-action="telegram-cancel">${translate("Cancel")}</button>
          <button class="primary-button telegram-action" id="telegramChannelConfirm" type="button" data-action="telegram-select" ${picker.selected ? '' : 'disabled'}>${translate("Use this channel")}</button>
        </div>
      </fieldset>`;
    }

    matchesChannel(item, query) {
      return item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    }

    filterTelegramChannels() {
      const picker = this.channelPicker;
      const rows = elements.content.querySelectorAll('.telegram-channel');
      let anyVisible = false;
      for (let i = 0; i < rows.length; i++) {
        rows[i].hidden = !this.matchesChannel(picker.items[i], picker.query);
        anyVisible ||= !rows[i].hidden;
      }
      if (picker.selected && !this.matchesChannel(picker.selected, picker.query)) {
        picker.selected = null;
        const checked = elements.content.querySelector('input[name="telegramChannel"]:checked');
        if (checked) checked.checked = false;
      }
      document.getElementById('telegramChannelConfirm').disabled = !picker.selected;
      document.getElementById('telegramSearchEmpty').hidden = anyVisible;
    }

    openTelegramSettings() {
      this.view = { ...this.view, screen: 'settings' };
      this.render();
      window.scrollTo(0, 0);
      document.getElementById('telegramSettingsTitle').focus({ preventScroll: true });
    }

    async withTelegram(operation, task) {
      if (this.telegramOperation) return;
      this.telegramOperation = operation;
      this.telegramNotice = null;
      this.render({ preserveScroll: true });
      let client;
      try {
        const saved = await mini.functions.call('telegram.connect', { reauthenticate: this.reauthenticate });
        if (!saved) throw new Error('telegram_session_unavailable');
        await mini.modules.load('telegram');
        if (!globalThis.MiniAppTelegram?.shoppingHistoryBytes) throw new Error('module_load_failed');
        client = MiniAppTelegram.createClient({ ...saved, onFloodWait: until => {
          this.showToast(translate("Telegram will retry after ") + new Date(until).toLocaleTimeString());
        } });
        await client.resume();
        this.reauthenticate = false;
        await task(client);
      } catch (error) {
        const code = error?.errorMessage || error?.code || error?.message;
        if (code === 401 || /AUTH_KEY|SESSION_(?:REVOKED|EXPIRED)/.test(String(code))) {
          this.reauthenticate = true;
          this.telegramNotice = { error: true, text: translate("Telegram sign-in expired. Choose Sign in again.") };
          if (operation === 'sync' && this.view.screen !== 'settings') this.openTelegramSettings();
        } else if (code !== 'operation_cancelled') {
          const messages = {
            telegram_package_missing: translate("Install Telegram from the MiniApps launcher first."),
            module_load_failed: translate("Install or update Telegram from the MiniApps launcher."),
            method_not_found: translate("Update MiniApps to enable Telegram sync."),
            telegram_runtime_update_required: translate("Update MiniApps to enable Telegram sync."),
            telegram_session_unavailable: translate("The Telegram session is unavailable. Try signing in again."),
            permission_denied: translate("Allow Telegram access in the MiniApps permissions for this app."),
            telegram_session_busy: translate("Close the other MiniApps Telegram window and try again."),
            CLOUD_CHANNEL_UNAVAILABLE: translate("Telegram no longer grants posting access to this private channel."),
            CHANNEL_NOT_LOADED: translate("The selected channel is unavailable. Choose it again in Settings."),
            SHOPPING_CHANNEL_UNAVAILABLE: translate("Choose a private channel with auto-delete and content protection off."),
            SYNC_LIST_TOO_LARGE: translate("The shared list is too large to send. It is saved on this device."),
            SHOPPING_HISTORY_LIMIT: translate("The Telegram channel has too much shopping history to sync."),
            SHOPPING_HISTORY_TOO_LARGE: translate("The Telegram channel has too much shopping history to sync."),
            SYNC_INVALID_SNAPSHOT: translate("A shopping list backup in this channel could not be read."),
            telegram_channel_save_failed: translate("Could not save the Telegram channel.")
          };
          const fallback = operation === 'sync' ? "Telegram sync failed. Your list is available locally."
            : operation === 'channels' ? "Could not load the Telegram channels. Try again."
            : "Could not check the Telegram channel. Try again.";
          const message = messages[code] ?? translate(fallback);
          this.telegramNotice = { error: true, text: message };
          if (this.view.screen !== 'settings') this.showToast(message, true);
        }
      } finally {
        try { await client?.close(); } catch (error) { console.warn('Telegram connection close failed:', error?.code); }
        this.telegramOperation = null;
        this.render({ preserveScroll: true });
      }
    }

    async findChannels(client) {
      let reset = true;
      const result = [];
      do {
        const page = await client.cloudChannels(reset);
        result.push(...page.items);
        if (!page.more) return result;
        reset = false;
      } while (true);
    }

    async loadTelegramChannels() {
      if (this.telegramOperation) return;
      this.channelPicker = null;
      const settingsView = this.view;
      await this.withTelegram('channels', async client => {
        const items = await this.findChannels(client);
        if (this.view !== settingsView) return;
        this.channelPicker = { items, selected: items.find(item => item.id === this.channel?.id) ?? null, query: '' };
        if (!items.length) this.telegramNotice = { text: translate("No private channels with posting access."), error: false };
      });
      if (this.view === settingsView) {
        const target = document.getElementById('telegramPickerTitle') ?? elements.content.querySelector('[data-action="telegram-connect"]');
        target?.focus({ preventScroll: true });
      }
    }

    async selectTelegramChannel() {
      const channel = this.channelPicker?.selected;
      if (!channel) return;
      await this.withTelegram('save', async client => {
        const transport = await client.shoppingTransport(channel.id, channel.peerHint);
        const selected = { ...channel, peerHint: transport.peerHint ?? null };
        try {
          await mini.storage.private.set(CHANNEL_KEY, selected);
        } catch {
          throw new Error('telegram_channel_save_failed');
        }
        this.channel = selected;
        this.channelPicker = null;
        this.telegramNotice = { text: translate("Telegram channel selected. Press Sync to update the list."), error: false };
        if (this.view.screen !== 'settings') this.showToast(this.telegramNotice.text);
      });
      if (this.view.screen === 'settings') {
        const target = document.getElementById('telegramChannelConfirm') ?? elements.content.querySelector('[data-action="telegram-connect"]');
        target?.focus({ preventScroll: true });
      }
    }

    syncTelegram() {
      if (!this.channel) {
        this.openTelegramSettings();
        return;
      }
      void this.withTelegram('sync', async client => {
        const channel = this.channel;
        const transport = await client.shoppingTransport(channel.id, channel.peerHint);
        const peerHint = transport.peerHint ?? null;
        if ((channel.peerHint?.scope ?? null) !== (peerHint?.scope ?? null) ||
            channel.peerHint?.accessHash !== peerHint?.accessHash ||
            channel.peerHint?.channelId !== peerHint?.channelId) {
          this.channel = { ...channel, peerHint };
          await mini.storage.private.set(CHANNEL_KEY, this.channel).catch(error => {
            console.warn('Telegram channel cache could not be saved:', error?.code);
          });
        }
        const initial = this.state;
        const saved = this.repository.syncBase;
        const base = saved?.channelId === channel.id && saved.mode === 'purchases' ? saved.list : null;
        const selected = Sync.project(initial, base);
        const actor = M.makeId('shopping');
        const result = await Sync.reconcile(transport, selected, base, Sync.project(M.createDefaultState()), actor);
        const merged = Sync.applyToLocal(initial, Sync.materialize(result.snapshot), selected);
        const localEdits = Sync.applyChanges(result.snapshot, selected, Sync.project(this.state, base), actor);
        const localList = Sync.materialize(localEdits);
        const updated = Sync.applyToLocal(this.state, localList, merged.base);
        this.state = M.withTimestamp(updated.state);
        this.render({ preserveScroll: true });
        const confirmed = Sync.rememberRemovals(merged.base, result.snapshot, base, selected);
        await this.repository.save(this.state, { channelId: channel.id, mode: 'purchases', list: confirmed });
        let cleaned = false;
        try { cleaned = await result.cleanUp(); } catch (error) { console.warn('Telegram cleanup failed:', error?.code); }
        this.showToast(cleaned ? translate("Shopping list synced") : translate("List synced. Some previous messages could not be removed."));
      });
    }

    emptyState(kind) {
      if (kind === 'shopping') {
        return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${svg('<path d="M3.5 5.5h2l1.7 9.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.4l1.8-6.3H7"></path><path d="M9 20h.01M17 20h.01"></path>')}</div><h2>${translate("The list is empty")}</h2><p>${translate("Open “Products” and check the boxes for what you want to buy.")}</p><button class="primary-inline-button" type="button" data-action="change-tab" data-tab="products">${translate("Select products")}</button></div></div>`;
      }
      return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${svg('<path d="M4 7h16M4 12h16M4 17h10"></path><path d="M18 15v6M15 18h6"></path>')}</div><h2>${translate("No categories")}</h2><p>${translate("Create the first category, and then add products to it.")}</p><button class="primary-inline-button" type="button" data-action="open-modal" data-modal="add-category">${translate("Create category")}</button></div></div>`;
    }

    renderCategoryCard(category, products, mode, meta, index = -1) {
      const tools = mode === 'products' ? this.renderCategoryTools(category, index) : '';
      const rows = products.length
        ? products.map(product => this.renderProductRow(product, category, mode)).join('')
        : `<div class="empty-category">${translate("Add the first product here via the menu ⋮")}</div>`;
      return `<section class="category-card" data-category-id="${escapeHtml(category.id)}" style="${categoryStyle(category.color)}"><header class="category-header"><span class="category-dot" aria-hidden="true"></span><div class="category-meta"><h2 class="category-name">${escapeHtml(category.name)}</h2><p class="category-count">${escapeHtml(meta)}</p></div>${tools}</header><div class="product-list">${rows}</div></section>`;
    }

    renderCategoryTools(category, index) {
      const top = index <= 0;
      const bottom = index >= this.state.categories.length - 1;
      return `<div class="category-tools"><button class="item-menu-button" type="button" data-action="open-item-menu" data-kind="category" data-id="${escapeHtml(category.id)}" aria-label="${translate("Edit category")} ${escapeHtml(category.name)}" aria-haspopup="menu" aria-expanded="false">${svg('<circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="12" cy="19" r="1.7"></circle>')}</button><div class="category-order-controls" aria-label="${translate("Category order")} ${escapeHtml(category.name)}"><button class="category-order-button" type="button" data-action="move-category" data-id="${escapeHtml(category.id)}" data-direction="up" aria-label="${translate("Move category higher")}" ${top ? 'disabled' : ''}>${svg('<path d="M6.5 14.5 12 9l5.5 5.5"></path>')}</button><button class="category-order-button" type="button" data-action="move-category" data-id="${escapeHtml(category.id)}" data-direction="down" aria-label="${translate("Move category lower")}" ${bottom ? 'disabled' : ''}>${svg('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"></path>')}</button></div></div>`;
    }

    renderProductRow(product, category, mode) {
      const shopping = mode === 'shopping';
      const checked = shopping ? product.bought : product.selected;
      const rowClass = shopping && product.bought ? ' is-bought' : '';
      const checkboxId = `product-${mode}-${product.id}`;
      const label = shopping
        ? `${translate("Mark \"")}${product.name}${translate("\" as taken")}`
        : `${product.selected ? translate("Put away") : translate("Add")} ${translate("opening quote")}${product.name}${translate("closing quote")} ${product.selected ? translate("from") : translate("V")} ${translate("shopping list")}`;
      const checkbox = `<label class="checkbox-wrap" for="${escapeHtml(checkboxId)}" style="${categoryStyle(category.color)}"><input id="${escapeHtml(checkboxId)}" type="checkbox" data-product-toggle data-id="${escapeHtml(product.id)}" data-mode="${mode}" ${checked ? 'checked' : ''} aria-label="${escapeHtml(label)}"><span class="custom-checkbox">${svg('<path d="M5.5 12.5l4 4L18.8 7"></path>')}</span></label>`;
      if (mode === 'shopping') {
        return `<div class="product-row shopping-product-row${rowClass}" data-product-id="${escapeHtml(product.id)}"><label class="product-title" for="${escapeHtml(checkboxId)}">${escapeHtml(product.name)}</label>${checkbox}</div>`;
      }
      return `<div class="product-row editable-product-row" data-product-id="${escapeHtml(product.id)}"><label class="product-title" for="${escapeHtml(checkboxId)}">${escapeHtml(product.name)}</label><button class="item-menu-button" type="button" data-action="open-item-menu" data-kind="product" data-id="${escapeHtml(product.id)}" aria-label="${translate("Edit product")} ${escapeHtml(product.name)}" aria-haspopup="menu" aria-expanded="false">${svg('<circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="12" cy="19" r="1.7"></circle>')}</button>${checkbox}</div>`;
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
      else if (action === 'telegram-sync') this.syncTelegram();
      else if (action === 'telegram-connect') void this.loadTelegramChannels();
      else if (action === 'telegram-cancel') {
        this.channelPicker = null;
        this.telegramNotice = null;
        this.render({ preserveScroll: true });
        elements.content.querySelector('[data-action="telegram-connect"]')?.focus({ preventScroll: true });
      }
      else if (action === 'telegram-select') void this.selectTelegramChannel();
      else if (action === 'set-theme') void this.setTheme(actionTarget.dataset.theme);
    }

    onChange(event) {
      if (event.target.matches('input[name="telegramChannel"]') && this.channelPicker) {
        this.channelPicker.selected = this.channelPicker.items.find(item => item.id === event.target.value);
        document.getElementById('telegramChannelConfirm').disabled = !this.channelPicker.selected;
        return;
      }
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
        void this.commit(M.updateSettings(this.state, { checkboxesRight: right }), right ? translate("Checkboxes moved to the right") : translate("Checkboxes moved to the left"));
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
      this.channelPicker = null;
      this.view = { ...this.view, screen: 'main' };
      this.render();
    }

    async setTheme(theme) {
      const nextTheme = theme === 'light' ? 'light' : 'dark';
      await this.commit(M.updateSettings(this.state, { theme: nextTheme }), nextTheme === 'light' ? translate("Light theme included") : translate("Dark theme enabled"));
    }

    toggleMainMenu(anchor) {
      if (!elements.mainMenu.hidden) { this.closeMenus(); return; }
      this.closeMenus(false);
      this.lastMenuFocus = anchor ?? document.activeElement;
      const shopping = this.view.tab === 'shopping';
      const items = shopping
        ? [{ action: 'reset', label: translate("Reset marks"), icon: ICONS.reset, danger: true,
            disabled: !M.boughtProducts(this.state).length }]
        : [
            { action: 'add-product', label: translate("Add product"), icon: ICONS.add },
            { action: 'add-category', label: translate("Create a category"), icon: ICONS.category },
            { separator: true },
            { action: 'settings', label: translate("Settings"), icon: ICONS.settings }
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
            { action: 'delete', label: translate("Delete"), icon: ICONS.delete, danger: true },
            { action: 'rename', label: translate("Rename"), icon: ICONS.rename },
            { action: 'move', label: translate("Change category"), icon: ICONS.move }
          ]
        : [
            { action: 'delete', label: translate("Delete"), icon: ICONS.delete, danger: true },
            { action: 'rename', label: translate("Rename"), icon: ICONS.rename },
            { action: 'color', label: translate("Change color"), icon: ICONS.color }
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
      if (action === 'reset') void this.commit(M.resetBought(this.state), translate("All \"accepted\" marks are cleared"));
      if (action === 'add-product') this.openModal('add-product');
      if (action === 'add-category') this.openModal('add-category');
      if (action === 'settings') this.openTelegramSettings();
    }

    handleItemMenuAction(kind, id, action) {
      this.closeMenus(false);
      const modal = kind === 'product'
        ? { delete: 'delete-product', rename: 'rename-product', move: 'move-product' }[action]
        : { delete: 'delete-category', rename: 'rename-category', color: 'color-category' }[action];
      if (modal) this.openModal(modal, id);
    }

    async moveCategory(id, direction) {
      await this.commit(M.moveCategory(this.state, id, direction), translate("The order of the categories is preserved"));
    }

    openModal(type, id = null) {
      this.closeMenus(false);
      if (type === 'add-product' && this.state.categories.length === 0) {
        this.showToast(translate("First create a category"), true);
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
      if (type.endsWith('product') && !product) { this.showToast(translate("Product not found"), true); return null; }
      if (type.endsWith('category') && !category) { this.showToast(translate("Category not found"), true); return null; }
      if (type === 'rename-product') return this.renameProductModal(product);
      if (type === 'move-product') return this.moveProductModal(product);
      if (type === 'delete-product') return this.deleteProductModal(product);
      if (type === 'rename-category') return this.renameCategoryModal(category);
      if (type === 'color-category') return this.colorCategoryModal(category);
      if (type === 'delete-category') return this.deleteCategoryModal(category);
      return null;
    }

    addProductModal() {
      return { eyebrow: translate("New element"), title: translate("Add product"), html: `${this.textField('productName', translate("Product name"), '', translate("For example, olive oil"), 80)}${this.categorySelect('productCategory')}<p class="form-error" data-form-error></p>${this.modalActions(translate("Add"))}` };
    }

    addCategoryModal() {
      const color = M.DEFAULT_COLORS[this.state.categories.length % M.DEFAULT_COLORS.length];
      return { eyebrow: translate("New group"), title: translate("Create a category"), html: `${this.textField('categoryName', translate("Category name"), '', translate("For example, Freeze"), 60)}${this.colorField(color)}<p class="form-error" data-form-error></p>${this.modalActions(translate("Create"))}` };
    }

    renameProductModal(product) {
      return { eyebrow: translate("Editing a product"), title: translate("Rename"), html: `${this.textField('productName', translate("Product name"), product.name, '', 80)}<p class="form-error" data-form-error></p>${this.modalActions(translate("Save"))}` };
    }

    moveProductModal(product) {
      if (this.state.categories.length < 2) {
        this.showToast(translate("To transfer you need one more category"), true);
        return null;
      }
      return { eyebrow: translate("Editing a product"), title: translate("Change category"), html: `<div class="form-summary"><strong>${escapeHtml(product.name)}</strong><span>${translate("Select a new category for the product")}.</span></div>${this.categorySelect('productCategory', product.categoryId)}<p class="form-error" data-form-error></p>${this.modalActions(translate("Postpone"))}` };
    }

    deleteProductModal(product) {
      return { eyebrow: translate("Removing a product"), title: translate("Delete a product?"), html: `${this.deleteWarning(`${translate("Product")}<strong>«${escapeHtml(product.name)}»</strong> ${translate("will be removed from the catalog and shopping list")}.`)}${this.modalActions(translate("Delete"), true)}` };
    }

    renameCategoryModal(category) {
      return { eyebrow: translate("Editing a category"), title: translate("Rename"), html: `${this.textField('categoryName', translate("Category name"), category.name, '', 60)}<p class="form-error" data-form-error></p>${this.modalActions(translate("Save"))}` };
    }

    colorCategoryModal(category) {
      return { eyebrow: translate("Editing a category"), title: translate("Change color"), html: `<div class="category-edit-preview" data-color-preview style="${categoryStyle(category.color)}"><span class="category-dot"></span><strong>${escapeHtml(category.name)}</strong></div>${this.colorField(category.color)}<p class="form-error" data-form-error></p>${this.modalActions(translate("Save"))}` };
    }

    deleteCategoryModal(category) {
      const products = this.state.products.filter(product => product.categoryId === category.id);
      const selected = products.filter(product => product.selected).length;
      const detail = `${translate("category deletion count prefix")}${products.length} ${pluralizeProducts(products.length)}${selected ?`, ${translate("including")}${selected} ${translate("from the shopping list")}` : ''}.`;
      return { eyebrow: translate("Delete a category"), title: translate("Delete category?"), html: `${this.deleteWarning(`${translate("Category")}<strong>«${escapeHtml(category.name)}»</strong> ${translate("will be deleted")}.<span class="delete-warning-detail">${escapeHtml(detail)}</span>`)}${this.modalActions(translate("Delete everything"), true)}` };
    }

    textField(name, label, value = '', placeholder = '', maxlength = 80) {
      return `<div class="form-group"><label class="form-label" for="${name}">${escapeHtml(label)}</label><input class="text-input" id="${name}" name="${name}" type="text" maxlength="${maxlength}" autocomplete="off" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" required></div>`;
    }

    categorySelect(name, selectedId = '') {
      const options = this.state.categories.map(category => `<option value="${escapeHtml(category.id)}" ${category.id === selectedId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
      return `<div class="form-group"><label class="form-label" for="${name}">${translate("Category")}</label><select class="select-input" id="${name}" name="${name}" required>${options}</select></div>`;
    }

    colorField(selectedColor) {
      const radios = M.DEFAULT_COLORS.map(color => `<label class="color-option" title="${color}"><input type="radio" name="categoryColor" data-color-radio value="${color}" ${color.toLowerCase() === selectedColor.toLowerCase() ? 'checked' : ''}><span class="color-swatch" style="--swatch:${color}"></span></label>`).join('');
      return `<div class="form-group"><span class="form-label">${translate("Category color")}</span><div class="color-grid">${radios}</div><label class="custom-color-row"><span>${translate("Custom color")}</span><input name="customColor" data-color-custom type="color" value="${escapeHtml(selectedColor)}" aria-label="${translate("Choose your color")}"></label></div>`;
    }

    deleteWarning(content) {
      return `<div class="delete-warning"><div class="delete-warning-icon">${svg(ICONS.delete)}</div><p>${content}</p></div>`;
    }

    modalActions(label, danger = false) {
      return `<div class="modal-actions"><button class="secondary-button" type="button" data-action="close-modal">${translate("Cancel")}</button><button class="${danger ? 'danger-button' : 'primary-button'}" type="submit">${escapeHtml(label)}</button></div>`;
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
          message = `${translate("Product \"")}${M.normalizeName(data.get('productName'))}${translate("\" added")}`;
        } else if (type === 'add-category') {
          next = M.addCategory(this.state, { name: data.get('categoryName'), color: data.get('categoryColor') || data.get('customColor') });
          message = `${translate("Category \"")}${M.normalizeName(data.get('categoryName'))}${translate("\" created")}`;
        } else if (type === 'rename-product') {
          next = M.renameProduct(this.state, id, data.get('productName'));
          message = translate("Product name saved");
        } else if (type === 'move-product') {
          const category = M.categoryById(this.state, data.get('productCategory'));
          next = M.moveProduct(this.state, id, data.get('productCategory'));
          message = `${translate("Product moved to “")}${category?.name ?? translate("category")}${translate("”")}`;
        } else if (type === 'delete-product') {
          const product = M.productById(this.state, id);
          next = M.deleteProduct(this.state, id);
          message = `${translate("Product \"")}${product?.name ?? ''}${translate("\" removed")}`;
        } else if (type === 'rename-category') {
          next = M.renameCategory(this.state, id, data.get('categoryName'));
          message = translate("Category name saved");
        } else if (type === 'color-category') {
          next = M.setCategoryColor(this.state, id, data.get('categoryColor') || data.get('customColor'));
          message = translate("Category color changed");
        } else if (type === 'delete-category') {
          const category = M.categoryById(this.state, id);
          next = M.deleteCategory(this.state, id);
          message = `${translate("Category \"")}${category?.name ?? ''}${translate("category removed suffix")}`;
        } else {
          return;
        }
        this.closeModal();
        await this.commit(next, message);
      } catch (error) {
        const field = elements.modalForm.querySelector('[data-form-error]');
        if (field) field.textContent = error instanceof M.DomainError ? error.message : translate("Action failed");
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

  async function boot() {
    let language;
    try {
      language = (await globalThis.mini?.locale?.get?.())?.preferred;
    } catch {
      // Use the browser language when the runtime does not provide a preference.
    }
    document.documentElement.lang = /^ru(?:-|$)/i.test(language ?? navigator.language) ? 'ru' : 'en';
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = translate(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll('[data-i18n-aria-label]')) {
      node.setAttribute('aria-label', translate(node.dataset.i18nAriaLabel));
    }

    const app = new ShoppingApplication();
    globalThis.shoppingApp = app;
    elements.headerMenuButton.dataset.action = 'open-main-menu';
    elements.modalBackdrop.addEventListener('click', event => {
      if (event.target === elements.modalBackdrop) app.closeModal();
    });
    await app.init();
  }
  void boot();
})();

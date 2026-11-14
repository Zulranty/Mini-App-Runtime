(() => {
  const pending = new Map(); let sequence = 0;
  function call(method, params = {}) {
    const id = `l-${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const raw = JSON.stringify({ id, method, params });
      if (method.startsWith('interfaces.') && window.InterfaceRuntime?.postMessage) window.InterfaceRuntime.postMessage(raw);
      else if (window.LauncherRuntime?.postMessage) window.LauncherRuntime.postMessage(raw);
      else if (method.startsWith('interfaces.') && window.InterfaceRuntime?.call) window.InterfaceRuntime.call(raw);
      else if (window.LauncherRuntime?.call) window.LauncherRuntime.call(raw);
      else if (window.chrome?.webview) window.chrome.webview.postMessage(raw);
      else { pending.delete(id); reject(Object.assign(new Error('Launcher runtime is unavailable'), { code: 'runtime_unavailable' })); }
    });
  }
  window.__launcherResolve = raw => {
    const response = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const item = pending.get(response.id); if (!item) return;
    pending.delete(response.id);
    if (response.success) {
      // Both launchers show result.message as a toast. Surface the outcome of
      // the native file import instead of silently closing the file picker.
      if (response.result && typeof response.result === 'object' && Object.prototype.hasOwnProperty.call(response.result, 'installed')) {
        response.result.message = response.result.installed
          ? `${label('appInstalled')}${response.result.appPath || response.result.appId}`
          : label('newerAppInstalled');
      }
      item.resolve(response.result);
    }
    else { const error = Object.assign(new Error(response.error?.message || 'Runtime error'), { code: response.error?.code || 'runtime_error' }); item.reject(error); }
  };
  window.launcher = {
    list: () => call('apps.list'), open: id => call('apps.open', { id }),
    getAppInfo: appId => call('apps.getAppInfo', { id: appId }),
    openNewWindow: id => call('apps.openNewWindow', { id }), refresh: () => call('apps.refresh'),
    hasTelegramClient: () => call('telegram.installStatus'),
    installTelegram: () => call('telegram.install'),
    importApp: () => call('apps.importApp'), deleteApp: id => call('apps.delete', { id }),
    shareApp: id => call('apps.share', { id }), shareAppData: id => call('apps.shareData', { id }),
    createBackup: options => call('backup.create', options || {}),
    inspectBackup: () => call('backup.inspect'),
    restoreBackup: options => call('backup.restore', options || {}),
    getRollbackInfo: id => call('apps.rollbackInfo', { id }),
    rollbackApp: id => call('apps.rollback', { id }),
    deleteRollback: id => call('apps.deleteRollback', { id }),
    getAppPermissions: id => call('apps.permissions.get', { id }),
    setAppPermission: (id, permission, state) => call('apps.permissions.set', { id, permission, state }),
    resetAppPermissions: id => call('apps.permissions.reset', { id }),
    getSettingsInfo: () => call('apps.settings'),
    getLanguage: () => call('language.get'),
    setLanguage: language => call('language.set', { language }),
    listInterfaces: () => call('interfaces.list'), selectInterface: id => call('interfaces.select', { id }),
    importInterface: () => call('interfaces.import'),
    getInterfaceSettings: () => call('interfaces.settings.get'),
    setInterfaceSettings: settings => call('interfaces.settings.set', { settings }),
    mountTelegramSettings,
    mountLanguageSettings
  };

  const messages = {
    en: {
      appInstalled: "App installed: ",
      appliesWhenYouNextOpenUnofficialTelegram: "Applies when you next open Unofficial Telegram.",
      copyLog: "Copy log",
      language: "Language",
      logCopied: "Log copied.",
      newerAppInstalled: "A newer version of the app is already installed",
      noTelegramLoginEventsRecorded: "No Telegram login events recorded.",
      refreshLog: "Refresh log",
      saveTelegramLoginLogToFile: "Save Telegram login log to file",
      telegramLoginLog: "Telegram login log",
      telegramTestServer: "Telegram test server",
    },
    ru: {
      appInstalled: "Приложение установлено: ",
      appliesWhenYouNextOpenUnofficialTelegram: "Применится при следующем открытии Unofficial Telegram.",
      copyLog: "Скопировать журнал",
      language: "Язык",
      logCopied: "Журнал скопирован.",
      newerAppInstalled: "Установлена более новая версия приложения",
      noTelegramLoginEventsRecorded: "Записей о входе в Telegram пока нет.",
      refreshLog: "Обновить журнал",
      saveTelegramLoginLogToFile: "Записывать журнал входа Telegram в файл",
      telegramLoginLog: "Журнал входа Telegram",
      telegramTestServer: "Тестовый сервер Telegram",
    },
  };
  const label = key => messages[/^ru(?:-|$)/i.test(document.documentElement.lang) ? 'ru' : 'en'][key];

  function mountLanguageSettings(container) {
    if (container.querySelector('[data-miniapps-language]')) return;
    const panel = document.createElement('div');
    panel.dataset.miniappsLanguage = '';
    const caption = document.createElement('label');
    caption.textContent = label('language');
    const select = document.createElement('select');
    select.style.cssText = 'margin-inline-start: .75em; padding: .45em; font: inherit';
    select.disabled = true;
    select.add(new Option('English', 'en'));
    select.add(new Option('Русский', 'ru'));
    caption.append(select);
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    panel.append(caption, feedback);
    container.append(panel);

    let saved;
    void window.launcher.getLanguage().then(language => {
      saved = select.value = language;
      select.disabled = false;
    }).catch(error => { feedback.textContent = error.message; });
    select.onchange = async () => {
      select.disabled = true;
      feedback.textContent = '';
      try {
        await window.launcher.setLanguage(select.value);
        location.reload();
      } catch (error) {
        select.value = saved;
        select.disabled = false;
        feedback.textContent = error.message;
      }
    };
  }

  function mountTelegramSettings(container) {
    const panel = document.createElement('div');
    const root = panel.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; margin-block: 12px; }
        label { display: flex; align-items: center; gap: .65em; min-height: 44px; }
        input { margin: 0; width: 1.15em; height: 1.15em; }
        p { margin: .35em 0 0; font-size: .9em; }
        details { margin-block: 12px; }
        summary { cursor: pointer; }
        textarea { box-sizing: border-box; width: 100%; margin-block: 8px; resize: vertical; }
        #logPath { overflow-wrap: anywhere; }
        button { margin-inline-end: .4em; min-height: 36px; }
        [role="status"]:empty { display: none; }
      </style>
      <label><input id="testServer" type="checkbox" disabled> ${label('telegramTestServer')}</label>
      <p>${label('appliesWhenYouNextOpenUnofficialTelegram')}</p>
      <label><input id="writeLoginLog" type="checkbox" disabled> ${label('saveTelegramLoginLogToFile')}</label>
      <p id="settingsStatus" role="status"></p>
      <details>
        <summary>${label('telegramLoginLog')}</summary>
        <textarea aria-label="${label('telegramLoginLog')}" rows="6" readonly spellcheck="false"></textarea>
        <button id="refreshLog" type="button">${label('refreshLog')}</button>
        <button id="copyLog" type="button" disabled>${label('copyLog')}</button>
        <p id="logPath"></p>
        <p id="logStatus" role="status"></p>
      </details>`;
    container.replaceChildren(panel);
    const testServer = root.getElementById('testServer');
    const writeLoginLog = root.getElementById('writeLoginLog');
    const feedback = root.getElementById('settingsStatus');
    let saved;
    const render = () => {
      testServer.checked = saved.testServer;
      writeLoginLog.checked = saved.writeLoginLog;
      testServer.disabled = writeLoginLog.disabled = false;
    };
    const save = async () => {
      testServer.disabled = writeLoginLog.disabled = true;
      feedback.textContent = '';
      try {
        saved = await call('telegram.settings.set', {
          testServer: testServer.checked, writeLoginLog: writeLoginLog.checked
        });
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        render();
      }
    };
    testServer.onchange = writeLoginLog.onchange = save;
    void call('telegram.settings.get').then(settings => {
      saved = settings;
      render();
    }).catch(error => { feedback.textContent = error.message; });

    const details = root.querySelector('details');
    const log = root.querySelector('textarea');
    const refresh = root.getElementById('refreshLog');
    const copy = root.getElementById('copyLog');
    const logStatus = root.getElementById('logStatus');
    refresh.onclick = async () => {
      refresh.disabled = copy.disabled = true;
      logStatus.textContent = '';
      try {
        const result = await call('telegram.log.read');
        log.value = result.text;
        root.getElementById('logPath').textContent = result.path;
        if (!log.value) logStatus.textContent = label('noTelegramLoginEventsRecorded');
      } catch (error) {
        log.value = '';
        logStatus.textContent = error.message;
      } finally {
        refresh.disabled = false;
        copy.disabled = !log.value;
      }
    };
    details.ontoggle = () => { if (details.open && !refresh.disabled) void refresh.onclick(); };
    copy.onclick = async () => {
      refresh.disabled = copy.disabled = true;
      try {
        await call('telegram.log.copy');
        logStatus.textContent = label('logCopied');
      } catch (error) {
        logStatus.textContent = error.message;
      } finally {
        refresh.disabled = copy.disabled = false;
      }
    };
  }

})();

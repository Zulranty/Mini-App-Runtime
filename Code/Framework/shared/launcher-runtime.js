(() => {
  const pending = new Map(); let sequence = 0;
  function call(method, params = {}) {
    const id = `l-${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const raw = JSON.stringify({ id, method, params });
      if (method.startsWith('interfaces.') && window.InterfaceRuntime?.call) window.InterfaceRuntime.call(raw);
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
          ? `Приложение установлено: ${response.result.appPath || response.result.appId}`
          : 'Установлена более новая версия приложения';
      }
      item.resolve(response.result);
    }
    else { const error = Object.assign(new Error(response.error?.message || 'Runtime error'), { code: response.error?.code || 'runtime_error' }); item.reject(error); }
  };
  window.launcher = {
    list: () => call('apps.list'), open: id => call('apps.open', { id }),
    getAppInfo: appId => call('apps.getAppInfo', { id: appId }),
    openNewWindow: id => call('apps.openNewWindow', { id }), refresh: () => call('apps.refresh'),
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
    listInterfaces: () => call('interfaces.list'), selectInterface: id => call('interfaces.select', { id }),
    importInterface: () => call('interfaces.import'),
    getInterfaceSettings: () => call('interfaces.settings.get'),
    setInterfaceSettings: settings => call('interfaces.settings.set', { settings })
  };
})();

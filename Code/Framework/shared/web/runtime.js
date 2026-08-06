(function () {
  'use strict';

  const pending = new Map();
  const events = new Map();

  function post(raw) {
    if (window.MiniRuntime && typeof window.MiniRuntime.call === 'function') {
      window.MiniRuntime.call(raw); // Android JavascriptInterface
      return;
    }
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(raw); // Windows WebView2
      return;
    }
    throw new Error('Mini App runtime is unavailable');
  }

  function call(method, params) {
    const id = 'r-' + Date.now() + '-' + Math.random();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { post(JSON.stringify({ id, method, params: params || {} })); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  function scopedStorage(scope) {
    const withScope = params => Object.assign({ scope }, params || {});
    return {
      get: key => call('storage.get', withScope({ key })),
      set: (key, value) => call('storage.set', withScope({ key, value })),
      remove: key => call('storage.remove', withScope({ key })),
      clear: () => call('storage.clear', withScope()),
      keys: () => call('storage.keys', withScope()),
      getMany: keys => call('storage.getMany', withScope({ keys })),
      setMany: values => call('storage.setMany', withScope({ values })),
      getSchemaVersion: () => call('storage.getSchemaVersion', withScope()),
      setSchemaVersion: value => call('storage.setSchemaVersion', withScope({ value })),
      getUsage: () => call('storage.getUsage', withScope())
    };
  }

  const privateStorage = scopedStorage('private');
  const publicStorage = scopedStorage('public');
  window.addEventListener('mini.runtimeTimer', event => {
    const id = event && event.detail && event.detail.id;
    if (typeof id === 'string') window.__miniRuntimeEvent('timer.' + id, { id });
  });
  window.__miniRuntimeResolve = function (raw) {
    const response = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    response.success ? item.resolve(response.result) : item.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
  };
  window.__miniRuntimeEvent = (name, payload) => (events.get(name) || []).slice().forEach(fn => { try { fn(payload); } catch (_) {} });
  // Native hosts await this promise with a short timeout. `handled()` is deliberately
  // synchronous so a hung handler never blocks the platform Back/Escape behaviour.
  window.__miniRuntimeBackRequested = () => {
    let handled = false;
    const event = { handled: () => { handled = true; } };
    try { (events.get('navigation.backRequested') || []).forEach(fn => fn(event)); } catch (_) { }
    return handled;
  };
  window.mini = {
    app: { getInfo: () => call('app.getInfo'), getAppInfo: () => call('app.getAppInfo'), close: () => call('app.close'), getRuntimeVersion: () => call('app.getRuntimeVersion'), getLaunchParams: () => call('app.getLaunchParams'), setWindowTitle: title => call('app.setWindowTitle', { title }), onBackRequested: fn => window.mini.events.on('navigation.backRequested', event => { if (fn() === true) event.handled(); }) },
    runtime: { getCapabilities: () => call('runtime.getCapabilities'), supports: name => call('runtime.supports', { name }) },
    navigation: { setBackEnabled: enabled => call('navigation.setBackEnabled', { enabled }), getState: () => call('navigation.getState') },
    storage: Object.assign({}, privateStorage, { private: privateStorage, public: publicStorage, getPublic: key => publicStorage.get(key), setPublic: (key, value) => publicStorage.set(key, value), removePublic: key => publicStorage.remove(key), clearPublic: () => publicStorage.clear(), publicKeys: () => publicStorage.keys(), getMany: keys => call('storage.getMany', { keys }), setMany: values => call('storage.setMany', { values }), transaction: transaction => call('storage.transaction', transaction) }),
    permissions: { query: permission => call('permissions.query', { permission }), request: permission => call('permissions.request', { permission }), openSettings: () => call('permissions.openSettings') },
    secureStorage: { get: key => call('secureStorage.get', { key }), set: (key, value) => call('secureStorage.set', { key, value }), remove: key => call('secureStorage.remove', { key }), keys: () => call('secureStorage.keys'), clear: () => call('secureStorage.clear') },
    device: { getInfo: () => call('device.getInfo') },
    network: { getStatus: () => call('network.getStatus'), request: options => call('network.request', options) },
    // Peer networking is deliberately exposed as opaque runtime operations.  A
    // mini-app receives neither network addresses nor socket handles; channel
    // ownership is enforced by the native host using the current manifest ID.
    peers: {
      startDiscovery: () => call('peers.startDiscovery'),
      stopDiscovery: () => call('peers.stopDiscovery'),
      list: () => call('peers.list'),
      connect: peerId => call('peers.connect', { peerId }),
      disconnect: peerId => call('peers.disconnect', { peerId }),
      connections: () => call('peers.connections'),
      openChannel: options => call('peers.openChannel', options),
      closeChannel: options => call('peers.closeChannel', options),
      sendMessage: options => call('peers.sendMessage', options),
      sendFile: options => call('peers.sendFile', options),
      acceptFile: options => call('peers.acceptFile', options),
      rejectFile: options => call('peers.rejectFile', options),
      cancelTransfer: options => call('peers.cancelTransfer', options),
      transfers: () => call('peers.transfers')
    },
    notifications: { requestPermission: () => call('notifications.requestPermission'), schedule: options => call('notifications.schedule', options), cancel: id => call('notifications.cancel', { id }), get: id => call('notifications.get', { id }), list: () => call('notifications.list'), cancelAll: () => call('notifications.cancelAll') },
    clipboard: { write: text => call('clipboard.write', { text }), readText: () => call('clipboard.readText'), getAvailableFormats: () => call('clipboard.getAvailableFormats') },
    files: {
      pick: options => call('files.pick', options),
      pickMultiple: options => call('files.pickMultiple', options),
      getInfo: id => call('files.getInfo', { id }),
      readText: id => call('files.readText', { id }),
      readBase64: id => call('files.readBase64', { id }),
      readChunk: (id, options) => call('files.readChunk', Object.assign({ id }, options || {})),
      readTextChunk: (id, options) => call('files.readTextChunk', Object.assign({ id }, options || {})),
      release: id => call('files.release', { id }),
      releaseMany: ids => call('files.releaseMany', { ids }),
      // Read-only handles for resources bundled with this mini-app. They never
      // expose an operating-system path and cannot be used for writes.
      getAppDirectory: () => call('files.getAppDirectory'),
      listAppDirectory: (id, options) => call('files.listAppDirectory', Object.assign({ id }, options || {})),
      pickDirectory: options => call('files.pickDirectory', options),
      listDirectory: (id, options) => call('files.listDirectory', Object.assign({ id }, options || {})),
      openInDirectory: (id, options) => call('files.openInDirectory', Object.assign({ id }, options || {})),
      createInDirectory: (id, options) => call('files.createInDirectory', Object.assign({ id }, options || {})),
      writeChunk: (id, options) => call('files.writeChunk', Object.assign({ id }, options || {})),
      flush: id => call('files.flush', { id }),
      persistDirectory: (id, options) => call('files.persistDirectory', Object.assign({ id }, options || {})),
      restoreDirectory: name => call('files.restoreDirectory', { name }),
      forgetDirectory: name => call('files.forgetDirectory', { name }),
      saveText: options => call('files.saveText', options),
      saveBase64: options => call('files.saveBase64', options)
    },
    share: {
      text: (text, options) => call('share.text', Object.assign({ text }, options || {})),
      file: options => call('share.file', options)
    },
    timers: { create: options => call('timer.create', options), pause: id => call('timer.pause', { id }), resume: id => call('timer.resume', { id }), cancel: id => call('timer.cancel', { id }), get: id => call('timer.get', { id }), list: () => call('timer.list') },
    ui: { setTopBar: config => call('ui.setTopBar', config), hideTopBar: () => call('ui.setTopBar', { visible: false }), alert: options => call('ui.alert', options), confirm: options => call('ui.confirm', options), prompt: options => call('ui.prompt', options), toast: options => call('ui.toast', options) },
    haptics: { impact: type => call('haptics.impact', { type }), selection: () => call('haptics.selection'), notification: type => call('haptics.notification', { type }) },
    system: { canOpenUrl: url => call('system.canOpenUrl', { url }), openUrl: url => call('system.openUrl', typeof url === 'string' ? { url } : url), openFile: options => call('system.openFile', options), openSettings: options => call('system.openSettings', options) },
    events: { on: (name, fn) => { const handlers = events.get(name) || []; handlers.push(fn); events.set(name, handlers); return () => events.set(name, (events.get(name) || []).filter(item => item !== fn)); } }
  };
}());

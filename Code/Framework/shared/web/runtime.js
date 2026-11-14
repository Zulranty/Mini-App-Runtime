(function () {
  'use strict';

  const pending = new Map();
  const events = new Map();
  const modules = new Map();
  const streams = new Map();
  let nextStream = 0;

  if (window.chrome?.webview) {
    const now = window.performance.now.bind(window.performance);
    let lastInput = -Infinity;
    const markInput = event => { if (event.isTrusted) lastInput = now(); };
    window.addEventListener('pointerdown', markInput, true);
    window.addEventListener('keydown', markInput, true);
    Object.defineProperty(window, '__miniRecentUserInput', {
      value: () => now() - lastInput <= 1_000
    });
  }

  function streamSource(read) {
    const source = 'stream-' + ++nextStream;
    const controller = new AbortController();
    streams.set(source, { read, signal: controller.signal });
    return {
      source,
      dispose() {
        streams.delete(source);
        controller.abort();
      }
    };
  }

  async function answerStream({ source, request, offset, length, waitUntil = 0 }) {
    const stream = streams.get(source);
    let data;
    if (stream) {
      stream.waitUntil ??= waitUntil;
      const requestController = new AbortController();
      const abort = () => requestController.abort();
      stream.signal.addEventListener('abort', abort, { once: true });
      const deadline = Date.now() + 40_000;
      let timer;
      function checkDeadline() {
        const remaining = Math.max(deadline, stream.waitUntil + 40_000) - Date.now();
        if (remaining <= 0) abort();
        else timer = setTimeout(checkDeadline, Math.min(remaining, 86_400_000));
      }
      checkDeadline();
      try {
        const bytes = await stream.read(offset, length, requestController.signal);
        if (bytes?.byteLength === length && !requestController.signal.aborted) {
          if (typeof bytes.toBase64 === 'function') data = bytes.toBase64();
          else {
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            data = btoa(binary);
          }
        }
      } catch {}
      finally {
        clearTimeout(timer);
        stream.signal.removeEventListener('abort', abort);
      }
    }
    await call('streams.reply', { request, data }).catch(() => {});
  }

  function loadModule(id) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id))
      return Promise.reject(Object.assign(new Error('Invalid module ID'), { code: 'invalid_module_id' }));
    if (modules.has(id)) return modules.get(id);
    const script = document.createElement('script');
    script.src = 'https://modules.miniapp.local/' + id + '/index.js';
    const loaded = new Promise((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        modules.delete(id);
        reject(Object.assign(new Error('Could not load module ' + id), { code: 'module_load_failed' }));
      };
    });
    modules.set(id, loaded);
    document.head.append(script);
    return loaded;
  }

  function post(raw) {
    if (window.MiniRuntime?.postMessage) {
      window.MiniRuntime.postMessage(raw);
      return;
    }
    if (window.MiniRuntime && typeof window.MiniRuntime.call === 'function') {
      window.MiniRuntime.call(raw); // Compatibility with earlier hosts
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
  events.set('streams.read', [request => { void answerStream(request); }]);
  events.set('streams.waitUntil', [({ source, until }) => {
    const stream = streams.get(source);
    if (stream) stream.waitUntil = until;
  }]);
  // Native hosts await this promise with a short timeout. `handled()` is deliberately
  // synchronous so a hung handler never blocks the platform Back/Escape behaviour.
  window.__miniRuntimeBackRequested = () => {
    let handled = false;
    const event = { handled: () => { handled = true; } };
    try { (events.get('navigation.backRequested') || []).forEach(fn => fn(event)); } catch (_) { }
    return handled;
  };
  window.mini = {
    locale: { get: () => call('locale.get') },
    app: { getInfo: () => call('app.getInfo'), getAppInfo: () => call('app.getAppInfo'), close: () => call('app.close'), getRuntimeVersion: () => call('app.getRuntimeVersion'), getLaunchParams: () => call('app.getLaunchParams'), setWindowTitle: title => call('app.setWindowTitle', { title }), onBackRequested: fn => window.mini.events.on('navigation.backRequested', event => { if (fn() === true) event.handled(); }) },
    runtime: { getCapabilities: () => call('runtime.getCapabilities'), supports: name => call('runtime.supports', { name }) },
    logs: { write: (event, fields) => call('logs.write', { event, fields }) },
    modules: { load: loadModule },
    streams: {
      async open(options, read) {
        const source = streamSource(read);
        try {
          const url = await call('streams.open', { ...options, source: source.source });
          return {
            url,
            close() {
              source.dispose();
              return call('streams.close', { source: source.source });
            }
          };
        } catch (error) {
          source.dispose();
          throw error;
        }
      },
      async save(options, read, signal) {
        if (signal?.aborted) return null;
        const source = streamSource(read);
        const cancel = () => {
          source.dispose();
          void call('streams.close', { source: source.source }).catch(() => {});
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          const method = options.directoryId === undefined ? 'streams.save' : 'streams.saveInDirectory';
          return await call(method, { ...options, source: source.source });
        } finally {
          signal?.removeEventListener('abort', cancel);
          source.dispose();
        }
      }
    },
    functions: { call },
    navigation: { setBackEnabled: enabled => call('navigation.setBackEnabled', { enabled }), getState: () => call('navigation.getState') },
    storage: Object.assign({}, privateStorage, { private: privateStorage, public: publicStorage, getPublic: key => publicStorage.get(key), setPublic: (key, value) => publicStorage.set(key, value), removePublic: key => publicStorage.remove(key), clearPublic: () => publicStorage.clear(), publicKeys: () => publicStorage.keys(), getMany: keys => call('storage.getMany', { keys }), setMany: values => call('storage.setMany', { values }), transaction: transaction => call('storage.transaction', transaction) }),
    permissions: { query: permission => call('permissions.query', { permission }), request: permission => call('permissions.request', { permission }), openSettings: () => call('permissions.openSettings') },
    secureStorage: { get: key => call('secureStorage.get', { key }), set: (key, value) => call('secureStorage.set', { key, value }), remove: key => call('secureStorage.remove', { key }), keys: () => call('secureStorage.keys'), clear: () => call('secureStorage.clear') },
    device: { getInfo: () => call('device.getInfo') },
    network: { getStatus: () => call('network.getStatus'), request: options => call('network.request', options), discoverDevices: options => call('network.discoverDevices', options), requestDevice: options => call('network.requestDevice', options) },
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
      writeChecked: (id, options) => call('files.writeChecked', { ...options, id }),
      releaseDirectory: id => call('files.releaseDirectory', { id }),
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

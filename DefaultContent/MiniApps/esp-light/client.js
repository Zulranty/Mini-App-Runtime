(function (root) {
  'use strict';
  const SERVICE = 'miniapp-light';
  const error = (code, message) => Object.assign(new Error(message), { code });
  const EFFECTS = ['color', 'wheel', 'rainbow', 'fire', 'custom'];
  const RAINBOW_MODES = ['forward','side','down','up'];
  function validateFire(fire) {
    if (!fire || !['speed','height','width','smooth','intensity'].every(key=>Number.isInteger(fire[key])&&fire[key]>=(['smooth','intensity'].includes(key)?0:1)&&fire[key]<=100) ||
        typeof fire.color!=='string'||fire.color.length!==7||!/^#[0-9a-f]{6}$/i.test(fire.color)) throw error('protocol_mismatch','Некорректные настройки огня');
    return fire;
  }
  function validateInfo(info, deviceId) {
    if (info?.service !== SERVICE || ![2,3].includes(info.version)) throw error('firmware_update_required', 'Загрузите обновлённый скетч MiniAppLight с режимами и 3D-раскладкой.');
    const layout = info.layout;
    let end = 0;
    if (info.deviceId !== deviceId || !Number.isInteger(info.ledCount) || info.ledCount < 1 || info.ledCount > 512 ||
        !layout || !Number.isInteger(layout.rows) || layout.rows < 1 || layout.rows > info.ledCount ||
        !Array.isArray(layout.rowStarts) || !Array.isArray(layout.rowLengths) || layout.rowStarts.length !== layout.rows || layout.rowLengths.length !== layout.rows ||
        typeof layout.serpentine !== 'boolean' || !Number.isFinite(layout.radiusMm) || layout.radiusMm <= 0 || layout.radiusMm > 10000 ||
        (layout.columns !== undefined && (!Number.isInteger(layout.columns) || layout.columns < 1 || layout.columns > 512)) ||
        !Number.isFinite(layout.heightMm) || layout.heightMm <= 0 || layout.heightMm > 10000 ||
        !Array.isArray(info.effects) || !EFFECTS.every(effect => info.effects.includes(effect))) throw error('protocol_mismatch', 'Некорректная раскладка лампы');
    for (let row = 0; row < layout.rows; row++) {
      const count = layout.rowLengths[row];
      if (layout.rowStarts[row] !== end || !Number.isInteger(count) || count < 1 || end + count > info.ledCount ||
          (layout.columns !== undefined && count > layout.columns)) throw error('protocol_mismatch', 'Некорректная раскладка лампы');
      end += count;
    }
    if (end !== info.ledCount) throw error('protocol_mismatch', 'Раскладка не соответствует числу LED');
    if (layout.anglesDeg !== undefined || layout.heightsMm !== undefined) {
      if (!Array.isArray(layout.anglesDeg) || !Array.isArray(layout.heightsMm) ||
          layout.anglesDeg.length !== info.ledCount || layout.heightsMm.length !== info.ledCount)
        throw error('protocol_mismatch', 'Некорректная физическая геометрия лампы');
      for (let i = 0; i < info.ledCount; i++) {
        if (!Number.isFinite(layout.anglesDeg[i]) || layout.anglesDeg[i] < 0 || layout.anglesDeg[i] > 360 ||
            !Number.isFinite(layout.heightsMm[i]) || layout.heightsMm[i] < 0 || layout.heightsMm[i] > layout.heightMm)
          throw error('protocol_mismatch', 'Некорректная физическая геометрия лампы');
      }
    }
    if(info.version===3){
      if(!Number.isInteger(info.maxCurrentMa)||info.maxCurrentMa<1||info.maxCurrentMa>65535||!Number.isInteger(info.maxTimerMinutes)||info.maxTimerMinutes<1||info.maxTimerMinutes>1440)
        throw error('protocol_mismatch','Некорректные ограничения лампы');
      validateFire(info.fireDefaults);
    }
    return info;
  }
  function validateState(state, info) {
    if (state?.deviceId !== info.deviceId || typeof state.on !== 'boolean' || !Number.isInteger(state.brightness) || state.brightness < 0 || state.brightness > 255 ||
        typeof state.color !== 'string' || state.color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(state.color) || !EFFECTS.includes(state.effect) ||
        typeof state.pixels !== 'string' || state.pixels.length !== info.ledCount * 6 || /[^0-9a-f]/i.test(state.pixels)) throw error('protocol_mismatch', 'Некорректное состояние лампы');
    if(info.version===3){
      if(!Number.isInteger(state.brightnessPercent)||state.brightnessPercent<0||state.brightnessPercent>100||
          state.brightness!==Math.round(state.brightnessPercent*255/100)||
          state.currentLimitMa!==Math.round(info.maxCurrentMa*state.brightnessPercent/100)||!RAINBOW_MODES.includes(state.rainbowMode)||
          !state.timer||typeof state.timer.active!=='boolean'||!Number.isInteger(state.timer.minutes)||state.timer.minutes<0||state.timer.minutes>info.maxTimerMinutes||
          !Number.isInteger(state.timer.remainingSeconds)||state.timer.remainingSeconds<0||state.timer.remainingSeconds>state.timer.minutes*60||
          (state.timer.active&&state.timer.minutes===0)||(!state.timer.active&&state.timer.remainingSeconds!==0))throw error('protocol_mismatch','Некорректные параметры лампы');
      validateFire(state.fire);
    }
    return state;
  }

  class LightClient {
    constructor(mini, update) {
      this.mini = mini;
      this.update = update;
      this.devices = [];
      this.connection = null;
      this.preferred = null;
      this.lastDiscovery = 0;
      this.running = false;
      this.paused = false;
      this.timer = null;
      this.cycle = null;
      this.message = 'Подготовка…';
    }
    notify(message) {
      if (message) this.message = message;
      this.update({ devices: this.devices, selected: this.connection?.device.id,
        info: this.connection?.info, state: this.connection?.state,
        busy: !!this.connection?.writing, message: this.message });
    }
    async start(grant = false) {
      if (!await this.mini.runtime.supports('network.discoverDevices') || !await this.mini.runtime.supports('network.requestDevice')) {
        this.notify('Нужен MiniApp Runtime 1.5.0 или новее с поиском локальных устройств.');
        return false;
      }
      if (!grant && await this.mini.permissions.query('network') !== 'granted') {
        this.notify('Разрешите поиск устройств в домашней сети.');
        return false;
      }
      if (await this.mini.permissions.query('storage') === 'granted') this.preferred = await this.mini.storage.get('deviceId');
      this.running = true; this.paused = false;
      await this.tick();
      return true;
    }
    async tick() {
      if (!this.running || this.paused || this.cycle) return;
      clearTimeout(this.timer);
      this.cycle = this.refresh();
      try { await this.cycle; }
      catch (e) {
        if (!this.running || this.paused) return;
        if (['permission_denied', 'network_permission_denied', 'permission_not_declared'].includes(e.code)) {
          this.running = false; this.notify('Доступ к сети запрещён. Разрешите его в настройках мини‑аппки.');
        } else {
          this.lastDiscovery = 0;
          if (this.connection) this.connection.state = null;
          if (this.connection && e.code === 'protocol_mismatch') this.connection.info = null;
          this.notify(['firmware_update_required', 'protocol_mismatch'].includes(e.code) ? e.message : 'Устройство недоступно. Повторяю поиск…');
        }
      } finally {
        this.cycle = null;
        if (this.running && !this.paused) this.timer = setTimeout(() => this.tick(), 4000);
      }
    }
    async refresh() {
      if (!this.connection || Date.now() - this.lastDiscovery >= 20000) {
        this.notify('Ищу ESP в домашней сети…');
        const devices = await this.mini.network.discoverDevices({ service: SERVICE, timeoutMs: 2500 });
        if (!this.running || this.paused) return;
        this.devices = devices; this.lastDiscovery = Date.now();
        const current = devices.find(d => d.id === this.connection?.device.id);
        if (!current) {
          this.connection = null;
          const next = devices.find(d => d.deviceId === this.preferred) || (devices.length === 1 ? devices[0] : null);
          if (next) this.select(next.id);
        }
        this.notify(devices.length ? (this.connection ? 'Устройство найдено.' : 'Выберите лампу.') : 'ESP не найдена. Проверьте питание и подключение к тому же Wi‑Fi.');
      }
      const connection = this.connection;
      if (!connection || connection.writing) return;
      if (!connection.info) {
        const info = await this.request(connection, '/api/info');
        if (!this.active(connection)) return;
        connection.info = validateInfo(info, connection.device.deviceId);
      }
      const revision = connection.revision;
      const state = await this.request(connection, '/api/state');
      if (this.active(connection) && !connection.writing && connection.revision === revision) { connection.state = state; this.notify('Подключено'); }
    }
    active(connection) { return this.running && !this.paused && this.connection === connection; }
    select(id) {
      const device = this.devices.find(d => d.id === id);
      if (!device) return;
      this.connection = { device, info: null, state: null, queue: Promise.resolve(), writing: 0, revision: 0 };
      this.preferred = device.deviceId;
      this.notify('Подключаюсь к ' + device.name + '…');
    }
    async choose(id) {
      this.select(id);
      if (await this.mini.permissions.query('storage') === 'granted') await this.mini.storage.set('deviceId', this.preferred);
      if (this.cycle) await this.cycle.catch(() => {});
      await this.tick();
    }
    async request(connection, path, patch) {
      const options = { id: connection.device.id, path, method: patch ? 'POST' : 'GET', timeoutMs: 4000 };
      if (patch) options.body = new URLSearchParams(Object.entries(patch).map(([key, value]) =>
        [key, key === 'on' ? (value ? '1' : '0') : ['color', 'pixel','fireColor'].includes(key) ? value.slice(1).toLowerCase() : key==='pixels'?value.toLowerCase():String(value)])).toString();
      const response = await this.mini.network.requestDevice(options);
      if (response.status === 401) {
        if (this.active(connection)) connection.state = null;
        throw error('firmware_update_required', 'На ESP старая прошивка с ключом. Загрузите новый скетч MiniAppLight без сопряжения.');
      }
      if (!response.ok) throw error('device_error', 'Устройство вернуло ошибку ' + response.status);
      let data;
      try { data = JSON.parse(response.body.data); } catch (_) { throw error('protocol_mismatch', 'Некорректный ответ устройства'); }
      if (data.deviceId !== connection.device.deviceId) throw error('protocol_mismatch', 'Ответ другого устройства');
      if (path === '/api/state') validateState(data, connection.info);
      if (path === '/api/sync') validateState(data.state, validateInfo(data.info, connection.device.deviceId));
      return data;
    }
    sync() {
      const connection = this.connection;
      if (!connection?.state) return Promise.reject(error('device_not_connected', 'Сначала подключитесь к лампе'));
      connection.revision++; connection.writing++; this.notify();
      const task = connection.queue.catch(() => {}).then(async () => {
        if (!this.active(connection)) return;
        const snapshot = await this.request(connection, '/api/sync');
        if (this.active(connection)) { connection.info = snapshot.info; connection.state = snapshot.state; this.notify('Синхронизировано'); }
      });
      connection.queue = task;
      return task.finally(() => { connection.writing--; if (this.active(connection)) this.notify(); });
    }
    setPixel(index, color, toggle = false) {
      if (!Number.isInteger(index) || index < 0 || index >= (this.connection?.info?.ledCount ?? 0) || typeof color !== 'string' || color.length !== 7 || !/^#[a-f0-9]{6}$/i.test(color))
        return Promise.reject(error('invalid_pixel', 'Некорректный LED или цвет'));
      return this.patch({ index, pixel: color, effect: 'custom', on: true, ...(toggle?{toggle:1}:{}) });
    }
    patch(patch) {
      const connection = this.connection;
      if (!connection?.state) return Promise.reject(error('device_not_connected', 'Подключитесь к лампе'));
      connection.revision++; connection.writing++; this.notify();
      const task = connection.queue.catch(() => {}).then(async () => {
        if (!this.active(connection)) return;
        const state = await this.request(connection, '/api/state', patch);
        if (this.active(connection)) { connection.state = state; this.notify('Подключено'); }
      });
      connection.queue = task;
      return task.finally(() => { connection.writing--; if (this.active(connection)) this.notify(); });
    }
    async search() {
      if (this.cycle) await this.cycle.catch(() => {});
      this.lastDiscovery = 0;
      return this.tick();
    }
    pause() { this.paused = true; clearTimeout(this.timer); }
    async resume() {
      if (!this.running) return;
      this.paused = false;
      if (this.cycle) await this.cycle.catch(() => {});
      this.lastDiscovery = 0;
      await this.tick();
    }
    stop() { this.running = false; this.paused = true; this.connection = null; clearTimeout(this.timer); this.timer = null; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { LightClient, validateInfo, validateState };
  else root.LightClient = LightClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);

'use strict';

const byId = id => document.getElementById(id);
const welcome = byId('welcome');
const login = byId('login');
const challenge = byId('challenge');
const answer = byId('answer');
const resend = byId('resend');
const resendStatus = byId('resend-status');
const resetEmail = byId('reset-email');
const resetEmailStatus = byId('reset-email-status');
const openFragment = byId('open-fragment');
const switchQr = byId('switch-qr');
const qrPanel = byId('qr-panel');
const qrCode = byId('qr-code');
const workspace = byId('workspace');
const chatList = byId('chat-list');
const messageList = byId('messages');
const historyPane = byId('history');
const draft = byId('draft');
const telegramStorage = {
  production: { sessionKey: 'telegram.session.v1', futureAuthKey: 'telegram.futureAuth.v1' },
  test: { sessionKey: 'telegram.test.session.v1', futureAuthKey: 'telegram.test.futureAuth.v1' }
};
const telegramServiceChat = '777000';
const chats = new Map();
const drafts = new Map();
const newDevices = new Map();
let library;
let saved;
let hasFutureTokens = false;
let client;
let pendingAnswer;
let resendTimer;
let fragmentUrl;
let qrExpiry;
let qrController;
let selected;
let messages = [];
let busy = false;
let sharedSignIn = false;
let testServers = false;
let writeLoginLog = false;
let bundledApi;
let useBundledApi = false;
let clientMetadata;
let loginLogStarted;
let loginLogAttempt;

function logLogin(event, fields = {}) {
  if (!writeLoginLog) return;
  const elapsedMs = Math.max(0, Date.now() - loginLogStarted);
  void mini.logs.write('telegram.' + event, { attempt: loginLogAttempt, elapsedMs, ...fields }).catch(() => {});
}

function startLoginLog(usingBundledApi, useQr) {
  loginLogStarted = Date.now();
  loginLogAttempt = loginLogStarted.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  logLogin(useQr ? 'qr.start' : 'phone.start', {
    credentials: usingBundledApi ? 'bundled' : 'manual', environment: testServers ? 'test' : 'production'
  });
  if (!(useQr ? library.qrLoginDiagnostics : library.phoneLoginDiagnostics) || !library.supportsClientMetadata)
    logLogin('module.update_required');
}

const errors = {
  TELEGRAM_TEST_SERVER_MISMATCH: 'Telegram не подтвердил подключение к тестовому серверу.',
  AUTH_USER_CANCEL: 'Вход отменён.',
  SESSION_SAVE_REQUIRED: 'MiniApps не смог сохранить сеанс. Разрешите доступ к защищённому хранилищу и повторите вход.',
  API_ID_INVALID: 'Проверьте API ID и API hash.',
  API_HASH_INVALID: 'Проверьте API ID и API hash.',
  API_ID_PUBLISHED_FLOOD: 'Telegram отклонил API ID. Введите собственные реквизиты.',
  BUNDLED_API_INVALID: 'Telegram отклонил реквизиты из сборки. Введите свой API ID и API hash.',
  PHONE_NUMBER_INVALID: 'Проверьте номер телефона и код страны.',
  PHONE_NUMBER_BANNED: 'Telegram заблокировал вход для этого номера.',
  PHONE_NUMBER_FLOOD: 'Telegram ограничил число запросов кода для этого номера. Повторите позже.',
  PHONE_PASSWORD_FLOOD: 'Telegram ограничил число попыток входа. Повторите позже.',
  PHONE_NUMBER_APP_SIGNUP_FORBIDDEN: 'Telegram не разрешает создать аккаунт через этот клиент. Сначала зарегистрируйтесь в официальном Telegram.',
  SMS_CODE_CREATE_FAILED: 'Telegram не смог отправить SMS. Попробуйте вход по QR с устройства, где аккаунт уже открыт.',
  UPDATE_APP_TO_LOGIN: 'Telegram отклонил версию клиента. Попробуйте войти по QR или через официальный Telegram.',
  AUTH_TOKEN_EXPIRED: 'QR-код устарел. Нажмите «Войти по QR» и отсканируйте новый код.',
  QR_LOGIN_UNEXPECTED: 'Telegram не подтвердил вход по QR. Попробуйте открыть новый код.',
  PHONE_CODE_INVALID: 'Код не подошёл. Введите его ещё раз.',
  PHONE_CODE_EXPIRED: 'Код устарел. Запросите новый.',
  SEND_CODE_UNAVAILABLE: 'Telegram не предлагает повторную доставку. Попробуйте вход по QR.',
  SEND_CODE_WAIT: 'Дождитесь окончания отсчёта перед повторным запросом.',
  PHONE_LOGIN_UNEXPECTED: 'Telegram вернул неизвестный ответ на запрос входа.',
  AUTH_RESTART: 'Telegram попросил начать вход заново. Запросите новый код.',
  PHONE_DELIVERY_UNSUPPORTED: 'Этот способ доставки кода недоступен в MiniApps. Попробуйте вход по QR.',
  PHONE_LOGIN_PAYMENT_REQUIRED: 'Telegram требует завершить этот вход в официальном приложении.',
  PHONE_ACCOUNT_REQUIRED: 'Сначала зарегистрируйте этот номер в официальном Telegram.',
  EMAIL_RESET_WAIT: 'Telegram ещё не разрешил завершить сброс почты.',
  EMAIL_NOT_ALLOWED: 'Telegram не разрешил использовать этот адрес. Введите другой.',
  TELEGRAM_AUTHORIZATION_UNCONFIRMED: 'Telegram не подтвердил действие с устройством. Повторите попытку.',
  telegram_capture_protection_failed: 'MiniApps не смог защитить служебный чат от захвата экрана.',
  PASSWORD_HASH_INVALID: 'Пароль не подошёл. Введите его ещё раз.',
  EMAIL_INVALID: 'Проверьте адрес электронной почты.',
  EMAIL_VERIFY_CODE_INVALID: 'Код из письма не подошёл. Введите его ещё раз.',
  CODE_INVALID: 'Код не подошёл. Введите его ещё раз.',
  CHAT_WRITE_FORBIDDEN: 'У вас нет права отправлять сообщения в этот чат.',
  CHANNEL_PRIVATE: 'Этот чат недоступен для вашего аккаунта.',
  SESSION_EXPIRED: 'Сеанс завершён. Войдите снова.',
  telegram_session_busy: 'Этот вход уже использует другая мини-аппка. Закройте её и повторите вход.',
  telegram_session_unavailable: 'Не удалось заблокировать общий сеанс Telegram. Откройте мини-аппку заново.',
  telegram_runtime_update_required: 'Обновите MiniApps для безопасного общего входа в Telegram.',
  FROZEN_METHOD_INVALID: 'Telegram ограничил аккаунт. Откройте официальный Telegram, чтобы увидеть причину и возможность обжалования.',
  LOGOUT_UNCONFIRMED: 'Telegram не подтвердил выход. Завершите сеанс в настройках Telegram или повторите попытку.',
  PEER_FLOOD: 'Telegram ограничил отправку. Планирование остановлено.',
  SCHEDULE_MODULE_REQUIRED: 'Для отложенных сообщений обновите общий модуль Telegram.',
  SCHEDULE_CHAT_COUNT: 'Выберите от 1 до 10 чатов.',
  SCHEDULE_DELIVERY_LIMIT: 'Выберите не больше 30 отправок за раз. Каждый чат на каждый день считается отдельно.',
  SCHEDULE_INVALID_DAY: 'Проверьте даты и местное время отправки для каждого дня.',
  SCHEDULE_DUPLICATE_DAY: 'Один день указан несколько раз. Уберите повторяющиеся даты.',
  SCHEDULE_NO_PENDING: 'Эти отправки уже обработаны. Выберите другие дни или начните новый черновик.',
  SCHEDULE_TEXT_LIMIT: 'Введите текст или добавьте файлы. Максимум 4096 знаков для текста и 1024 для подписи.',
  SCHEDULE_LEAD_TIME: 'Выберите более позднее время. Для постановки в очередь требуется запас не менее 45 секунд.',
  SCHEDULE_TOO_MUCH: 'В чате заполнена очередь отложенных сообщений.',
  SCHEDULE_DATE_TOO_LATE: 'Telegram не позволяет запланировать отправку так далеко.',
  SCHEDULE_FILE_LIMIT: 'Можно прикрепить до 10 непустых файлов размером до 2 ГБ каждый.',
  SCHEDULE_FILE_INCOMPLETE: 'Не удалось прочитать файл целиком. Выберите его заново.',
  SCHEDULE_UPLOAD_UNCONFIRMED: 'Telegram не подтвердил загрузку файла. Проверьте соединение.',
  SCHEDULE_QUEUE_CHANGED: 'Очередь изменилась во время проверки. Обновите список.',
  CHAT_ADMIN_REQUIRED: 'Telegram требует права администратора для этого чата.',
  CHAT_SEND_DOCS_FORBIDDEN: 'Telegram запрещает отправку файлов в этот чат.',
  ALLOW_PAYMENT_REQUIRED: 'В этом чате отправка требует оплаты в Telegram Stars.'
};

function errorCode(error) {
  return error?.errorMessage || (typeof error?.code === 'string' ? error.code : error?.message);
}

function describe(error) {
  const code = errorCode(error);
  if (Object.prototype.hasOwnProperty.call(errors, code)) return errors[code];
  if (/^RECAPTCHA_CHECK_/.test(code)) return 'Telegram требует завершить этот вход в официальном приложении.';
  const seconds = /^(?:FLOOD|SLOWMODE)_WAIT_(\d+)$/.exec(code)?.[1] || error?.seconds;
  if (Number(seconds) > 0) return `Telegram просит повторить через ${Number(seconds)} с.`;
  if (error?.code === 'permission_denied') return 'MiniApps не получил доступ к защищённому хранилищу.';
  if (/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.errorMessage ?? ''))
    return 'Telegram отклонил запрос (' + error.errorMessage + ').';
  return 'Операция не выполнена. Проверьте подключение к Telegram и повторите.';
}

function status(text, isError = false) {
  byId('status').textContent = text;
  byId('status').classList.toggle('error', isError);
}

function environmentStorage() {
  return testServers ? telegramStorage.test : telegramStorage.production;
}

async function readFutureTokens(futureAuthKey = environmentStorage().futureAuthKey) {
  const entries = await mini.secureStorage.get(futureAuthKey);
  return Array.isArray(entries) ? entries.filter(entry => Number.isInteger(entry?.apiId) &&
    typeof entry.token === 'string' && /^(?:[\da-f]{2}){1,512}$/.test(entry.token)).slice(0, 20) : [];
}

function createTelegramClient(record, remember = true) {
  const { futureAuthKey } = environmentStorage();
  return library.createClient({ ...record,
    testServers,
    clientMetadata,
    onFutureAuthToken: remember ? async token => {
      try {
        const entries = await readFutureTokens(futureAuthKey);
        await mini.secureStorage.set(futureAuthKey, [{ apiId: record.apiId, token },
          ...entries.filter(entry => entry.token !== token)].slice(0, 20));
        hasFutureTokens = true;
      } catch {
        if (loginLogAttempt) logLogin('storage.future_token_failed');
      }
    } : undefined,
    onNewAuthorization: device => {
      newDevices.set(device.id, device);
      renderNewDevices();
    },
    onScheduledChange: () => scheduler.changed(),
    onFloodWait: until => status('Telegram ограничил запросы. Продолжим после ' + new Date(until).toLocaleTimeString('ru') + '.'),
    onServiceNotice: notice => {
      if (!notice.text || signInCodes(notice.text).length) return;
      if (notice.popup) void mini.ui.alert({ title: 'Telegram', message: notice.text }).catch(() => {});
      else status(notice.text);
    }
  });
}

function credentials(apiId, apiHash) {
  if (typeof apiId === 'string' && /^\d+$/.test(apiId)) apiId = Number(apiId);
  if (Number.isInteger(apiId) && apiId > 0 && apiId <= 2147483647 &&
      typeof apiHash === 'string' && /^[a-f\d]{32}$/i.test(apiHash)) return { apiId, apiHash };
}

function renderCredentials() {
  const fields = byId('api-fields');
  fields.hidden = fields.disabled = useBundledApi;
  byId('bundled-api').hidden = !useBundledApi;
  byId('manual-api').hidden = !bundledApi;
  byId('manual-api').textContent = useBundledApi ? 'Ввести свои API ID и API hash' : 'Использовать реквизиты из сборки';
}

function showWelcome() {
  renderCredentials();
  welcome.hidden = false;
  login.hidden = Boolean(saved);
  byId('saved-login').hidden = !saved;
  byId('forget-future').hidden = Boolean(saved) || !hasFutureTokens;
  byId('shared-login-note').hidden = !sharedSignIn;
  byId('cancel-shared-login').hidden = !sharedSignIn;
  byId('test-account-note').hidden = !testServers;
  if (sharedSignIn) login.elements.remember.checked = true;
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('main button, main input, main textarea').forEach(control => {
    if (!challenge.contains(control) && !qrPanel.contains(control)) control.disabled = value;
  });
  workspace.setAttribute('aria-busy', String(value));
  scheduler.setBusy(value);
}

async function run(task) {
  if (busy) return;
  status('');
  setBusy(true);
  try {
    await task();
  } catch (error) {
    if (error?.code === 401 && !byId('workspace-nav').hidden) {
      await leaveWorkspace({ keepDraft: true });
      try {
        await forgetSaved();
        showWelcome();
        status(errors.SESSION_EXPIRED, true);
      } catch (storageError) {
        status(describe(storageError), true);
      }
    } else status(describe(error), true);
  } finally {
    setBusy(false);
  }
}

async function loadModule() {
  status('Загружаем модуль Telegram…');
  let useTestServer;
  try {
    const [launchParams, settings] = await Promise.all([
      mini.app.getLaunchParams(), mini.functions.call('telegram.getSettings')
    ]);
    sharedSignIn = launchParams.reason === 'telegramSignIn';
    writeLoginLog = settings.writeLoginLog === true;
    useTestServer = !sharedSignIn && settings.testServer === true;
    if (!bundledApi) {
      const record = await mini.functions.call('telegram.getAppCredentials').catch(() => null);
      bundledApi = credentials(record?.api_id, record?.api_hash);
      useBundledApi = Boolean(bundledApi);
    }
    await mini.modules.load('telegram');
    if (window.MiniAppTelegram?.version !== 1 || window.MiniAppTelegram.phoneLoginVersion !== 2 ||
        !window.MiniAppTelegram.protectsSession) {
      status('Модуль несовместим. Замените его и откройте мини-апку заново.', true);
      byId('module-panel').hidden = false;
      return;
    }
    library = window.MiniAppTelegram;
    if (useTestServer && (!library.supportsTestServers || !await mini.runtime.supports('telegram.acquireTest'))) {
      status('Тестовый сервер недоступен. Обновите MiniApps и пакет Telegram в лаунчере.', true);
      byId('module-panel').hidden = false;
      return;
    }
    byId('login-qr').hidden = !library.supportsQrLogin;
    const [info, device] = await Promise.all([
      mini.app?.getInfo?.().catch(() => null),
      mini.device?.getInfo?.().catch(() => null)
    ]);
    const appVersion = typeof info?.version === 'string' && info.version.length > 0 && info.version.length <= 64
      ? info.version
      : undefined;
    const osVersion = device?.platform === 'android' ? device.androidVersion : device?.windowsVersion;
    const systemVersion = typeof osVersion === 'string' && osVersion.length > 0 && osVersion.length <= 120
      ? device.platform === 'android' ? `Android ${osVersion}` : osVersion
      : undefined;
    clientMetadata = { appVersion, systemVersion };
  } catch {
    status('Модуль Telegram недоступен.', true);
    byId('module-panel').hidden = false;
    return;
  }
  byId('module-panel').hidden = true;
  status('');
  try {
    await loadSavedEnvironment(useTestServer);
    if (saved) {
      await resume();
      return;
    }
  } catch (error) {
    if (welcome.hidden && byId('workspace-nav').hidden) showWelcome();
    throw error;
  }
  showWelcome();
}

async function loadSavedEnvironment(useTestServer) {
  const { sessionKey, futureAuthKey } = useTestServer ? telegramStorage.test : telegramStorage.production;
  const granted = await mini.permissions.query('secureStorage') === 'granted';
  const record = granted ? await mini.secureStorage.get(sessionKey) : undefined;
  const tokens = granted ? await readFutureTokens(futureAuthKey) : [];
  saved = record;
  hasFutureTokens = tokens.length > 0;
  testServers = useTestServer;
  byId('test-server-indicator').hidden = !testServers;
}

const prompts = {
  code: ['Код входа', 'Код из Telegram', 'text', 'numeric'],
  password: ['Двухфакторная аутентификация', 'Пароль Telegram', 'password', 'text'],
  email: ['Подтверждение почты', 'Адрес электронной почты', 'email', 'email'],
  emailCode: ['Код из письма', 'Код подтверждения', 'text', 'numeric']
};

function showDeliveryActions(delivery) {
  resend.hidden = !delivery?.nextType;
  resend.textContent = delivery.nextType === 'sms' ? 'Запросить код по SMS' : 'Запросить новый код';
  resetEmail.hidden = !delivery.emailReset;
  resetEmail.textContent = delivery.resetPendingDate ? 'Завершить сброс почты' : 'Запросить сброс почты';
  fragmentUrl = undefined;
  if (delivery.fragmentUrl) {
    try {
      const url = new URL(delivery.fragmentUrl);
      if (url.protocol === 'https:' && url.hostname === 'fragment.com' && !url.username && !url.password)
        fragmentUrl = url.href;
    } catch { /* The URL must point to Fragment before it can be opened. */ }
  }
  openFragment.hidden = !fragmentUrl;
  function updateCountdown() {
    const resendSeconds = Math.ceil(((delivery.resendAt ?? 0) - Date.now()) / 1000);
    const resetSeconds = Math.ceil(((delivery.resetPendingDate ?? 0) * 1000 - Date.now()) / 1000);
    resend.disabled = resendSeconds > 0;
    resetEmail.disabled = resetSeconds > 0;
    resendStatus.textContent = resend.hidden ? (delivery.responseType
      ? 'Telegram не предложил другой способ доставки. Если код не появился, можно войти по QR.' : '')
      : resendSeconds > 0 ? `Повторный запрос через ${resendSeconds} с.` : '';
    resetEmailStatus.textContent = resetSeconds > 0 ? `Сброс доступен после ${time.format(delivery.resetPendingDate * 1000)}.` : '';
    resendStatus.hidden = !resendStatus.textContent;
    resetEmailStatus.hidden = resetEmail.hidden || !resetEmailStatus.textContent;
    if ((!resend.hidden && resendSeconds > 0) || (!resetEmail.hidden && resetSeconds > 0))
      resendTimer = setTimeout(updateCountdown, 1000);
  }
  updateCountdown();
}

function ask(kind, hint, delivery = {}) {
  const [title, label, type, inputMode] = prompts[kind];
  if (!byId('status').classList.contains('error')) status('');
  byId('challenge-title').textContent = title;
  byId('challenge-label').textContent = kind === 'code' && delivery.type !== 'app' ? 'Код подтверждения' : label;
  byId('challenge-hint').textContent = hint || '';
  answer.type = type;
  answer.inputMode = ['smsWord', 'smsPhrase', 'flashCall'].includes(delivery?.type) ? 'text' : inputMode;
  answer.value = '';
  switchQr.hidden = kind === 'password' || !library.supportsQrLogin;
  showDeliveryActions(delivery);
  const response = byId('code-response');
  response.open = false;
  response.hidden = !delivery?.responseType;
  byId('code-response-text').textContent = delivery?.responseType
    ? `${delivery.responseType} · next_type=${delivery.nextResponseType ?? '—'} · timeout=${delivery.timeout ?? '—'}`
    : '';
  challenge.hidden = false;
  answer.focus();
  return new Promise((resolve, reject) => { pendingAnswer = { resolve, reject }; });
}

function answerChallenge(action) {
  if (!pendingAnswer) return;
  const { resolve, reject } = pendingAnswer;
  const value = answer.type === 'password' ? answer.value : answer.value.trim();
  if (action === 'submit' && !value) return;
  pendingAnswer = undefined;
  clearTimeout(resendTimer);
  answer.value = '';
  challenge.hidden = true;
  if (action === 'cancel') reject(new Error('AUTH_USER_CANCEL'));
  else if (action === 'qr') reject(new Error('AUTH_SWITCH_TO_QR'));
  else if (action === 'resetEmail') {
    status('Запрашиваем сброс почты…');
    resolve({ resetLoginEmail: true });
  }
  else if (action === 'resend') {
    status('Запрашиваем новый код…');
    resolve(null);
  } else {
    status('Проверяем данные…');
    resolve(value);
  }
}

function clearQrCode() {
  clearTimeout(qrExpiry);
  qrCode.hidden = true;
  qrCode.width = 0;
}

function showQrCode(matrix, expires) {
  clearQrCode();
  const remaining = expires * 1000 - Date.now();
  if (remaining <= 0) {
    status('Обновляем QR-код…');
    return;
  }
  const scale = 5;
  qrCode.width = qrCode.height = matrix.length * scale;
  const context = qrCode.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, qrCode.width, qrCode.height);
  context.fillStyle = '#000';
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) context.fillRect(x * scale, y * scale, scale, scale);
  }));
  qrCode.hidden = false;
  status('Ожидаем подтверждение в Telegram…');
  qrExpiry = setTimeout(() => {
    clearQrCode();
    status('Обновляем QR-код…');
  }, remaining);
}

async function signInByQr() {
  const controller = new AbortController();
  qrController = controller;
  qrPanel.hidden = false;
  status('Запрашиваем QR-код…');
  try {
    return await client.signInQr(showQrCode, (kind, hint) => {
      qrPanel.hidden = true;
      clearQrCode();
      logLogin('prompt.shown', { kind });
      return ask(kind, hint);
    }, authError, controller.signal, logLogin);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AUTH_USER_CANCEL');
    throw error;
  } finally {
    clearQrCode();
    qrPanel.hidden = true;
    qrController = undefined;
  }
}

function authError(error) {
  if (!['PHONE_CODE_INVALID', 'PASSWORD_HASH_INVALID', 'EMAIL_INVALID', 'EMAIL_NOT_ALLOWED', 'EMAIL_VERIFY_CODE_INVALID',
    'CODE_INVALID', 'SEND_CODE_WAIT', 'EMAIL_RESET_WAIT']
    .includes(errorCode(error))) throw error;
  status(describe(error), true);
  return false;
}

async function closeClient() {
  const previous = client;
  client = undefined;
  await previous?.close();
}

async function forgetSaved() {
  if (saved) await mini.secureStorage.remove(environmentStorage().sessionKey);
  saved = undefined;
}

async function signIn(useQr) {
  const fields = login.elements;
  const usingBundledApi = useBundledApi;
  const api = usingBundledApi ? bundledApi : credentials(fields.apiId.value.trim(), fields.apiHash.value.trim());
  const phone = fields.phone.value.replace(/[\s()-]/g, '');
  startLoginLog(usingBundledApi, useQr);
  if (!api) {
    logLogin('form.invalid_credentials');
    status('Введите числовой API ID и API hash из 32 символов.', true);
    return;
  }
  if (!useQr && !/^\+[1-9]\d{6,14}$/.test(phone)) {
    logLogin('form.invalid_phone');
    status('Введите номер в международном формате с + и кодом страны.', true);
    return;
  }
  const remember = sharedSignIn || fields.remember.checked;
  if (sharedSignIn && await mini.permissions.query('secureStorage') !== 'granted') {
    if (await mini.permissions.request('secureStorage') !== 'granted') {
      logLogin('storage.permission_denied');
      throw new Error('SESSION_SAVE_REQUIRED');
    }
  }
  fields.apiHash.value = '';
  welcome.hidden = true;
  status('Подключаемся к Telegram…');
  let name;
  try {
    let tokens = [];
    if (remember) {
      if (!sharedSignIn && await mini.permissions.query('secureStorage') !== 'granted')
        await mini.permissions.request('secureStorage').catch(() => {});
      if (!useQr) {
        try { tokens = (await readFutureTokens()).filter(entry => entry.apiId === api.apiId).map(entry => entry.token); }
        catch { logLogin('storage.future_token_read_failed'); }
      }
    }
    client = createTelegramClient(api, remember);
    if (useQr) name = await signInByQr();
    else {
      try {
        name = await client.signIn(phone, (kind, hint, delivery) => {
          logLogin('prompt.shown', { kind });
          return ask(kind, hint, delivery);
        }, authError, logLogin, tokens);
      } catch (error) {
        if (errorCode(error) !== 'AUTH_SWITCH_TO_QR') throw error;
        logLogin('phone.switched_to_qr');
        if (!library.qrLoginDiagnostics) logLogin('module.update_required');
        name = await signInByQr();
      }
    }
  } catch (error) {
    const code = errorCode(error);
    logLogin(code === 'AUTH_USER_CANCEL' ? 'login.cancelled' : 'login.failed', {
      code: Object.prototype.hasOwnProperty.call(errors, code) ? code : undefined
    });
    await closeClient().catch(() => logLogin('session.close_failed'));
    if (usingBundledApi && ['API_ID_INVALID', 'API_HASH_INVALID', 'API_ID_PUBLISHED_FLOOD'].includes(errorCode(error))) {
      bundledApi = undefined;
      useBundledApi = false;
      showWelcome();
      throw new Error('BUNDLED_API_INVALID');
    }
    showWelcome();
    throw error;
  }
  logLogin('login.authorized');
  login.reset();
  let storageFailed = false;
  if (remember) {
    try {
      const session = client.session();
      if (!session) throw new Error('SESSION_EMPTY');
      const record = { ...api, session };
      await mini.secureStorage.set(environmentStorage().sessionKey, record);
      saved = record;
    } catch {
      storageFailed = true;
    }
  }
  if (sharedSignIn) {
    await closeClient();
    if (storageFailed) {
      showWelcome();
      throw new Error('SESSION_SAVE_REQUIRED');
    }
    await mini.functions.call('telegram.finishSignIn');
    return;
  }
  await enterWorkspace(name);
  if (storageFailed) status('Вход выполнен. Сохранить сеанс в защищённом хранилище не удалось.', true);
}

async function resume() {
  status('Восстанавливаем сеанс…');
  let name;
  try {
    client = createTelegramClient(saved);
    name = await client.resume();
  } catch (error) {
    await closeClient();
    if (error.code === 401 || errorCode(error) === 'AUTH_KEY_DUPLICATED') {
      await forgetSaved();
      showWelcome();
      throw new Error('SESSION_EXPIRED');
    }
    throw error;
  }
  if (sharedSignIn) {
    await closeClient();
    await mini.functions.call('telegram.finishSignIn');
    return;
  }
  await enterWorkspace(name);
}

async function enterWorkspace(name) {
  welcome.hidden = true;
  byId('account').textContent = name || 'Личный аккаунт';
  const account = client.accountId?.();
  await scheduler.connect(client, library.reportsScheduleOutcomes ? library.scheduleLimits : null,
    account ? JSON.stringify([testServers, account]) : null);
  byId('logout').hidden = false;
  status('Загружаем чаты…');
  await loadChats(true);
  status('');
  void client.loadUnconfirmedAuthorizations().catch(() => {});
}

async function leaveWorkspace(options) {
  try { await closeClient(); }
  catch (error) { console.warn('Telegram connection cleanup failed:', error?.code); }
  await scheduler.disconnect(options);
  chats.clear();
  drafts.clear();
  newDevices.clear();
  renderNewDevices();
  chatList.replaceChildren();
  selectChat(undefined);
  workspace.hidden = true;
  byId('logout').hidden = true;
  byId('account').textContent = 'Личный аккаунт · MiniApps';
  showWelcome();
}

async function logout() {
  status('Завершаем сеанс…');
  const confirmed = await client.logout();
  await leaveWorkspace();
  if (!confirmed) throw new Error('LOGOUT_UNCONFIRMED');
  await forgetSaved();
  showWelcome();
  status('Сеанс завершён.');
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function renderNewDevices() {
  const list = byId('new-device-list');
  list.replaceChildren(...[...newDevices.values()].map(device => {
    const row = node('div', '', 'new-device');
    row.append(node('p', [device.device, device.location].filter(Boolean).join(' · ') || 'Новое устройство'));
    const actions = node('div', '', 'actions');
    for (const [label, confirmed] of [['Это я', true], ['Завершить сеанс', false]]) {
      const button = node('button', label);
      button.type = 'button';
      button.disabled = busy;
      button.addEventListener('click', () => run(async () => {
        await client.decideAuthorization(device.id, confirmed);
        newDevices.delete(device.id);
        renderNewDevices();
      }));
      actions.append(button);
    }
    row.append(actions);
    return row;
  }));
  byId('new-devices').hidden = !newDevices.size;
}

function signInCodes(text) {
  return [...text.matchAll(/(?<![\d-])\d(?:-*\d){4,6}(?!-*\d)/g)].map(match => match[0].replace(/-/g, ''));
}

async function invalidateCapturedCodes() {
  if (!client || selected !== telegramServiceChat || workspace.hidden) return;
  const viewport = historyPane.getBoundingClientRect();
  const codes = new Set(messages.flatMap((message, index) => {
    const row = messageList.children[index]?.getBoundingClientRect();
    return !message.outgoing && row?.bottom > viewport.top && row.top < viewport.bottom
      ? signInCodes(message.text) : [];
  }));
  if (!codes.size) return;
  try {
    await client.invalidateSignInCodes([...codes]);
    status('Telegram аннулировал коды входа, попавшие на снимок экрана.');
  } catch {
    status('Не удалось аннулировать коды со снимка. Запросите новый код для входа.', true);
  }
}

function renderChats() {
  const rows = [...chats.values()].map(chat => {
    const item = node('li');
    const button = node('button');
    button.type = 'button';
    button.dataset.chat = chat.id;
    button.disabled = busy;
    button.setAttribute('aria-current', String(chat.id === selected));
    const title = chat.unread ? `${chat.title} · ${chat.unread}` : chat.title;
    button.append(node('span', title, 'chat-name'));
    if (chat.id !== telegramServiceChat) button.append(node('small', chat.preview, 'preview'));
    item.append(button);
    return item;
  });
  chatList.replaceChildren(...(rows.length ? rows : [node('li', 'Чатов пока нет.', 'empty')]));
}

async function loadChats(reset) {
  const page = await client.chats(reset);
  if (reset) chats.clear();
  for (const chat of page.items) chats.set(chat.id, chat);
  byId('more-chats').hidden = !page.more;
  renderChats();
}

const time = new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' });
const scheduler = createScheduleView({ byId, node, status, run, describe, time });
function messageRow(message) {
  const item = node('li', '', message.outgoing ? 'message out' : 'message');
  const author = message.outgoing ? 'Вы' : message.sender;
  const date = message.date ? time.format(message.date * 1000) : '';
  item.append(node('small', [author, date].filter(Boolean).join(' · ')), node('div', message.text));
  return item;
}

function selectChat(id) {
  const leavingServiceChat = selected === telegramServiceChat && id !== telegramServiceChat;
  selected = id;
  messages = [];
  draft.value = drafts.get(id) || '';
  byId('chat-title').textContent = chats.get(id)?.title || 'Выберите чат';
  byId('compose').hidden = !id || id === telegramServiceChat;
  byId('refresh-chat').hidden = !id;
  byId('older').hidden = true;
  workspace.classList.toggle('chat-open', Boolean(id));
  messageList.replaceChildren();
  if (leavingServiceChat) void mini.functions.call('telegram.setCodeCaptureProtection', { enabled: false }).catch(() => {});
  for (const button of chatList.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.chat === id));
  }
}

async function loadMessages(older = false) {
  if (selected === telegramServiceChat) await mini.functions.call('telegram.setCodeCaptureProtection', { enabled: true });
  const before = older ? messages.find(message => !message.local)?.id : undefined;
  const page = await client.messages(selected, before);
  const oldHeight = historyPane.scrollHeight;
  const oldScroll = historyPane.scrollTop;
  messages = older ? [...page.items, ...messages] : page.items;
  messageList.replaceChildren(...(messages.length ? messages.map(messageRow) : [node('li', 'Сообщений пока нет.', 'empty')]));
  byId('older').hidden = !page.more;
  historyPane.scrollTop = older ? oldScroll + historyPane.scrollHeight - oldHeight : historyPane.scrollHeight;
  const latest = [...messages].reverse().find(message => !message.local);
  if (!older && latest) {
    await client.markRead(selected, latest.id);
    const chat = chats.get(selected);
    if (chat?.unread) {
      chat.unread = 0;
      renderChats();
    }
  }
}

async function send() {
  const text = draft.value;
  if (!text.trim()) return;
  status('Отправляем…');
  const message = await client.send(selected, text);
  draft.value = '';
  drafts.delete(selected);
  messages.push(message);
  messageList.querySelector('.empty')?.remove();
  messageList.append(messageRow(message));
  historyPane.scrollTop = historyPane.scrollHeight;
  status('Отправлено.');
}

function submit(form, action) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(action);
  });
}

login.addEventListener('submit', event => {
  event.preventDefault();
  run(() => signIn(event.submitter?.id === 'login-qr'));
});
submit(byId('compose'), send);
challenge.addEventListener('submit', event => {
  event.preventDefault();
  answerChallenge('submit');
});
byId('cancel').addEventListener('click', () => answerChallenge('cancel'));
resend.addEventListener('click', () => {
  if (!resend.hidden && !resend.disabled) answerChallenge('resend');
});
resetEmail.addEventListener('click', () => {
  if (!resetEmail.hidden && !resetEmail.disabled) answerChallenge('resetEmail');
});
openFragment.addEventListener('click', () => {
  if (fragmentUrl) void mini.system.openUrl(fragmentUrl).catch(error => status(describe(error), true));
});
switchQr.addEventListener('click', () => answerChallenge('qr'));
byId('cancel-qr').addEventListener('click', () => qrController?.abort());
byId('manual-api').addEventListener('click', () => {
  useBundledApi = Boolean(bundledApi) && !useBundledApi;
  renderCredentials();
});
byId('cancel-shared-login').addEventListener('click', () => void mini.app.close());
document.querySelectorAll('[data-telegram-help]').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    void mini.system.openUrl(link.href).catch(error => status(describe(error), true));
  });
});

byId('retry-module').addEventListener('click', () => run(loadModule));
byId('resume').addEventListener('click', () => run(resume));
byId('forget').addEventListener('click', () => run(async () => {
  await mini.secureStorage.remove(environmentStorage().futureAuthKey);
  hasFutureTokens = false;
  await forgetSaved();
  showWelcome();
}));
byId('forget-future').addEventListener('click', () => run(async () => {
  await mini.secureStorage.remove(environmentStorage().futureAuthKey);
  hasFutureTokens = false;
  showWelcome();
}));
mini.events.on('telegram.screenCaptured', () => void invalidateCapturedCodes());
byId('logout').addEventListener('click', () => run(logout));
byId('refresh-chats').addEventListener('click', () => run(() => loadChats(true)));
byId('more-chats').addEventListener('click', () => run(() => loadChats(false)));
byId('refresh-chat').addEventListener('click', () => run(() => loadMessages()));
byId('older').addEventListener('click', () => run(() => loadMessages(true)));
byId('back').addEventListener('click', () => selectChat(undefined));
chatList.addEventListener('click', event => {
  const id = event.target.closest('button')?.dataset.chat;
  if (id) run(async () => {
    selectChat(id);
    await loadMessages();
  });
});
draft.addEventListener('input', () => drafts.set(selected, draft.value));
window.addEventListener('pagehide', () => {
  qrController?.abort();
  void closeClient().catch(() => {});
});
run(loadModule);

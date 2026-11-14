import { createScheduler, scheduleLimits } from './scheduling.js';
import { Api, TelegramClient, helpers, utils } from 'teleproto';
import { Raw } from 'teleproto/events';
import { StringSession } from 'teleproto/sessions';
import { encode } from 'uqr';
import { Buffer } from 'buffer';

const deliveryHints = {
  app: 'Telegram выбрал доставку в служебный чат «Telegram». Проверьте этот чат в приложении, где уже открыт аккаунт с этим номером.',
  sms: 'Telegram выбрал доставку по SMS.',
  call: 'Telegram продиктует код по телефону.',
  flashCall: 'Введите номер входящего звонка, который сразу завершился.',
  missedCall: 'Введите последние цифры номера пропущенного звонка.',
  fragment: 'Telegram отправил код через Fragment.',
  smsWord: 'Введите слово из SMS.',
  smsPhrase: 'Введите фразу из SMS.'
};

const deliveryTypes = new Map([
  [Api.auth.SentCodeTypeApp, 'app'], [Api.auth.SentCodeTypeSms, 'sms'],
  [Api.auth.SentCodeTypeCall, 'call'], [Api.auth.SentCodeTypeFlashCall, 'flashCall'],
  [Api.auth.SentCodeTypeMissedCall, 'missedCall'], [Api.auth.SentCodeTypeFragmentSms, 'fragment'],
  [Api.auth.SentCodeTypeSmsWord, 'smsWord'], [Api.auth.SentCodeTypeSmsPhrase, 'smsPhrase']
]);

function displayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || '';
}

function toMessage(message) {
  return {
    id: message.id,
    date: message.date,
    outgoing: Boolean(message.out),
    sender: message.sender ? displayName(message.sender) || message.sender.title : undefined,
    text: message.message || (message.media ? 'Вложение' : 'Служебное сообщение')
  };
}

function canUseCloud(channel) {
  return channel instanceof Api.Channel && channel.broadcast && !channel.left &&
    !channel.username && !channel.usernames?.some(username => username.active) &&
    (channel.creator || channel.adminRights?.postMessages);
}

const shoppingTag = '#miniapps_shopping_list';
const shoppingPurchasesCaption = shoppingTag + '\nMiniApps Shopping Purchases v2';
const shoppingName = 'miniapps-shopping-list.json';
const shoppingMaxBytes = 1024 * 1024;
const shoppingHistoryBytes = 8 * shoppingMaxBytes;
function shoppingDocument(message) {
  const document = message?.media?.document;
  const caption = message?.message;
  return (caption === shoppingPurchasesCaption ||
    (typeof caption === 'string' && caption.startsWith(shoppingPurchasesCaption + '\n'))) && document instanceof Api.Document &&
    document.attributes?.some(attribute => attribute instanceof Api.DocumentAttributeFilename && attribute.fileName === shoppingName)
    ? document : null;
}

function shoppingPost(message) {
  const document = shoppingDocument(message);
  return document ? { document, signature: String(document.id) + ':' + (message.editDate ?? 0) + ':' + message.message } : null;
}

const folderMarker = '[MiniApps folder v1] ';
const fileMarker = '[MiniApps file v1] ';

function validCloudName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 255 &&
    name !== '.' && name !== '..' && !/[\\/\x00-\x1f]/.test(name);
}

function validCloudFolder(folder) {
  return typeof folder === 'string' && folder.length <= 1024 &&
    (folder === '' || folder.split('/').every(validCloudName));
}

function readMarker(text, prefix) {
  if (!text?.startsWith(prefix)) return;
  try { return JSON.parse(text.slice(prefix.length).split('\n', 1)[0]); }
  catch { return undefined; }
}

function cloudFolder(message) {
  if (message.ttlPeriod) return;
  if (message.media && !(message.media instanceof Api.MessageMediaEmpty)) return;
  const path = readMarker(message.message, folderMarker);
  if (path && validCloudFolder(path)) return path;
}

function readFileMarker(caption) {
  const metadata = readMarker(caption, fileMarker);
  if (metadata && validCloudName(metadata.name) && validCloudFolder(metadata.folder)) return metadata;
}

function cloudPath(caption, name) {
  const metadata = readFileMarker(caption);
  if (metadata) return { folder: metadata.folder, name: metadata.name };
  const value = caption.trim();
  const virtualName = value.includes('^') ? value : !value ? name : '';
  if (virtualName.includes('^') && !/[\\/]/.test(virtualName)) {
    const parts = virtualName.split('^').filter(Boolean);
    if (parts.length && parts.every(part => part !== '.' && part !== '..' && !/[\x00-\x1f]/.test(part))) {
      const leaf = parts.pop();
      return { folder: parts.join('/'), name: leaf };
    }
  }
  if (!/[\\/]/.test(value) || value === name) return { folder: '', name };
  const parts = value.split(/[\\/]+/).filter(Boolean);
  const valid = parts.every(part => part !== '.' && part !== '..' && !/[\x00-\x1f<>:"|?*]/.test(part));
  return { folder: valid ? parts.join('/') : '', name };
}

function sizedPhoto(size) {
  let bytes;
  if (size instanceof Api.PhotoSize) bytes = size.size;
  else if (size instanceof Api.PhotoSizeProgressive) bytes = Math.max(...size.sizes);
  else if (size instanceof Api.PhotoCachedSize) bytes = size.bytes.length;
  else return;
  return { thumb: size.type, bytes, width: size.w, height: size.h };
}

const thumbnailLimit = 512 * 1024;
const thumbnailSourceLimit = 32 * 1024 * 1024;
const uploadThumbnailLimit = 200_000;
const croppedThumbnail = /^[a-d]$/;
const cloudUploadLimit = 2_000_000_000;
const largeUploadThreshold = 16 * 1024 * 1024;
const mediaBlockSize = 512 * 1024;
const saveBlockSize = 1024 * 1024;
const imageTypes = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp'
};
const imageMimes = new Set(Object.values(imageTypes));

function telegramThumbnails(sizes, file) {
  const available = (sizes || []).map(sizedPhoto)
    .filter(size => size?.bytes > 0 && size.bytes <= thumbnailLimit)
    .sort((a, b) => Number(croppedThumbnail.test(a.thumb)) - Number(croppedThumbnail.test(b.thumb)) || b.bytes - a.bytes);
  const stripped = sizes?.find(size => size instanceof Api.PhotoStrippedSize && size.bytes.length > 3 && size.bytes[0] === 1);
  const thumbnail = available.length ? { ...available[0], mimeType: 'image/jpeg' } :
    (file && imageThumbnail(file)) || (stripped && { thumb: stripped.type, mimeType: 'image/jpeg' });
  const cached = sizes?.find(size => size instanceof Api.PhotoCachedSize && size.type === thumbnail?.thumb) ||
    sizes?.find(size => size instanceof Api.PhotoCachedSize && size.bytes.length > 0 && size.bytes.length <= thumbnailLimit);
  const inlineThumbnail = cached || stripped;
  return { thumbnail, inlineThumbnail: inlineThumbnail && {
    bytes: cached ? cached.bytes : utils.strippedPhotoToJpg(stripped.bytes),
    complete: inlineThumbnail.type === thumbnail?.thumb
  } };
}

function imageThumbnail(file) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > thumbnailSourceLimit) return;
  const extension = file.name.split('.').pop().toLowerCase();
  const generic = !file.mimeType || file.mimeType === 'application/octet-stream';
  const mimeType = imageMimes.has(file.mimeType) ? file.mimeType :
    generic && Object.prototype.hasOwnProperty.call(imageTypes, extension) ? imageTypes[extension] : undefined;
  if (mimeType) return { bytes: file.size, thumb: file.thumb, mimeType, resize: file.size > thumbnailLimit, original: true };
}

function cloudAttachment(message, protectedChannel) {
  const media = message.media;
  if (message.ttlPeriod || media?.ttlSeconds) return;
  const metadata = {
    id: message.id,
    date: message.date,
    caption: message.message || '',
    protected: Boolean(protectedChannel || message.noforwards)
  };
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const { document } = media;
    const filename = document.attributes.find(attribute => attribute instanceof Api.DocumentAttributeFilename);
    const file = { ...metadata, ...cloudPath(metadata.caption, filename?.fileName || `file-${message.id}`),
      size: Number(document.size), mimeType: document.mimeType };
    const cover = media.videoCover instanceof Api.Photo && telegramThumbnails(media.videoCover.sizes);
    const previews = cover?.thumbnail ? cover : telegramThumbnails(document.thumbs, file);
    const thumbnail = cover?.thumbnail ? { ...cover.thumbnail, cover: true } : previews.thumbnail;
    const thumbnailKey = thumbnail && [document.id, thumbnail.cover ? media.videoCover.id : 0, message.editDate || message.date || 0,
      thumbnail.thumb || 'original', thumbnail.bytes || 0].join(':');
    return { ...file, ...previews, thumbnail, thumbnailKey };
  }
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    const largest = media.photo.sizes.map(sizedPhoto).filter(size => size?.bytes > 0).sort((a, b) => b.bytes - a.bytes)[0];
    if (largest) {
      const photoName = !/[\^\\/]/.test(metadata.caption) && /\.(?:jpe?g|png|webp)$/i.test(metadata.caption)
        ? metadata.caption : `photo-${message.id}.jpg`;
      const file = { ...metadata, ...cloudPath(metadata.caption, photoName), size: largest.bytes,
        mimeType: 'image/jpeg', thumb: largest.thumb };
      const previews = telegramThumbnails(media.photo.sizes, file);
      const { thumbnail } = previews;
      const thumbnailKey = thumbnail && [media.photo.id, message.editDate || message.date || 0,
        thumbnail.thumb, thumbnail.bytes || 0].join(':');
      return { ...file, ...previews, thumbnailKey };
    }
  }
}

function floodDelay(error) {
  const match = /^(?:FLOOD(?:_PREMIUM|_TEST_PHONE)?|SLOWMODE)_WAIT_(\d+)$/.exec(error?.errorMessage || error?.message || '');
  const seconds = Number(match?.[1]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

// Only known protocol identifiers and bounded numeric metadata enter the login log.
function loginErrorFields(error) {
  const formatted = /^(?:[345]\d\d): ([A-Z][A-Z0-9_]{1,63})(?: \(caused by [A-Za-z.]+\))?$/.exec(error?.message)?.[1];
  const raw = formatted ?? error?.errorMessage;
  const known = /^(?:API_ID_INVALID|API_HASH_INVALID|API_ID_PUBLISHED_FLOOD|AUTH_KEY_UNREGISTERED|AUTH_KEY|AUTH_TOKEN_EXPIRED|AUTH_TOKEN_INVALID|AUTH_TOKEN_INVALID1|AUTH_TOKEN_ALREADY_ACCEPTED|BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|INTERNAL|FLOOD|PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED|PHONE_NUMBER_FLOOD|PHONE_PASSWORD_FLOOD|PHONE_PASSWORD_PROTECTED|PHONE_NUMBER_APP_SIGNUP_FORBIDDEN|PHONE_CODE_INVALID|PHONE_CODE_EMPTY|PHONE_CODE_EXPIRED|SESSION_PASSWORD_NEEDED|PASSWORD_HASH_INVALID|SRP_ID_INVALID|SMS_CODE_CREATE_FAILED|UPDATE_APP_TO_LOGIN|SEND_CODE_UNAVAILABLE|EMAIL_INVALID|EMAIL_VERIFY_CODE_INVALID|CODE_INVALID)$/;
  const wait = floodDelay(error);
  const migrate = /^(PHONE_MIGRATE|NETWORK_MIGRATE|USER_MIGRATE)(?:_\d{1,2})?$/.exec(raw);
  const code = known.test(raw) ? raw
    : wait ? 'FLOOD_WAIT'
    : migrate ? migrate[1]
    : /^AUTH_RESTART(?:_\d+)?$/.test(raw) ? 'AUTH_RESTART'
    : /^RECAPTCHA_CHECK_/.test(raw) ? 'RECAPTCHA_CHECK'
    : Number.isInteger(error?.code) ? 'RPC_ERROR'
    : /^WebSocket connection to .* failed$/.test(error?.message) ? 'WEBSOCKET_CONNECT_FAILED'
    : ['TimeoutError', 'AbortError', 'NetworkError', 'SecurityError'].includes(error?.name) ? error.name
    : 'UNKNOWN';
  return {
    code,
    rpcStatus: Number.isInteger(error?.code) && error.code >= 300 && error.code < 600 ? error.code : undefined,
    waitSeconds: wait ? wait / 1000 : undefined,
    targetDc: migrate && Number.isInteger(error?.newDc) && error.newDc > 0 && error.newDc < 100 ? error.newDc : undefined
  };
}

function sentCodeFields(result) {
  const typeName = value => /^auth\.(?:SentCode|CodeType)[A-Za-z]{0,32}$/.test(value?.className) ? value.className : undefined;
  return {
    response: typeName(result),
    type: typeName(result?.type),
    next_type: typeName(result?.nextType),
    timeout: Number.isInteger(result?.timeout) && result.timeout >= 0 ? result.timeout : undefined
  };
}

function sleep(delay, lifetime, signal) {
  if (lifetime.aborted || signal?.aborted) return Promise.reject(new Error('operation_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), Math.min(delay, 86_400_000));
    const cancel = () => finish(new Error('operation_cancelled'));
    function finish(error) {
      clearTimeout(timer);
      lifetime.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve();
    }
    lifetime.addEventListener('abort', cancel, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function createClient({ apiId, apiHash, session = '', testServers = false, clientMetadata, onFloodWait, onServiceNotice,
  onCloudChange, onScheduledChange, onNewAuthorization, onFutureAuthToken }) {
  const connectionProfile = {
    appVersion: clientMetadata?.appVersion || '1.0.0',
    systemVersion: clientMetadata?.systemVersion
  };
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    testServers,
    deviceModel: 'Mini App Runtime',
    ...connectionProfile,
    langCode: 'ru',
    systemLangCode: 'en-US',
    connectionRetries: 2,
    reconnectRetries: 2,
    timeout: 10,
    floodSleepThreshold: 0
  });
  client.setLogLevel('none');
  const peers = new Map();
  const cloudPeers = new Map();
  const channelIds = new Map();
  const protectedChannels = new Map();
  const history = new Map();
  const thumbnailSources = new WeakMap();
  const dirtyHeads = new Set();
  const lifetime = new AbortController();
  const callHost = window.mini?.functions?.call;
  const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  let waitUntil = 0;
  let leasePending;
  let leased = false;
  let closing;
  let accountId;
  let shoppingPeerScope;
  let loginLog;
  const pendingNotices = [];
  const shownNotices = new Map();
  const unconfirmedAuthorizations = new Map();
  let noticeWrites = Promise.resolve();
  let dialogs;
  let channelDialogs;
  const scheduler = createScheduler({
    client, lifetimeSignal: lifetime.signal, sleep, largeUploadThreshold,
    currentAccountId: () => accountId, waitDeadline: () => waitUntil, onScheduledChange
  });

  async function waitForTelegram(signal) {
    for (let remaining = waitUntil - Date.now(); remaining > 0; remaining = waitUntil - Date.now()) {
      await sleep(remaining, lifetime.signal, signal);
    }
    if (lifetime.signal.aborted || signal?.aborted) throw new Error('operation_cancelled');
  }

  async function respectFloodWait(send, signal, beforeSend) {
    for (;;) {
      beforeSend?.(Math.max(0, waitUntil - Date.now()));
      await waitForTelegram(signal);
      beforeSend?.(0);
      try { return await send(); }
      catch (error) {
        const delay = floodDelay(error);
        if (!delay || lifetime.signal.aborted) throw error;
        const until = Date.now() + delay;
        if (until > waitUntil) {
          waitUntil = until;
          if (leased) void callHost('telegram.setWaitUntil', { owner, until }).catch(() => {});
          onFloodWait?.(until);
        }
      }
    }
  }

  function logLogin(event, fields = {}) {
    try { loginLog?.(event, fields); } catch { /* Diagnostics cannot interrupt login. */ }
  }

  async function traceLoginCall(name, send, resultFields) {
    const dc = () => Number.isInteger(client.session.dcId) && client.session.dcId > 0 ? client.session.dcId : undefined;
    logLogin(name + '.start', { dc: dc() });
    try {
      const result = await send();
      logLogin(name + '.result', { dc: dc(), ...resultFields?.(result) });
      return result;
    } catch (error) {
      logLogin(name + '.error', { dc: dc(), ...loginErrorFields(error) });
      throw error;
    }
  }

  const connect = client.connect.bind(client);
  client.connect = (...args) => {
    const connectToServer = async () => {
      const result = await connect(...args);
      if (testServers && client._config?.testMode !== true) throw new Error('TELEGRAM_TEST_SERVER_MISMATCH');
      return result;
    };
    return loginLog ? traceLoginCall('connect', connectToServer) : connectToServer();
  };
  const invoke = client.invoke.bind(client);
  const loginMethods = new Map([
    [Api.auth.SendCode, ['auth.sendCode', sentCodeFields]],
    [Api.auth.ResendCode, ['auth.resendCode', sentCodeFields]],
    [Api.auth.SignIn, ['auth.signIn', sentCodeFields]],
    [Api.auth.ResetLoginEmail, ['auth.resetLoginEmail', sentCodeFields]],
    [Api.account.SendVerifyEmailCode, ['account.sendVerifyEmailCode']],
    [Api.account.VerifyEmail, ['account.verifyEmail']],
    [Api.account.GetPassword, ['account.getPassword']],
    [Api.auth.CheckPassword, ['auth.checkPassword']]
  ]);
  async function retainFutureAuthToken(result) {
    if (!onFutureAuthToken) return;
    const authorization = result?.authorization ?? result?.sentCode?.authorization ?? result;
    const token = authorization?.futureAuthToken;
    if (token?.length) await onFutureAuthToken(token.toString('hex'));
  }

  client.invoke = (request, dcId, options) => {
    const method = loginLog && loginMethods.get(request.constructor);
    const send = async () => {
      const result = await invoke(request, dcId, options);
      await retainFutureAuthToken(result);
      return result;
    };
    return respectFloodWait(
      method ? () => traceLoginCall(method[0], send, method[1]) : send,
      options?.abortSignal ?? options?.signal,
      options?.beforeSend
    );
  };
  // Teleproto 1.232.1 sends file parts through its media sender, outside invoke().
  const sendPart = client._files.send.bind(client._files);
  client._files.send = (sender, slot, request, signal) =>
    respectFloodWait(() => sendPart(sender, slot, request, signal), signal);

  async function acquireSession(signal) {
    if (window.mini && !callHost) throw new Error('telegram_runtime_update_required');
    if (callHost && !leasePending) {
      leasePending = callHost(testServers ? 'telegram.acquireTest' : 'telegram.acquire', { owner }).then(until => {
        leased = true;
        waitUntil = Math.max(waitUntil, until || 0);
        if (waitUntil > Date.now()) onFloodWait?.(waitUntil);
      }).catch(error => {
        if (error?.code === 'method_not_found') throw new Error('telegram_runtime_update_required');
        throw error;
      });
    }
    await leasePending;
    await waitForTelegram(signal);
  }

  async function authenticatePhone(phoneNumber, ask, onError, savedTokens) {
    const logoutTokens = savedTokens.slice(0, 20).map(token => Buffer.from(token, 'hex'));
    const settings = new Api.CodeSettings(logoutTokens.length ? { logoutTokens } : {});
    let sent;
    for (let retry = 0; ; retry++) {
      try {
        sent = await client.invoke(new Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings }));
        break;
      } catch (error) {
        if (error?.errorMessage !== 'AUTH_RESTART' || retry !== 0) throw error;
      }
    }

    let emailPattern;
    let resendAt = Date.now() + (sent.timeout ?? 0) * 1000;
    for (;;) {
      if (sent instanceof Api.auth.SentCodeSuccess) return sent.authorization;
      if (sent instanceof Api.auth.SentCodePaymentRequired) throw new Error('PHONE_LOGIN_PAYMENT_REQUIRED');
      if (!(sent instanceof Api.auth.SentCode)) throw new Error('PHONE_LOGIN_UNEXPECTED');
      const { type, nextType, phoneCodeHash, timeout } = sent;
      const request = { phoneNumber, phoneCodeHash };
      const purpose = () => new Api.EmailVerifyPurposeLoginSetup(request);
      const delivery = {
        nextType: nextType && (nextType instanceof Api.auth.CodeTypeSms ? 'sms' : 'other'),
        resendAt, responseType: type.className, nextResponseType: nextType?.className, timeout
      };
      const setupEmail = type instanceof Api.auth.SentCodeTypeSetUpEmailRequired;
      const loginEmail = type instanceof Api.auth.SentCodeTypeEmailCode;
      const emailReset = loginEmail && (type.resetAvailablePeriod != null || type.resetPendingDate != null);
      try {
        let next;
        if (setupEmail) {
          if (emailPattern === undefined) {
            const email = await ask('email');
            const response = await client.invoke(new Api.account.SendVerifyEmailCode({ purpose: purpose(), email }));
            emailPattern = response.emailPattern;
          }
          const code = await ask('emailCode', emailPattern);
          const verified = await client.invoke(new Api.account.VerifyEmail({
            purpose: purpose(), verification: new Api.EmailVerificationCode({ code })
          }));
          next = verified.sentCode;
        } else {
          const kind = loginEmail ? 'emailCode' : 'code';
          const method = deliveryTypes.get(type.constructor);
          if (!loginEmail && !method) throw new Error('PHONE_DELIVERY_UNSUPPORTED');
          const value = await ask(kind, loginEmail ? type.emailPattern : deliveryHints[method], {
            ...delivery, type: method, fragmentUrl: method === 'fragment' ? type.url : undefined,
            emailReset,
            resetAvailablePeriod: type.resetAvailablePeriod, resetPendingDate: type.resetPendingDate
          });
          if (value?.resetLoginEmail && emailReset) {
            if (type.resetPendingDate * 1000 > Date.now()) throw new Error('EMAIL_RESET_WAIT');
            next = await client.invoke(new Api.auth.ResetLoginEmail(request));
          } else if (value === null) {
            if (!nextType) throw new Error('SEND_CODE_UNAVAILABLE');
            if (Date.now() < resendAt) throw new Error('SEND_CODE_WAIT');
            next = await client.invoke(new Api.auth.ResendCode(request));
          } else {
            return await client.invoke(new Api.auth.SignIn({
              ...request,
              phoneCode: loginEmail ? undefined : value,
              emailVerification: loginEmail ? new Api.EmailVerificationCode({ code: value }) : undefined
            }));
          }
        }
        if (!next) throw new Error('PHONE_LOGIN_UNEXPECTED');
        sent = next;
        resendAt = Date.now() + (sent.timeout ?? 0) * 1000;
        emailPattern = undefined;
      } catch (error) {
        if (['AUTH_USER_CANCEL', 'AUTH_SWITCH_TO_QR'].includes(error?.message)) {
          if (waitUntil <= Date.now()) {
            const cancel = () => invoke(new Api.auth.CancelCode(request),
              undefined, { abortSignal: lifetime.signal, timeout: 3000, maxRetryCount: 0 });
            await traceLoginCall('auth.cancelCode', cancel).catch(() => {});
          }
          throw error;
        }
        if (['SESSION_PASSWORD_NEEDED', 'PHONE_CODE_EXPIRED', 'PHONE_NUMBER_INVALID', 'PHONE_NUMBER_BANNED']
          .includes(error?.errorMessage)) throw error;
        if (await onError(error)) throw new Error('AUTH_USER_CANCEL');
      }
    }
  }

  async function authenticateQr(showQr, signal) {
    const event = new Raw({});
    let changed = false;
    let wake;
    const checkLoginToken = reason => {
      logLogin('qr.' + reason);
      changed = true;
      wake?.();
    };
    const onUpdate = update => {
      if (update instanceof Api.UpdateLoginToken) checkLoginToken('scan_update');
    };
    const stopWatchingResume = window.mini?.events?.on('app.resume', () => checkLoginToken('app_resumed'));
    const tokenFields = result => {
      if (result instanceof Api.auth.LoginToken) return { result: 'pending' };
      if (result instanceof Api.auth.LoginTokenMigrateTo) return { result: 'migrate', targetDc: result.dcId };
      if (result instanceof Api.auth.LoginTokenSuccess) return { result: 'authorized' };
      return { result: 'unexpected' };
    };

    async function waitForScan(expires) {
      if (changed) {
        changed = false;
        return;
      }
      const waiting = new AbortController();
      const interrupt = () => waiting.abort();
      wake = interrupt;
      signal.addEventListener('abort', interrupt, { once: true });
      if (signal.aborted) interrupt();
      try {
        const remaining = expires * 1000 - Date.now();
        await sleep(Math.max(1000, Math.min(30_000, remaining)), lifetime.signal, waiting.signal);
      } catch (error) {
        if (!changed || signal.aborted || lifetime.signal.aborted) throw error;
      } finally {
        signal.removeEventListener('abort', interrupt);
        changed = false;
        wake = undefined;
      }
    }

    client.addEventHandler(onUpdate, event);
    try {
      while (true) {
        let result = await traceLoginCall('auth.exportLoginToken', () => client.invoke(new Api.auth.ExportLoginToken({
          apiId, apiHash, exceptIds: []
        }), undefined, { abortSignal: signal }), tokenFields);
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
          const { dcId, token } = result;
          await traceLoginCall('qr.switch_dc', () => client._switchDC(dcId));
          result = await traceLoginCall('auth.importLoginToken', () => client.invoke(new Api.auth.ImportLoginToken({ token }),
            undefined, { abortSignal: signal }), tokenFields);
        }
        if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization)
          return result.authorization.user;
        if (!(result instanceof Api.auth.LoginToken)) throw new Error('QR_LOGIN_UNEXPECTED');
        if (signal.aborted) throw new Error('operation_cancelled');
        const encoded = result.token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const qr = encode('tg://login?token=' + encoded, { border: 4 });
        showQr(qr.data, result.expires);
        await waitForScan(result.expires);
      }
    } finally {
      stopWatchingResume?.();
      client.removeEventHandler(onUpdate, event);
    }
  }

  function close() {
    if (closing) return closing;
    lifetime.abort();
    closing = (async () => {
      await leasePending?.catch(() => {});
      try {
        await client.destroy();
        await noticeWrites;
      } finally {
        if (leased) await callHost('telegram.release', { owner });
      }
    })();
    return closing;
  }

  function peer(chatId) {
    if (!peers.has(chatId)) throw new Error('CHAT_NOT_LOADED');
    return peers.get(chatId);
  }

  async function checkedChannel(id) {
    const input = cloudPeers.get(id);
    if (!input) throw new Error('CHANNEL_NOT_LOADED');
    const channel = await client.getEntity(input);
    if (!canUseCloud(channel)) throw new Error('CLOUD_CHANNEL_UNAVAILABLE');
    protectedChannels.set(id, Boolean(channel.noforwards));
    return { input, protectedChannel: channel.noforwards };
  }

  async function cloudChannels(reset, stopAtId) {
    if (reset || !channelDialogs) {
      cloudPeers.clear();
      channelIds.clear();
      protectedChannels.clear();
      channelDialogs = client.iterDialogs({ ignoreMigrated: true })[Symbol.asyncIterator]();
    }
    const items = [];
    for (let index = 0; index < 100; index++) {
      const { value, done } = await channelDialogs.next();
      if (done) return { items, more: false };
      if (!value.inputEntity || !canUseCloud(value.entity)) continue;
      const id = String(value.id);
      cloudPeers.set(id, value.inputEntity);
      channelIds.set(String(value.entity.id), id);
      protectedChannels.set(id, Boolean(value.entity.noforwards));
      items.push({ id, title: value.title || 'Канал' });
      if (id === stopAtId) return { items, more: true };
    }
    return { items, more: true };
  }

  async function shoppingTransport(channelId, savedPeer) {
    // An access hash belongs to a login session. Keep only a fingerprint of
    // that session in the mini-app's private cache.
    if (session && !shoppingPeerScope) {
      const identity = JSON.stringify([apiId, testServers, accountId, session]);
      shoppingPeerScope = (await helpers.sha256(Buffer.from(identity))).toString('hex');
    }
    const scope = shoppingPeerScope;
    let input = cloudPeers.get(channelId);
    let full;
    const markedId = /^-100([1-9]\d{0,18})$/.exec(channelId);
    if (!input && scope && savedPeer?.scope === scope && savedPeer.channelId === channelId &&
        markedId && typeof savedPeer.accessHash === 'string' && /^-?\d{1,19}$/.test(savedPeer.accessHash)) {
      input = new Api.InputPeerChannel({ channelId: markedId[1], accessHash: savedPeer.accessHash });
      try {
        full = await client.invoke(new Api.channels.GetFullChannel({ channel: utils.getInputChannel(input) }));
      } catch (error) {
        if (!['CHANNEL_INVALID', 'CHANNEL_PRIVATE', 'PEER_ID_INVALID'].includes(error?.errorMessage)) throw error;
        input = undefined;
      }
    }
    if (!input) {
      let reset = true;
      for (;;) {
        const page = await cloudChannels(reset, channelId);
        input = cloudPeers.get(channelId);
        if (input || !page.more) break;
        reset = false;
      }
      if (!input) throw new Error('CHANNEL_NOT_LOADED');
    }
    if (!full) full = await client.invoke(new Api.channels.GetFullChannel({ channel: utils.getInputChannel(input) }));
    const entity = full.chats?.find(chat => String(chat.id) === String(input.channelId));
    const current = entity instanceof Api.Channel && !entity.min ? entity : await client.getEntity(input);
    if (!canUseCloud(current)) throw new Error('CLOUD_CHANNEL_UNAVAILABLE');
    if (current.noforwards || full.fullChat?.ttlPeriod) throw new Error('SHOPPING_CHANNEL_UNAVAILABLE');
    const hash = String(current.accessHash ?? input.accessHash ?? '0');
    const peerHint = scope && markedId && input instanceof Api.InputPeerChannel && hash !== '0'
      ? { scope, channelId, accessHash: hash }
      : null;
    const observed = new Map();
    let downloaded = 0;
    let captionLimit;

    async function publishPurchases(text, preview = []) {
      const bytes = new TextEncoder().encode(text);
      if (!bytes.length || bytes.length > shoppingMaxBytes) throw new Error('SYNC_LIST_TOO_LARGE');
      if (captionLimit === undefined) {
        const config = client._config?.captionLengthMax ? client._config : await client.invoke(new Api.help.GetConfig());
        captionLimit = config.captionLengthMax;
        if (!Number.isSafeInteger(captionLimit) || captionLimit < shoppingPurchasesCaption.length)
          throw new Error('SHOPPING_MESSAGE_LIMIT_UNAVAILABLE');
      }
      const lines = [];
      let available = captionLimit - shoppingPurchasesCaption.length;
      for (const line of preview) {
        if (line.length + 1 > available - 2) {
          if (available >= 2) lines.push('…');
          break;
        }
        lines.push(line);
        available -= line.length + 1;
      }
      const caption = [shoppingPurchasesCaption, ...lines].join('\n');
      const uploaded = await client.uploadFile({
        file: { name: shoppingName, size: bytes.length, readRange: (offset, length) => bytes.slice(offset, offset + length) },
        workers: 1
      });
      const media = new Api.InputMediaUploadedDocument({
        file: uploaded, mimeType: 'application/json', forceFile: true,
        attributes: [new Api.DocumentAttributeFilename({ fileName: shoppingName })]
      });
      const message = await client.sendFile(input, {
        file: media, caption, silent: true,
        formattingEntities: [new Api.MessageEntityHashtag({ offset: 0, length: shoppingTag.length })]
      });
      const post = shoppingPost(message);
      if (!post?.document || Number(post.document.size) !== bytes.length || message.message !== caption ||
          message.ttlPeriod || message.media?.ttlSeconds || !Number.isSafeInteger(message.id) || message.id <= 0)
        throw new Error('SYNC_SEND_UNCONFIRMED');
      observed.set(message.id, { signature: post.signature, delivered: true });
      return message.id;
    }

    async function read(visit) {
      const [matches, recent] = await Promise.all([
        client.getMessages(input, { search: shoppingTag, limit: 513 }),
        client.getMessages(input, { limit: 50 })
      ]);
      if (matches.length > 512) throw new Error('SHOPPING_HISTORY_LIMIT');
      const ids = new Set();
      const rows = [];
      const consume = visit ?? (row => rows.push(row));
      for (const message of [...recent, ...matches]) {
        if (ids.has(message.id)) continue;
        ids.add(message.id);
        const post = shoppingPost(message);
        if (!post) continue;
        const { document, signature } = post;
        if (message.ttlPeriod || message.media?.ttlSeconds)
          throw new Error('SHOPPING_SNAPSHOT_UNAVAILABLE');
        let entry = observed.get(message.id);
        if (entry && entry.signature !== signature) throw new Error('SHOPPING_SNAPSHOT_CHANGED');
        if (!entry?.delivered || !visit) {
          const size = Number(document.size);
          if (!Number.isSafeInteger(size) || size < 1 || size > shoppingMaxBytes)
            throw new Error('SHOPPING_SNAPSHOT_UNAVAILABLE');
          if (downloaded + size > shoppingHistoryBytes) throw new Error('SHOPPING_HISTORY_TOO_LARGE');
          downloaded += size;
          const bytes = await client.downloadMedia(message);
          if (!bytes || bytes.length !== size) throw new Error('SHOPPING_SNAPSHOT_UNAVAILABLE');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          consume({ id: message.id, text, owned: message.out === true });
          observed.set(message.id, { signature, delivered: Boolean(visit) || entry?.delivered === true });
        }
      }
      return rows;
    }

    async function remove(ids, keepId) {
      let removed = 0;
      let validated = false;
      for (let offset = 0; offset < ids.length; offset += 99) {
        const batch = ids.slice(offset, offset + 99).filter(id => observed.has(id) && id !== keepId);
        if (!batch.length) continue;
        const [found, entity] = await Promise.all([
          client.getMessages(input, { ids: [keepId, ...batch] }),
          validated ? null : client.getEntity(input)
        ]);
        if (!validated && !canUseCloud(entity)) throw new Error('SHOPPING_CHANNEL_UNAVAILABLE');
        validated = true;
        const messages = new Map(found.filter(message => message?.id).map(message => [message.id, message]));
        const keep = messages.get(keepId);
        const keptPost = shoppingPost(keep);
        if (!keptPost || keep.ttlPeriod || keep.media?.ttlSeconds || observed.get(keepId)?.signature !== keptPost.signature)
          return removed;
        const targets = [];
        for (const id of batch) {
          const message = messages.get(id);
          if (!message || message instanceof Api.MessageEmpty) {
            removed++;
            continue;
          }
          const post = shoppingPost(message);
          if (message.out === true && post && !message.ttlPeriod && !message.media?.ttlSeconds &&
              observed.get(id).signature === post.signature) targets.push(id);
        }
        if (targets.length) {
          await client.deleteMessages(input, targets, { revoke: true });
          removed += targets.length;
        }
      }
      return removed;
    }

    return Object.freeze({ read, publishPurchases, remove, peerHint });
  }

  function rememberAttachment(channelId, message, protectedChannel) {
    const file = cloudAttachment(message, protectedChannel);
    if (file?.thumbnail) thumbnailSources.set(file, { channelId, message });
    return file;
  }

  function historyRow(channelId, message, protectedChannel) {
    return { id: message.id, file: rememberAttachment(channelId, message, protectedChannel), folder: cloudFolder(message) };
  }

  async function cloudFiles(channelId, before) {
    if (!cloudPeers.has(channelId)) throw new Error('CHANNEL_NOT_LOADED');
    if (!history.has(channelId)) history.set(channelId, new Map());
    const pages = history.get(channelId);
    const offset = before ?? 0;
    const repair = offset === 0 && dirtyHeads.delete(channelId) ? pages.get(offset) : undefined;
    if (!pages.has(offset) || repair) {
      const request = (async () => {
        const { input, protectedChannel } = await checkedChannel(channelId);
        const messages = await client.getMessages(input, { limit: 51, offsetId: before });
        const rows = messages.slice(0, 50).map(message => historyRow(channelId, message, protectedChannel));
        if (repair && messages.length > 50) {
          const previous = await repair.catch(() => undefined);
          const oldest = rows[rows.length - 1].id;
          if (previous?.protectedChannel === protectedChannel && previous?.rows.some(row => row.id >= oldest)) {
            return {
              rows: rows.filter(row => previous.next === undefined || row.id >= previous.next)
                .concat(previous.rows.filter(row => row.id < oldest)),
              protectedChannel, next: previous.next
            };
          }
        }
        return { rows, protectedChannel, next: messages.length > 50 ? rows[rows.length - 1].id : undefined };
      })();
      pages.set(offset, request);
      void request.catch(() => {
        if (pages.get(offset) !== request) return;
        if (repair) {
          pages.set(offset, repair);
          dirtyHeads.add(channelId);
        } else pages.delete(offset);
      });
    }
    const page = await pages.get(offset);
    if (history.get(channelId) !== pages) return cloudFiles(channelId, before);
    return { items: page.rows.map(row => row.file).filter(Boolean), folders: page.rows.map(row => row.folder).filter(Boolean), next: page.next };
  }

  function applyCloudMessage(channelId, message, insert) {
    for (const [offset, request] of history.get(channelId) ?? []) {
      void request.then(page => {
        const index = page.rows.findIndex(row => row.id === message.id);
        const row = historyRow(channelId, message, page.protectedChannel);
        if (index >= 0) page.rows[index] = row;
        else if (insert && offset === 0 && (page.next === undefined || message.id > page.next)) {
          page.rows.push(row);
          page.rows.sort((a, b) => b.id - a.id);
        }
      }, () => {});
    }
  }

  function removeCloudMessages(channelId, ids) {
    const removed = new Set(ids);
    for (const request of history.get(channelId)?.values() ?? []) {
      void request.then(page => { page.rows = page.rows.filter(row => !removed.has(row.id)); }, () => {});
    }
  }

  function storeNotice(notice) {
    if (!accountId) {
      if (pendingNotices.length < 64) pendingNotices.push(notice);
      return;
    }
    if (callHost) {
      noticeWrites = noticeWrites.then(() => callHost('telegram.serviceNotices', { owner, accountId, notice })).catch(() => {});
    }
  }

  async function serviceNotices() {
    if (!accountId || !callHost) return [];
    await noticeWrites;
    return callHost('telegram.serviceNotices', { owner, accountId }).catch(() => []);
  }

  function rememberAccount(user) {
    accountId = user?.id && String(user.id);
    if (accountId) for (const notice of pendingNotices.splice(0)) storeNotice(notice);
    return displayName(user);
  }

  function rememberUnconfirmedAuthorization(authorization) {
    if (!authorization.unconfirmed) return;
    const id = String(authorization.hash);
    unconfirmedAuthorizations.set(id, authorization.hash);
    onNewAuthorization?.({ id, device: authorization.device || authorization.deviceModel || authorization.appName,
      location: authorization.location || [authorization.region, authorization.country].filter(Boolean).join(', ') });
  }

  client.addEventHandler(update => {
    if (onScheduledChange && (update instanceof Api.UpdateNewScheduledMessage || update instanceof Api.UpdateDeleteScheduledMessages)) {
      const peer = update.peer ?? update.message?.peerId;
      if (peer) scheduler.update(String(utils.getPeerId(peer)), update);
    } else if (onNewAuthorization && update instanceof Api.UpdateNewAuthorization) {
      rememberUnconfirmedAuthorization(update);
    } else if (update instanceof Api.UpdateServiceNotification) {
      if (!update.message) return;
      const now = Date.now();
      const key = JSON.stringify([update.type, update.message]);
      if (shownNotices.has(key) && now - shownNotices.get(key) < 900_000) return;
      if (shownNotices.size >= 64) shownNotices.delete(shownNotices.keys().next().value);
      shownNotices.set(key, now);
      const notice = { type: update.type || '', text: update.message, date: update.inboxDate || Math.floor(now / 1000) };
      storeNotice(notice);
      onServiceNotice?.({ ...notice, popup: Boolean(update.popup) });
    } else if (update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateEditChannelMessage) {
      const id = channelIds.get(String(update.message?.peerId?.channelId));
      if (id) {
        const fresh = update instanceof Api.UpdateNewChannelMessage;
        applyCloudMessage(id, update.message, fresh);
        onCloudChange?.({ channelId: id, messageId: update.message.id,
          file: rememberAttachment(id, update.message, protectedChannels.get(id)), fresh });
      }
    } else if (update instanceof Api.UpdateDeleteChannelMessages) {
      const id = channelIds.get(String(update.channelId));
      if (id) {
        removeCloudMessages(id, update.messages);
        onCloudChange?.({ channelId: id, removed: update.messages });
      }
    } else if (update instanceof Api.UpdateChannel || update instanceof Api.UpdateChannelTooLong) {
      const id = channelIds.get(String(update.channelId));
      if (id) history.delete(id);
    }
  });

  async function getCloudFile(channelId, messageId, forSave) {
    const { input, protectedChannel } = await checkedChannel(channelId);
    const [message] = await client.getMessages(input, { ids: [messageId] });
    const file = message && cloudAttachment(message, protectedChannel);
    if (!file) throw new Error('CLOUD_FILE_MISSING');
    if (forSave && file.protected) throw new Error('CLOUD_FILE_PROTECTED');
    return { input, message, file, protectedChannel };
  }

  async function selectedCloudFiles(channelId, ids, allowMissing = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
        ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
      throw new Error('CLOUD_FILE_MISSING');
    }
    const { input, protectedChannel } = await checkedChannel(channelId);
    const messages = await client.getMessages(input, { ids });
    const byId = new Map(messages.filter(Boolean).map(message => [message.id, message]));
    const selected = [];
    for (const id of ids) {
      const message = byId.get(id);
      if (allowMissing && (!message || message instanceof Api.MessageEmpty)) continue;
      const file = message && cloudAttachment(message, protectedChannel);
      if (!file) throw new Error('CLOUD_FILE_MISSING');
      selected.push(file);
    }
    return { input, selected };
  }

  async function downloadThumbnail(channelId, message, file, signal) {
    const image = file?.thumbnail;
    if (!image || signal?.aborted) return;
    const document = message.media.document;
    const progressive = !image.cover && document?.thumbs?.find(size =>
      size instanceof Api.PhotoSizeProgressive && size.type === image.thumb);
    let bytes;
    if (progressive) {
      // Teleproto uses the size of the original document for progressive document thumbs.
      const location = new Api.InputDocumentFileLocation({
        id: document.id, accessHash: document.accessHash, fileReference: document.fileReference, thumbSize: image.thumb
      });
      const output = new Uint8Array(image.bytes);
      let offset = 0;
      for await (const chunk of client.iterDownload(location, { limit: output.length, dcId: document.dcId, signal })) {
        const part = chunk.subarray(0, output.length - offset);
        output.set(part, offset);
        offset += part.length;
        if (offset === output.length) break;
      }
      if (offset === output.length) bytes = output;
    } else {
      // Refresh expired references here so the next tile can reuse the new reference.
      bytes = await client.downloadMedia(image.cover ? message.media.videoCover : message.media, { thumb: image.thumb, signal });
    }
    if (bytes?.length > 0 && (image.bytes === undefined ? bytes.length <= thumbnailLimit : bytes.length === image.bytes)) {
      return { bytes, mimeType: image.mimeType, key: file.thumbnailKey, protected: file.protected || Boolean(protectedChannels.get(channelId)), resize: image.resize };
    }
    const fallback = !image.original && imageThumbnail(file);
    if (!fallback || signal?.aborted) return;
    bytes = await client.downloadMedia(message.media, { thumb: fallback.thumb, signal });
    if (bytes?.length === fallback.bytes) {
      return { bytes, mimeType: fallback.mimeType, key: file.thumbnailKey, protected: file.protected || Boolean(protectedChannels.get(channelId)), resize: fallback.resize };
    }
  }

  async function openCloudFile(channelId, messageId, forSave) {
    let { message, file } = await getCloudFile(channelId, messageId, forSave);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > cloudUploadLimit) {
      throw new Error('CLOUD_TRANSFER_SIZE');
    }
    const mediaId = current => String((current.media.document ?? current.media.photo).id);
    const original = mediaId(message);

    async function* chunks(offset, length, requestSize, signal) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
          offset < 0 || length < 1 || offset + length > file.size) throw new Error('CLOUD_FILE_RANGE');
      let remaining = length;
      for (let attempt = 0; remaining > 0; attempt++) {
        if (signal?.aborted) throw new Error('operation_cancelled');
        const current = message;
        let media = current;
        const params = { offset: offset + length - remaining, limit: remaining, requestSize, signal };
        if (current.media instanceof Api.MessageMediaPhoto) {
          const photo = current.media.photo;
          const cached = photo.sizes.find(size => size instanceof Api.PhotoCachedSize && size.type === file.thumb);
          if (cached) {
            yield cached.bytes.subarray(params.offset, params.offset + remaining);
            return;
          }
          media = new Api.InputPhotoFileLocation({
            id: photo.id, accessHash: photo.accessHash, fileReference: photo.fileReference, thumbSize: file.thumb
          });
          params.dcId = photo.dcId;
        }
        try {
          for await (const chunk of client.iterDownload(media, params)) {
            const bytes = chunk.subarray(0, remaining);
            if (!bytes.length) continue;
            remaining -= bytes.length;
            yield bytes;
            if (!remaining) return;
          }
          throw new Error('CLOUD_FILE_INCOMPLETE');
        } catch (error) {
          if (attempt || !/^FILE_REFERENCE_/.test(error?.errorMessage || '') || signal?.aborted) throw error;
          const fresh = await getCloudFile(channelId, messageId, forSave);
          if (mediaId(fresh.message) !== original || fresh.file.size !== file.size) throw new Error('CLOUD_FILE_MISSING');
          message = fresh.message;
        }
      }
    }

    return {
      ...file,
      chunks: signal => chunks(0, file.size, forSave ? saveBlockSize : mediaBlockSize, signal),
      async read(offset, length, signal) {
        if (!Number.isSafeInteger(length) || length < 1 || length > mediaBlockSize) throw new Error('CLOUD_FILE_RANGE');
        const output = new Uint8Array(length);
        let written = 0;
        for await (const bytes of chunks(offset, length, mediaBlockSize, signal)) {
          output.set(bytes, written);
          written += bytes.length;
        }
        if (written !== length) throw new Error('CLOUD_FILE_INCOMPLETE');
        return output;
      }
    };
  }

  return Object.freeze({
    async signIn(phoneNumber, ask, onError, onLog, savedTokens = []) {
      loginLog = onLog;
      try {
        logLogin('connection.profile', testServers ? { ...connectionProfile, environment: 'test' } : connectionProfile);
        logLogin('session.wait');
        await acquireSession();
        logLogin('session.ready');
        if (!client.connected) await client.connect();
        try {
          const authorization = await authenticatePhone(phoneNumber, ask, onError, savedTokens);
          if (authorization instanceof Api.auth.AuthorizationSignUpRequired) throw new Error('PHONE_ACCOUNT_REQUIRED');
          if (!(authorization instanceof Api.auth.Authorization)) throw new Error('PHONE_LOGIN_UNEXPECTED');
        } catch (error) {
          if (error?.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw error;
          await client.signInWithPassword({ apiId, apiHash }, { password: hint => ask('password', hint), onError });
        }
        return rememberAccount(await client.getMe());
      } finally {
        loginLog = undefined;
      }
    },
    async signInQr(showQr, ask, onError, abortSignal, onLog) {
      loginLog = onLog;
      try {
        logLogin('connection.profile', testServers ? { ...connectionProfile, environment: 'test' } : connectionProfile);
        logLogin('session.wait');
        await acquireSession(abortSignal);
        logLogin('session.ready');
        if (!client.connected) await client.connect();
        try {
          return rememberAccount(await authenticateQr(showQr, abortSignal));
        } catch (error) {
          if (error?.errorMessage !== 'SESSION_PASSWORD_NEEDED' || abortSignal.aborted || lifetime.signal.aborted)
            throw error;
          logLogin('qr.password_required');
          const user = await client.signInWithPassword({ apiId, apiHash }, {
            password: hint => ask('password', hint), onError
          });
          return rememberAccount(user);
        }
      } finally {
        loginLog = undefined;
      }
    },
    async resume() {
      await acquireSession();
      await client.connect();
      return rememberAccount(await client.getMe());
    },
    async loadUnconfirmedAuthorizations() {
      const result = await client.invoke(new Api.account.GetAuthorizations());
      for (const authorization of result.authorizations) rememberUnconfirmedAuthorization(authorization);
    },
    async decideAuthorization(id, confirmed) {
      const hash = unconfirmedAuthorizations.get(id);
      if (hash === undefined) return;
      const request = confirmed ? new Api.account.ChangeAuthorizationSettings({ hash, confirmed: true })
        : new Api.account.ResetAuthorization({ hash });
      if (!await client.invoke(request)) throw new Error('TELEGRAM_AUTHORIZATION_UNCONFIRMED');
      unconfirmedAuthorizations.delete(id);
    },
    async invalidateSignInCodes(codes) {
      if (codes.length) await client.invoke(new Api.account.InvalidateSignInCodes({ codes }));
    },
    session: () => client.session.save(),
    accountId: () => accountId,
    ...scheduler.actions,
    async chats(reset = false) {
      if (reset || !dialogs) dialogs = client.iterDialogs({ ignoreMigrated: true })[Symbol.asyncIterator]();
      const items = [];
      if (reset) {
        const notices = await serviceNotices();
        if (notices.length) items.push({ id: '777000', title: 'Уведомления Telegram', preview: notices[notices.length - 1].text });
      }
      while (items.length < 40) {
        const { value, done } = await dialogs.next();
        if (done) return { items, more: false };
        // Broadcast channels require a sponsored-message flow. This client
        // presents personal conversations and groups.
        if (!value.inputEntity || value.entity.broadcast) continue;
        const id = String(value.id);
        peers.set(id, value.inputEntity);
        if (items.some(item => item.id === id)) continue;
        items.push({
          id,
          title: value.title || 'Чат',
          unread: value.unreadCount,
          preview: value.message ? toMessage(value.message).text : ''
        });
      }
      return { items, more: true };
    },
    async messages(chatId, before) {
      const messages = chatId === '777000' && !peers.has(chatId) ? [] :
        await client.getMessages(peer(chatId), { limit: 40, offsetId: before });
      const items = messages.map(toMessage).reverse();
      if (chatId === '777000' && !before) {
        for (const [index, notice] of (await serviceNotices()).entries()) {
          if (items.some(item => item.text === notice.text && item.date === notice.date)) continue;
          items.push({ id: -index - 1, date: notice.date, text: notice.text, sender: 'Telegram', local: true });
        }
        items.sort((a, b) => a.date - b.date);
      }
      return { items, more: messages.length === 40 };
    },
    markRead: (chatId, id) => client.markAsRead(peer(chatId), id),
    async send(chatId, text) {
      return toMessage(await client.sendMessage(peer(chatId), { message: text, formattingEntities: [] }));
    },
    cloudChannels: reset => cloudChannels(reset),
    cloudFiles,
    shoppingTransport,
    async cloudCreateFolder(channelId, path) {
      if (!path || !validCloudFolder(path)) throw new Error('CLOUD_INVALID_NAME');
      const { input } = await checkedChannel(channelId);
      const message = await client.sendMessage(input, { message: folderMarker + JSON.stringify(path), formattingEntities: [] });
      if (!message || cloudFolder(message) !== path) throw new Error('CLOUD_SEND_UNCONFIRMED');
      applyCloudMessage(channelId, message, true);
      return path;
    },
    async cloudEditFile(channelId, messageId, changes) {
      const { input, message, file, protectedChannel } = await getCloudFile(channelId, messageId, false);
      const name = changes.name ?? file.name;
      const folder = changes.folder ?? file.folder;
      if (!validCloudName(name) || !validCloudFolder(folder)) throw new Error('CLOUD_INVALID_NAME');
      if (name === file.name && folder === file.folder) return file;
      const previous = message.message || '';
      const lineBreak = readFileMarker(previous) ? previous.indexOf('\n') : undefined;
      const start = lineBreak === undefined ? 0 : lineBreak < 0 ? previous.length : lineBreak + 1;
      const description = previous.slice(start);
      const header = fileMarker + JSON.stringify({ folder, name });
      const text = description ? header + '\n' + description : header;
      const shift = header.length + 1 - start;
      const formattingEntities = description ? (message.entities ?? [])
        .filter(entity => entity.offset >= start)
        .map(entity => new entity.constructor({ ...entity, offset: entity.offset + shift })) : [];
      const updated = await client.editMessage(input, { message: messageId, text, formattingEntities });
      const result = updated && rememberAttachment(channelId, updated, protectedChannel);
      if (!result || result.name !== name || result.folder !== folder) throw new Error('CLOUD_EDIT_UNCONFIRMED');
      applyCloudMessage(channelId, updated, false);
      return result;
    },
    async cloudDeleteFiles(channelId, ids) {
      const { input, selected } = await selectedCloudFiles(channelId, ids, true);
      if (selected.length) await client.deleteMessages(input, selected.map(file => file.id), { revoke: true });
      removeCloudMessages(channelId, ids);
    },
    async cloudForwardFiles(channelId, ids, chatId) {
      const target = chatId === 'me' ? 'me' : peer(chatId);
      const { input, selected } = await selectedCloudFiles(channelId, ids);
      if (selected.some(file => file.protected)) throw new Error('CLOUD_FILE_PROTECTED');
      const forwarded = await client.forwardMessages(target, { messages: ids, fromPeer: input });
      if (forwarded?.filter(Boolean).length !== ids.length) throw new Error('CLOUD_FORWARD_UNCONFIRMED');
    },
    async cloudDownload(channelId, messageId, maxBytes, forSave = false, signal) {
      const { message, file } = await getCloudFile(channelId, messageId, forSave);
      if (signal?.aborted) throw new Error('operation_cancelled');
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes) {
        throw new Error('CLOUD_FILE_TOO_LARGE');
      }
      const bytes = await client.downloadMedia(message, { thumb: file.thumb, signal });
      if (!bytes || bytes.length !== file.size) throw new Error('CLOUD_FILE_INCOMPLETE');
      return { ...file, bytes };
    },
    cloudOpenFile: openCloudFile,
    async cloudThumbnail(channelId, messageId, signal, record) {
      const input = cloudPeers.get(channelId);
      if (!input || signal?.aborted) return;
      const source = thumbnailSources.get(record);
      const known = source?.channelId === channelId && source.message.id === messageId;
      const message = known ? source.message : (await client.getMessages(input, { ids: [messageId] }))[0];
      const file = known ? record : message && cloudAttachment(message, protectedChannels.get(channelId));
      try {
        return await downloadThumbnail(channelId, message, file, signal);
      } catch (error) {
        if (!known || signal?.aborted || !/^FILE_REFERENCE_/.test(error?.errorMessage || error?.message || '')) throw error;
        const fresh = source.message !== message ? source.message : (await client.getMessages(input, { ids: [messageId] }))[0];
        const updated = fresh && cloudAttachment(fresh, protectedChannels.get(channelId));
        if (updated?.thumbnailKey !== file.thumbnailKey) return;
        source.message = fresh;
        return downloadThumbnail(channelId, fresh, updated, signal);
      }
    },
    async cloudUpload(channelId, file, folder, onProgress) {
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > cloudUploadLimit) {
        throw new Error('CLOUD_UPLOAD_SIZE');
      }
      await checkedChannel(channelId);
      const thumbnail = file.thumbnail;
      const thumb = thumbnail?.type === 'image/jpeg' && thumbnail.size > 0 && thumbnail.size < uploadThumbnailLimit
        ? await client.uploadFile({
          file: {
            name: 'thumb.jpg', size: thumbnail.size,
            readRange: async (offset, length) => new Uint8Array(await thumbnail.slice(offset, offset + length).arrayBuffer())
          },
          workers: 1
        }) : undefined;
      const readRange = file.readRange ?? (async (offset, length) =>
        new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()));
      const preferLargeParts = file.size >= largeUploadThreshold;
      const uploaded = await client.uploadFile({
        file: { name: file.name, size: file.size, readRange, preferLargeParts }, onProgress,
        workers: preferLargeParts ? 4 : 2
      });
      const { input, protectedChannel } = await checkedChannel(channelId);
      const media = new Api.InputMediaUploadedDocument({
        file: uploaded,
        thumb,
        mimeType: file.type || 'application/octet-stream',
        attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })],
        forceFile: true
      });
      const caption = file.name.includes('^') || folder.includes('^') ? '\\' + folder.replace(/\//g, '\\') :
        folder ? folder.replace(/\//g, '^') + '^' + file.name : '';
      try {
        const message = await client.sendFile(input, { file: media, caption, formattingEntities: [] });
        const result = message && rememberAttachment(channelId, message, protectedChannel);
        if (!result) throw new Error('CLOUD_SEND_UNCONFIRMED');
        applyCloudMessage(channelId, message, true);
        return result;
      } catch (error) {
        // Telegram can publish the attachment even if the acknowledgement is lost.
        dirtyHeads.add(channelId);
        throw error;
      }
    },
    logout: () => client.logOut(),
    close
  });
}

window.MiniAppTelegram = Object.freeze({
  version: 1, supportsQrLogin: true, supportsCloud: true, supportsCloudActions: true, protectsSession: true,
  reportsScheduleOutcomes: true,
  cloudVersion: 3, cloudUploadLimit, scheduleLimits, supportsShoppingPurchases: true, shoppingHistoryBytes,
  phoneLoginDiagnostics: true, qrLoginDiagnostics: true,
  supportsClientMetadata: true, supportsTestServers: true, phoneLoginVersion: 2, createClient
});

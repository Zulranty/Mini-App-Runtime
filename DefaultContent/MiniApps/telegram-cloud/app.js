'use strict';

const byId = id => document.getElementById(id);
const controls = byId('controls');
const channelPicker = byId('channels');
const channelSearch = byId('channel-search');
const toolbar = byId('cloud-toolbar');
const folderPath = byId('folders');
const folderActions = byId('folder-actions');
const folderMenu = byId('folder-menu');
const fileMenu = byId('file-menu');
const dropTarget = byId('drop-target');
const targetPicker = byId('cloud-target');
const transferDialog = byId('transfers');
const fileList = byId('file-list');
const catalogEnd = byId('catalog-end');
const channels = new Map();
const files = new Map();
const explicitFolders = new Set();
const selectedFiles = new Set();
const preview = byId('preview');
const previewBody = byId('preview-body');
const previewDate = byId('preview-date');
const previewScale = byId('preview-scale');
const previewPrev = byId('preview-prev');
const previewNext = byId('preview-next');
const previewUnmute = byId('preview-unmute');
const viewMode = byId('view-mode');
const sortMode = byId('sort-mode');
const tiles = new Map();
const thumbnailCache = new Map();
const thumbnailRatios = new WeakMap();
const MiB = 1024 * 1024;
const previewLimit = 10 * MiB;
const imagePreviewLimit = 64 * MiB;
const dateFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'short' });
const sizeFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const fileNames = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
let client;
let channel;
let folder = '';
let before;
let currentPreview;
let folderMedia = [];
let touchGesture;
let mousePan;
let suppressMouseClick = false;
let suppressTapUntil = 0;
let previewUrl;
let previewThumbnailUrl;
let previewStream;
let previewCover;
let transferView = 'upload';
let nativeToolbar = false;
let nativeContextMenu = false;
let contextFiles = [];
let fileHold;
let suppressFileClick = false;
let toolbarState;
let visiblePath;
let localFileId = 0;
let directorySaves = false;
let channelMore = false;
let pagingFiles = false;
let pagingFailed = false;
let catalogColumns = 1;
let catalogScroll;
let masonryWidth = 0;
let masonryFrame = 0;
let activeThumbnails = 0;
let uploadLimit;
let waitTimer;
let cloudUpdateFrame;

const transfers = createCloudTransfers({
  filesApi: mini.files, streams: mini.streams, readLocalRange, mimeType, safeName, canSaveFile,
  canMakeThumbnail: (file, type) => file.size <= imagePreviewLimit && previewKind(type) === 'img',
  makeThumbnail: async (file, type) => resizeImage(await localFileBlob(file, type), 320, 'image/jpeg'),
  expired, errorText, reportError, isCurrentSession: session => client === session, status,
  onProgress: renderTransferProgress,
  onChange: syncTransfers,
  onDownloadComplete: transfer => {
    const statusId = !currentPreview?.local && currentPreview?.file.id === transfer.previewFileId && transfer.previewFileId !== undefined ?
      'preview-status' : 'status';
    status(transfer.detail, transfer.error, statusId);
  },
  onQueueChange: () => { renderQueue(); syncTransfers(); },
  onQueuedFileRemoved: file => {
    byId('queue').querySelector(`[data-upload-id="${CSS.escape(file.id)}"]`)?.remove();
    if (currentPreview?.local && currentPreview.file.id === file.id) resetPreview();
  },
  onQueueCleared: () => {
    if (currentPreview?.local) resetPreview();
    renderQueue();
    syncTransfers();
  },
  onCatalogFile: file => files.set(file.id, file),
  onCatalogChange: renderFiles
});

const observer = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    const tile = tiles.get(target);
    if (!tile) continue;
    tile.visible = isIntersecting;
    if (!isIntersecting) dropThumbnail(tile);
  }
  loadThumbnails();
}, { rootMargin: '140px' });
const catalogObserver = new IntersectionObserver(schedulePaging, { rootMargin: '260px' });
const masonryObserver = new ResizeObserver(entries => {
  if (masonryFrame || !entries.some(entry => entry.target !== fileList || entry.contentRect.width !== masonryWidth)) return;
  masonryFrame = requestAnimationFrame(() => {
    masonryFrame = 0;
    layoutMasonry();
  });
});

const messages = {
  operation_cancelled: 'Действие отменено.',
  permission_not_declared: 'Обновите облако и MiniApps для работы с папками.',
  permission_denied: 'MiniApps не получил разрешение на работу с файлами.',
  user_gesture_required: 'Нажмите кнопку ещё раз, чтобы открыть системный диалог.',
  module_load_failed: 'Установите обновлённый модуль Modules/telegram и откройте облако заново.',
  secure_storage_failed: 'Сохранённый вход недоступен. Войдите снова в Unofficial Telegram.',
  telegram_session_changed: 'Сохранённый сеанс изменился. Подключитесь к аккаунту заново.',
  telegram_session_busy: 'Этот вход уже использует другая мини-аппка. Закройте её и нажмите «Использовать сохранённый вход».',
  telegram_session_unavailable: 'Не удалось заблокировать общий сеанс Telegram. Откройте мини-аппку заново.',
  telegram_runtime_update_required: 'Обновите MiniApps для безопасного общего входа в Telegram.',
  FROZEN_METHOD_INVALID: 'Telegram ограничил аккаунт. Откройте официальный Telegram, чтобы увидеть причину и возможность обжалования.',
  FROZEN_PARTICIPANT_MISSING: 'Telegram ограничил доступ этого аккаунта к каналу.',
  CLOUD_CHANNEL_UNAVAILABLE: 'Канал больше не приватный или право публикации недоступно. Вернитесь к списку каналов.',
  CLOUD_FILE_MISSING: 'Файл больше недоступен. Обновите список.',
  CLOUD_FILE_PROTECTED: 'В канале включена защита контента. Файл можно только посмотреть.',
  CLOUD_FILE_TOO_LARGE: 'Полный предпросмотр этого формата доступен до 10 МиБ.',
  CLOUD_TRANSFER_SIZE: 'Для скачивания и потокового просмотра доступны файлы до 2 ГБ.',
  stream_read_failed: 'Получить данные из Telegram не удалось. Повторите попытку.',
  file_write_failed: 'Не удалось сохранить файл. Проверьте место на диске и выбранную папку.',
  CLOUD_FILE_INCOMPLETE: 'Не удалось прочитать файл целиком.',
  CLOUD_UPLOAD_SIZE: 'Можно загрузить непустые файлы до 2 ГБ.',
  file_read_failed: 'Не удалось прочитать выбранный файл. Выберите его ещё раз.',
  CLOUD_SEND_UNCONFIRMED: 'Telegram не подтвердил публикацию. Проверьте список файлов перед повторной загрузкой.',
  CLOUD_EDIT_UNCONFIRMED: 'Telegram не подтвердил изменение. Откройте канал заново и проверьте файл.',
  CLOUD_FORWARD_UNCONFIRMED: 'Telegram не подтвердил все пересылки. Проверьте чат перед повтором.',
  CLOUD_INVALID_NAME: 'Укажите имя без разделителей пути и специальных символов.',
  CLOUD_DROP_READ_FAILED: 'Не удалось прочитать перетащенные файлы или папки. Проверьте, что они доступны, и повторите.',
  CHAT_ADMIN_REQUIRED: 'Для этой операции нужны дополнительные права в канале.',
  MESSAGE_AUTHOR_REQUIRED: 'Telegram разрешает изменить эту подпись автору или администратору с правом редактирования.',
  MESSAGE_EDIT_TIME_EXPIRED: 'Telegram больше не позволяет изменить этот пост.',
  MEDIA_CAPTION_TOO_LONG: 'В подписи Telegram не хватает места для нового имени или пути.',
  CHAT_FORWARDS_RESTRICTED: 'Telegram запрещает пересылать сообщения из этого канала.',
  CHAT_WRITE_FORBIDDEN: 'Telegram не разрешил публикацию в этот канал.',
  CHANNEL_PRIVATE: 'Доступ к каналу потерян. Обновите список каналов.'
};

function status(text, error = false, id = preview.open ? 'preview-status' : 'status') {
  const element = byId(id);
  element.textContent = text;
  element.classList.toggle('error', error);
}

function errorText(error) {
  const code = error?.errorMessage || (typeof error?.code === 'string' ? error.code : error?.message);
  const seconds = Number(error?.seconds || /^(?:FLOOD|SLOWMODE)_WAIT_(\d+)$/.exec(code)?.[1]);
  if (seconds > 0) return 'Telegram просит повторить через ' + seconds + ' с.';
  return Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] :
    'Операция не завершилась. Проверьте подключение к Telegram и повторите.';
}

function expired(error) {
  return error?.code === 401 || ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_DUPLICATED', 'SESSION_REVOKED', 'SESSION_EXPIRED']
    .includes(error?.errorMessage || error?.message);
}

async function reportError(error) {
  if (expired(error)) {
    const closing = closeClient();
    transfers.discardDownload();
    const released = clearQueue();
    leaveDrive();
    channelPicker.close();
    targetPicker.close();
    transferDialog.close();
    byId('welcome').hidden = false;
    status('Сеанс Telegram завершён. Войдите снова в Unofficial Telegram и сохраните сеанс.', true);
    await Promise.all([released, closing]);
  } else if (channelPicker.open) byId('channel-status').textContent = errorText(error);
  else status(errorText(error), error?.code !== 'operation_cancelled');
}

async function run(task) {
  if (controls.disabled) return;
  controls.disabled = true;
  byId('close-preview').disabled = true;
  updatePreviewNavigation();
  controls.setAttribute('aria-busy', 'true');
  status('');
  try {
    await task();
  } catch (error) {
    await reportError(error);
  } finally {
    controls.disabled = false;
    byId('close-preview').disabled = false;
    updatePreviewNavigation();
    controls.setAttribute('aria-busy', 'false');
    schedulePaging();
  }
}

function node(tag, content) {
  const element = document.createElement(tag);
  if (content) element.textContent = content;
  return element;
}

function button(title, action, detail) {
  const element = node('button');
  element.type = 'button';
  element.append(node('span', title));
  if (detail) element.append(node('small', detail));
  element.addEventListener('click', () => run(action));
  return element;
}

function row(...children) {
  const element = node('li');
  element.append(...children);
  return element;
}

function renderRows(id, rows, emptyText) {
  const empty = node('li', emptyText);
  empty.className = 'empty';
  byId(id).replaceChildren(...(rows.length ? rows : [empty]));
}

function sizeLabel(size) {
  if (!Number.isFinite(size)) return 'Размер неизвестен';
  if (size >= 1_000_000_000) return sizeFormat.format(size / 1_000_000_000) + ' ГБ';
  if (size >= MiB) return sizeFormat.format(size / MiB) + ' МиБ';
  if (size >= 1024) return sizeFormat.format(size / 1024) + ' КиБ';
  return sizeFormat.format(size) + ' Б';
}

async function closeClient() {
  const previous = client;
  client = undefined;
  showTelegramWait(0);
  await previous?.close().catch(() => {});
}

function showTelegramWait(until) {
  clearTimeout(waitTimer);
  const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const text = seconds ? 'Telegram ограничил запросы. Продолжим через ' + seconds + ' с.' : '';
  for (const id of ['telegram-wait', 'transfer-wait']) {
    byId(id).textContent = text;
    byId(id).hidden = !seconds;
  }
  if (seconds) waitTimer = setTimeout(() => showTelegramWait(until), 1000);
}

function showServiceNotice(notice) {
  if (!notice.text) return;
  if (notice.popup) void mini.ui.alert({ title: 'Telegram', message: notice.text }).catch(() => {});
  else status(notice.text, false, 'status');
}

function updateFromTelegram(change) {
  if (channel?.id !== change.channelId) return;
  if (change.removed) {
    for (const id of change.removed) {
      files.delete(id);
      selectedFiles.delete(id);
      if (currentPreview?.file.id === id && !currentPreview.local) resetPreview();
    }
  } else if (change.fresh || files.has(change.messageId)) {
    if (change.file) files.set(change.messageId, change.file);
    else {
      files.delete(change.messageId);
      selectedFiles.delete(change.messageId);
      if (currentPreview?.file.id === change.messageId && !currentPreview.local) resetPreview();
    }
  } else return;
  if (cloudUpdateFrame) return;
  cloudUpdateFrame = requestAnimationFrame(() => {
    cloudUpdateFrame = undefined;
    renderFiles();
  });
}

async function connect(automatic = false) {
  const saved = await mini.functions.call(automatic ? 'telegram.restoreSaved' : 'telegram.connect');
  if (!saved?.apiId || !saved?.apiHash || !saved?.session) {
    if (!automatic) status('Сохранённый вход не найден. Войдите в Unofficial Telegram с сохранением сеанса.', true);
    return;
  }
  await mini.modules.load('telegram');
  const library = window.MiniAppTelegram;
  if (library?.cloudVersion !== 3 || !library.supportsCloudActions || !library.protectsSession) throw new Error('module_load_failed');
  uploadLimit = library.cloudUploadLimit;
  nativeToolbar = await mini.runtime.supports('telegramCloud.setToolbar');
  nativeContextMenu = nativeToolbar && await mini.runtime.supports('telegramCloud.showContextMenu');
  directorySaves = await mini.runtime.supports('streams.saveInDirectory');
  status('Подключаемся к Telegram…');
  try {
    client = library.createClient({ ...saved, onFloodWait: showTelegramWait, onServiceNotice: showServiceNotice, onCloudChange: updateFromTelegram });
    await client.resume();
  } catch (error) {
    await closeClient();
    throw error;
  }
  byId('welcome').hidden = true;
  updateToolbar();
  await loadChannels(true);
  const savedChannelId = await mini.functions.call('telegramCloud.getSavedChannel');
  if (savedChannelId) {
    while (channelMore && !channels.has(savedChannelId)) await loadChannels(false);
    const previous = channels.get(savedChannelId);
    if (previous) {
      await openChannel(previous, false);
      return;
    }
  }
  showChannelPicker();
}

async function loadChannels(reset) {
  if (reset) {
    channels.clear();
    channelMore = true;
  }
  const progress = byId('channel-status');
  progress.textContent = 'Загружаем каналы…';
  byId('more-channels').disabled = true;
  try {
    const page = await client.cloudChannels(reset);
    for (const item of page.items) channels.set(item.id, item);
    channelMore = page.more;
    progress.textContent = '';
  } catch (error) {
    progress.textContent = errorText(error);
    throw error;
  } finally {
    byId('more-channels').disabled = false;
    renderChannels();
  }
}

function renderChannels() {
  const query = channelSearch.value.trim().toLocaleLowerCase('ru');
  const found = [...channels.values()].filter(item => item.title.toLocaleLowerCase('ru').includes(query));
  renderRows('channel-list', found.map(item => row(button(item.title, () => openChannel(item)))),
    channelMore ? 'В просмотренной части списка совпадений пока нет.' : 'Подходящих каналов нет.');
  byId('more-channels').hidden = !channelMore;
}

function showChannelPicker() {
  if (channelPicker.open) return;
  stopCatalogScroll();
  channelSearch.value = '';
  renderChannels();
  channelPicker.showModal();
}

async function openChannel(item, remember = true) {
  if (channel?.id === item.id) {
    channelPicker.close();
    return;
  }
  if (transfers.upload?.running || transfers.download?.running) return;
  if (transfers.queuedCount && !await mini.ui.confirm({ title: 'Сменить канал?', message: 'Список файлов к загрузке будет очищен.' })) return;
  status('Загружаем файлы канала…');
  const page = await client.cloudFiles(item.id);
  await clearQueue();
  transfers.discardDownload();
  channel = item;
  folder = '';
  channelPicker.close();
  byId('drive').hidden = false;
  setFilePage(page, true);
  stopCatalogScroll();
  window.scrollTo(0, 0);
  updateToolbar();
  status('');
  if (remember) {
    try { await mini.functions.call('telegramCloud.rememberChannel', { id: item.id }); }
    catch { status('Канал открыт. Сохранить выбор на этом устройстве не удалось.', true); }
  }
}

function setFilePage(page, reset) {
  if (reset) {
    files.clear();
    explicitFolders.clear();
    clearFileSelection();
    thumbnailCache.clear();
    pagingFailed = false;
  }
  for (const item of page.items) files.set(item.id, item);
  for (const path of page.folders ?? []) explicitFolders.add(path);
  before = page.next;
  renderFiles();
}

function renderFiles() {
  clearThumbnails();
  const rows = [];
  const visibleFiles = [];
  const folders = new Set();
  const prefix = folder ? folder + '/' : '';
  for (const path of explicitFolders) {
    if (path !== folder && path.startsWith(prefix)) folders.add(path.slice(prefix.length).split('/')[0]);
  }
  for (const file of files.values()) {
    const path = file.folder;
    if (path === folder) {
      visibleFiles.push(file);
    } else if (path.startsWith(prefix)) {
      folders.add(path.slice(prefix.length).split('/')[0]);
    }
  }
  const reverseNames = sortMode.value === 'name-desc' ? -1 : 1;
  for (const name of [...folders].sort((a, b) => reverseNames * fileNames.compare(a, b))) {
    rows.push(catalogRow(name, () => navigateFolder(prefix + name), 'Папка'));
  }
  visibleFiles.sort(compareFiles);
  folderMedia = visibleFiles.filter(isGalleryMedia);
  for (const file of visibleFiles) {
    const date = file.date ? dateFormat.format(file.date * 1000) : '';
    const detail = [sizeLabel(file.size), date].filter(Boolean).join(' · ');
    rows.push(catalogRow(file.name, () => previewRemote(file), detail, file));
  }
  masonryObserver.disconnect();
  fileList.dataset.view = viewMode.value;
  renderRows('file-list', rows, 'В загруженных записях этой папки файлов пока нет.');
  const packed = viewMode.value !== 'list' && rows.length > 0;
  fileList.classList.toggle('masonry', packed);
  if (packed) {
    layoutMasonry();
    masonryObserver.observe(fileList);
    for (const card of rows) masonryObserver.observe(card);
  } else {
    catalogColumns = 1;
    fileList.style.removeProperty('height');
  }
  catalogEnd.hidden = before === undefined;
  byId('catalog-retry').hidden = !pagingFailed;
  byId('catalog-status').textContent = pagingFailed ? 'Не удалось загрузить следующую порцию. ' : '';

  schedulePaging();
}

function layoutMasonry() {
  if (!fileList.classList.contains('masonry')) return;
  const width = fileList.getBoundingClientRect().width;
  if (!width) return;
  masonryWidth = width;
  const style = getComputedStyle(fileList);
  const gap = parseFloat(style.columnGap);
  const minWidth = parseFloat(style.getPropertyValue('--tile-min-width'));
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  catalogColumns = columns;
  const tileWidth = (width - (columns - 1) * gap) / columns;
  fileList.style.setProperty('--tile-width', tileWidth + 'px');

  const cards = Array.from(fileList.children);
  const heights = cards.map(card => card.getBoundingClientRect().height);
  const nextTop = Array(columns).fill(0);
  for (const [index, card] of cards.entries()) {
    const top = Math.min(...nextTop);
    const column = nextTop.indexOf(top);
    card.style.left = column * (tileWidth + gap) + 'px';
    card.style.top = top + 'px';
    nextTop[column] += heights[index] + gap;
  }
  fileList.style.height = Math.max(...nextTop) - gap + 'px';
}

function compareFiles(a, b) {
  const order = sortMode.value;
  const byName = fileNames.compare(a.name, b.name);
  if (order === 'name-desc') return -byName;
  if (order === 'date') return (b.date || 0) - (a.date || 0) || byName;
  if (order === 'date-asc') return (a.date || 0) - (b.date || 0) || byName;
  if (order === 'size') return b.size - a.size || byName;
  if (order === 'size-asc') return a.size - b.size || byName;
  return byName;
}

function thumbnailRatio(width, height) {
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return width + ' / ' + height;
  }
  return '';
}

function catalogRow(name, action, detail, file) {
  const control = button(name, action, detail);
  control.title = name + '\n' + detail;
  if (viewMode.value !== 'list') {
    const kind = file && previewKind(mimeType(file));
    const media = node('span');
    media.className = 'tile-media';
    media.setAttribute('aria-hidden', 'true');
    const icon = node('span', !file ? '📁' : kind === 'video' ? '▶' : kind === 'audio' ? '♫' : kind === 'img' ? '▧' : '▤');
    icon.className = 'tile-icon';
    media.append(icon);
    control.prepend(media);
    if (file?.thumbnail) {
      media.style.aspectRatio = thumbnailRatios.get(file) ?? thumbnailRatio(file.thumbnail.width, file.thumbnail.height);
      tiles.set(media, { media, file, channelId: channel.id });
      observer.observe(media);
    }
  }
  const card = row(control);
  if (file) {
    card.className = 'selectable-file';
    card.dataset.fileId = file.id;
    const label = node('label');
    label.className = 'file-check';
    const check = node('input');
    check.type = 'checkbox';
    check.checked = selectedFiles.has(file.id);
    check.setAttribute('aria-label', 'Выбрать ' + file.name);
    card.toggleAttribute('data-selected', check.checked);
    check.addEventListener('change', () => {
      if (check.checked) selectedFiles.add(file.id);
      else selectedFiles.delete(file.id);
      card.toggleAttribute('data-selected', check.checked);
    });
    label.append(check);
    card.append(label);
  }
  return card;
}

function dropThumbnail(tile) {
  tile.request?.abort();
  tile.prepared = false;
  tile.finished = false;
  if (tile.url) {
    tile.media.querySelector('img')?.remove();
    URL.revokeObjectURL(tile.url);
    tile.url = undefined;
  }
}

function clearThumbnails() {
  observer.disconnect();
  for (const tile of tiles.values()) dropThumbnail(tile);
  tiles.clear();
}

function loadThumbnails() {
  for (const tile of tiles.values()) {
    if (!tile.visible || tile.request || tile.finished) continue;
    const fetch = Boolean(tile.prepared);
    if (fetch && activeThumbnails >= 2) continue;
    const request = tile.request = new AbortController();
    if (fetch) activeThumbnails++;
    loadTileThumbnail(tile, fetch, request.signal).catch(() => {}).finally(() => {
      if (fetch) activeThumbnails--;
      if (!request.signal.aborted) {
        tile.prepared = true;
        if (fetch) tile.finished = true;
      }
      tile.request = undefined;
      loadThumbnails();
    });
  }
}

async function loadTileThumbnail(tile, fetch, signal) {
  const { channelId, file } = tile;
  if (fetch) {
    const blob = await fetchThumbnail(channelId, file, signal);
    await showThumbnail(tile, blob, signal);
    return;
  }
  const memoryKey = thumbnailMemoryKey(channelId, file);
  const memory = thumbnailCache.get(memoryKey);
  if (memory && await showThumbnail(tile, memory, signal)) {
    rememberThumbnail(memoryKey, memory);
    tile.finished = true;
    return;
  }
  const cached = cachedThumbnail(channelId, file, signal);
  const complete = file.inlineThumbnail?.complete;
  const embedded = await showThumbnail(tile, inlineThumbnailBlob(file), signal, !complete);
  if (signal.aborted) return;
  const sharp = await showThumbnail(tile, await cached, signal);
  if (!signal.aborted) tile.finished = sharp || (embedded && complete);
}

function inlineThumbnailBlob(file) {
  if (file.inlineThumbnail) return new Blob([file.inlineThumbnail.bytes], { type: 'image/jpeg' });
}

function thumbnailDiskKey(channelId, file) {
  if (file.thumbnailKey && !file.protected) return 'v1:' + channelId + ':' + file.id + ':' + file.thumbnailKey;
}

function thumbnailMemoryKey(channelId, file) {
  return [channelId, file.id, file.thumbnailKey, file.protected].join(':');
}

function rememberThumbnail(key, blob) {
  thumbnailCache.delete(key);
  if (thumbnailCache.size >= 96) thumbnailCache.delete(thumbnailCache.keys().next().value);
  thumbnailCache.set(key, blob);
  return blob;
}

async function cachedThumbnail(channelId, file, signal) {
  if (!file.thumbnail || signal?.aborted) return;
  const current = client;
  const key = thumbnailMemoryKey(channelId, file);
  const blob = thumbnailCache.get(key);
  if (blob) return rememberThumbnail(key, blob);
  const diskKey = thumbnailDiskKey(channelId, file);
  if (!diskKey) return;
  try {
    const stored = await mini.functions.call('telegramCloud.getThumbnail', { key: diskKey });
    if (signal?.aborted || current !== client) return;
    const match = /^data:(image\/(?:jpeg|png|webp|avif|gif|bmp));base64,([A-Za-z0-9+/=]+)$/.exec(stored);
    if (match) return rememberThumbnail(key,
      new Blob([Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))], { type: match[1] }));
  } catch {}
}

async function fetchThumbnail(channelId, file, signal) {
  if (!file.thumbnail || signal?.aborted) return;
  const current = client;
  const data = await current.cloudThumbnail(channelId, file.id, signal, file);
  if (!data || signal?.aborted || current !== client) return;
  const blob = await thumbnailBlob(data);
  if (signal?.aborted || current !== client) return;
  const diskKey = thumbnailDiskKey(channelId, file);
  if (diskKey && data.key === file.thumbnailKey && !data.protected && blob.size <= 128 * 1024) {
    const reader = new FileReader();
    reader.onload = () => {
      if (current === client && !signal?.aborted) void mini.functions.call('telegramCloud.cacheThumbnail', { key: diskKey, data: reader.result }).catch(() => {});
    };
    reader.readAsDataURL(blob);
  }
  return rememberThumbnail(thumbnailMemoryKey(channelId, file), blob);
}

async function getThumbnail(channelId, file, signal) {
  const cached = await cachedThumbnail(channelId, file, signal);
  if (cached || signal?.aborted) return cached;
  const inline = inlineThumbnailBlob(file);
  if (file.inlineThumbnail?.complete) return inline;
  return await fetchThumbnail(channelId, file, signal) ?? inline;
}

async function thumbnailBlob(data) {
  const source = new Blob([data.bytes], { type: data.mimeType });
  if (!data.resize && source.size <= 128 * 1024) return source;
  return resizeImage(source, 360, 'image/webp');
}

async function resizeImage(source, maxSide, type) {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = node('canvas');
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (type === 'image/jpeg') {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Thumbnail conversion failed')), type, 0.8);
    });
  } finally {
    bitmap.close();
  }
}

async function showDecodedImage(blob, signal, display) {
  if (!blob || signal?.aborted) return false;
  const url = URL.createObjectURL(blob);
  const image = node('img');
  const cancel = () => image.removeAttribute('src');
  signal?.addEventListener('abort', cancel, { once: true });
  image.src = url;
  let shown = false;
  try {
    await image.decode();
    if (!signal?.aborted) shown = display(image, url);
    return shown;
  } catch {
    return false;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!shown) URL.revokeObjectURL(url);
  }
}

function showThumbnail(tile, blob, signal, provisional = false) {
  return showDecodedImage(blob, signal, (image, url) => {
    const ratio = thumbnailRatio(image.naturalWidth, image.naturalHeight);
    if (ratio && (!provisional || !tile.media.style.aspectRatio)) {
      if (!provisional) thumbnailRatios.set(tile.file, ratio);
      tile.media.style.aspectRatio = ratio;
    }
    image.alt = '';
    const previous = tile.media.querySelector('img');
    if (previous) previous.replaceWith(image);
    else tile.media.append(image);
    if (tile.url) URL.revokeObjectURL(tile.url);
    tile.url = url;
    return true;
  });
}

function navigateFolder(path) {
  stopCatalogScroll();
  if (path !== folder) clearFileSelection();
  folder = path;
  resetPreview();
  renderFiles();
  window.scrollTo(0, 0);
  updateToolbar();
}

function stopCatalogScroll() {
  if (catalogScroll) cancelAnimationFrame(catalogScroll.frame);
  catalogScroll = undefined;
}

function scrollCatalogTo(target) {
  const start = window.scrollY;
  stopCatalogScroll();
  if (Math.abs(target - start) <= 0.5) return;
  let previousFrame;
  let elapsed = 0;
  const movement = catalogScroll = { target, frame: 0 };
  function animate(now) {
    if (previousFrame !== undefined) elapsed += Math.min(32, now - previousFrame);
    previousFrame = now;
    const progress = Math.min(1, elapsed / 360);
    const top = start + (target - start) * progress * (2 - progress);
    window.scrollTo({ top, behavior: 'instant' });
    if (progress < 1) movement.frame = requestAnimationFrame(animate);
    else catalogScroll = undefined;
  }
  movement.frame = requestAnimationFrame(animate);
}

function wheelCatalog(event) {
  if (!channel || preview.open || channelPicker.open || targetPicker.open || transferDialog.open || !folderMenu.hidden || !fileMenu.hidden ||
      !event.cancelable || event.defaultPrevented || event.ctrlKey || event.shiftKey || event.metaKey ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.target.closest?.('input, select, textarea') ||
      !fileList.firstElementChild || fileList.firstElementChild.classList.contains('empty')) return;

  const limit = Math.max(0, document.scrollingElement.scrollHeight - innerHeight);
  const reference = Math.min(limit, catalogScroll?.target ?? window.scrollY);
  const down = event.deltaY > 0;
  const cards = fileList.children;
  const catalogTop = fileList.getBoundingClientRect().top;
  const rowCount = Math.ceil(cards.length / catalogColumns);
  const rowTop = index => Math.round(cards[index * catalogColumns].getBoundingClientRect().top - catalogTop);
  let low = 0;
  let high = rowCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const offset = rowTop(middle);
    const beforeTarget = down ? offset <= reference + 0.5 : offset < reference - 0.5;
    if (beforeTarget) low = middle + 1;
    else high = middle;
  }
  const rowIndex = down ? low : low - 1;
  const target = rowIndex < 0 ? 0 : rowIndex >= rowCount ? limit : rowTop(rowIndex);
  event.preventDefault();
  scrollCatalogTo(Math.min(target, limit));
}

function schedulePaging() {
  requestAnimationFrame(() => {
    if (!channel || before === undefined || pagingFiles || pagingFailed || controls.disabled ||
        channelPicker.open || preview.open || transferDialog.open || catalogEnd.getBoundingClientRect().top > innerHeight + 260) return;
    void loadOlder();
  });
}

async function loadOlder() {
  const current = channel;
  const cursor = before;
  pagingFiles = true;
  byId('catalog-status').textContent = 'Загружаем файлы…';
  try {
    const page = await client.cloudFiles(current.id, cursor);
    if (channel === current) setFilePage(page, false);
  } catch (error) {
    if (channel === current) {
      pagingFailed = true;
      byId('catalog-status').textContent = errorText(error) + ' ';
      byId('catalog-retry').hidden = false;
    }
  } finally {
    pagingFiles = false;
    schedulePaging();
  }
}

function leaveDrive() {
  channel = undefined;
  files.clear();
  explicitFolders.clear();
  clearFileSelection();
  folderMedia = [];
  clearThumbnails();
  thumbnailCache.clear();
  resetPreview();
  byId('drive').hidden = true;
  updateToolbar();
}

function resetPreview(keepOpen = false) {
  if (!keepOpen && preview.open) preview.close();
  previewCover?.abort();
  previewCover = undefined;
  const player = previewBody.querySelector('video, audio');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  if (previewStream) void previewStream.close().catch(() => {});
  previewStream = undefined;
  previewBody.replaceChildren();
  setPreviewScale();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  releasePreviewThumbnail();
  currentPreview = undefined;
  touchGesture = undefined;
  previewUnmute.hidden = true;
  byId('preview-name').textContent = '';
  previewDate.hidden = true;
  previewDate.textContent = '';
  previewDate.removeAttribute('datetime');
  byId('preview-status').textContent = '';
  byId('save').hidden = true;
  updatePreviewNavigation();
}

function releasePreviewThumbnail() {
  if (previewThumbnailUrl) URL.revokeObjectURL(previewThumbnailUrl);
  previewThumbnailUrl = undefined;
}

function setPreviewScale(mode) {
  stopMousePan();
  const frame = previewBody.querySelector('.preview-frame');
  if (mode) preview.dataset.scale = mode;
  else delete preview.dataset.scale;
  previewScale.hidden = !mode || !frame;
  previewScale.setAttribute('aria-pressed', String(mode === 'original'));
  previewScale.title = mode === 'fit' ? 'Показать в исходном размере' : 'Вписать в окно';
  if (mode !== 'zoom') {
    frame?.style.removeProperty('width');
    frame?.style.removeProperty('height');
    previewBody.scrollTop = 0;
    previewBody.scrollLeft = 0;
  }
}

function visualGeometry() {
  const frame = previewBody.querySelector('.preview-frame');
  const media = frame?.firstElementChild;
  const width = media?.videoWidth ?? media?.naturalWidth;
  const height = media?.videoHeight ?? media?.naturalHeight;
  if (!width || !height) return;
  const bounds = frame.getBoundingClientRect();
  return { frame, width, height, bounds, scale: Math.min(bounds.width / width, bounds.height / height) };
}

function zoomPreview(visual, multiplier, x, y) {
  const { frame, width, height, bounds, scale } = visual;
  if (!scale || !multiplier) return;
  const fit = Math.min(previewBody.offsetWidth / width, previewBody.offsetHeight / height);
  const next = Math.max(Math.min(fit, 1) / 4, Math.min(scale * multiplier, Math.max(fit, 1) * 8));
  if (Math.abs(next - scale) < 0.0001) return;
  const anchorX = (x - bounds.left - (bounds.width - width * scale) / 2) / (width * scale);
  const anchorY = (y - bounds.top - (bounds.height - height * scale) / 2) / (height * scale);
  setPreviewScale('zoom');
  frame.style.width = width * next + 'px';
  frame.style.height = height * next + 'px';
  const after = frame.getBoundingClientRect();
  previewBody.scrollLeft += after.left + after.width * anchorX - x;
  previewBody.scrollTop += after.top + after.height * anchorY - y;
}

function previewOverflows() {
  return previewBody.scrollWidth > previewBody.clientWidth || previewBody.scrollHeight > previewBody.clientHeight;
}

function startMousePan(event) {
  if (event.pointerType !== 'mouse' || event.button !== 0) return;
  suppressMouseClick = false;
  const target = event.target;
  if (!target.closest('.preview-frame') || target instanceof HTMLVideoElement || !previewOverflows()) return;
  target.setPointerCapture(event.pointerId);
  mousePan = { target, id: event.pointerId, x: event.clientX, y: event.clientY,
    left: previewBody.scrollLeft, top: previewBody.scrollTop };
}

function moveMousePan(event) {
  const gesture = mousePan;
  if (!gesture || event.pointerId !== gesture.id) return;
  if (!(event.buttons & 1)) {
    stopMousePan();
    return;
  }
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (!suppressMouseClick && Math.hypot(dx, dy) < 5) return;
  suppressMouseClick = true;
  previewBody.classList.add('dragging');
  previewBody.scrollTo(gesture.left - dx, gesture.top - dy);
}

function stopMousePan() {
  if (!mousePan) return;
  const { target, id } = mousePan;
  mousePan = undefined;
  previewBody.classList.remove('dragging');
  if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
}

function pinchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function startPreviewTouch(event) {
  if (!preview.dataset.scale || (!touchGesture && event.target instanceof HTMLVideoElement)) return;
  if (event.touches.length === 2) {
    touchGesture = { distance: pinchDistance(event.touches) };
  } else if (event.touches.length === 1) {
    const { clientX: x, clientY: y } = event.touches[0];
    const pan = previewOverflows();
    touchGesture = { x, y, pan, left: previewBody.scrollLeft, top: previewBody.scrollTop };
  }
}

function movePreviewTouch(event) {
  const gesture = touchGesture;
  if (!gesture) return;
  if (gesture.distance !== undefined) {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    const visual = visualGeometry();
    const distance = pinchDistance(event.touches);
    const a = event.touches[0];
    const b = event.touches[1];
    if (visual && gesture.distance > 0 && distance > 0) {
      zoomPreview(visual, distance / gesture.distance, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    }
    gesture.distance = distance;
    return;
  }
  if (event.touches.length !== 1) return;
  const dx = event.touches[0].clientX - gesture.x;
  const dy = event.touches[0].clientY - gesture.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 8) return;
  gesture.moved = true;
  event.preventDefault();
  if (gesture.pan) {
    previewBody.scrollLeft = gesture.left - dx;
    previewBody.scrollTop = gesture.top - dy;
  }
}

function endPreviewTouch(event) {
  if (event.touches.length) return;
  const gesture = touchGesture;
  touchGesture = undefined;
  if (!gesture) return;
  if (gesture.moved || gesture.distance !== undefined) suppressTapUntil = performance.now() + 350;
  if (gesture.pan || gesture.distance !== undefined || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - gesture.x;
  const dy = event.changedTouches[0].clientY - gesture.y;
  if (Math.abs(dx) >= 48 && Math.abs(dx) > 1.25 * Math.abs(dy)) {
    suppressTapUntil = performance.now() + 350;
    stepPreview(dx < 0 ? 1 : -1);
  }
}

function renderPreview(element) {
  if (!element.matches('img, video')) {
    previewBody.replaceChildren(element);
    setPreviewScale();
    return;
  }
  const frame = node('div');
  frame.className = 'preview-frame';
  frame.append(element);
  if (element.tagName === 'IMG') element.draggable = false;
  else frame.append(videoSurface(element));
  previewBody.replaceChildren(frame);
  setPreviewScale('fit');
  if (element.tagName === 'VIDEO') void startVideo(element);
}

function videoSurface(video) {
  const surface = node('button');
  surface.type = 'button';
  surface.className = 'video-surface';
  function updateLabel() {
    const title = video.paused ? 'Воспроизвести видео' : 'Поставить видео на паузу';
    surface.setAttribute('aria-label', title);
  }
  updateLabel();
  video.addEventListener('play', updateLabel);
  video.addEventListener('pause', updateLabel);
  video.addEventListener('ended', updateLabel);
  video.addEventListener('volumechange', () => {
    if (previewBody.contains(video)) previewUnmute.hidden = !video.muted;
  });
  surface.addEventListener('click', event => {
    const touchClick = event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents;
    if (touchClick ? performance.now() < suppressTapUntil : event.detail > 0 && suppressMouseClick) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  });
  return surface;
}

async function startVideo(video) {
  try { await video.play(); }
  catch (error) {
    if (error.name !== 'NotAllowedError' || !previewBody.contains(video)) return;
    video.muted = true;
    await video.play().catch(() => {});
  }
}

const extensionTypes = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  txt: 'text/plain', log: 'text/plain', csv: 'text/plain', md: 'text/plain', json: 'text/plain'
};

function mimeType(file) {
  const mime = file.mimeType?.split(';')[0].toLowerCase();
  if (mime && mime !== 'application/octet-stream') return mime;
  const extension = file.name.split('.').pop().toLowerCase();
  return Object.prototype.hasOwnProperty.call(extensionTypes, extension) ? extensionTypes[extension] : 'application/octet-stream';
}

function previewKind(type) {
  if (/^image\/(?:jpeg|png|gif|webp|avif|bmp)$/.test(type)) return 'img';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/') || type === 'application/json') return 'pre';
}

function isGalleryMedia(file) {
  const kind = previewKind(mimeType(file));
  return (kind === 'img' && (file.size <= imagePreviewLimit || file.thumbnail)) ||
    (kind === 'video' && (file.size <= uploadLimit || file.thumbnail));
}

function galleryIndex() {
  if (!currentPreview || currentPreview.local) return -1;
  return folderMedia.findIndex(file => file.id === currentPreview.file.id);
}

function updatePreviewNavigation() {
  const index = galleryIndex();
  const visible = index >= 0 && folderMedia.length > 1;
  previewPrev.hidden = previewNext.hidden = !visible;
  previewPrev.disabled = controls.disabled || index <= 0;
  previewNext.disabled = controls.disabled || index < 0 || index + 1 >= folderMedia.length;
  byId('save').disabled = controls.disabled || Boolean(transfers.download?.running);
  byId('cancel-save').hidden = !transfers.download?.running || !currentPreview || currentPreview.local ||
    transfers.download.previewFileId !== currentPreview.file.id;
}

function stepPreview(direction) {
  const index = galleryIndex();
  const next = index < 0 ? undefined : folderMedia[index + direction];
  if (preview.open && next) void run(() => previewRemote(next));
}

function startPreview(file, local) {
  stopCatalogScroll();
  resetPreview(true);
  currentPreview = { file, local };
  byId('preview-name').textContent = file.name + ' · ' + sizeLabel(file.size);
  if (file.date) {
    const date = new Date(file.date * 1000);
    previewDate.dateTime = date.toISOString();
    previewDate.textContent = dateFormat.format(date);
    previewDate.hidden = false;
  }
  byId('save').hidden = local || file.protected || file.size < 1 || file.size > uploadLimit;
  if (!local && isGalleryMedia(file)) setPreviewScale('fit');
  if (!preview.open) preview.showModal();
  updatePreviewNavigation();
  return previewKind(mimeType(file));
}

function playerFor(kind) {
  const element = node(kind);
  element.controls = true;
  element.preload = 'metadata';
  element.setAttribute('controlslist', 'nodownload nofullscreen');
  element.disablePictureInPicture = true;
  if (kind === 'video') {
    element.playsInline = true;
    element.addEventListener('resize', () => {
      if (!element.videoWidth || !element.videoHeight) return;
      element.width = element.videoWidth;
      element.height = element.videoHeight;
    });
  }
  return element;
}

function setVideoPoster(element, file) {
  if (!file.thumbnail) return;
  const controller = previewCover = new AbortController();
  getThumbnail(channel.id, file, controller.signal).then(blob => {
    if (!blob || controller.signal.aborted) return;
    previewUrl = URL.createObjectURL(blob);
    element.poster = previewUrl;
  }).catch(() => {});
}

async function showPreview(kind, blob, file) {
  const element = kind === 'video' || kind === 'audio' ? playerFor(kind) : node(kind);
  if (kind === 'pre') {
    const text = await blob.slice(0, 64 * 1024).text();
    element.textContent = text + (blob.size > 64 * 1024 ? '\n…' : '');
  } else {
    previewUrl = URL.createObjectURL(blob);
    if (kind === 'img') element.alt = file.name;
    element.addEventListener('error', () => {
      if (previewBody.contains(element)) renderPreview(node('p', 'Этот файл не удалось отобразить.'));
    }, { once: true });
    element.src = previewUrl;
  }
  renderPreview(element);
}

function canPreviewImageParts(type) {
  return type === 'image/jpeg' || type === 'image/png' || (type === 'image/webp' && typeof ImageDecoder === 'function');
}

async function decodeWebpPrefix(parts, signal) {
  const data = new ReadableStream({ start(input) {
    for (const part of parts) input.enqueue(part);
  } });
  // A closed WebP prefix is treated as truncated. Keep the input open while decoding the available rows.
  const decoder = new ImageDecoder({ type: 'image/webp', data });
  void decoder.completed.catch(() => {});
  const close = () => decoder.close();
  const timeout = setTimeout(close, 500);
  signal.addEventListener('abort', close, { once: true });
  let canvas;
  let dimensions;
  try {
    const { image } = await decoder.decode({ completeFramesOnly: false });
    try {
      if (signal.aborted) return;
      dimensions = { width: image.displayWidth, height: image.displayHeight };
      const scale = Math.min(1, 2048 / Math.max(dimensions.width, dimensions.height));
      canvas = node('canvas');
      canvas.width = Math.max(1, Math.round(dimensions.width * scale));
      canvas.height = Math.max(1, Math.round(dimensions.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    } finally {
      image.close();
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', close);
    close();
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  if (blob && !signal.aborted) return { blob, dimensions };
}

async function downloadImagePreview(session, channelId, file, signal, showPartial) {
  const remote = await session.cloudOpenFile(channelId, file.id, false);
  if (signal.aborted) return;
  const type = mimeType(remote);
  if (previewKind(type) !== 'img') throw new Error('CLOUD_FILE_MISSING');
  if (remote.size < 1 || remote.size > imagePreviewLimit) throw new Error('CLOUD_FILE_TOO_LARGE');

  const parts = [];
  const stride = Math.max(128 * 1024, Math.ceil(remote.size / 8));
  let received = 0;
  let nextPrefix = 128 * 1024;
  let decoding = false;
  let finished = false;
  async function displayPrefix(length) {
    if (type === 'image/webp') {
      const decoded = await decodeWebpPrefix(parts, signal);
      if (decoded) await showPartial(decoded.blob, length, decoded.dimensions);
    } else await showPartial(new Blob(parts, { type }), length);
  }
  function updatePartial() {
    if (!canPreviewImageParts(type) || finished || signal.aborted || decoding || received < nextPrefix || received >= remote.size) return;
    nextPrefix = received + stride;
    decoding = true;
    void displayPrefix(received).catch(() => {}).finally(() => {
      decoding = false;
      updatePartial();
    });
  }
  try {
    for await (const part of remote.chunks(signal)) {
      if (signal.aborted) return;
      received += part.byteLength;
      if (received > remote.size) throw new Error('CLOUD_FILE_INCOMPLETE');
      parts.push(part);
      updatePartial();
    }
    if (signal.aborted) return;
    if (received !== remote.size) throw new Error('CLOUD_FILE_INCOMPLETE');
    return new Blob(parts, { type });
  } finally {
    finished = true;
  }
}

function previewPhoto(file) {
  const session = client;
  const channelId = channel.id;
  const { signal } = previewCover = new AbortController();
  let quality = 0;
  let thumbnailQuality = 0;
  let thumbnail;

  function compositePartial(image) {
    const frame = image.parentElement;
    const surface = frame.querySelector('.photo-composite') ?? node('canvas');
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (surface.width !== width) surface.width = width;
    if (surface.height !== height) surface.height = height;
    const context = surface.getContext('2d', { alpha: false });
    if (!context) return;
    const thumbScale = Math.min(width / thumbnail.naturalWidth, height / thumbnail.naturalHeight);
    const thumbWidth = thumbnail.naturalWidth * thumbScale;
    const thumbHeight = thumbnail.naturalHeight * thumbScale;
    context.clearRect(0, 0, width, height);
    context.drawImage(thumbnail, (width - thumbWidth) / 2, (height - thumbHeight) / 2, thumbWidth, thumbHeight);
    context.drawImage(image, 0, 0, width, height);
    if (!surface.isConnected) {
      surface.className = 'photo-composite';
      surface.setAttribute('aria-hidden', 'true');
      frame.append(surface);
    }
    image.classList.add('composited-photo');
  }

  function show(blob, rank, partial = false, dimensions) {
    return showDecodedImage(blob, signal, (image, url) => {
      const previous = previewBody.querySelector('img');
      if (rank <= 2) {
        if (rank <= thumbnailQuality || quality === Infinity) return false;
        thumbnailQuality = rank;
        releasePreviewThumbnail();
        previewThumbnailUrl = url;
        thumbnail = image;
        if (quality > 2) {
          compositePartial(previous);
          return true;
        }
      } else {
        if (rank <= quality) return false;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = url;
      }
      image.alt = file.name;
      image.draggable = false;
      if (dimensions) {
        image.width = dimensions.width;
        image.height = dimensions.height;
      }
      image.classList.toggle('partial-photo', partial);
      if (previous) previous.replaceWith(image);
      else renderPreview(image);
      if (partial && thumbnail) compositePartial(image);
      if (rank === Infinity) {
        image.parentElement.querySelector('.photo-composite')?.remove();
        thumbnail = undefined;
        releasePreviewThumbnail();
      }
      quality = rank;
      return true;
    });
  }
  const memory = thumbnailCache.get(thumbnailMemoryKey(channelId, file));
  const cached = cachedThumbnail(channelId, file, signal);
  const initial = (async () => {
    if (memory && await show(memory, 2)) return;
    await show(inlineThumbnailBlob(file), 1);
    await show(await cached, 2);
  })();

  const full = file.size <= imagePreviewLimit;
  status(full ? 'Загружаем оригинал…' : 'Загружаем миниатюру…');
  void (async () => {
    if (full) {
      let original;
      if (canPreviewImageParts(mimeType(file))) {
        original = await downloadImagePreview(session, channelId, file, signal,
          (blob, received, dimensions) => show(blob, received + 2, true, dimensions));
      } else {
        const data = await session.cloudDownload(channelId, file.id, imagePreviewLimit, false, signal);
        const type = mimeType(data);
        if (previewKind(type) === 'img') original = new Blob([data.bytes], { type });
      }
      if (signal.aborted) return;
      if (!await show(original, Infinity)) {
        if (!signal.aborted) status('Этот файл не удалось отобразить.', true);
        return;
      }
    } else {
      await initial;
      if (quality < 2 && (!quality || !file.inlineThumbnail?.complete)) {
        await show(await fetchThumbnail(channelId, file, signal), 2);
      }
      if (!signal.aborted && !quality) previewBody.append(node('p', 'Для этого файла доступны имя и размер.'));
    }
    if (!signal.aborted) status('');
  })().catch(error => { if (!signal.aborted) void reportError(error); });
}

async function previewRemote(file) {
  const kind = startPreview(file, false);
  if (kind === 'img') {
    previewPhoto(file);
    return;
  }
  if ((kind === 'video' || kind === 'audio') && file.size <= uploadLimit) {
    status('Открываем поток…');
    const remote = await client.cloudOpenFile(channel.id, file.id, false);
    const type = mimeType(remote);
    if (previewKind(type) !== kind) throw new Error('CLOUD_FILE_MISSING');
    previewStream = await mini.streams.open({ size: remote.size, mimeType: type }, remote.read);
    const element = playerFor(kind);
    if (kind === 'video') setVideoPoster(element, file.thumbnail ? file : remote);
    element.addEventListener('error', () => {
      if (element.isConnected) status('Плеер не смог открыть поток. Проверьте подключение и формат видео.', true);
    }, { once: true });
    element.src = previewStream.url;
    renderPreview(element);
    status('');
    return;
  }
  if (kind === 'pre' && file.size > previewLimit && file.size <= uploadLimit) {
    const remote = await client.cloudOpenFile(channel.id, file.id, false);
    const bytes = await remote.read(0, Math.min(64 * 1024, remote.size));
    byId('preview-body').append(node('pre', new TextDecoder().decode(bytes) + '\n…'));
    return;
  }
  if (!kind || file.size > previewLimit) {
    if (file.thumbnail) {
      status('Загружаем миниатюру…');
      const blob = await getThumbnail(channel.id, file);
      status('');
      if (blob) {
        await showPreview('img', blob, file);
        return;
      }
    }
    byId('preview-body').append(node('p', 'Для этого файла доступны имя и размер.'));
    return;
  }
  status('Загружаем предпросмотр…');
  const data = await client.cloudDownload(channel.id, file.id, previewLimit);
  const actualType = mimeType(data);
  const actualKind = previewKind(actualType);
  if (actualKind) await showPreview(actualKind, new Blob([data.bytes], { type: actualType }), data);
  else byId('preview-body').append(node('p', 'Этот формат предпросмотра недоступен.'));
  status('');
}

async function readLocalRange(file, offset, length) {
  if (file.source) return new Uint8Array(await file.source.slice(offset, offset + length).arrayBuffer());
  const bytes = new Uint8Array(length);
  let written = 0;
  while (written < length) {
    const count = Math.min(MiB, length - written);
    const start = offset + written;
    const chunk = await mini.files.readChunk(file.id, { offset: start, length: count, sequential: true });
    const decoded = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(chunk.data) : atob(chunk.data);
    if (chunk.offset !== start || decoded.length !== count || (chunk.eof && start + count < file.size)) {
      throw new Error('CLOUD_FILE_INCOMPLETE');
    }
    if (typeof decoded === 'string') {
      for (let i = 0; i < count; i++) bytes[written + i] = decoded.charCodeAt(i);
    } else bytes.set(decoded, written);
    written += count;
  }
  return bytes;
}

async function localFileBlob(file, type) {
  return file.source?.slice(0, file.size, type) ?? new Blob([await readLocalRange(file, 0, file.size)], { type });
}

async function previewLocal(file) {
  const kind = startPreview(file, true);
  const limit = kind === 'img' ? imagePreviewLimit : previewLimit;
  if (!kind || (!file.source && file.size > limit)) {
    byId('preview-body').append(node('p', 'Для этого файла доступны имя и размер.'));
    return;
  }
  const type = mimeType(file);
  await showPreview(kind, await localFileBlob(file, type), file);
}

function saveRemote() {
  const { file } = currentPreview;
  startDownload([{ file }], true);
}

function safeName(value, fallback) {
  const name = value.trim().replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '');
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?: *\.|$)/i.test(name)) return '_' + name;
  return name || fallback;
}

function canSaveFile(file) {
  return !file.protected && file.size > 0 && file.size <= uploadLimit;
}

function startDownload(entries, single = false) {
  transfers.startDownload({ session: client, channelId: channel.id, folder }, entries, single);
}

function stageFiles(selection) {
  return transfers.stageFiles(selection, { session: client, channelId: channel.id, channelTitle: channel.title, uploadLimit });
}

function clearQueue() {
  return transfers.clearQueue();
}

function uploadFiles() {
  return transfers.uploadFiles();
}

function cancelDownload() {
  transfers.cancelDownload();
}

function renderQueue() {
  byId('queue').hidden = !transfers.queuedCount;
  renderRows('queue', transfers.queuedFiles().map(file => {
    const open = button(file.name, () => previewLocal(file), [file.destination, sizeLabel(file.size)].filter(Boolean).join(' · '));
    const remove = button('Убрать', async () => {
      if (transfers.queuedCount === 1) await clearQueue();
      else {
        await transfers.removeQueuedFile(file, true);
        syncTransfers();
      }
    });
    open.disabled = remove.disabled = Boolean(transfers.upload?.running);
    const item = row(open, remove);
    item.dataset.uploadId = file.id;
    return item;
  }), '');
}

async function pickFiles() {
  if (transfers.upload?.running || transfers.queuedCount) {
    status('Сначала повторите загрузку или очистите предыдущий список.', true);
    return;
  }
  const selection = await mini.files.pickMultiple();
  await stageFiles(selection.map(file => ({ ...file, destination: folder })));
}

async function pickFolder() {
  if (transfers.upload?.running || transfers.queuedCount) {
    status('Сначала повторите загрузку или очистите предыдущий список.', true);
    return;
  }
  const root = await mini.files.pickDirectory();
  const pending = [{ ...root, destination: [folder, safeName(root.name, 'Папка')].filter(Boolean).join('/') }];
  const selection = [];
  try {
    while (pending.length) {
      const current = pending.pop();
      try {
        let cursor;
        do {
          status('Читаем папку · ' + current.destination);
          const page = await mini.files.listDirectory(current.id, { cursor, limit: 200 });
          cursor = page.nextCursor;
          for (const entry of page.entries) {
            if (entry.directory) pending.push({ ...entry, destination: current.destination + '/' + safeName(entry.name, 'Папка') });
            else selection.push({ ...entry, destination: current.destination });
          }
        } while (cursor != null);
      } finally {
        await mini.files.releaseDirectory(current.id).catch(() => {});
      }
    }
  } catch (error) {
    await transfers.release(selection);
    for (const directory of pending) await mini.files.releaseDirectory(directory.id).catch(() => {});
    throw error;
  }
  await stageFiles(selection);
}

function browserFile(source, destination) {
  return { source, id: 'browser-' + ++localFileId, name: source.name, size: source.size, mimeType: source.type, destination };
}

async function collectDroppedEntry(entry, destination, selection) {
  if (entry.isFile) {
    const source = await new Promise((resolve, reject) => entry.file(resolve, reject));
    selection.push(browserFile(source, destination));
    return;
  }
  const path = [destination, safeName(entry.name, 'Папка')].filter(Boolean).join('/');
  const reader = entry.createReader();
  for (;;) {
    const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) return;
    for (const child of entries) await collectDroppedEntry(child, path, selection);
  }
}

async function collectDrop(data, destination) {
  try {
    const items = Array.from(data.items).filter(item => item.kind === 'file').map(item => {
      const entry = item.webkitGetAsEntry?.();
      return entry ? { entry } : { source: item.getAsFile() };
    });
    const dropped = items.length ? items : Array.from(data.files, source => ({ source }));
    const selection = [];
    for (const { entry, source } of dropped) {
      if (entry) await collectDroppedEntry(entry, destination, selection);
      else if (source) selection.push(browserFile(source, destination));
      else throw new Error('CLOUD_DROP_READ_FAILED');
    }
    return selection;
  } catch {
    throw new Error('CLOUD_DROP_READ_FAILED');
  }
}

function fileDrag(event) {
  return event.dataTransfer?.types.includes('Files');
}

function canDropFiles() {
  return channel && canOpenContext() && !transfers.upload?.running && !transfers.queuedCount;
}

function showDropTarget(event) {
  if (!fileDrag(event)) return;
  event.preventDefault();
  const allowed = Boolean(canDropFiles());
  event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
  if (allowed && dropTarget.hidden) {
    byId('drop-destination').textContent = folder ? channel.title + ' / ' + folder : channel.title;
  }
  dropTarget.hidden = !allowed;
}

function hideDropTarget() {
  dropTarget.hidden = true;
}

function dropFiles(event) {
  hideDropTarget();
  if (!fileDrag(event)) return;
  event.preventDefault();
  if (!canDropFiles()) {
    if (channel && (transfers.upload?.running || transfers.queuedCount)) {
      status('Завершите предыдущую загрузку или очистите её очередь.', true, 'status');
    }
    return;
  }
  closeFolderMenu();
  closeFileMenu();
  const session = client;
  const target = channel;
  const destination = folder;
  void run(async () => {
    status('Читаем перетащенные файлы и папки…');
    const selection = await collectDrop(event.dataTransfer, destination);
    if (client === session && channel === target) await stageFiles(selection);
  });
}

function transferAvailable() {
  return Boolean(transfers.upload?.running || transfers.queuedCount || transfers.download?.running);
}

function renderTransferProgress(direction) {
  const transfer = direction === 'upload' ? transfers.upload : transfers.download;
  const progress = byId(direction + '-progress');
  progress.hidden = !transfer?.running;
  if (transfer?.total == null) progress.removeAttribute('value');
  else {
    progress.max = Math.max(1, transfer.total);
    progress.value = transfer.done + Math.min(transfer.fraction, 0.99);
  }
  const summary = byId(direction + '-summary');
  const counts = transfer?.total == null ? '' :
    (direction === 'upload' ? 'Загружено: ' + transfer.sent : 'Сохранено: ' + transfer.saved) +
    ' · Обработано: ' + transfer.done + ' из ' + transfer.total;
  if (summary.textContent !== counts) summary.textContent = counts;
  const detail = byId(direction + '-detail');
  const text = transfer?.detail || 'Нет передач.';
  if (detail.textContent !== text) detail.textContent = text;
  detail.classList.toggle('error', Boolean(transfer?.error));
}

function syncTransfers() {
  const upload = Boolean(transfers.upload?.running || transfers.queuedCount);
  const download = Boolean(transfers.download?.running);
  if (upload !== download) transferView = upload ? 'upload' : 'download';
  byId('transfer-tabs').hidden = !(upload && download);
  for (const direction of ['upload', 'download']) {
    byId(direction).hidden = transferView !== direction;
    byId('show-' + direction).setAttribute('aria-pressed', String(transferView === direction));
  }
  byId('send').hidden = byId('clear-queue').hidden = !transfers.queuedCount || Boolean(transfers.upload?.running);
  byId('cancel-folder-save').hidden = !download;
  byId('cancel-folder-save').disabled = byId('cancel-save').disabled = Boolean(transfers.download?.controller.signal.aborted);
  renderTransferProgress('upload');
  renderTransferProgress('download');
  updatePreviewNavigation();
  updateToolbar();
}

function showTransfers() {
  if (!transferAvailable() || transferDialog.open || targetPicker.open || channelPicker.open) return;
  closeFileMenu();
  stopCatalogScroll();
  syncTransfers();
  transferDialog.showModal();
}

async function promptName(title, initial = '') {
  const answer = await mini.ui.prompt({ title, defaultValue: initial, maxLength: 255, confirmText: 'Сохранить', cancelText: 'Отмена' });
  if (typeof answer !== 'string') return;
  const name = answer.trim();
  if (!name || name.length > 255 || safeName(name, '') !== name) throw new Error('CLOUD_INVALID_NAME');
  return name;
}

async function createFolder() {
  const name = await promptName('Имя новой папки');
  if (!name) return;
  const path = folder ? folder + '/' + name : name;
  const exists = explicitFolders.has(path) || [...explicitFolders].some(other => other.startsWith(path + '/')) ||
    [...files.values()].some(file => file.folder === path || file.folder.startsWith(path + '/'));
  if (!exists) explicitFolders.add(await client.cloudCreateFolder(channel.id, path));
  renderFiles();
  status(exists ? 'Папка уже есть.' : 'Папка создана.');
}

function chooseTarget(title, entries) {
  const search = byId('cloud-target-search');
  let chosen;
  byId('cloud-target-title').textContent = title;
  search.value = '';
  function render() {
    const query = search.value.trim().toLocaleLowerCase('ru');
    const matches = entries.filter(entry => entry.title.toLocaleLowerCase('ru').includes(query));
    renderRows('cloud-target-list', matches.map(entry => {
      const control = node('button', entry.title);
      control.type = 'button';
      control.addEventListener('click', () => {
        chosen = entry;
        targetPicker.close();
      });
      return row(control);
    }), 'Совпадений нет.');
  }
  render();
  return new Promise(resolve => {
    search.addEventListener('input', render);
    targetPicker.addEventListener('close', () => {
      search.removeEventListener('input', render);
      resolve(chosen);
    }, { once: true });
    targetPicker.showModal();
  });
}

async function folderTargets() {
  const paths = new Set(['']);
  function add(path) {
    for (let part = path; part && !paths.has(part); part = part.slice(0, Math.max(0, part.lastIndexOf('/')))) paths.add(part);
  }
  let cursor;
  do {
    status('Загружаем папки канала…');
    const page = await client.cloudFiles(channel.id, cursor);
    for (const path of page.folders ?? []) add(path);
    for (const file of page.items) add(file.folder);
    cursor = page.next;
  } while (cursor !== undefined);
  return [...paths].sort(fileNames.compare).map(id => ({ id, title: id || 'Корень канала' }));
}

async function shareTargets() {
  const chats = new Map([['me', { id: 'me', title: 'Избранное' }]]);
  let reset = true;
  let more;
  do {
    status('Загружаем чаты Telegram…');
    const page = await client.chats(reset);
    for (const chat of page.items) if (chat.id !== '777000') chats.set(chat.id, chat);
    reset = false;
    more = page.more;
  } while (more);
  return [...chats.values()];
}

async function renameFile(file) {
  const name = await promptName('Новое имя файла', file.name);
  if (!name || name === file.name) return;
  files.set(file.id, await client.cloudEditFile(channel.id, file.id, { name }));
  renderFiles();
  status('Файл переименован.');
}

async function changeFileBatches(list, batchSize, label, apply, refresh = true) {
  let count = 0;
  try {
    while (count < list.length) {
      const batch = list.slice(count, count + batchSize);
      status(label + ' · ' + count + ' из ' + list.length);
      await apply(batch);
      count += batch.length;
    }
    status(label + ' · ' + count + ' из ' + list.length + '.');
  } catch (error) {
    if (expired(error)) throw error;
    status(label + ' · ' + count + ' из ' + list.length + '. ' + errorText(error), true);
  } finally {
    if (refresh) renderFiles();
  }
}

async function moveFiles(list) {
  const target = await chooseTarget('Переместить в папку', await folderTargets());
  if (!target || target.id === folder) return;
  await changeFileBatches(list, 1, 'Перемещено', async ([file]) => {
    files.set(file.id, await client.cloudEditFile(channel.id, file.id, { folder: target.id }));
    selectedFiles.delete(file.id);
  });
}

async function deleteFiles(list) {
  if (!await mini.ui.confirm({
    title: 'Удалить из канала?',
    message: list.length === 1 ? 'Сообщение с файлом «' + list[0].name + '» будет удалено из Telegram.' :
      'Сообщения с выбранными файлами будут удалены из Telegram. Файлов: ' + list.length + '.',
    confirmText: 'Удалить', cancelText: 'Отмена'
  })) return;
  await changeFileBatches(list, 100, 'Удалено', async batch => {
    await client.cloudDeleteFiles(channel.id, batch.map(file => file.id));
    for (const file of batch) {
      files.delete(file.id);
      selectedFiles.delete(file.id);
    }
  });
}

async function forwardFiles(list) {
  const target = await chooseTarget('Переслать в чат Telegram', await shareTargets());
  if (!target) return;
  await changeFileBatches(list, 100, 'Переслано', batch =>
    client.cloudForwardFiles(channel.id, batch.map(file => file.id), target.id), false);
}

const folderCommands = {
  'download-folder': () => startDownload(),
  'upload-files': pickFiles,
  'upload-folder': pickFolder,
  'create-folder': createFolder,
  'choose-channel': showChannelPicker
};

function renderToolbarPath() {
  const key = JSON.stringify([channel?.id, channel?.title, folder]);
  if (visiblePath === key) return;
  visiblePath = key;
  byId('toolbar-title').hidden = Boolean(channel);
  folderPath.hidden = !channel;
  folderPath.replaceChildren();
  if (!channel) return;
  const root = button(channel.title, () => navigateFolder(''));
  root.title = channel.title;
  folderPath.append(root);
  let path = '';
  for (const part of folder ? folder.split('/') : []) {
    const divider = node('span', '›');
    divider.className = 'crumb-divider';
    divider.setAttribute('aria-hidden', 'true');
    path += (path ? '/' : '') + part;
    const target = path;
    const crumb = button(part, () => navigateFolder(target));
    crumb.title = part;
    folderPath.append(divider, crumb);
  }
  folderPath.lastElementChild.setAttribute('aria-current', 'location');
  folderPath.scrollLeft = folderPath.scrollWidth;
}

function updateToolbar() {
  const connected = Boolean(client);
  toolbar.hidden = nativeToolbar;
  folderActions.hidden = nativeToolbar || !connected;
  byId('folder-commands').hidden = nativeToolbar;
  byId('catalog-options').hidden = !channel;
  const hasTransfers = transferAvailable();
  folderMenu.querySelector('[data-action="transfers"]').hidden = !hasTransfers;
  if (!nativeToolbar) renderToolbarPath();
  for (const button of folderMenu.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    button.disabled = action !== 'transfers' && (action === 'choose-channel' ?
      Boolean(transfers.upload?.running || transfers.download?.running) : !channel ||
      ((action === 'download-folder' || action === 'upload-folder') && !directorySaves) ||
      (action === 'download-folder' && Boolean(transfers.download?.running)) ||
      (action.startsWith('upload-') && Boolean(transfers.upload?.running)));
  }
  if (!nativeToolbar) return;
  const hasChannel = Boolean(channel);
  const state = {
    connected, hasChannel, channelTitle: channel?.title ?? '', folder: hasChannel ? folder : '',
    view: viewMode.value, sort: sortMode.value, hasTransfers
  };
  const key = JSON.stringify(state);
  if (key === toolbarState) return;
  toolbarState = key;
  void mini.functions.call('telegramCloud.setToolbar', state).catch(() => {
    if (toolbarState !== key) return;
    nativeToolbar = false;
    nativeContextMenu = false;
    updateToolbar();
  });
}

function closeFolderMenu() {
  folderMenu.hidden = true;
  if (folderMenu.parentElement !== toolbar) toolbar.append(folderMenu);
  byId('folder-commands').hidden = nativeToolbar;
  folderMenu.classList.remove('at-pointer');
  folderMenu.style.removeProperty('left');
  folderMenu.style.removeProperty('top');
  folderActions.setAttribute('aria-expanded', 'false');
}

function closeFileMenu() {
  fileMenu.hidden = true;
}

function stopFileHold() {
  if (fileHold) clearTimeout(fileHold.timer);
  fileHold = undefined;
}

function clearFileSelection() {
  selectedFiles.clear();
  contextFiles = [];
  stopFileHold();
  closeFileMenu();
}

function showPopupAt(menu, x, y) {
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, document.documentElement.clientWidth - bounds.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) + 'px';
}

function showNativeContextMenu(options, fallback) {
  if (nativeContextMenu && nativeToolbar) {
    void mini.functions.call('telegramCloud.showContextMenu', options).then(shown => { if (!shown) fallback(); }, fallback);
  } else fallback();
}

function openFolderContext(x, y) {
  closeFileMenu();
  contextFiles = [];
  showNativeContextMenu({ kind: 'background' }, () => {
    if (toolbar.hidden) toolbar.after(folderMenu);
    byId('folder-commands').hidden = false;
    folderMenu.classList.add('at-pointer');
    showPopupAt(folderMenu, x, y);
    folderActions.setAttribute('aria-expanded', 'true');
  });
}

function openFileContext(file, x, y) {
  closeFolderMenu();
  contextFiles = selectedFiles.has(file.id) && selectedFiles.size > 1 ?
    [...selectedFiles].map(id => files.get(id)).filter(item => item?.folder === folder) : [file];
  const multiple = contextFiles.length > 1;
  const canShare = contextFiles.every(item => !item.protected);
  const canDownload = directorySaves && !transfers.download?.running && contextFiles.some(canSaveFile);
  showNativeContextMenu({ kind: multiple ? 'selection' : 'file', canShare, canDownload }, () => {
    byId('file-menu-title').textContent = multiple ? 'Выбрано файлов: ' + contextFiles.length : file.name;
    const rename = fileMenu.querySelector('[data-file-action="rename"]');
    const download = fileMenu.querySelector('[data-file-action="download"]');
    rename.hidden = multiple;
    download.hidden = !multiple;
    download.disabled = !canDownload;
    fileMenu.querySelector('[data-file-action="share"]').disabled = !canShare;
    showPopupAt(fileMenu, x, y);
  });
}

function fileAction(action) {
  const list = contextFiles;
  closeFileMenu();
  contextFiles = [];
  if (!channel || !list.length || !canOpenContext()) return;
  if (action === 'rename' && list.length === 1) void run(() => renameFile(list[0]));
  if (action === 'move') void run(() => moveFiles(list));
  if (action === 'delete') void run(() => deleteFiles(list));
  if (action === 'share' && list.every(file => !file.protected)) void run(() => forwardFiles(list));
  if (action === 'download' && list.length > 1 && directorySaves && !transfers.download?.running && list.some(canSaveFile)) {
    void run(() => startDownload(list.map(file => ({ file, folders: [] }))));
  }
}

function catalogFile(target) {
  const card = target.closest?.('.selectable-file');
  return card && files.get(Number(card.dataset.fileId));
}

function canOpenContext() {
  return Boolean(client && !controls.disabled && !preview.open && !channelPicker.open && !targetPicker.open && !transferDialog.open);
}

document.addEventListener('contextmenu', event => {
  if (!canOpenContext() || event.target.closest('dialog, #file-menu, #folder-menu')) return;
  const file = catalogFile(event.target);
  if (file) {
    event.preventDefault();
    const touch = fileHold || event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents;
    if (touch && suppressFileClick) return;
    stopFileHold();
    suppressFileClick = Boolean(touch);
    openFileContext(file, event.clientX, event.clientY);
  } else if (event.button === 2 && !event.target.closest('button, label, a, input, select, textarea')) {
    event.preventDefault();
    openFolderContext(event.clientX, event.clientY);
  }
});

fileList.addEventListener('pointerdown', event => {
  suppressFileClick = false;
  stopFileHold();
  if (event.pointerType !== 'touch' || !canOpenContext() || event.target.closest('.file-check')) return;
  const file = catalogFile(event.target);
  if (!file) return;
  const hold = fileHold = { id: event.pointerId, x: event.clientX, y: event.clientY };
  hold.timer = setTimeout(() => {
    if (!canOpenContext()) return;
    suppressFileClick = true;
    openFileContext(file, hold.x, hold.y);
  }, 500);
});
document.addEventListener('pointermove', event => {
  if (fileHold?.id === event.pointerId &&
      Math.hypot(event.clientX - fileHold.x, event.clientY - fileHold.y) > 10) stopFileHold();
}, { passive: true });
for (const eventName of ['pointerup', 'pointercancel']) {
  document.addEventListener(eventName, event => {
    if (fileHold?.id === event.pointerId) stopFileHold();
  });
}
fileList.addEventListener('click', event => {
  if (!suppressFileClick) return;
  suppressFileClick = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
fileMenu.addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.fileAction;
  if (action) fileAction(action);
});
byId('close-cloud-target').addEventListener('click', () => targetPicker.close());
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!fileMenu.hidden) closeFileMenu();
  else if (!folderMenu.hidden) closeFolderMenu();
});

function folderCommand(action) {
  closeFolderMenu();
  if (action === 'transfers') { showTransfers(); return; }
  if (!canOpenContext() || !Object.hasOwn(folderCommands, action)) return;
  if (action !== 'choose-channel' && !channel) return;
  if ((action === 'download-folder' || action === 'upload-folder') && !directorySaves) return;
  if (action === 'choose-channel' && (transfers.upload?.running || transfers.download?.running)) return;
  void run(folderCommands[action]);
}

function toolbarAction(action) {
  if (typeof action !== 'string') return;
  if (action.startsWith('files:')) {
    fileAction(action.slice(6));
    return;
  }
  if (!/^(folder|view|sort):/.test(action)) {
    folderCommand(action);
    return;
  }
  if (!channel || !canOpenContext()) return;
  const separator = action.indexOf(':');
  const value = action.slice(separator + 1);
  if (action.startsWith('folder:')) {
    if (value !== folder && (!value || folder.startsWith(value + '/'))) void run(() => navigateFolder(value));
    return;
  }
  const select = action.startsWith('view:') ? viewMode : sortMode;
  if (value === select.value || ![...select.options].some(option => option.value === value)) return;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

folderActions.addEventListener('click', () => {
  closeFileMenu();
  if (!folderMenu.hidden) closeFolderMenu();
  else if (!controls.disabled || transferAvailable()) {
    folderMenu.hidden = false;
    folderActions.setAttribute('aria-expanded', 'true');
    folderMenu.querySelector('#folder-commands:not([hidden]) button:not([hidden]):not(:disabled), #catalog-options:not([hidden]) select')?.focus();
  }
});
folderMenu.addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.action;
  if (action) folderCommand(action);
});
document.addEventListener('pointerdown', event => {
  if (!folderMenu.contains(event.target) && !folderActions.contains(event.target)) closeFolderMenu();
  if (!fileMenu.contains(event.target)) closeFileMenu();
});
window.mini?.events?.on('ui.topBarAction', toolbarAction);
byId('close-transfers').addEventListener('click', () => transferDialog.close());
for (const direction of ['upload', 'download']) {
  byId('show-' + direction).addEventListener('click', () => {
    transferView = direction;
    syncTransfers();
  });
}
transferDialog.addEventListener('close', schedulePaging);
channelPicker.addEventListener('close', schedulePaging);
preview.addEventListener('close', schedulePaging);
byId('close-channels').addEventListener('click', () => channelPicker.close());
channelSearch.addEventListener('input', () => {
  renderChannels();
  if (!channelSearch.value.trim() || !channelMore) return;
  void run(async () => {
    while (channelPicker.open && channelSearch.value.trim() && channelMore) await loadChannels(false);
  });
});
byId('catalog-retry').addEventListener('click', () => {
  pagingFailed = false;
  byId('catalog-retry').hidden = true;
  schedulePaging();
});
document.addEventListener('dragenter', showDropTarget);
document.addEventListener('dragover', showDropTarget);
document.addEventListener('dragleave', event => { if (!event.relatedTarget) hideDropTarget(); });
document.addEventListener('drop', dropFiles);
window.addEventListener('blur', hideDropTarget);
catalogObserver.observe(catalogEnd);
window.addEventListener('wheel', wheelCatalog, { passive: false });
window.addEventListener('pointerdown', stopCatalogScroll, { passive: true });
window.addEventListener('keydown', stopCatalogScroll);
window.addEventListener('resize', stopCatalogScroll);

const actions = {
  connect,
  'more-channels': () => loadChannels(false),
  'clear-queue': clearQueue,
  'close-preview': resetPreview,
  save: saveRemote,
  send: uploadFiles
};
for (const [id, action] of Object.entries(actions)) byId(id).addEventListener('click', () => run(action));
for (const select of [viewMode, sortMode]) {
  const key = 'telegram-cloud.' + select.id;
  try {
    const value = localStorage.getItem(key);
    if ([...select.options].some(option => option.value === value)) select.value = value;
  } catch {}
  select.addEventListener('change', () => {
    try { localStorage.setItem(key, select.value); } catch {}
    closeFolderMenu();
    renderFiles();
    updateToolbar();
  });
}
preview.addEventListener('cancel', event => {
  event.preventDefault();
  if (!controls.disabled) resetPreview();
});
previewScale.addEventListener('click', () => {
  setPreviewScale(preview.dataset.scale === 'fit' ? 'original' : 'fit');
});
previewPrev.addEventListener('click', () => stepPreview(-1));
previewNext.addEventListener('click', () => stepPreview(1));
document.addEventListener('keydown', event => {
  if (!preview.open || galleryIndex() < 0 || event.altKey || event.ctrlKey || event.metaKey ||
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  event.preventDefault();
  stepPreview(event.key === 'ArrowLeft' ? -1 : 1);
}, true);
previewBody.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey) return;
  const visual = visualGeometry();
  if (!visual || !event.deltaY) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? previewBody.clientHeight : 1);
  zoomPreview(visual, Math.exp(Math.max(-2, Math.min(2, -delta / 350))), event.clientX, event.clientY);
}, { passive: false });
previewBody.addEventListener('pointerdown', startMousePan);
previewBody.addEventListener('pointermove', moveMousePan);
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  previewBody.addEventListener(eventName, event => {
    if (event.pointerId === mousePan?.id) stopMousePan();
  });
}
previewBody.addEventListener('touchstart', startPreviewTouch, { passive: true });
previewBody.addEventListener('touchmove', movePreviewTouch, { passive: false });
previewBody.addEventListener('touchend', endPreviewTouch, { passive: true });
previewBody.addEventListener('touchcancel', () => { touchGesture = undefined; });
previewUnmute.addEventListener('click', () => {
  const player = previewBody.querySelector('video');
  if (!player) return;
  player.muted = false;
  if (player.paused) void player.play().catch(() => {});
});
byId('cancel-save').addEventListener('click', cancelDownload);
window.mini?.app?.onBackRequested(() => {
  if (transferDialog.open && !(preview.open && currentPreview?.local)) {
    transferDialog.close();
    return true;
  }
  if (targetPicker.open) {
    targetPicker.close();
    return true;
  }
  if (!fileMenu.hidden) {
    closeFileMenu();
    return true;
  }
  if (channelPicker.open && channel) {
    channelPicker.close();
    return true;
  }
  if (!folderMenu.hidden) {
    closeFolderMenu();
    return true;
  }
  if (preview.open) {
    if (!controls.disabled) resetPreview();
    return true;
  }
  if (controls.disabled) return true;
  if (!channel || !folder) return false;
  navigateFolder(folder.slice(0, Math.max(0, folder.lastIndexOf('/'))));
  return true;
});
byId('cancel-folder-save').addEventListener('click', cancelDownload);
window.addEventListener('pagehide', () => {
  transfers.stop();
  stopFileHold();
  stopCatalogScroll();
  masonryObserver.disconnect();
  cancelAnimationFrame(masonryFrame);
  cancelAnimationFrame(cloudUpdateFrame);
  clearThumbnails();
  resetPreview();
  void closeClient();
});
void run(() => connect(true));

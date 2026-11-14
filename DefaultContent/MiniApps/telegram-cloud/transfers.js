'use strict';

function createCloudTransfers({
  filesApi, streams, readLocalRange, mimeType, safeName, canSaveFile, canMakeThumbnail, makeThumbnail,
  expired, errorText, reportError, isCurrentSession, status, onProgress, onChange, onDownloadComplete,
  onQueueChange, onQueuedFileRemoved, onQueueCleared, onCatalogFile, onCatalogChange
}) {
  const queue = new Map();
  let uploadTransfer;
  let downloadTransfer;

  function release(localFiles) {
    const ids = localFiles.filter(file => !file.source).map(file => file.id);
    return ids.length ? filesApi.releaseMany(ids).catch(() => {}) : Promise.resolve();
  }

  async function removeQueuedFile(file, discard = false) {
    if (discard) uploadTransfer.total--;
    queue.delete(file.id);
    onQueuedFileRemoved(file);
    await release([file]);
  }

  async function clearQueue() {
    const localFiles = [...queue.values()];
    queue.clear();
    uploadTransfer = undefined;
    onQueueCleared();
    await release(localFiles);
  }

  function discardDownload() {
    downloadTransfer?.controller.abort();
    downloadTransfer = undefined;
  }

  function cancelDownload() {
    if (!downloadTransfer?.running) return;
    downloadTransfer.controller.abort();
    downloadTransfer.detail = 'Отменяем скачивание…';
    onChange();
  }

  async function saveAttachment(file, options, transfer) {
    const { session, channelId, controller: { signal } } = transfer;
    const remote = await session.cloudOpenFile(channelId, file.id, true);
    if (signal.aborted) return null;
    const name = safeName(remote.name, 'file-' + file.id);
    const reader = new AbortController();
    const cancelReader = () => reader.abort();
    signal.addEventListener('abort', cancelReader, { once: true });
    const chunks = remote.chunks(reader.signal);
    let offset = 0;
    let remainder = new Uint8Array(0);
    let lastPercent = -1;
    try {
      return await streams.save({ ...options, suggestedName: name, mimeType: mimeType(remote), size: remote.size },
        async (start, length, signal) => {
          if (offset !== start) throw new Error('CLOUD_FILE_RANGE');
          let output;
          let written = 0;
          while (written < length) {
            if (signal.aborted) throw new Error('operation_cancelled');
            if (!remainder.length) {
              const next = await chunks.next();
              if (next.done) throw new Error('CLOUD_FILE_INCOMPLETE');
              remainder = next.value;
            }
            const count = Math.min(length - written, remainder.length);
            if (count === length) output = remainder.subarray(0, count);
            else {
              output ??= new Uint8Array(length);
              output.set(remainder.subarray(0, count), written);
            }
            remainder = remainder.subarray(count);
            written += count;
          }
          offset += written;
          const percent = Math.floor(offset * 100 / remote.size);
          if (percent !== lastPercent) {
            lastPercent = percent;
            transfer.fraction = offset / remote.size;
            onProgress('download');
          }
          return output;
        }, signal);
    } finally {
      signal.removeEventListener('abort', cancelReader);
      reader.abort();
      await chunks.return().catch(() => {});
    }
  }

  async function* folderDownloadEntries(transfer) {
    const { session, channelId, folder, controller: { signal } } = transfer;
    const prefix = folder ? folder + '/' : '';
    let cursor;
    do {
      const page = await session.cloudFiles(channelId, cursor);
      cursor = page.next;
      for (const file of page.items) {
        if (signal.aborted) return;
        if (file.folder !== folder && !file.folder.startsWith(prefix)) continue;
        const folders = file.folder === folder ? [] : file.folder.slice(prefix.length).split('/').map(part => safeName(part, '_'));
        yield { file, folders };
      }
    } while (!signal.aborted && cursor !== undefined);
  }

  function startDownload({ session, channelId, folder }, entries, single = false) {
    if (downloadTransfer?.running) return;
    const transfer = downloadTransfer = {
      running: true, controller: new AbortController(), session, channelId, folder,
      done: 0, fraction: 0, saved: 0, skipped: 0, failed: 0,
      previewFileId: single ? entries[0].file.id : undefined,
      detail: single ? 'Подготавливаем файл…' : 'Выберите папку на устройстве.'
    };
    onChange();
    void downloadFiles(transfer, entries, single);
  }

  async function downloadFiles(transfer, entries, single) {
    const { controller, session } = transfer;
    const { signal } = controller;
    let directory;
    try {
      if (!single) directory = await filesApi.pickDirectory();
      transfer.detail = 'Собираем список файлов…';
      onProgress('download');
      const pending = new Map();
      for await (const entry of entries ?? folderDownloadEntries(transfer)) {
        if (signal.aborted) break;
        if (canSaveFile(entry.file)) pending.set(entry.file.id, entry);
        else transfer.skipped++;
      }
      transfer.total = pending.size;
      for (const { file, folders } of pending.values()) {
        if (signal.aborted) break;
        transfer.detail = 'Скачиваем · ' + file.name;
        onProgress('download');
        try {
          const result = await saveAttachment(file, directory ? { directoryId: directory.id, folders } : {}, transfer);
          if (!result) { controller.abort(); break; }
          transfer.saved++;
        } catch (error) {
          if (signal.aborted) break;
          if (expired(error) || single || ['FROZEN_METHOD_INVALID', 'FROZEN_PARTICIPANT_MISSING', 'CHANNEL_PRIVATE',
            'CLOUD_CHANNEL_UNAVAILABLE'].includes(error?.errorMessage || error?.message)) throw error;
          transfer.failed++;
        }
        transfer.done++;
        transfer.fraction = 0;
      }
      transfer.detail = single ? (transfer.saved ? 'Файл сохранён.' : 'Скачивание отменено.') :
        (signal.aborted ? 'Скачивание отменено. ' : '') + 'Сохранено файлов: ' + transfer.saved +
        '. Пропущено: ' + transfer.skipped + '. Ошибок: ' + transfer.failed + '.';
      transfer.error = transfer.failed > 0;
    } catch (error) {
      if (expired(error) && isCurrentSession(session)) await reportError(error);
      transfer.error = !signal.aborted && error?.code !== 'operation_cancelled';
      transfer.detail = transfer.error ? errorText(error) : 'Скачивание отменено.';
    } finally {
      controller.abort();
      if (directory) await filesApi.releaseDirectory(directory.id).catch(() => {});
      if (downloadTransfer === transfer) {
        transfer.running = false;
        onChange();
        onDownloadComplete(transfer);
      }
    }
  }

  async function stageFiles(selection, { session, channelId, channelTitle, uploadLimit }) {
    const skipped = [];
    for (const file of selection) {
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > uploadLimit) skipped.push(file);
      else queue.set(file.id, file);
    }
    if (queue.size) {
      uploadTransfer = {
        session, channelId, channelTitle, total: queue.size,
        done: 0, fraction: 0, sent: 0, duplicates: 0, invalid: skipped.length
      };
      void uploadFiles();
    } else if (skipped.length) status('Пропущено файлов: ' + skipped.length + '. Можно загрузить непустые файлы до 2 ГБ.', true);
    else status('В выбранной папке нет файлов.');
    await release(skipped);
  }

  function uploadKey(path, file) {
    return JSON.stringify([path, file.name, file.size]);
  }

  async function existingUploads(transfer) {
    const pending = new Set([...queue.values()].map(file => uploadKey(file.destination, file)));
    const existing = new Set();
    let cursor;
    do {
      const page = await transfer.session.cloudFiles(transfer.channelId, cursor);
      if (uploadTransfer !== transfer) break;
      for (const file of page.items) {
        const key = uploadKey(file.folder, file);
        if (pending.has(key)) {
          existing.add(key);
          onCatalogFile(file);
        }
      }
      cursor = page.next;
    } while (cursor !== undefined && existing.size < pending.size);
    return existing;
  }

  async function uploadFiles() {
    const transfer = uploadTransfer;
    if (!transfer || transfer.running || !queue.size) return;
    transfer.running = true;
    transfer.error = false;
    transfer.detail = 'Проверяем, какие файлы уже есть в канале…';
    onQueueChange();
    let activeFile;
    try {
      const existing = await existingUploads(transfer);
      for (const file of queue.values()) {
        if (uploadTransfer !== transfer) return;
        const key = uploadKey(file.destination, file);
        if (existing.has(key)) transfer.duplicates++;
        else {
          activeFile = file;
          transfer.detail = 'Загружаем · ' + file.name;
          onProgress('upload');
          const data = {
            name: file.name, size: file.size, type: mimeType(file),
            readRange: (offset, length) => {
              if (uploadTransfer !== transfer) throw new Error('operation_cancelled');
              return readLocalRange(file, offset, length);
            }
          };
          if (canMakeThumbnail(file, data.type)) {
            transfer.detail = 'Создаём миниатюру · ' + file.name;
            onProgress('upload');
            try {
              data.thumbnail = await makeThumbnail(file, data.type);
            } catch {
              // A file can still be uploaded if WebView cannot decode it as an image.
            }
            if (uploadTransfer !== transfer) return;
            transfer.detail = 'Загружаем · ' + file.name;
            onProgress('upload');
          }
          let lastPercent;
          const uploaded = await transfer.session.cloudUpload(transfer.channelId, data, file.destination, value => {
            const percent = Math.floor(value * 100);
            if (uploadTransfer !== transfer || percent === lastPercent) return;
            lastPercent = percent;
            transfer.fraction = value;
            if (value >= 1) transfer.detail = 'Публикуем · ' + file.name;
            onProgress('upload');
          });
          if (uploadTransfer !== transfer) return;
          onCatalogFile(uploaded);
          existing.add(key);
          transfer.sent++;
        }
        transfer.done++;
        transfer.fraction = 0;
        onProgress('upload');
        await removeQueuedFile(file);
      }
      transfer.detail = 'В канал «' + transfer.channelTitle + '» загружено файлов: ' + transfer.sent + '.' +
        (transfer.duplicates ? ' Уже были в канале: ' + transfer.duplicates + '.' : '') +
        (transfer.invalid ? ' Пропущено файлов: ' + transfer.invalid + ' (пустые или больше 2 ГБ).' : '');
    } catch (error) {
      if (uploadTransfer !== transfer) return;
      if (expired(error)) await reportError(error);
      else {
        transfer.error = true;
        transfer.detail = 'Загружено ' + transfer.sent + ' из ' + transfer.total + '. ' +
          (activeFile ? activeFile.name + ' · ' : '') + errorText(error);
      }
    } finally {
      if (uploadTransfer === transfer) {
        transfer.running = false;
        transfer.fraction = 0;
        onQueueChange();
        onCatalogChange();
        status(transfer.detail, transfer.error || transfer.invalid > 0, 'status');
      }
    }
  }

  return {
    get upload() { return uploadTransfer; },
    get download() { return downloadTransfer; },
    get queuedCount() { return queue.size; },
    queuedFiles: () => [...queue.values()],
    removeQueuedFile,
    release,
    clearQueue,
    stageFiles,
    uploadFiles,
    startDownload,
    discardDownload,
    cancelDownload,
    stop() {
      discardDownload();
      uploadTransfer = undefined;
    }
  };
}

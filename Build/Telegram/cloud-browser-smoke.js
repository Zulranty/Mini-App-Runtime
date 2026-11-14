async (page) => {
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const media = await page.request.get(new URL('/fixture.webm', page.url()).href);
  if (!media.ok()) throw new Error('The local WebM fixture is missing');
  const sample = await media.body();
  if (sample.length <= 10 * 1024 * 1024) throw new Error('The video fixture must exceed 10 MiB');
  const ranges = [];
  await page.route('https://media.miniapp.local/fixture', async route => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || 'bytes=0-');
    const start = Number(match[1]);
    const end = Math.min(sample.length - 1, start + 512 * 1024 - 1, match[2] ? Number(match[2]) : Infinity);
    ranges.push([start, end]);
    await new Promise(resolve => setTimeout(resolve, 30));
    await route.fulfill({
      status: 206,
      headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes',
        'content-range': 'bytes ' + start + '-' + end + '/' + sample.length, 'cache-control': 'no-store' },
      body: sample.subarray(start, end + 1)
    });
  });
  await page.addInitScript(videoSize => {
    const state = window.cloudTest = {
      consent: 'missing', uploads: [], downloads: [], released: [], failSecond: true,
      platform: sessionStorage.getItem('fixture-platform') || 'android', dialogPages: [], manualLogin: 0,
      pages: [], thumbnailFetches: [], cacheHits: [], folderSaves: [], releasedDirectories: [], directoryPages: [],
      scrollSamples: [], edits: [], forwards: [], deletions: []
    };
    const created = new Map();
    window.addEventListener('scroll', () => state.scrollSamples.push(scrollY));
    const oldFile = { id: 101, name: 'старый.txt', size: 5, folder: 'Архив/2024', mimeType: 'text/plain' };
    const protectedFile = { id: 102, name: 'защищённый.txt', size: 5, folder: '', protected: true, mimeType: 'text/plain' };
    const imageFile = { id: 104, name: 'альбом.png', size: 99, folder: '', mimeType: 'image/png', thumbnail: true, thumbnailKey: 'photo-test' };
    const bigImage = { id: 105, name: 'большое.png', size: 20_000_000, folder: '', mimeType: 'image/png',
      thumbnail: { width: 640, height: 360 }, thumbnailKey: 'large-test', date: 1_728_000_000 };
    const bigText = { id: 106, name: 'большой.txt', size: 20_000_000, folder: '', mimeType: 'text/plain' };
    const video = { id: 107, name: 'ролик.webm', size: videoSize, folder: '', mimeType: 'video/webm',
      thumbnail: true, thumbnailKey: 'video-test', date: 1_729_000_000 };
    const boundary = { id: 108, name: 'скачать.zip', size: 2_000_000_000, folder: '', mimeType: 'application/zip' };
    const fillers = Array.from({ length: 80 }, (_, index) => ({
      id: 300 + index, name: 'файл ' + index + (index === 0 ? ' ' + 'длинное-имя-'.repeat(25) : ''),
      size: 9999, folder: '', date: 1_728_000_000
    }));
    const guarded = { id: 109, name: 'закрытое.png', size: 19_000_000, folder: 'Архив/Закрыто',
      mimeType: 'image/png', thumbnail: true, thumbnailKey: 'guarded-test', protected: true };
    const motionPhoto = { id: 110, name: 'MVIMG_20220821_074212.jpg', size: 12_687_770, folder: 'Архив/Фото',
      mimeType: 'application/octet-stream', thumbnail: { resize: true }, thumbnailKey: 'original-test' };
    const scanPhoto = { id: 112, name: 'Строки.jpg', folder: 'Проверка JPEG', mimeType: 'image/jpeg',
      thumbnail: { width: 160, height: 100 }, thumbnailKey: 'scan-test' };
    const scanPng = { ...scanPhoto, id: 113, name: 'Строки.png', mimeType: 'image/png', thumbnailKey: 'scan-png' };
    const scanWebp = { ...scanPhoto, id: 114, name: 'Строки.webp', mimeType: 'image/webp', thumbnailKey: 'scan-webp' };
    const scanFiles = [scanPhoto, scanPng, scanWebp];
    const scanBytes = new Map();
    let scanDiskThumbnail;
    let photoSource;
    let uploadedThumbnail;
    const saved = { apiId: 99, apiHash: 'fixture', session: 'fixture-session' };
    const wideThumbnail = new Promise(resolve => { state.releaseWideThumbnail = resolve; });
    async function picture(width = 640, height = 480, type = 'image/png', size) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').fillRect(0, 0, width, height);
      const image = await new Promise(resolve => canvas.toBlob(resolve, type));
      const bytes = new Uint8Array(size ?? image.size);
      bytes.set(new Uint8Array(await image.arrayBuffer()));
      return { mimeType: image.type, resize: true, bytes };
    }
    const original = file => file === motionPhoto
      ? picture(1600, 900, 'image/jpeg', file.size) : picture(640, 360, 'image/png', file.size);
    function scanThumbnail(color) {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 20;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg');
    }
    state.dropScanThumbnail = () => {
      delete scanPhoto.inlineThumbnail;
      delete scanPhoto.thumbnail;
      delete scanPhoto.thumbnailKey;
    };
    async function scanPicture(type) {
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 1000;
      const context = canvas.getContext('2d');
      const pixels = context.createImageData(canvas.width, canvas.height);
      let random = 803;
      for (let index = 0; index < pixels.data.length; index += 4) {
        random = Math.imul(random, 1664525) + 1013904223 | 0;
        pixels.data[index] = 160 + (random >>> 24) / 3;
        pixels.data[index + 1] = 35 + ((random >>> 16) & 255) / 3;
        pixels.data[index + 2] = 40 + ((random >>> 8) & 255) / 3;
        pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const encoded = await new Promise(resolve => canvas.toBlob(resolve, type, 0.96));
      return new Uint8Array(await encoded.arrayBuffer());
    }
    const embedded = Promise.all([
      picture(32, 18, 'image/jpeg'), picture(32, 24, 'image/jpeg'), picture(18, 32, 'image/jpeg')
    ]).then(images => {
      [bigImage, imageFile, video].forEach((file, index) => {
        file.inlineThumbnail = { bytes: images[index].bytes, complete: false };
      });
    });
    window.MiniAppTelegram = {
      cloudVersion: 3,
      supportsCloudActions: true,
      protectsSession: true,
      cloudUploadLimit: 2_000_000_000,
      createClient(record) {
        if (record.session !== saved.session) throw new Error('Incorrect session');
        return {
          resume: async () => 'Тестовый аккаунт',
          close: async () => {},
          cloudChannels: async reset => {
            state.dialogPages.push(reset);
            return reset
              ? { items: [{ id: 'a', title: 'Мои файлы' }], more: true }
              : { items: [{ id: 'b', title: 'Второй канал' }], more: false };
          },
          cloudFiles: async (id, before) => {
            await embedded;
            state.pages.push([id, before ?? null]);
            if (id === 'b' && before === 190) return { items: [
              { id: 189, name: 'старый-дубль.txt', size: 5, folder: '' },
              { id: 188, name: 'новый-размер.txt', size: 8, folder: '' }
            ] };
            if (id === 'a' && before === 103) {
              if (state.platform === 'windows') return { items: [oldFile, guarded, motionPhoto] };
              if (!scanBytes.size) {
                const thumb = Uint8Array.from(atob(scanThumbnail('#1546d0').split(',')[1]), character => character.charCodeAt(0));
                await Promise.all(scanFiles.map(async file => {
                  const bytes = await scanPicture(file.mimeType);
                  file.size = bytes.length;
                  file.inlineThumbnail = { bytes: thumb };
                  scanBytes.set(file.id, bytes);
                }));
                scanDiskThumbnail = scanThumbnail('#0cb64c');
              }
              return { items: [oldFile, guarded, motionPhoto, ...scanFiles] };
            }
            return id === 'a'
              ? { items: [protectedFile, imageFile, bigImage, bigText, video, boundary, ...fillers], next: 103 }
              : { items: [...created.values()], folders: JSON.parse(sessionStorage.getItem('fixture-folders') || '[]'),
                  next: state.duplicateProbe ? 190 : undefined };
          },
          cloudCreateFolder: async (id, path) => {
            if (id !== 'b') throw new Error('Wrong folder channel');
            const paths = JSON.parse(sessionStorage.getItem('fixture-folders') || '[]');
            sessionStorage.setItem('fixture-folders', JSON.stringify([...paths, path]));
            return path;
          },
          cloudEditFile: async (id, fileId, changes) => {
            state.edits.push([id, fileId, changes]);
            const file = { ...created.get(fileId), ...changes };
            created.set(fileId, file);
            return file;
          },
          chats: async () => ({ items: [{ id: 'group', title: 'Тестовая группа' }], more: false }),
          cloudForwardFiles: async (...args) => { state.forwards.push(args); },
          cloudDeleteFiles: async (id, ids) => {
            state.deletions.push([id, ids]);
            ids.forEach(fileId => created.delete(fileId));
          },
          cloudThumbnail: async (id, fileId) => {
            state.thumbnailFetches.push(fileId);
            if (fileId === 111) return { bytes: new Uint8Array(await uploadedThumbnail.arrayBuffer()),
              mimeType: 'image/jpeg', key: 'uploaded-thumb' };
            if ([104, 105, 107].includes(fileId) && state.platform === 'android') await wideThumbnail;
            const file = [imageFile, bigImage, video, guarded, motionPhoto].find(item => item.id === fileId);
            const dimensions = fileId === 105 ? [640, 360] : fileId === 107 ? [360, 640] : [];
            const data = file === motionPhoto ? await original(file) : await picture(...dimensions);
            return { ...data, key: file.thumbnailKey, protected: file.protected };
          },
          cloudDownload: async (id, fileId, max, forSave) => {
            if (fileId === scanWebp.id) return { ...scanWebp, bytes: scanBytes.get(fileId) };
            if (fileId !== 101 && fileId !== 102) throw new Error('Large file was buffered');
            state.downloads.push({ id, fileId, max, forSave });
            return { ...(fileId === 101 ? oldFile : protectedFile), bytes: new TextEncoder().encode('hello') };
          },
          async cloudOpenFile(id, fileId, forSave) {
            const previewImages = forSave ? [] : [imageFile, guarded, motionPhoto, ...scanFiles];
            const file = created.get(fileId) || [oldFile, bigImage, bigText, video, boundary, ...previewImages].find(item => item.id === fileId);
            if (!file) throw new Error('Wrong file opened');
            state.opened = { id, fileId, forSave };
            const smallPng = file === imageFile ? (await picture()).bytes : undefined;
            return {
              ...file,
              size: smallPng?.length ?? file.size,
              async read(offset, length) {
                state.read = { offset, length };
                const bytes = new Uint8Array(length).fill(65);
                return bytes;
              },
              async *chunks(signal) {
                if (fileId === 101 || created.has(fileId)) {
                  yield new TextEncoder().encode('he');
                  yield new TextEncoder().encode('llo');
                } else if (scanBytes.has(fileId)) {
                  const bytes = scanBytes.get(fileId);
                  let offset = 0;
                  for (const fraction of [0.2, 0.62, 1]) {
                    const end = Math.ceil(bytes.length * fraction);
                    yield bytes.subarray(offset, end);
                    offset = end;
                    if (fraction === 1) return;
                    await new Promise(resolve => {
                      const abort = () => { state.jpegAborted = true; resolve(); };
                      signal.addEventListener('abort', abort, { once: true });
                      state.advanceScan = () => { signal.removeEventListener('abort', abort); resolve(); };
                    });
                    if (signal.aborted) return;
                  }
                } else if (smallPng) yield smallPng;
                else if (file === motionPhoto || file === guarded || file === bigImage) {
                  if (file === bigImage && state.holdOriginal) {
                    await new Promise(resolve => {
                      state.releaseOriginal = resolve;
                      signal.addEventListener('abort', () => { state.originalAborted = true; resolve(); }, { once: true });
                    });
                  }
                  if (!signal.aborted) yield (await original(file)).bytes;
                } else yield new Uint8Array(512 * 1024).fill(9);
              }
            };
          },
          cloudUpload: async (id, file, folder, progress) => {
            if (file.name === 'photo-upload.jpg') {
              const expected = (await photoSource).bytes;
              const actual = await file.readRange(0, file.size);
              if (actual.length !== expected.length || !actual.every((byte, index) => byte === expected[index])) {
                throw new Error('Generating the upload thumbnail changed the original');
              }
              uploadedThumbnail = file.thumbnail;
              if (uploadedThumbnail?.type !== 'image/jpeg' || uploadedThumbnail.size >= 200_000) {
                throw new Error('Missing or oversized upload JPEG thumbnail');
              }
              const bitmap = await createImageBitmap(uploadedThumbnail);
              state.photoSize = [bitmap.width, bitmap.height];
              bitmap.close();
              progress(1);
              return { id: 111, name: file.name, folder, size: file.size, mimeType: file.type,
                thumbnail: { width: 320, height: 180 }, thumbnailKey: 'uploaded-thumb' };
            }
            if (file.thumbnail) throw new Error('Generated a thumbnail for an unsupported or corrupt file');
            const length = file.size === 2_000_000_000 ? 5 : file.size;
            const sample = await file.readRange(file.size - length, length);
            state.uploads.push([id, file.name, folder, new TextDecoder().decode(sample)]);
            if (file.name === 'два.txt' && state.holdSecond) {
              progress(0.5);
              await new Promise(resolve => { state.finishHeldUpload = resolve; });
            }
            progress(1);
            if (file.name === 'два.txt' && state.failSecond) throw new Error('CHAT_WRITE_FORBIDDEN');
            const result = { id: 200 + state.uploads.length, name: file.name, folder, size: file.size, mimeType: file.type, date: 1_728_000_000 };
            if (id === 'b') created.set(result.id, result);
            if (state.duplicateProbe && file.name === 'новый-размер.txt') throw new Error('CLOUD_SEND_UNCONFIRMED');
            return result;
          }
        };
      }
    };
    const cloudMethods = {
      rememberChannel: async id => { sessionStorage.setItem('fixture-channel', id); },
      getThumbnail: async key => {
        if (key === 'v1:a:112:scan-test' && state.holdScanThumbnail) {
          await new Promise(resolve => { state.releaseScanThumbnail = resolve; });
          return scanDiskThumbnail;
        }
        const value = sessionStorage.getItem(key);
        if (value) state.cacheHits.push(key);
        return value;
      },
      cacheThumbnail: async (key, data) => { sessionStorage.setItem(key, data); }
    };
    window.mini = {
      app: { onBackRequested: listener => { state.back = listener; } },
      runtime: {
        supports: async method => ['telegramCloud.setToolbar', 'telegramCloud.showContextMenu'].includes(method)
          ? state.platform === 'windows' : method === 'streams.saveInDirectory'
      },
      modules: { load: async () => {} },
      functions: { async call(method, params = {}) {
        switch (method) {
          case 'telegram.connect':
            state.manualLogin++;
            if (state.consent === 'missing') return null;
            if (state.consent === 'declined') throw Object.assign(new Error(), { code: 'operation_cancelled' });
            sessionStorage.setItem('fixture-approved', saved.session);
            return saved;
          case 'telegram.restoreSaved':
            return sessionStorage.getItem('fixture-approved') === saved.session ? saved : null;
          case 'telegramCloud.getSavedChannel': return sessionStorage.getItem('fixture-channel');
          case 'telegramCloud.rememberChannel': return cloudMethods.rememberChannel(params.id);
          case 'telegramCloud.getThumbnail': return cloudMethods.getThumbnail(params.key);
          case 'telegramCloud.cacheThumbnail': return cloudMethods.cacheThumbnail(params.key, params.data);
          case 'telegramCloud.setToolbar': state.toolbar = params; return;
          case 'telegramCloud.showContextMenu': state.context = params; return true;
          default: throw new Error('Unexpected native function: ' + method);
        }
      } },
      streams: {
        async open(options, read) {
          await read(1000, 40);
          state.player = options;
          return { url: 'https://media.miniapp.local/fixture', close: async () => { state.playerClosed = true; } };
        },
        async save(options, read, signal) {
          const bytes = await read(0, Math.min(options.size, 512 * 1024), signal);
          state.saved = { ...options, head: bytes[0], count: bytes.length };
          if (options.directoryId && state.holdFolderSave) {
            await new Promise(resolve => { state.finishHeldSave = resolve; });
          }
          if (options.size === 2_000_000_000) {
            if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            return null;
          }
          state.saved.text = new TextDecoder().decode(bytes);
          if (options.directoryId) state.folderSaves.push(state.saved);
          return { name: options.suggestedName };
        }
      },
      files: {
        pickDirectory: async () => ({ id: 'picked-dir', name: 'Локальная папка' }),
        listDirectory: async (id, { cursor }) => {
          state.directoryPages.push([id, cursor ?? null]);
          if (id === 'picked-dir' && cursor == null) return {
            entries: [{ id: 'dir-child', name: 'Подпапка', directory: true }], nextCursor: 200
          };
          return { entries: [{ id: id + '-file', name: id + '.txt', size: 5 }], nextCursor: null };
        },
        releaseDirectory: async id => { state.releasedDirectories.push(id); },
        pickMultiple: async () => state.pickPhoto ? [
          { id: 'local-photo', name: 'photo-upload.jpg', size: motionPhoto.size },
          { id: 'broken-photo', name: 'broken.jpg', size: 5 }
        ] : state.duplicateProbe ? [
          { id: 'duplicate', name: 'старый-дубль.txt', size: 5 },
          { id: 'changed', name: 'новый-размер.txt', size: 5 }
        ] : state.pickLarge ? [{ id: 'boundary', name: 'boundary.zip', size: 2_000_000_000 }] : [
          { id: 'local-1', name: 'один.txt', size: 5 },
          { id: 'local-2', name: 'два.txt', size: 5 },
          { id: 'large', name: 'large.zip', size: 2_000_000_001 }
        ],
        readChunk: async (id, options) => {
          const { offset, length, sequential } = options;
          if (id === 'local-photo') {
            if (!sequential || length > 1024 * 1024) throw new Error('Photo read exceeded the native chunk limit');
            const { bytes } = await (photoSource ??= original(motionPhoto));
            const dataUrl = await new Promise(resolve => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(new Blob([bytes.subarray(offset, offset + length)]));
            });
            return { offset, data: dataUrl.split(',')[1], eof: offset + length === bytes.length };
          }
          if (length !== 5 || !sequential) throw new Error('Unexpected native read');
          if (id === 'boundary') state.boundaryOffset = offset;
          return { offset, data: btoa(id === 'local-1' ? 'first' : 'other'), eof: true };
        },
        releaseMany: async ids => { state.released.push(...ids); }
      },
      ui: {
        confirm: async options => { state.confirm = options; return !state.cancelDelete; },
        prompt: async options => { state.prompt = options; return state.answer; }
      },
      events: { on: (event, listener) => { if (event === 'ui.topBarAction') state.emit = listener; } }
    };
  }, sample.length);
  await page.reload();
  const status = text => page.waitForFunction(expected =>
    [...document.querySelectorAll('#status,#preview-status')].some(node => node.textContent.includes(expected)), text);
  const click = selector => page.locator(selector).click();
  const back = () => page.evaluate(() => cloudTest.back());
  const drag = (type, withFolder = false) => page.evaluate(({ type, withFolder }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['loose'], 'dropped.txt', { type: 'text/plain' }));
    const getEntry = DataTransferItem.prototype.webkitGetAsEntry;
    if (withFolder) {
      const file = name => ({ isFile: true, file: resolve => resolve(new File([name], name)) });
      const directory = (name, ...pages) => ({ name, createReader: () => ({
        readEntries: resolve => resolve(pages.shift() || [])
      }) });
      dataTransfer.items.add(new File([], 'Dropped folder'));
      const droppedFolder = directory('Dropped folder',
        Array.from({ length: 100 }, (_, index) => file(`part-${index}.txt`)),
        [directory('Nested', [file('child.txt')])]);
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        return this.getAsFile()?.name === 'Dropped folder' ? droppedFolder : getEntry.call(this);
      };
    }
    try {
      return !document.querySelector('main').dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
    } finally {
      if (withFolder) DataTransferItem.prototype.webkitGetAsEntry = getEntry;
    }
  }, { type, withFolder });
  const rightClickBlank = () => page.locator('main').click({ button: 'right', position: { x: 3, y: 3 } });
  const fileCommand = action => click('#file-menu [data-file-action="' + action + '"]');
  const menu = async action => {
    await click('#folder-actions');
    await click('#folder-menu [data-action="' + action + '"]');
  };
  const catalogOption = async (id, value) => {
    await click('#folder-actions');
    await page.locator(id).selectOption(value);
  };
  const textButton = (scope, title) => page.locator(scope).getByRole('button').filter({ hasText: title }).click();
  const fit = async (tag, mustEnlarge = false) => {
    const layout = await page.locator('#preview-body ' + tag).evaluate(element => {
      const dialog = document.querySelector('#preview');
      const stage = document.querySelector('#preview-body').getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const windowRect = dialog.getBoundingClientRect();
      const width = element.videoWidth ?? element.naturalWidth;
      const height = element.videoHeight ?? element.naturalHeight;
      return {
        mode: dialog.dataset.scale,
        coversWindow: windowRect.width >= document.documentElement.clientWidth && windowRect.width <= innerWidth &&
          windowRect.height === innerHeight &&
          windowRect.top === 0 && windowRect.left === 0,
        fillsStage: rect.width === stage.width && rect.height === stage.height,
        contains: getComputedStyle(element).objectFit === 'contain',
        factor: Math.min(stage.width / width, stage.height / height)
      };
    });
    if (layout.mode !== 'fit' || !layout.coversWindow || !layout.fillsStage || !layout.contains ||
        (mustEnlarge && !(layout.factor > 1))) throw new Error('Wrong fit-to-window layout for ' + tag);
  };
  const original = async tag => {
    const size = await page.locator('#preview-body ' + tag).evaluate(element => {
      const box = element.getBoundingClientRect();
      return [box.width, box.height, element.videoWidth ?? element.naturalWidth, element.videoHeight ?? element.naturalHeight];
    });
    if (size[0] !== size[2] || size[1] !== size[3]) throw new Error('Original size distorted for ' + tag + ': ' + size);
    if (await page.locator('#preview-scale').getAttribute('aria-pressed') !== 'true') throw new Error('Scale state was not announced');
  };
  const name = prefix => page.waitForFunction(expected =>
    document.querySelector('#preview-name').textContent.startsWith(expected), prefix);
  const checkPreviewDate = async timestamp => {
    const date = page.locator('#preview-date');
    await date.waitFor();
    if (await date.getAttribute('datetime') !== new Date(timestamp * 1000).toISOString() ||
        !/^\d{2}\.\d{2}\.\d{4}$/.test(await date.textContent())) throw new Error('Wrong preview date');
  };
  const tileMedia = title => page.locator('#file-list').getByRole('button').filter({ hasText: title }).locator('.tile-media');
  const scrollToTile = async tile => {
    for (let attempt = 0; ; attempt++) {
      try { await tile.scrollIntoViewIfNeeded(); return; }
      catch (error) {
        if (attempt >= 2 || !error.message.includes('not attached')) throw error;
      }
    }
  };
  const checkTile = async (title, portrait) => {
    const image = tileMedia(title).locator('img');
    let layout;
    for (let attempt = 0; attempt < 3 && !layout; attempt++) {
      await image.waitFor();
      layout = await image.evaluate(img => {
        if (!img.isConnected) return null;
        const { width, height } = img.parentElement.getBoundingClientRect();
        const button = img.closest('button');
        const card = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          fit: getComputedStyle(img).objectFit,
          ratio: img.naturalWidth / img.naturalHeight,
          imageHeightError: Math.abs(height - width * img.naturalHeight / img.naturalWidth),
          bottomSpace: card.bottom - button.lastElementChild.getBoundingClientRect().bottom -
            parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth),
          cardHeight: card.height
        };
      });
    }
    if (!layout || layout.fit !== 'contain' ||
        Math.abs(layout.ratio - (portrait ? 9 / 16 : 16 / 9)) > 0.01 ||
        layout.imageHeightError > 0.5 || layout.bottomSpace > 0.5) {
      throw new Error('Tile cropped or distorted the thumbnail: ' + title);
    }
    return layout.cardHeight;
  };
  const checkMasonry = columns => page.waitForFunction(expectedColumns => {
    const catalog = document.querySelector('#file-list');
    const bounds = catalog.getBoundingClientRect();
    const columnEnds = new Map();
    let previousTop = bounds.top;
    for (const card of catalog.children) {
      const { left, right, top, bottom } = card.getBoundingClientRect();
      const preceding = columnEnds.get(left);
      const expectedTop = preceding === undefined ? bounds.top : preceding + 8;
      if (Math.abs(top - expectedTop) > 0.5 || top < previousTop - 0.5 ||
          left < bounds.left - 0.5 || right > bounds.right + 0.5) return false;
      previousTop = top;
      columnEnds.set(left, bottom);
    }
    return columnEnds.size === expectedColumns &&
      Math.abs(bounds.bottom - Math.max(...columnEnds.values())) <= 0.5;
  }, columns, { timeout: 5000 });
  const checkFixedLabels = async () => {
    const labels = await page.locator('#file-list').evaluate(catalog => {
      const names = Array.from(catalog.querySelectorAll('button > span:not(.tile-media)'));
      const long = names.find(name => name.textContent.startsWith('файл 0 '));
      const short = names.find(name => name.textContent === 'файл 1');
      const detail = long.nextElementSibling;
      return {
        longHeight: long.offsetHeight, shortHeight: short.offsetHeight, detailHeight: detail.offsetHeight,
        nameSize: getComputedStyle(long).fontSize, detailSize: getComputedStyle(detail).fontSize,
        clipped: long.scrollWidth > long.clientWidth && getComputedStyle(long).textOverflow === 'ellipsis',
        detail: detail.textContent, fullName: long.textContent, tooltip: long.parentElement.title
      };
    });
    if (!labels.clipped || labels.longHeight !== labels.shortHeight || labels.longHeight !== 18 ||
        labels.detailHeight !== 15 || labels.nameSize !== '13px' || labels.detailSize !== '11px' ||
        !/· \d{2}\.\d{2}\.\d{4}$/.test(labels.detail) ||
        labels.tooltip !== labels.fullName + '\n' + labels.detail) {
      throw new Error('Catalog labels do not have fixed metrics or lost metadata');
    }
  };
  const checkRowWheel = async columns => {
    const [one, two] = await page.locator('#file-list').evaluate((catalog, stride) => {
      const origin = catalog.getBoundingClientRect().top;
      return [stride, stride * 2].map(index => Math.round(catalog.children[index].getBoundingClientRect().top - origin));
    }, columns);
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerdown'));
      scrollTo(0, 0);
      cloudTest.scrollSamples = [];
    });
    await page.mouse.move(350, 250);
    const waitAt = target => page.waitForFunction(expected => Math.abs(scrollY - expected) <= 0.5, target, { timeout: 3000 });
    await page.mouse.wheel(0, 1440);
    await waitAt(one);
    if (!await page.evaluate(end => new Set(cloudTest.scrollSamples.filter(value => value > 0 && value < end - 1)).size >= 3, one)) {
      throw new Error('Wheel jumped to the next row with reduced-motion enabled');
    }
    await page.mouse.wheel(0, -1440);
    await waitAt(0);
    await page.locator('#file-list').evaluate(catalog => {
      for (let index = 0; index < 2; index++) {
        catalog.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      }
    });
    await waitAt(two);
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerdown'));
      scrollTo(0, 0);
    });
  };
  const panWithMouse = async () => {
    const stage = page.locator('#preview-body');
    await stage.evaluate(element => element.scrollTo(0, 0));
    const box = await stage.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y - 80, { steps: 8 });
    await page.waitForFunction(() => {
      const stage = document.querySelector('#preview-body');
      return stage.scrollLeft >= 95 && stage.scrollTop >= 75 && stage.classList.contains('dragging');
    });
    await page.mouse.move(x - 100, box.y - 4, { steps: 4 });
    await page.mouse.up();
    if (await stage.evaluate(element => element.classList.contains('dragging'))) {
      throw new Error('Releasing outside the preview body did not end the drag');
    }
    return { x, y };
  };
  const touch = (type, points, changed = points) => page.locator('#preview-body').evaluate((stage, args) => {
    const rect = stage.getBoundingClientRect();
    const touches = values => values.map(([x, y], index) =>
      new Touch({ identifier: index, target: stage, clientX: rect.left + x, clientY: rect.top + y }));
    stage.dispatchEvent(new TouchEvent(args.type, {
      touches: touches(args.points), changedTouches: touches(args.changed), bubbles: true, cancelable: true
    }));
  }, { type, points, changed });

  await click('#connect');
  await status('Сохранённый вход не найден');
  if (await back()) throw new Error('Back at welcome must return to the launcher');
  await page.evaluate(() => { cloudTest.consent = 'declined'; });
  await click('#connect');
  await status('Действие отменено');
  await page.evaluate(() => { cloudTest.consent = 'allowed'; });
  await click('#connect');
  await page.locator('#channels').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#controls').disabled);
  if (await back()) throw new Error('Back at initial channel selection must return to the launcher');
  await page.locator('#channel-search').fill('вТОрОй');
  await page.locator('#channel-list button').filter({ hasText: 'Второй канал' }).waitFor();
  if (await page.locator('#channel-list button').count() !== 1) throw new Error('Channel search did not filter by name');
  await page.locator('#channel-search').fill('');
  await textButton('#channel-list', 'Мои файлы');
  if (await page.locator('#cloud-toolbar #folders [aria-current]').textContent() !== 'Мои файлы' ||
      await page.locator('#drive #folders, #drive #view-mode, #drive #sort-mode, #account').count()) {
    throw new Error('The catalog retained its duplicate header or controls');
  }
  await click('#folder-actions');
  await page.locator('#folder-menu [data-action="upload-files"]').hover();
  const menuStyle = await page.locator('#folder-menu').evaluate(menu => ({
    background: getComputedStyle(menu).backgroundColor,
    hover: getComputedStyle(menu.querySelector('[data-action="upload-files"]')).backgroundColor,
    icons: menu.querySelectorAll('#folder-commands button:not([hidden]) svg').length
  }));
  if (menuStyle.background !== 'rgb(24, 31, 43)' || menuStyle.hover !== 'rgb(34, 45, 60)' || menuStyle.icons !== 5) {
    throw new Error('Android popup lost its dark style, icon or selection highlight');
  }
  if (!await back()) throw new Error('Back did not close the folder menu');
  await page.locator('#folder-menu').waitFor({ state: 'hidden' });
  if (await page.evaluate(() => cloudTest.pages.length) !== 1) throw new Error('Loaded the next page before reaching the bottom');
  const reserved = await tileMedia('большое.png').boundingBox();
  if (Math.abs(reserved.height - reserved.width * 9 / 16) > 0.5) throw new Error('Missing thumbnail aspect before decoding');
  await page.waitForFunction(() => [105, 104, 107].every((id, index) =>
    document.querySelector(`[data-file-id="${id}"] .tile-media img`)?.naturalWidth === [32, 32, 18][index]));
  await page.evaluate(() => { cloudTest.holdOriginal = true; });
  await textButton('#file-list', 'большое.png');
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 32 && cloudTest.releaseOriginal);
  await click('#close-preview');
  if (!await page.evaluate(() => cloudTest.originalAborted)) throw new Error('Closing the viewer did not abort the original');
  await page.evaluate(() => { cloudTest.holdOriginal = false; });
  await page.evaluate(() => cloudTest.releaseWideThumbnail());
  await page.waitForFunction(() => document.querySelector('[data-file-id="105"] .tile-media img')?.naturalWidth === 360);
  const wideCard = await checkTile('большое.png', false);
  if (await checkTile('ролик.webm', true) <= wideCard) throw new Error('The portrait card did not become taller');
  await checkMasonry(7);
  await checkFixedLabels();
  await checkRowWheel(7);
  await page.setViewportSize({ width: 680, height: 800 });
  await checkMasonry(4);
  await page.setViewportSize({ width: 1120, height: 800 });
  await checkMasonry(7);
  await catalogOption('#view-mode', 'large');
  if (await page.locator('#file-list').getAttribute('data-view') !== 'large') throw new Error('Wrong tile size');
  await checkTile('ролик.webm', true);
  await checkMasonry(4);
  await checkRowWheel(4);
  await catalogOption('#view-mode', 'list');
  await catalogOption('#sort-mode', 'size-asc');
  if (await page.locator('#file-list button span').first().textContent() !== 'защищённый.txt') {
    throw new Error('Wrong ascending size order');
  }
  if (await page.locator('#file-list .tile-media').count()) throw new Error('List mode still displays tiles');
  await checkFixedLabels();
  await checkRowWheel(1);
  await textButton('#file-list', 'защищённый.txt');
  await page.locator('#preview-body pre').waitFor();
  if (await page.locator('#save').isVisible()) throw new Error('Protected attachment can be saved');
  if (await page.locator('#preview-scale').isVisible()) throw new Error('Text preview has an image-scale button');
  await click('#close-preview');
  await textButton('#file-list', 'большое.png');
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 640);
  await checkPreviewDate(1_728_000_000);
  await fit('img', true);
  const browserZoom = await page.locator('#preview-body').evaluate(stage => {
    const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -300, bubbles: true, cancelable: true });
    stage.dispatchEvent(event);
    return !event.defaultPrevented && document.querySelector('#preview').dataset.scale === 'fit';
  });
  if (!browserZoom) throw new Error('Ctrl+wheel was handled as media zoom');
  await click('#preview-scale');
  await original('img');
  await click('#preview-scale');
  await fit('img', true);
  await page.locator('#preview-body').hover();
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => document.querySelector('#preview').dataset.scale === 'zoom' &&
    document.querySelector('#preview-body').scrollWidth > innerWidth);
  await panWithMouse();
  await page.locator('#preview-body').hover();
  const zoomedWidth = await page.locator('.preview-frame').evaluate(frame => frame.clientWidth);
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(before => document.querySelector('.preview-frame').clientWidth < before, zoomedWidth);
  await click('#preview-scale');
  await fit('img', true);
  await touch('touchstart', [[90, 150], [180, 150]]);
  await touch('touchmove', [[45, 150], [240, 150]]);
  await touch('touchend', [], [[45, 150], [240, 150]]);
  if (await page.locator('#preview').getAttribute('data-scale') !== 'zoom') throw new Error('Pinch did not zoom');
  await name('большое.png');
  await page.evaluate(() => {
    const dialog = document.querySelector('#preview');
    dialog.addEventListener('close', () => { cloudTest.previewClosed = true; }, { once: true });
  });
  await page.keyboard.press('ArrowRight');
  await name('ролик.webm');
  await checkPreviewDate(1_729_000_000);
  await page.waitForFunction(() => document.querySelector('#preview-body video')?.readyState >= 2);
  await page.waitForFunction(() => document.querySelector('#preview-body video')?.poster.startsWith('blob:'));
  await fit('video', true);
  if (ranges.reduce((bytes, [start, end]) => bytes + end - start + 1, 0) >= sample.length) {
    throw new Error('Player buffered the entire video before the first frame');
  }
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
  await page.locator('video').evaluate(player => { player.dataset.scaleProbe = 'alive'; });
  await click('#preview-scale');
  await original('video');
  await page.setViewportSize({ width: 390, height: 780 });
  await checkPreviewDate(1_729_000_000);
  const scroll = await page.locator('#preview-body').evaluate(stage => {
    stage.scrollLeft = stage.scrollWidth;
    return stage.scrollLeft;
  });
  if (scroll <= 0) throw new Error('An original-size video cannot be panned in a narrow window');
  await click('#preview-scale');
  await fit('video');
  if (await page.locator('video').getAttribute('data-scale-probe') !== 'alive' ||
      await page.locator('video').evaluate(player => player.paused || player.currentTime < 0.1) ||
      await page.evaluate(() => cloudTest.playerClosed)) throw new Error('Scaling restarted or paused playback');
  await click('.video-surface');
  await page.waitForFunction(() => document.querySelector('video')?.paused === true);
  await click('.video-surface');
  await page.waitForFunction(() => document.querySelector('video')?.paused === false);
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.locator('#preview-body').hover();
  await page.mouse.wheel(0, -450);
  await page.waitForFunction(() => {
    const stage = document.querySelector('#preview-body');
    return stage.scrollWidth - stage.clientWidth >= 100 && stage.scrollHeight - stage.clientHeight >= 80;
  });
  const videoPoint = await panWithMouse();
  if (await page.locator('video').evaluate(player => player.paused)) throw new Error('Dragging the video paused playback');
  await page.mouse.click(videoPoint.x, videoPoint.y);
  await page.waitForFunction(() => document.querySelector('video')?.paused === true);
  const seek = await page.locator('video').evaluate(player => {
    player.pause();
    const time = player.duration * 0.75;
    player.currentTime = time;
    return time;
  });
  await page.waitForFunction(expected => {
    const player = document.querySelector('video');
    return player && !player.seeking && player.readyState >= 2 && Math.abs(player.currentTime - expected) < 0.2;
  }, seek);
  if (!ranges.some(([start]) => start > sample.length / 2)) throw new Error('Seeking did not request a distant range');
  await page.keyboard.press('ArrowLeft');
  await name('большое.png');
  if (!await page.evaluate(() => cloudTest.playerClosed)) throw new Error('The media URL remained open');
  if (await page.evaluate(() => cloudTest.previewClosed)) throw new Error('Gallery navigation closed the modal');
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 640 &&
    !document.querySelector('#controls').disabled);
  await touch('touchstart', [[100, 150]]);
  await touch('touchmove', [[240, 150]]);
  await touch('touchend', [], [[240, 150]]);
  await name('альбом.png');
  if (await page.locator('#preview-date').isVisible()) throw new Error('An undated file inherited the previous date');
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 640);
  if (!await page.locator('#preview-prev').isDisabled()) throw new Error('Gallery crossed the start of the folder');
  await click('#close-preview');
  await textButton('#file-list', 'большой.txt');
  await page.locator('#preview-body pre').waitFor();
  if (await page.evaluate(() => cloudTest.read.length) !== 65536) throw new Error('Large text preview read the entire file');
  await click('#close-preview');
  await textButton('#file-list', 'скачать.zip');
  await click('#save');
  await page.waitForFunction(() => cloudTest.saved?.size === 2_000_000_000);
  await click('#cancel-save');
  await status('Скачивание отменено');
  if (await page.evaluate(() => cloudTest.saved.count) !== 524288) throw new Error('Download read beyond a block');
  await click('#close-preview');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => cloudTest.pages.some(([, cursor]) => cursor === 103));
  await textButton('#file-list', 'Архив');
  await menu('download-folder');
  await status('Сохранено файлов: 1. Пропущено: 1');
  const bulk = await page.evaluate(() => cloudTest.folderSaves);
  if (bulk.length !== 1 || bulk[0].directoryId !== 'picked-dir' || bulk[0].folders.join() !== '2024' ||
      bulk[0].suggestedName !== 'старый.txt' || bulk[0].text !== 'hello') throw new Error('Bulk download lost a path or bytes');
  await textButton('#file-list', 'Закрыто');
  await textButton('#file-list', 'закрытое.png');
  await page.locator('#preview-body img').waitFor();
  await click('#close-preview');
  if (await page.evaluate(() => sessionStorage.getItem('v1:a:109:guarded-test'))) throw new Error('Protected thumbnail persisted');
  await textButton('#folders', 'Архив');
  await textButton('#file-list', 'Фото');
  await catalogOption('#view-mode', 'tiles');
  await checkTile('MVIMG_20220821_074212.jpg', false);
  await page.waitForFunction(() => sessionStorage.getItem('v1:a:110:original-test')?.startsWith('data:image/webp'));
  await textButton('#file-list', 'MVIMG_20220821_074212.jpg');
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 1600);
  await fit('img', false);
  await click('#preview-scale');
  await original('img');
  await click('#close-preview');
  await catalogOption('#view-mode', 'list');
  await textButton('#folders', 'Мои файлы');
  await textButton('#file-list', 'Проверка JPEG');
  await page.evaluate(() => {
    cloudTest.savedDecoder = window.ImageDecoder;
    window.ImageDecoder = undefined;
    cloudTest.holdScanThumbnail = true;
  });
  await textButton('#file-list', 'Строки.jpg');
  const scanRows = expected => page.waitForFunction(middleVisible => {
    const image = document.querySelector('#preview-body img.partial-photo');
    if (!image || getComputedStyle(image).backgroundColor !== 'rgb(0, 0, 0)') return false;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixel = height => context.getImageData(canvas.width / 2, Math.floor(canvas.height * height), 1, 1).data;
    return pixel(0.05)[0] > 100 && pixel(0.95)[3] === 0 && (middleVisible ? pixel(0.5)[0] > 100 : pixel(0.5)[3] === 0);
  }, expected);
  const composite = page.locator('#preview-body .photo-composite');
  const composedRows = async () => {
    const points = await page.locator('#preview-body .partial-photo').evaluate(image => {
      const rect = image.getBoundingClientRect();
      const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
      const height = image.naturalHeight * scale;
      const top = rect.top + (rect.height - height) / 2;
      return [0.05, 0.5, 0.95].map(fraction => [Math.floor(rect.left + rect.width / 2), Math.floor(top + height * fraction)]);
    });
    const screenshot = await page.screenshot({ scale: 'css' });
    return page.evaluate(async ({ encoded, points }) => {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
    }, { encoded: screenshot.toString('base64'), points });
  };
  await scanRows(false);
  await composite.waitFor();
  const [earlyTop, , earlyBottom] = await composedRows();
  if (earlyTop[0] < 100 || earlyBottom[2] < 170) throw new Error('The decoded rows did not cover the blue embedded thumbnail');
  const initialForeground = await page.locator('#preview-body .partial-photo').getAttribute('src');
  await page.evaluate(() => cloudTest.releaseScanThumbnail());
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.photo-composite');
    return canvas && canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height - 10, 1, 1).data[1] > 145;
  });
  if (await page.locator('#preview-body .partial-photo').getAttribute('src') !== initialForeground) {
    throw new Error('A late cached thumbnail replaced the partial original');
  }
  await page.setViewportSize({ width: 530, height: 720 });
  const [resizedTop, , resizedBottom] = await composedRows();
  if (resizedTop[0] < 100 || resizedBottom[1] < 145) throw new Error('Thumbnail and original diverged after resize');
  await page.setViewportSize({ width: 1120, height: 800 });
  await click('#preview-scale');
  await page.evaluate(() => cloudTest.advanceScan());
  await scanRows(true);
  const aligned = await composite.evaluate(layer => {
    const image = layer.parentElement.querySelector('.partial-photo');
    const original = image.getBoundingClientRect();
    const background = layer.getBoundingClientRect();
    return Math.abs(layer.width / layer.height - image.naturalWidth / image.naturalHeight) < 0.001 &&
      ['x', 'y', 'width', 'height'].every(dimension => Math.abs(original[dimension] - background[dimension]) < 0.5);
  });
  if (!aligned) throw new Error('Thumbnail and original are misaligned at natural size');
  await page.evaluate(() => cloudTest.advanceScan());
  await page.waitForFunction(() => document.querySelector('#preview-body img:not(.partial-photo)')?.naturalWidth === 1600);
  await original('img');
  if (await composite.count()) throw new Error('The completed original retained the intermediate surface');
  await click('#close-preview');
  await page.evaluate(() => cloudTest.dropScanThumbnail());
  await textButton('#file-list', 'Строки.jpg');
  await scanRows(false);
  const [, , bareBottom] = await composedRows();
  if (bareBottom.slice(0, 3).some(Boolean) || await composite.count()) throw new Error('Missing thumbnail did not fall back to black');
  await click('#close-preview');
  await page.waitForFunction(() => cloudTest.jpegAborted);
  await page.evaluate(() => { window.ImageDecoder = cloudTest.savedDecoder; });
  for (const format of ['png', 'webp']) {
    if (format === 'webp') await page.setViewportSize({ width: 390, height: 780 });
    await textButton('#file-list', 'Строки.' + format);
    await scanRows(false);
    const loading = page.locator('.preview-title-line #preview-status');
    if (await loading.textContent() !== 'Загружаем оригинал…') throw new Error('Loading status is outside the title line');
    await composite.waitFor();
    const [top, , bottom] = await composedRows();
    if (top[0] < 100 || bottom[2] < 170) throw new Error('The ' + format + ' prefix did not appear over the thumbnail');
    const frame = page.locator('#preview-body .preview-frame');
    const before = await frame.boundingBox();
    await page.evaluate(() => cloudTest.advanceScan());
    await scanRows(true);
    await page.evaluate(() => cloudTest.advanceScan());
    await page.waitForFunction(() => document.querySelector('#preview-body img:not(.partial-photo)')?.naturalWidth === 1600 &&
      !document.querySelector('#preview-status').textContent);
    const after = await frame.boundingBox();
    if (['x', 'y', 'width', 'height'].some(key => Math.abs(before[key] - after[key]) > 0.5)) {
      throw new Error('Clearing the preview status resized the ' + format + ' frame');
    }
    await click('#close-preview');
  }
  await page.evaluate(() => { window.ImageDecoder = undefined; });
  await textButton('#file-list', 'Строки.webp');
  await page.waitForFunction(() => document.querySelector('#preview-body img:not(.partial-photo)')?.naturalWidth === 1600);
  await click('#close-preview');
  await page.evaluate(() => { window.ImageDecoder = cloudTest.savedDecoder; });
  await page.setViewportSize({ width: 1120, height: 800 });
  await catalogOption('#view-mode', 'list');
  await textButton('#folders', 'Мои файлы');
  await textButton('#file-list', 'Архив');
  await textButton('#file-list', '2024');
  await textButton('#file-list', 'старый.txt');
  await page.waitForFunction(() => document.querySelector('#preview-body pre')?.textContent === 'hello');
  await click('#save');
  await status('Файл сохранён');
  const saved = await page.evaluate(() => cloudTest.saved);
  if (saved.suggestedName !== 'старый.txt' || saved.text !== 'hello') throw new Error('Saved file changed');
  await click('#close-preview');

  await page.evaluate(() => { cloudTest.holdFolderSave = true; cloudTest.holdSecond = true; });
  await menu('download-folder');
  await page.waitForFunction(() => typeof cloudTest.finishHeldSave === 'function');
  await menu('upload-files');
  await page.waitForFunction(() => typeof cloudTest.finishHeldUpload === 'function');
  await menu('transfers');
  await page.locator('#transfer-tabs').waitFor();
  await click('#show-upload');
  const uploadProgress = await page.locator('#upload-progress').evaluate(bar => [bar.max, bar.value]);
  if (uploadProgress.join() !== '2,1.5') throw new Error('Upload progress lost its batch total or current file');
  await click('#show-download');
  if (!await page.locator('#download-progress').isVisible() ||
      await page.locator('#download-progress').evaluate(bar => bar.max) !== 1) throw new Error('Missing download progress');
  await page.evaluate(() => { cloudTest.holdFolderSave = false; cloudTest.finishHeldSave(); });
  await page.locator('#transfer-tabs').waitFor({ state: 'hidden' });
  await page.locator('#upload-progress').waitFor();
  await page.evaluate(() => { cloudTest.holdSecond = false; cloudTest.finishHeldUpload(); });
  await status('Загружено 1 из 2');
  await page.locator('#upload-progress').waitFor({ state: 'hidden' });
  if (await page.locator('#queue li').count() !== 1) throw new Error('Confirmed file still in the queue');
  await click('#close-transfers');
  if (!await drag('drop')) throw new Error('Blocked drop can trigger the browser default');
  await status('Завершите предыдущую загрузку');
  await menu('transfers');
  await page.evaluate(() => { cloudTest.failSecond = false; });
  await click('#send');
  await status('загружено файлов: 2');
  await click('#close-transfers');
  const state = await page.evaluate(() => cloudTest);
  const expected = [['a', 'один.txt', 'Архив/2024', 'first'],
    ['a', 'два.txt', 'Архив/2024', 'other'], ['a', 'два.txt', 'Архив/2024', 'other']];
  if (JSON.stringify(state.uploads) !== JSON.stringify(expected)) throw new Error('Wrong upload attempts');
  if (state.released.sort().join() !== 'large,local-1,local-2') throw new Error('File handles not released');
  await page.evaluate(() => { cloudTest.pickLarge = true; });
  await menu('upload-files');
  await status('загружено файлов: 1');
  if (await page.evaluate(() => cloudTest.boundaryOffset) !== 1_999_999_995) throw new Error('2 GB range lost its offset');
  const previousReleases = await page.evaluate(() => cloudTest.releasedDirectories.length);
  await menu('upload-folder');
  await status('загружено файлов: 2');
  const uploaded = await page.evaluate(() => cloudTest);
  if (uploaded.uploads.slice(-2).map(item => item[2]).join('|') !==
      'Архив/2024/Локальная папка|Архив/2024/Локальная папка/Подпапка' ||
      uploaded.directoryPages.length !== 3 || uploaded.releasedDirectories.length - previousReleases !== 2) {
    throw new Error('Folder upload skipped a page, path or handle release');
  }

  await menu('choose-channel');
  await textButton('#channel-list', 'Второй канал');
  if (await page.locator('#file-list button').count()) throw new Error('Previous channel leaked into the second');
  await page.evaluate(() => { cloudTest.answer = 'Новая папка'; cloudTest.pickLarge = false; });
  await rightClickBlank();
  await click('#folder-menu [data-action="create-folder"]');
  await status('Папка создана');
  await textButton('#file-list', 'Новая папка');
  await menu('upload-files');
  await status('загружено файлов: 2');
  const firstNew = page.locator('.selectable-file').filter({ hasText: 'один.txt' });
  const secondNew = page.locator('.selectable-file').filter({ hasText: 'два.txt' });
  await firstNew.locator('button').click({ button: 'right' });
  await page.evaluate(() => { cloudTest.answer = 'переименован.txt'; });
  await fileCommand('rename');
  await status('Файл переименован');
  if (await page.evaluate(() => cloudTest.prompt.defaultValue) !== 'один.txt') throw new Error('Rename input not filled');
  const renamed = page.locator('.selectable-file').filter({ hasText: 'переименован.txt' });
  await renamed.getByRole('checkbox').check();
  await secondNew.getByRole('checkbox').check();
  await renamed.locator('button').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 15, clientX: 80, clientY: 150 });
  await page.locator('#file-menu').waitFor({ state: 'visible' });
  await renamed.locator('button').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 15 });
  await renamed.locator('button').dispatchEvent('click');
  if (await page.locator('#preview').isVisible() || await page.locator('[data-file-action="rename"]').isVisible()) {
    throw new Error('Long press did not keep the selection menu open');
  }
  await fileCommand('share');
  await page.locator('#cloud-target-search').fill('группа');
  await textButton('#cloud-target-list', 'Тестовая группа');
  await status('Переслано · 2 из 2');
  await renamed.locator('button').click({ button: 'right' });
  await fileCommand('download');
  await status('Сохранено файлов: 2');
  await renamed.locator('button').click({ button: 'right' });
  await fileCommand('move');
  await textButton('#cloud-target-list', 'Корень канала');
  await status('Перемещено · 2 из 2');
  if (await page.locator('.selectable-file').count()) throw new Error('Moved files remain in their previous folder');
  await textButton('#folders', 'Второй канал');
  if (await page.locator('.selectable-file input:checked').count()) throw new Error('Selection leaked between folders');
  await renamed.getByRole('checkbox').check();
  await secondNew.getByRole('checkbox').check();
  await page.evaluate(() => { cloudTest.cancelDelete = true; });
  await renamed.locator('button').click({ button: 'right' });
  await fileCommand('delete');
  if (await page.evaluate(() => cloudTest.deletions.length)) throw new Error('Deletion ignored cancellation');
  await page.evaluate(() => { cloudTest.cancelDelete = false; });
  await renamed.locator('button').click({ button: 'right' });
  await fileCommand('delete');
  await status('Удалено · 2 из 2');
  const actions = await page.evaluate(() => cloudTest);
  const ids = actions.deletions[0][1];
  if (ids.length !== 2 || actions.forwards[0].join('|') !== ['b', ids, 'group'].join('|') ||
      actions.folderSaves.slice(-2).map(item => item.suggestedName).join() !== 'переименован.txt,два.txt') {
    throw new Error('Group action changed selected files');
  }
  await page.evaluate(() => { cloudTest.duplicateProbe = true; });
  await menu('upload-files');
  await status('Загружено 0 из 2');
  await menu('transfers');
  await click('#send');
  await status('Уже были в канале: 2');
  await click('#close-transfers');
  const checked = await page.evaluate(() => ({ uploads: cloudTest.uploads, pages: cloudTest.pages, released: cloudTest.released }));
  if (checked.uploads.length !== actions.uploads.length + 1 || checked.uploads.at(-1)[1] !== 'новый-размер.txt' ||
      !checked.pages.some(([id, cursor]) => id === 'b' && cursor === 190) ||
      !checked.released.includes('duplicate') || !checked.released.includes('changed')) {
    throw new Error('Duplicate scanning missed an older file, a different size or an ambiguous publication');
  }
  await page.locator('#file-list button').filter({ hasText: 'новый-размер.txt' }).waitFor();
  await click('#folder-actions');
  if (await page.locator('#folder-menu [data-action="transfers"]').isVisible()) throw new Error('Transfers menu stuck after completion');
  await click('#folder-actions');
  const stableScrollbar = await page.locator('#file-list').evaluate(catalog => {
    const root = document.documentElement;
    root.style.overflowY = 'hidden';
    const withoutScrollbar = catalog.getBoundingClientRect().width;
    root.style.overflowY = 'scroll';
    const withScrollbar = catalog.getBoundingClientRect().width;
    root.style.removeProperty('overflow-y');
    return Math.abs(withScrollbar - withoutScrollbar) <= 0.5;
  });
  if (!stableScrollbar) throw new Error('A scrollbar toggle resized the catalog');

  await page.evaluate(() => { sessionStorage.setItem('fixture-platform', 'windows'); });
  await page.reload();
  await page.locator('#drive').waitFor({ state: 'visible' });
  if (await page.evaluate(() => cloudTest.manualLogin || cloudTest.dialogPages.join() !== 'true,false')) {
    throw new Error('The account and second-page channel were not restored silently');
  }
  await page.waitForFunction(() => cloudTest.toolbar?.channelTitle === 'Второй канал' &&
    cloudTest.toolbar.view === 'list' && cloudTest.toolbar.sort === 'size-asc');
  if (await page.locator('#cloud-toolbar').isVisible()) throw new Error('Duplicate Windows toolbar');
  await page.locator('#file-list button').filter({ hasText: 'Новая папка' }).waitFor();
  await rightClickBlank();
  await page.waitForFunction(() => cloudTest.context?.kind === 'background');
  await page.evaluate(() => cloudTest.emit('choose-channel'));
  await page.locator('#channels').waitFor({ state: 'visible' });
  if (!await back()) throw new Error('Back did not close the channel picker over the catalog');
  await page.locator('#channels').waitFor({ state: 'hidden' });
  await page.evaluate(() => cloudTest.emit('choose-channel'));
  await textButton('#channel-list', 'Мои файлы');
  await page.evaluate(() => { cloudTest.holdOriginal = true; });
  await textButton('#file-list', 'большое.png');
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 360 && cloudTest.releaseOriginal);
  await click('#preview-scale');
  await page.evaluate(() => { cloudTest.holdOriginal = false; cloudTest.releaseOriginal(); });
  await page.waitForFunction(() => document.querySelector('#preview-body img')?.naturalWidth === 640);
  await original('img');
  await click('#close-preview');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.evaluate(() => {
    cloudTest.emit('view:tiles');
    cloudTest.emit('sort:name');
  });
  await page.waitForFunction(() => cloudTest.toolbar.view === 'tiles' && cloudTest.toolbar.sort === 'name');
  await scrollToTile(tileMedia('большое.png'));
  await checkTile('большое.png', false);
  if (!await page.evaluate(() => cloudTest.cacheHits.includes('v1:a:105:large-test') && !cloudTest.thumbnailFetches.includes(105))) {
    throw new Error('Large thumbnail was fetched again after reopening');
  }
  const posterTile = tileMedia('ролик.webm');
  await scrollToTile(posterTile);
  await checkTile('ролик.webm', true);
  await checkMasonry(2);
  const beforeScroll = await posterTile.boundingBox();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await posterTile.locator('img').waitFor({ state: 'detached' });
  const afterScroll = await posterTile.boundingBox();
  if (Math.abs(beforeScroll.height - afterScroll.height) > 0.5) throw new Error('Tile lost its aspect offscreen');
  await scrollToTile(posterTile);
  await checkTile('ролик.webm', true);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
    throw new Error('Mobile gallery overflows horizontally');
  }
  await textButton('#file-list', 'Архив');
  await page.waitForFunction(() => cloudTest.toolbar.folder === 'Архив');
  await page.evaluate(() => cloudTest.emit('folder:'));
  await page.waitForFunction(() => cloudTest.toolbar.folder === '');
  await page.locator('[data-file-id="105"] button').click({ button: 'right' });
  await page.waitForFunction(() => cloudTest.context?.kind === 'file' && cloudTest.context.canShare);
  await textButton('#file-list', 'скачать.zip');
  await click('#save');
  await page.waitForFunction(() => cloudTest.toolbar?.hasTransfers && cloudTest.saved?.size === 2_000_000_000);
  await page.evaluate(() => cloudTest.emit('transfers'));
  await page.locator('#download-progress').waitFor();
  if (!await back()) throw new Error('Back did not dismiss the transfers window');
  await page.locator('#transfers').waitFor({ state: 'hidden' });
  await click('#cancel-save');
  await page.waitForFunction(() => cloudTest.toolbar?.hasTransfers === false);
  await click('#close-preview');
  await textButton('#file-list', 'Архив');
  await page.waitForFunction(() => cloudTest.toolbar.folder === 'Архив');
  if (!await drag('dragenter')) throw new Error('File drag was not accepted');
  await page.locator('#drop-target').waitFor({ state: 'visible' });
  if (await page.locator('#drop-destination').textContent() !== 'Мои файлы / Архив') {
    throw new Error('Drop destination does not match the open folder');
  }
  await drag('dragleave');
  await page.locator('#drop-target').waitFor({ state: 'hidden' });
  if (!await drag('drop', true)) throw new Error('Mixed drop can trigger the browser default');
  await status('загружено файлов: 102');
  const dropped = await page.evaluate(() => cloudTest.uploads);
  if (dropped.length !== 102 || dropped[0].join('|') !== 'a|dropped.txt|Архив|loose' ||
      dropped[100].join('|') !== 'a|part-99.txt|Архив/Dropped folder|part-99.txt' ||
      dropped[101].join('|') !== 'a|child.txt|Архив/Dropped folder/Nested|child.txt') {
    throw new Error('Mixed drop lost file data, its destination or a directory page');
  }
  await page.evaluate(() => { cloudTest.pickPhoto = true; cloudTest.emit('upload-files'); });
  await status('загружено файлов: 2');
  if ((await page.evaluate(() => cloudTest.photoSize)).join() !== '320,180') throw new Error('Upload thumbnail was distorted');
  await scrollToTile(tileMedia('photo-upload.jpg'));
  await checkTile('photo-upload.jpg', false);
  await page.locator('#file-list').getByRole('button', { name: '2024 Папка', exact: true }).click();
  await textButton('#file-list', 'старый.txt');
  await page.locator('#preview-body pre').waitFor();
  if (!await back()) throw new Error('Back did not dismiss the preview');
  await page.locator('#preview').waitFor({ state: 'hidden' });
  if (await page.evaluate(() => cloudTest.toolbar.folder) !== 'Архив/2024') throw new Error('Closing preview left its folder');
  if (!await back() || await page.evaluate(() => cloudTest.toolbar.folder) !== 'Архив') throw new Error('Back skipped the parent folder');
  if (!await back() || await page.evaluate(() => cloudTest.toolbar.folder) !== '') throw new Error('Back did not reach the root');
  if (await back()) throw new Error('Back at the channel root must return to the launcher');
  if (errors.length) throw new Error(errors.join('\n'));
  return 'PASS: JPEG, PNG and WebP partial previews, fixed header geometry, gallery and transfers';
}

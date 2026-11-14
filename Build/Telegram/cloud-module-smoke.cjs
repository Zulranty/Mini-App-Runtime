const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const dependency = createRequire(path.resolve(__dirname, '../../Cache/Telegram/module/build-module.cjs'));
const { Api, TelegramClient } = dependency('teleproto');
const { FileTransfers } = dependency('./node_modules/teleproto/client/files/FileTransfers.js');
const { buildSync } = dependency('esbuild');
const { outputFiles: [entry] } = buildSync({
  entryPoints: [path.join(__dirname, 'telegram.js')],
  bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false
});
const host = { window: {}, require: dependency, AbortController, setTimeout, clearTimeout };
vm.runInNewContext(entry.text, host);

const makeChannel = fields => new Api.Channel({ broadcast: true, ...fields });
const privateChannel = makeChannel({ creator: true });
const writable = makeChannel({ adminRights: new Api.ChatAdminRights({ postMessages: true }) });
const readonly = makeChannel({});
const publicChannel = makeChannel({ creator: true, username: 'public' });
const alternatePublic = makeChannel({ creator: true, usernames: [new Api.Username({ active: true, username: 'alt' })] });
const dialog = (id, entity) => ({ id, entity, inputEntity: { id }, title: 'Channel ' + id });
const attachment = (id, fields = {}, caption = 'Old\\Folder', name = 'report.txt') => ({
  id, message: caption,
  media: Object.assign(new Api.MessageMediaDocument({
    document: new Api.Document({
      attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
      mimeType: 'text/plain', size: 5,
      thumbs: [new Api.PhotoSize({ type: 'm', size: 4, w: 160, h: 90 }),
        new Api.PhotoSize({ type: 'b', size: 9, w: 320, h: 320 })]
    }),
    ...fields
  }), { fixtureMessageId: id })
});
const photo = (id, caption) => ({
  id, message: caption,
  media: new Api.MessageMediaPhoto({
    photo: new Api.Photo({ id, sizes: [new Api.PhotoSize({ type: 'm', size: 4, w: 160, h: 90 })] })
  })
});

let channel = privateChannel;
let checkCount = 0;
let uploadCount = 0;
let sendCount = 0;
let downloadCount = 0;
let historyFetches = 0;
let messageLookups = 0;
let staleThumbnailReference;
let publishChannel = privateChannel;
let expiredRange = false;
let expiredSave = false;
let loseUploadResponse = false;
let unacknowledged;
const records = new Map();
const edits = [];
const forwards = [];
const deletions = [];
const largeImageSize = 12_687_770;
const jpegThumb = Buffer.from([255, 216, 255, 217]);
const uploadedThumb = new Api.InputFile({ name: 'thumb.jpg' });
const largeImage = attachment(99, {}, '', 'MVIMG_20220821_074212.jpg');
Object.assign(largeImage.media.document, { id: 9900, mimeType: 'application/octet-stream', size: largeImageSize, thumbs: undefined });
records.set(99, largeImage);
const mock = TelegramClient.prototype;
let connections = 0;
let connectedClient;
const connectionTimes = [];
const requests = [];
mock.connect = async function () { connections++; connectedClient = this; connectionTimes.push(Date.now()); };
mock.getMe = async () => ({ id: 401, firstName: 'Fixture' });
mock.invoke = async request => {
  requests.push({ request, at: Date.now() });
  if (request.flood && requests.filter(entry => entry.request === request).length === 1) {
    throw Object.assign(new Error('Wait'), { errorMessage: 'FLOOD_WAIT_1' });
  }
  return true;
};
const parts = [];
FileTransfers.prototype.send = async (sender, slot, request) => {
  parts.push(Date.now());
  if (parts.length === 1) throw Object.assign(new Error('Wait'), { errorMessage: 'FLOOD_PREMIUM_WAIT_1' });
  return true;
};
mock.iterDialogs = async function* () {
  yield dialog('private', privateChannel);
  yield dialog('public', publicChannel);
  yield dialog('alternate-public', alternatePublic);
  yield dialog('readonly', readonly);
  for (let i = 0; i < 96; i++) yield dialog('group-' + i, new Api.Chat());
  yield dialog('writable', writable);
};
mock.getEntity = async peer => {
  assert.equal(peer.id, 'private');
  checkCount++;
  return channel;
};
mock.getMessages = async (peer, options) => {
  assert.equal(peer.id, 'private');
  if (options.ids) {
    messageLookups++;
    return options.ids.map(id => {
      if (records.has(id)) return records.get(id);
      const message = attachment(id);
      if (id === 500) message.media.document.size = 2_000_000_000;
      if (id === 501) message.media.document.thumbs = [new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from([1, 2, 3, 4]) })];
      if (id === 502) {
        message.media.document.size = 2_000_000_000;
        message.media.document.thumbs = [new Api.PhotoSizeProgressive({ type: 'p', sizes: [2, 4] })];
      }
      if (id === 503) {
        message.media.document.size = 2_000_000_000;
        message.media.document.thumbs = [];
        message.media.videoCover = new Api.Photo({ id: 7, sizes: [new Api.PhotoSize({ type: 'm', size: 4 })] });
      }
      if (id === 504) message.media.document.thumbs = [new Api.PhotoSize({ type: 'b', size: 4, w: 320, h: 320 })];
      return message;
    });
  }
  historyFetches++;
  if (options.offsetId) {
    assert.equal(options.offsetId, 52);
    return [attachment(51, { ttlSeconds: 30 }), attachment(50, {}, 'Folder^asdf^papka^&.png'),
      attachment(49, {}, '', 'Folder^0.mp4'), attachment(48, {}, 'report.txt'), attachment(47, {}, '\\', 'a^b.txt'),
      photo(46, 'Вот такой ствол'), attachment(45, {}, 'Вечер с лего', 'lego.mp4'),
      photo(44, 'lego.jpg'), photo(43, 'Album^2024^shot.jpg'),
      attachment(42, {}, 'Old/Folder'), attachment(41, {}, '\\A^B', 'a^b.txt'),
      { ...attachment(40), ttlPeriod: 60 }];
  }
  assert.equal(options.limit, 51);
  staleThumbnailReference = attachment(101);
  staleThumbnailReference.media.document.thumbs.push(new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from([1, 18, 32, 4]) }));
  const head = Array.from({ length: 51 }, (_, i) => i === 0 ? staleThumbnailReference :
    records.get(101 - i) || { id: 101 - i });
  return unacknowledged ? [unacknowledged, ...head].slice(0, 51) : head;
};
mock.sendMessage = async (peer, request) => {
  assert.equal(peer.id, 'private');
  const message = { id: 100, message: request.message };
  records.set(message.id, message);
  return message;
};
mock.editMessage = async (peer, request) => {
  assert.equal(peer.id, 'private');
  edits.push(request);
  const edited = { ...records.get(request.message), message: request.text, entities: request.formattingEntities };
  records.set(edited.id, edited);
  return edited;
};
mock.forwardMessages = async (target, { messages, fromPeer }) => {
  assert.equal(target.id, 'group-0');
  assert.equal(fromPeer.id, 'private');
  forwards.push([...messages]);
  return messages.map(id => ({ id }));
};
mock.deleteMessages = async (peer, ids, { revoke }) => {
  assert.equal(peer.id, 'private');
  assert.equal(revoke, true);
  deletions.push([...ids]);
};
mock.downloadMedia = async (message, options) => {
  downloadCount++;
  const id = message.id ?? message.fixtureMessageId;
  if (id === 111) {
    assert.equal(options.thumb, 'm');
    return jpegThumb;
  }
  if (message instanceof Api.Photo) {
    assert.equal(message.id, 7);
    assert.equal(options.thumb, 'm');
    return Buffer.from('post');
  }
  if (id === 501) {
    assert.equal(options.thumb, 'i');
    return Buffer.from('decoded JPEG');
  }
  if (id === 504) {
    assert.equal(options.thumb, 'b');
    return Buffer.from('crop');
  }
  if (id === 99) {
    assert.equal(options.thumb === undefined || options.thumb === 'm', true);
    return options.thumb === 'm' ? Buffer.alloc(1) : Buffer.alloc(largeImageSize, 42);
  }
  assert.equal(id, 101);
  if (message === staleThumbnailReference.media && staleThumbnailReference.expired) {
    throw Object.assign(new Error('Expired media reference'), { errorMessage: 'FILE_REFERENCE_EXPIRED' });
  }
  return Buffer.from(options.thumb === 'm' ? 'mini' : 'hello');
};
const block = Buffer.alloc(512 * 1024, 41);
const saveBlock = Buffer.alloc(1024 * 1024, 73);
mock.iterDownload = async function* (message, options) {
  if (message instanceof Api.InputDocumentFileLocation) {
    assert.equal(message.thumbSize, 'p');
    assert.equal(options.limit, 4);
    yield Buffer.from('mini');
    return;
  }
  assert.equal(message.id, 500);
  if (options.offset === 1_900_000_000 && !expiredRange) {
    expiredRange = true;
    throw Object.assign(new Error('Expired'), { errorMessage: 'FILE_REFERENCE_EXPIRED' });
  }
  if (options.limit <= block.length) {
    assert.equal(options.requestSize, block.length);
    yield block;
    return;
  }
  assert.equal(options.requestSize, saveBlock.length);
  if (!expiredSave) {
    assert.equal(options.offset, 0);
    yield block;
    yield block;
    expiredSave = true;
    throw Object.assign(new Error('Expired'), { errorMessage: 'FILE_REFERENCE_EXPIRED' });
  }
  assert.equal(options.offset, saveBlock.length);
  for (let length = options.limit; length > 0; length -= saveBlock.length) yield saveBlock;
};
mock.uploadFile = async ({ file, onProgress, workers }) => {
  uploadCount++;
  if (file.name === 'thumb.jpg') {
    assert.equal(workers, 1);
    assert.equal(file.size, jpegThumb.length);
    assert.deepEqual(Buffer.from(await file.readRange(0, file.size)), jpegThumb);
    return uploadedThumb;
  }
  const large = file.size === 16 * 1024 * 1024;
  assert.equal(file.preferLargeParts, large);
  assert.equal(workers, large ? 4 : 2);
  assert.equal(Buffer.from(await file.readRange(0, 5)).toString(), 'hello');
  channel = publishChannel;
  onProgress(1);
  return new Api.InputFile({ name: file.name });
};
mock.sendFile = async (peer, request) => {
  sendCount++;
  assert.equal(peer.id, 'private');
  assert.ok(request.file instanceof Api.InputMediaUploadedDocument);
  assert.equal(request.file.forceFile, true);
  if (request.file.attributes[0].fileName === 'upload.jpg') {
    assert.equal(request.file.file.name, 'upload.jpg');
    assert.equal(request.file.thumb, uploadedThumb);
    assert.equal(request.caption, 'New^Folder^upload.jpg');
    const message = attachment(111, {}, request.caption, 'upload.jpg');
    Object.assign(message.media.document, { mimeType: 'image/jpeg', size: largeImageSize,
      thumbs: [new Api.PhotoSize({ type: 'm', size: jpegThumb.length, w: 320, h: 180 })] });
    records.set(111, message);
    return message;
  }
  assert.equal(request.caption, 'New^Folder^report.txt');
  assert.equal(request.file.thumb, undefined);
  assert.equal(request.file.attributes[0].fileName, 'report.txt');
  if (loseUploadResponse) {
    unacknowledged = { ...attachment(110), message: request.caption };
    throw new Error('Acknowledgement lost');
  }
  return { ...attachment(102), message: request.caption };
};

(async () => {
  const client = host.window.MiniAppTelegram.createClient({ apiId: 1, apiHash: 'a'.repeat(32) });
  try {
    const first = await client.cloudChannels(true);
    assert.equal(first.items.map(item => item.id).join(), 'private');
    assert.equal(first.more, true);
    const rest = await client.cloudChannels(false);
    assert.equal(rest.items.map(item => item.id).join(), 'writable');
    assert.equal(rest.more, false);
    await assert.rejects(client.cloudFiles('public'), /CHANNEL_NOT_LOADED/);
    const [files, samePage] = await Promise.all([client.cloudFiles('private'), client.cloudFiles('private')]);
    assert.equal(samePage.items[0].id, files.items[0].id);
    assert.equal(historyFetches, 1);
    assert.equal(files.items.length, 2);
    assert.equal(files.items[0].name, 'report.txt');
    assert.equal(files.items[0].caption, 'Old\\Folder');
    assert.equal(files.items[0].folder, 'Old/Folder');
    assert.equal(files.items[0].thumbnail.width, 160);
    assert.equal(files.items[0].thumbnail.height, 90);
    const largeImageFile = files.items.find(item => item.id === 99);
    assert.equal(largeImageFile.thumbnail.mimeType, 'image/jpeg');
    assert.equal(largeImageFile.thumbnail.resize, true);
    assert.equal(files.next, 52);
    const older = await client.cloudFiles('private', files.next);
    assert.equal(older.items.map(item => [item.id, item.folder, item.name].join(':')).join(),
      '50:Folder/asdf/papka:&.png,49:Folder:0.mp4,48::report.txt,47::a^b.txt,46::photo-46.jpg,' +
      '45::lego.mp4,44::lego.jpg,43:Album/2024:shot.jpg,42:Old/Folder:report.txt,41:A^B:a^b.txt');
    assert.equal(older.items.find(item => item.id === 46).caption, 'Вот такой ствол');
    assert.equal(older.next, undefined);
    assert.equal((await client.cloudFiles('private', files.next)).items.length, older.items.length);
    assert.equal(historyFetches, 2);
    await assert.rejects(client.cloudDownload('private', 101, 4), /CLOUD_FILE_TOO_LARGE/);
    channel = makeChannel({ creator: true, noforwards: true });
    await assert.rejects(client.cloudDownload('private', 101, 5, true), /CLOUD_FILE_PROTECTED/);
    assert.equal(downloadCount, 0);
    assert.equal((await client.cloudDownload('private', 101, 5)).bytes.toString(), 'hello');
    const reference = files.items[0];
    assert.equal(reference.inlineThumbnail.complete, false);
    assert.deepEqual([...reference.inlineThumbnail.bytes.subarray(0, 2)], [255, 216]);
    const lookups = messageLookups;
    const thumbnail = await client.cloudThumbnail('private', 101, undefined, reference);
    assert.equal(thumbnail.bytes.toString(), 'mini');
    assert.equal(thumbnail.mimeType, 'image/jpeg');
    assert.equal(messageLookups, lookups);
    staleThumbnailReference.expired = true;
    assert.equal((await client.cloudThumbnail('private', 101, undefined, reference)).bytes.toString(), 'mini');
    assert.equal((await client.cloudThumbnail('private', 101, undefined, reference)).bytes.toString(), 'mini');
    assert.equal(messageLookups, lookups + 1);
    assert.equal((await client.cloudThumbnail('private', 501)).bytes.toString(), 'decoded JPEG');
    assert.equal(Buffer.from((await client.cloudThumbnail('private', 502)).bytes).toString(), 'mini');
    assert.equal((await client.cloudThumbnail('private', 503)).bytes.toString(), 'post');
    assert.equal((await client.cloudThumbnail('private', 504)).bytes.toString(), 'crop');
    const imageThumb = await client.cloudThumbnail('private', 99);
    assert.equal(imageThumb.bytes.length, largeImageSize);
    assert.equal(imageThumb.key, largeImageFile.thumbnailKey);
    assert.equal(imageThumb.resize, true);
    assert.equal((await client.cloudDownload('private', 99, 64 * 1024 * 1024)).bytes.length, largeImageSize);
    largeImage.media.document.thumbs = [new Api.PhotoSize({ type: 'm', size: 1, w: 160, h: 90 })];
    assert.equal((await client.cloudThumbnail('private', 99)).bytes.length, 1);
    largeImage.media.document.thumbs = [new Api.PhotoSize({ type: 'm', size: 12, w: 160, h: 90 })];
    assert.equal((await client.cloudThumbnail('private', 99)).bytes.length, largeImageSize);
    largeImage.media.document.thumbs = undefined;
    largeImage.media.document.size = 32 * 1024 * 1024 + 1;
    const calls = downloadCount;
    assert.equal(await client.cloudThumbnail('private', 99), undefined);
    assert.equal(downloadCount, calls);
    largeImage.media.document.size = largeImageSize;
    await assert.rejects(client.cloudOpenFile('private', 500, true), /CLOUD_FILE_PROTECTED/);
    channel = privateChannel;
    const large = await client.cloudOpenFile('private', 500, true);
    assert.equal(large.size, 2_000_000_000);
    assert.equal((await large.read(1_900_000_000, 7)).length, 7);
    assert.ok(expiredRange);
    await assert.rejects(large.read(2_000_000_000, 1), /CLOUD_FILE_RANGE/);
    let count = 0;
    let total = 0;
    for await (const chunk of large.chunks()) {
      assert.ok(chunk.length > 0 && chunk.length <= saveBlock.length);
      assert.equal(chunk[0], total < saveBlock.length ? 41 : 73);
      count++;
      total += chunk.length;
    }
    assert.equal(total, 2_000_000_000);
    assert.equal(count, Math.ceil(total / saveBlock.length) + 1);
    const input = new File(['hello'], 'report.txt', { type: 'text/plain' });
    const before = checkCount;
    await assert.rejects(client.cloudUpload('private', { size: 2_000_000_001 }, '', () => {}), /CLOUD_UPLOAD_SIZE/);
    const uploaded = await client.cloudUpload('private', input, 'New/Folder', () => {});
    assert.equal(uploaded.id, 102);
    assert.equal(uploaded.folder, 'New/Folder');
    assert.equal(checkCount - before, 2);
    publishChannel = publicChannel;
    await assert.rejects(client.cloudUpload('private', input, 'New/Folder', () => {}), /CLOUD_CHANNEL_UNAVAILABLE/);
    assert.equal(uploadCount, 2);
    assert.equal(sendCount, 1);
    channel = privateChannel;
    publishChannel = privateChannel;
    await client.cloudUpload('private', {
      name: input.name, size: 16 * 1024 * 1024, readRange: async () => Buffer.from('hello')
    }, 'New/Folder', () => {});
    assert.equal(host.window.MiniAppTelegram.supportsCloudActions, true);
    await assert.rejects(client.cloudCreateFolder('private', 'Parent/../Child'), /CLOUD_INVALID_NAME/);
    assert.equal(await client.cloudCreateFolder('private', 'Parent/Empty^Child'), 'Parent/Empty^Child');
    assert.equal((await client.cloudFiles('private')).folders.join(), 'Parent/Empty^Child');
    assert.equal(historyFetches, 2);
    const originalCaption = '[MiniApps file v1] ordinary text';
    records.set(99, { ...attachment(99, {}, originalCaption), entities: [new Api.MessageEntityBold({ offset: 18, length: 8 })] });
    const renamed = await client.cloudEditFile('private', 99, { name: 'переименован^тест.txt' });
    assert.equal(renamed.name, 'переименован^тест.txt');
    const moved = await client.cloudEditFile('private', 99, { folder: 'Parent/Empty^Child' });
    assert.equal(moved.folder, 'Parent/Empty^Child');
    assert.equal(moved.name, renamed.name);
    assert.equal(moved.caption.split('\n')[1], originalCaption);
    assert.equal(edits[1].formattingEntities[0].offset, edits[1].text.indexOf('\n') + 19);
    const chatList = await client.chats(true);
    assert.ok(chatList.items.some(item => item.id === 'group-0'));
    await client.cloudForwardFiles('private', [99, 101], 'group-0');
    assert.deepEqual(forwards, [[99, 101]]);
    channel = makeChannel({ creator: true, noforwards: true });
    await assert.rejects(client.cloudForwardFiles('private', [99, 101], 'group-0'), /CLOUD_FILE_PROTECTED/);
    assert.equal(forwards.length, 1);
    await assert.rejects(client.cloudDeleteFiles('private', [99, 100]), /CLOUD_FILE_MISSING/);
    assert.equal(deletions.length, 0);
    records.set(98, new Api.MessageEmpty({ id: 98 }));
    await client.cloudDeleteFiles('private', [98, 99, 101]);
    assert.deepEqual(deletions, [[99, 101]]);
    channel = privateChannel;
    loseUploadResponse = true;
    await assert.rejects(client.cloudUpload('private', input, 'New/Folder', () => {}), /Acknowledgement lost/);
    const recovered = await client.cloudFiles('private');
    assert.ok(recovered.items.some(file => file.id === 110));
    assert.equal(recovered.next, files.next);
    await client.cloudFiles('private', recovered.next);
    assert.equal(historyFetches, 3);
    const beforePhoto = { uploads: uploadCount, sends: sendCount };
    const photoFile = await client.cloudUpload('private', {
      name: 'upload.jpg', type: 'image/jpeg', size: largeImageSize,
      readRange: async () => Buffer.from('hello'), thumbnail: new Blob([jpegThumb], { type: 'image/jpeg' })
    }, 'New/Folder', () => {});
    assert.equal(uploadCount, beforePhoto.uploads + 2);
    assert.equal(sendCount, beforePhoto.sends + 1);
    assert.equal(photoFile.size, largeImageSize);
    assert.equal(photoFile.thumbnail.width, 320);
    assert.deepEqual((await client.cloudThumbnail('private', photoFile.id)).bytes, jpegThumb);
    console.log('PASS: cloud folders and file actions, thumbnail variants, protected save, expired reference, exact 2 GB download and upload');
  } finally {
    await client.close();
  }

  let held;
  let persisted = 0;
  const savedNotices = [];
  function bridgeFor(owner) {
    return { functions: { async call(method, parameters) {
      if (method === 'telegram.acquire') {
        if (held) throw Object.assign(new Error('Busy'), { code: 'telegram_session_busy' });
        held = owner;
        return persisted;
      }
      assert.ok(parameters.owner);
      if (method === 'telegram.serviceNotices') {
        assert.equal(parameters.accountId, '401');
        if (parameters.notice) savedNotices.push(parameters.notice);
        return savedNotices;
      }
      assert.equal(held, owner);
      if (method === 'telegram.setWaitUntil') persisted = parameters.until;
      else {
        assert.equal(method, 'telegram.release');
        held = undefined;
      }
    } } };
  }
  let waited;
  let notice;
  host.window.mini = bridgeFor('first');
  const first = host.window.MiniAppTelegram.createClient({
    apiId: 1, apiHash: 'a'.repeat(32), onFloodWait: until => { waited = until; }, onServiceNotice: value => { notice = value; }
  });
  await first.resume();
  host.window.mini = bridgeFor('second');
  const second = host.window.MiniAppTelegram.createClient({ apiId: 1, apiHash: 'a'.repeat(32) });
  await assert.rejects(second.resume(), { code: 'telegram_session_busy' });
  assert.equal(connections, 1);
  await second.close();
  assert.equal(held, 'first');

  const raw = connectedClient;
  const waitNotice = raw.listEventHandlers()[0][1];
  waitNotice(new Api.UpdateServiceNotification({ type: 'fixture', message: 'Telegram notice', popup: true }));
  assert.equal(notice?.text, 'Telegram notice');
  assert.equal((await first.messages('777000')).items[0].text, 'Telegram notice');
  const rpc = { flood: true };
  const sending = raw.invoke(rpc);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(waited > Date.now());
  assert.equal(persisted, waited);
  const concurrent = raw.invoke({ flood: false });
  const cancelled = new AbortController();
  const aborted = raw.invoke({ flood: false }, undefined, { signal: cancelled.signal });
  cancelled.abort();
  await assert.rejects(aborted, /operation_cancelled/);
  await Promise.all([sending, concurrent]);
  assert.equal(requests.filter(entry => entry.request === rpc).length, 2);
  assert.ok(requests.slice(1).every(entry => entry.at >= waited));

  const media = raw._files.send({}, {}, {}, undefined);
  await new Promise(resolve => setImmediate(resolve));
  const mediaDeadline = waited;
  assert.ok(mediaDeadline > Date.now());
  await media;
  assert.ok(parts[1] >= mediaDeadline);
  const stopped = assert.rejects(raw.invoke({ flood: true }), /operation_cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  const reopenDeadline = persisted;
  assert.ok(reopenDeadline > Date.now());
  await first.close();
  await stopped;
  assert.equal(held, undefined);
  host.window.mini = bridgeFor('next');
  const next = host.window.MiniAppTelegram.createClient({ apiId: 1, apiHash: 'a'.repeat(32) });
  await next.resume();
  assert.equal(connections, 2);
  assert.ok(connectionTimes[1] >= reopenDeadline);
  assert.equal((await next.messages('777000')).items[0].text, 'Telegram notice');
  await next.close();
  console.log('PASS: shared history requests, TTL, native lease before connect, RPC and media flood deadlines, cancellation and handoff');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

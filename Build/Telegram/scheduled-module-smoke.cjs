const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const dependency = createRequire(path.resolve(__dirname, '../../Cache/Telegram/module/build-module.cjs'));
const { Api, TelegramClient, helpers, utils } = dependency('teleproto');
const { RPCMessageToError } = dependency('teleproto/errors');
const { buildSync } = dependency('esbuild');
const { outputFiles: [entry] } = buildSync({
  entryPoints: [path.join(__dirname, 'telegram.js')],
  bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false
});
const host = { window: {}, require: dependency, AbortController, setTimeout, clearTimeout };
vm.runInNewContext(entry.text, host);

const long = value => helpers.returnBigInt(value);
const userId = id => new Api.PeerUser({ userId: long(id) });
const groupId = id => new Api.PeerChat({ chatId: long(id) });
const rpcError = (request, code, name) => RPCMessageToError(new Api.RpcError({ errorCode: code, errorMessage: name }), request);
const scheduledDate = Math.floor(Date.now() / 1000) + 600;
const nextDate = scheduledDate + 86_400;
const textMessage = (peerId, id, message, date = scheduledDate) => new Api.Message({ peerId, id, message, date });
const user = id => ({ id, title: 'User ' + id, entity: new Api.User({ id: long(id) }),
  inputEntity: new Api.InputPeerUser({ userId: long(id), accessHash: long(1) }) });
const group = id => ({ id: -id, title: 'Group ' + id, entity: new Api.Chat({ id: long(id) }),
  inputEntity: new Api.InputPeerChat({ chatId: long(id) }) });
const chatKey = input => input instanceof Api.InputPeerSelf ? '42' : String(utils.getPeerId(input));
const queued = new Map([
  ['2', [textMessage(userId(2), 10, 'From official Telegram')]],
  ['-3', [textMessage(groupId(3), 10, 'Same id in another chat')]]
]);
const folderReads = [];
const requests = [];
const uploads = [];
let mutation;
let rawUpdate;
let nextId = 100;

TelegramClient.prototype.connect = async () => {};
TelegramClient.prototype.getMe = async () => ({ id: long(42), firstName: 'Fixture' });
TelegramClient.prototype.destroy = async () => {};
TelegramClient.prototype.addEventHandler = handler => { rawUpdate = handler; };
TelegramClient.prototype.iterDialogs = async function* ({ archived }) {
  folderReads.push(archived);
  if (archived) yield group(3);
  else {
    yield user(2);
    yield user(777000);
    yield user(4);
  }
};
TelegramClient.prototype.uploadFile = async ({ file, workers }) => {
  assert.equal(workers, 1);
  assert.equal((await file.readRange(0, file.size)).byteLength, file.size);
  uploads.push(file.name);
  return new Api.InputFile({ id: long(uploads.length), parts: 1, name: file.name, md5Checksum: '' });
};
TelegramClient.prototype.invoke = async (request, dcId, options) => {
  requests.push({ request, options, at: Date.now() });
  assert.ok(request.getBytes().byteLength > 4);
  const key = chatKey(request.peer);
  const history = queued.get(key) ?? [];
  if (request instanceof Api.messages.GetScheduledHistory) {
    if (request.hash.toString() !== '0' && key === '2') return new Api.messages.MessagesNotModified({ count: history.length });
    return new Api.messages.Messages({ messages: history, chats: [], users: [] });
  }
  if (request instanceof Api.messages.UploadMedia) {
    assert.equal(key, '42');
    assert.equal(request.media.mimeType, 'text/plain');
    return new Api.MessageMediaDocument({ document: new Api.Document({
      id: request.media.file.id, accessHash: long(9), fileReference: Buffer.from([9]),
      attributes: request.media.attributes
    }) });
  }
  if (request instanceof Api.messages.DeleteScheduledMessages) {
    const removed = history.filter(message => request.id.includes(message.id));
    queued.set(key, history.filter(message => !request.id.includes(message.id)));
    if (!removed.length) return { updates: [] };
    return new Api.UpdateShort({ date: 0, update: new Api.UpdateDeleteScheduledMessages({
      peer: key.startsWith('-') ? groupId(3) : userId(Number(key)),
      messages: removed.map(message => message.id)
    }) });
  }
  assert.ok([scheduledDate, nextDate].includes(request.scheduleDate));
  assert.equal(options.maxRetryCount, 0);
  assert.equal(options.timeout, 12_000);
  const failure = mutation?.(request, key);
  if (failure) throw failure;
  const media = request.multiMedia ?? [request];
  const albumId = long(nextId + 500);
  const messages = media.map(part => {
    const peer = key.startsWith('-') ? groupId(3) : userId(Number(key));
    const message = textMessage(peer, nextId++, part.message, request.scheduleDate);
    if (part.media) {
      const name = uploads[Number(part.media.id.id) - 1];
      message.media = new Api.MessageMediaDocument({
        document: new Api.Document({ attributes: [new Api.DocumentAttributeFilename({ fileName: name })] })
      });
    }
    if (media.length > 1) message.groupedId = albumId;
    return message;
  });
  queued.set(key, history.concat(messages));
  return { updates: messages.map(message => new Api.UpdateNewScheduledMessage({ message })) };
};

(async () => {
  const waits = [];
  const changes = [];
  const client = host.window.MiniAppTelegram.createClient({
    apiId: 1, apiHash: 'fixture', onFloodWait: until => waits.push(until), onScheduledChange: id => changes.push(id)
  });
  try {
    await client.resume();
    const chatIds = [...await client.scheduleChats()].map(chat => chat.id);
    assert.deepEqual(chatIds, ['42', '2', '4', '-3']);
    await client.scheduleChats();
    assert.deepEqual(folderReads, [false, true]);
    const initial = await client.scanScheduled();
    assert.deepEqual([...initial.rows].map(row => row.chat.id), ['2', '-3']);
    const initialRequests = requests.length;
    await client.scanScheduled();
    assert.equal(requests.length, initialRequests);
    const preserved = await client.scheduledInChat('2', true);
    assert.equal(preserved[0].text, 'From official Telegram');
    assert.notEqual(requests.at(-1).request.hash.toString(), '0');

    const files = ['one.txt', 'two.txt'].map(name => ({
      name, size: 4, mimeType: 'text/plain', readRange: async () => new Uint8Array([1, 2, 3, 4])
    }));
    const deliveries = [
      { chatId: '2', date: nextDate }, { chatId: '-3', date: nextDate },
      { chatId: '2', date: scheduledDate }, { chatId: '-3', date: scheduledDate }
    ];
    const beforeInvalid = requests.length;
    await assert.rejects(client.createScheduledBatch({
      deliveries: [deliveries[0], deliveries[0]], text: 'Caption', files
    }), /SCHEDULE_DUPLICATE_DAY/);
    await assert.rejects(client.createScheduledBatch({
      deliveries: Array.from({ length: 31 }, (_, index) => ({ chatId: '2', date: scheduledDate + index })),
      text: 'Caption', files
    }), /SCHEDULE_DELIVERY_LIMIT/);
    assert.equal(requests.length, beforeInvalid);
    assert.equal(uploads.length, 0);
    const album = await client.createScheduledBatch({ deliveries, text: 'Caption', files });
    assert.deepEqual([...album].map(({ chatId, date, state }) => [chatId, date, state]), [
      ['2', scheduledDate, 'scheduled'], ['-3', scheduledDate, 'scheduled'],
      ['2', nextDate, 'scheduled'], ['-3', nextDate, 'scheduled']
    ]);
    assert.deepEqual(uploads, ['one.txt', 'two.txt']);
    const sends = requests.filter(entry => entry.request instanceof Api.messages.SendMultiMedia);
    assert.equal(sends.length, 4);
    assert.deepEqual(sends.map(({ request }) => [chatKey(request.peer), request.scheduleDate]), [
      ['2', scheduledDate], ['-3', scheduledDate], ['2', nextDate], ['-3', nextDate]
    ]);
    assert.ok(sends.every(({ request }) => request.scheduleRepeatPeriod == null));
    assert.equal(sends[0].request.multiMedia[0].message, 'Caption');
    assert.equal(sends[0].request.multiMedia[1].message, '');
    assert.ok(sends[1].at - sends[0].at >= 1000);
    assert.notEqual(String(sends[0].request.multiMedia[0].randomId), String(sends[1].request.multiMedia[0].randomId));
    const grouped = client.cachedScheduled().find(row => row.chat.id === '2').messages.find(message => message.text === 'Caption');
    assert.deepEqual([...grouped.files], ['one.txt', 'two.txt']);
    assert.equal(await client.cancelScheduled('2', grouped.ids), 2);
    assert.equal(queued.get('2').length, 3);
    assert.equal(queued.get('-3').length, 5);
    assert.equal(await client.cancelScheduled('2', grouped.ids), 0);

    rawUpdate(new Api.UpdateDeleteScheduledMessages({ peer: groupId(3), messages: [10], sentMessages: [63] }));
    assert.ok(changes.includes('-3'));
    assert.ok(!client.cachedScheduled().find(row => row.chat.id === '-3').messages.some(message => message.ids.includes(10)));

    mutation = (request, key) => key === '2' ? rpcError(request, 400, 'SCHEDULE_TOO_MUCH') : undefined;
    const beforePartial = requests.length;
    const batchPartial = await client.createScheduledBatch({
      deliveries: [{ chatId: '2', date: scheduledDate }, { chatId: '2', date: nextDate }, { chatId: '4', date: nextDate }],
      text: 'Text', files: []
    });
    assert.deepEqual([...batchPartial].map(outcome => outcome.state), ['failed', 'failed', 'scheduled']);
    assert.deepEqual(requests.slice(beforePartial).map(({ request }) => chatKey(request.peer)), ['2', '4']);
    const partial = await client.createScheduled({ chatIds: ['2', '4'], text: 'Text', date: scheduledDate, files: [] });
    assert.deepEqual([...partial].map(outcome => outcome.state), ['failed', 'scheduled']);
    assert.ok(requests.at(-1).request instanceof Api.messages.SendMessage);

    const beforeAuthLoss = [];
    mutation = (request, key) => key === '4' ? rpcError(request, 401, 'AUTH_KEY_UNREGISTERED') : null;
    await assert.rejects(client.createScheduledBatch({
      deliveries: [{ chatId: '2', date: nextDate }, { chatId: '4', date: nextDate }],
      text: 'Auth loss after confirmation', files: [],
      onOutcome: outcome => beforeAuthLoss.push(outcome)
    }), error => error.code === 401);
    assert.deepEqual(beforeAuthLoss.map(({chatId,state}) => [chatId,state]), [['2','scheduled'],['4','failed']]);
    assert.equal(queued.get('2').filter(message => message.message === 'Auth loss after confirmation').length, 1);
    mutation = () => new Error('Connection lost after dispatch');
    const uncertain = await client.createScheduled({ chatIds: ['2', '4'], text: 'Text', date: scheduledDate, files: [] });
    assert.deepEqual([...uncertain].map(outcome => outcome.state), ['uncertain']);

    let slowmode = true;
    mutation = request => {
      if (!slowmode) return;
      slowmode = false;
      return rpcError(request, 420, 'SLOWMODE_WAIT_1');
    };
    const retried = await client.createScheduled({ chatIds: ['2'], text: 'Wait and retry', date: scheduledDate, files: [] });
    assert.equal(retried[0].state, 'scheduled');
    const [first, second] = requests.slice(-2);
    assert.equal(first.request, second.request);
    assert.ok(second.at - first.at >= 1000);

    mutation = request => rpcError(request, 420, 'FLOOD_WAIT_900');
    const floodStart = requests.length;
    const limited = await client.createScheduled({ chatIds: ['2', '4'], text: 'Text', date: scheduledDate, files: [] });
    assert.equal(limited[0].code, 'SCHEDULE_LEAD_TIME');
    assert.equal(requests.length, floodStart + 1);
    assert.ok(waits.at(-1) > Date.now() + 899_000);
    await assert.rejects(client.createScheduled({ chatIds: ['2'], text: 'Text', date: scheduledDate, files: [] }),
      /SCHEDULE_LEAD_TIME/);
    assert.equal(requests.length, floodStart + 1);
    const controller = new AbortController();
    const pending = client.scanScheduled({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /operation_cancelled/);
  } finally {
    await client.close();
  }

  const restricted = host.window.MiniAppTelegram.createClient({ apiId: 1, apiHash: 'fixture' });
  try {
    await restricted.resume();
    await restricted.scheduleChats();
    mutation = request => rpcError(request, 400, 'PEER_FLOOD');
    const before = requests.length;
    const outcomes = await restricted.createScheduled({ chatIds: ['2', '4'], text: 'Text', date: scheduledDate, files: [] });
    assert.deepEqual([...outcomes].map(outcome => outcome.code), ['PEER_FLOOD']);
    await assert.rejects(restricted.createScheduled({ chatIds: ['2'], text: 'Text', date: scheduledDate, files: [] }), /PEER_FLOOD/);
    assert.equal(requests.length, before + 1);
  } finally {
    await restricted.close();
  }
  console.log('Scheduled Telegram module smoke passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const dependency = createRequire(path.resolve(__dirname, '../../Cache/Telegram/module/build-module.cjs'));
const { Api, TelegramClient } = dependency('teleproto');
const { buildSync } = dependency('esbuild');
const { outputFiles: [entry] } = buildSync({
  entryPoints: [path.join(__dirname, 'telegram.js')],
  bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false
});
const host = {
  window: {}, require: dependency, AbortController, TextEncoder, TextDecoder,
  setTimeout, clearTimeout
};
vm.runInNewContext(entry.text, host);

test('shopping transport searches by hashtag and deletes only unchanged verified snapshots', async () => {
  const tag = '#miniapps_shopping_list';
  const caption = tag + '\nMiniApps Shopping Purchases v2';
  const fileName = 'miniapps-shopping-list.json';
  const inputEntity = new Api.InputPeerChannel({ channelId: 5, accessHash: 6 });
  const entity = new Api.Channel({ id: 5, broadcast: true, creator: true });
  const title = 'Private channel';
  const session = '1' + Buffer.concat([
    Buffer.from([2, 0, 9]), Buffer.from('127.0.0.1'), Buffer.from([1, 187]), Buffer.alloc(256, 7)
  ]).toString('base64');
  const records = new Map();
  const deleted = [];
  let searchTerm;
  let published;
  let downloaded = 0;
  let ttlPeriod;
  let dialogReads = 0;
  let entityReads = 0;
  let fullReads = 0;
  let configReads = 0;
  let rejectedHint = false;
  let includeChannel = true;
  const attachment =  '{"version":2,"scope":"purchases","categories":{},"products":{},"aliases":{"categories":{},"products":{}}}';

  function document(id, message, name = fileName) {
    return { id, message, media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: id + 1000, size: Buffer.byteLength(attachment),
        attributes: [new Api.DocumentAttributeFilename({ fileName: name })]
      })
    }) };
  }

  records.set(1, document(1, caption));
  records.set(8, { ...document(8, caption), out: true });
  records.set(2, document(2, tag + ' shopping notes'));
  records.set(3, document(3, caption, 'unrelated.json'));
  records.set(9, { id: 9, message: tag + '\nMiniApps Shopping List v2\nold synchronization text', out: true });
  records.set(10, { ...document(10, tag + '\nMiniApps Shopping List v1'), out: true });

  const mock = TelegramClient.prototype;
  mock.connect = async function () { this._config = { captionLengthMax: 120 }; };
  mock.getMe = async () => ({ id: 7, firstName: 'Fixture' });
  mock.destroy = async () => {};
  mock.iterDialogs = async function* () {
    dialogReads++;
    yield { id: '-1005', entity, inputEntity, title };
  };
  mock.getEntity = async () => { entityReads++; return entity; };
  mock.invoke = async request => {
    if (request instanceof Api.help.GetConfig) { configReads++; return { captionLengthMax: 120 }; }
    assert(request instanceof Api.channels.GetFullChannel);
    assert(request.channel instanceof Api.InputChannel);
    fullReads++;
    if (String(request.channel.accessHash) === '999') {
      rejectedHint = true;
      throw { errorMessage: 'CHANNEL_INVALID' };
    }
    return { fullChat: { ttlPeriod }, chats: includeChannel ? [entity] : [] };
  };
  mock.getMessages = async (_, options) => {
    if (options.ids) return options.ids.flatMap(id => records.has(id) ? [records.get(id)] : []);
    if (options.search) searchTerm = options.search;
    return [...records.values()];
  };
  mock.uploadFile = async ({ file }) => {
    assert.equal(file.name, fileName);
    assert.equal(Buffer.from(file.readRange(0, file.size)).toString('utf8'), attachment);
    return new Api.InputFile({ name: fileName });
  };
  mock.sendFile = async (_, options) => {
    assert(options.file instanceof Api.InputMediaUploadedDocument);
    assert.equal(options.file.mimeType, 'application/json');
    assert.equal(options.formattingEntities[0].length, tag.length);
    assert.match(options.caption, /^#miniapps_shopping_list\nMiniApps Shopping Purchases v2\n✓ Яблоки\n☐ Хлеб\n…$/);
    assert(options.caption.length <= 120);
    const added = document(12, options.caption);
    added.out = true;
    added.media.document.size = Buffer.byteLength(attachment);
    published = options.caption;
    records.set(12, added);
    return added;
  };
  mock.downloadMedia = async () => { downloaded++; return Buffer.from(attachment); };
  mock.sendMessage = async () => assert.fail('Shopping synchronization sends attachments');
  mock.deleteMessages = async (_, ids, { revoke }) => {
    assert.equal(revoke, true);
    deleted.push(...ids);
    for (const id of ids) records.delete(id);
  };

  const makeClient = (saved = session) => host.window.MiniAppTelegram.createClient({ apiId: 99, apiHash: 'fixture', session: saved });
  const client = makeClient();
  try {
    await client.resume();
    const transport = await client.shoppingTransport('-1005');
    assert.equal(dialogReads, 1, 'Legacy settings discover the channel once');
    assert.equal(fullReads, 1);
    assert.equal(entityReads, 0, 'Full response already contains posting rights');
    assert.equal(transport.peerHint.channelId, '-1005');
    assert.equal(transport.peerHint.accessHash, '6');
    assert.match(transport.peerHint.scope, /^[a-f0-9]{64}$/);
    const rows = await transport.read();
    assert.equal(searchTerm, tag);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 1);
    assert.equal(rows[0].text, attachment);
    assert.equal(rows[0].owned, false);
    assert.equal(rows[1].owned, true);
    assert.equal(downloaded, 2, 'Unrelated and old formats never download an attachment');
    const keep = await transport.publishPurchases(attachment, ['✓ Яблоки', '☐ Хлеб', '☐ ' + 'Я'.repeat(150)]);
    assert.equal(keep, 12);
    assert.equal(configReads, 0, 'Telegram connect already fetched the server configuration');
    const next = makeClient();
    try {
      await next.resume();
      const warm = await next.shoppingTransport('-1005', transport.peerHint);
      assert.equal(dialogReads, 1, 'A fresh connection with a valid hint skips dialog discovery');
      assert.equal(fullReads, 2);
      assert.equal(entityReads, 0);
      const restored = (await warm.read()).find(row => row.id === keep);
      assert.equal(restored.text, attachment);
      entity.creator = false;
      await assert.rejects(next.shoppingTransport('-1005', transport.peerHint), /CLOUD_CHANNEL_UNAVAILABLE/);
      assert.equal(dialogReads, 1, 'A cached channel is still subject to fresh posting rights');
      entity.creator = true;
      const recovered = await next.shoppingTransport('-1005', { ...transport.peerHint, accessHash: '999' });
      assert.equal(recovered.peerHint.accessHash, '6');
      assert.equal(rejectedHint, true);
      assert.equal(dialogReads, 2, 'A rejected hint triggers discovery');
    } finally { await next.close(); }

    const otherLogin = makeClient(session.slice(0, -4) + 'CAgI');
    try {
      await otherLogin.resume();
      includeChannel = false;
      const fresh = await otherLogin.shoppingTransport('-1005', transport.peerHint);
      assert.notEqual(fresh.peerHint.scope, transport.peerHint.scope);
      assert.equal(dialogReads, 3, 'A different login cannot reuse a hint');
      assert.equal(entityReads, 1, 'Missing channel metadata uses the established fallback');
    } finally {
      includeChannel = true;
      await otherLogin.close();
    }

    assert.equal(await transport.remove([1], keep), 0, 'channel owners may only remove outgoing posts');
    assert.equal(deleted.length, 0);

    records.get(keep).editDate = 20;
    assert.equal(await transport.remove([8], keep), 0);
    assert.equal(deleted.length, 0);

    delete records.get(keep).editDate;
    records.get(keep).message = published.replace('Яблоки', 'Груши');
    assert.equal(await transport.remove([8], keep), 0, 'A changed retained post cannot authorize deletion');
    records.get(keep).message = published;
    assert.equal(await transport.remove([1, 2, 3, 8, 9, 10, keep], keep), 1);
    assert.deepEqual(deleted, [8]);
    assert.deepEqual([...records.keys()], [1, 2, 3, 9, 10, keep]);

    await assert.rejects(transport.publishPurchases('a'.repeat(1024 * 1024 + 1)), /SYNC_LIST_TOO_LARGE/);

    const huge = 'x'.repeat(1024 * 1024);
    for (let id = 20; id < 29; id++) {
      const item = document(id, caption);
      item.media.document.size = huge.length;
      records.set(id, item);
    }
    mock.downloadMedia = async message => {
      downloaded++;
      return Buffer.from(message.id >= 20 ? huge : attachment);
    };
    const budgeted = await client.shoppingTransport('-1005');
    const beforeBudget = downloaded;
    await assert.rejects(budgeted.read(() => {}), /SHOPPING_HISTORY_TOO_LARGE/);
    assert.ok(downloaded - beforeBudget < 11, 'The aggregate budget rejects before reading all documents');
    ttlPeriod = 86_400;
    await assert.rejects(client.shoppingTransport('-1005'), /SHOPPING_CHANNEL_UNAVAILABLE/);
  } finally {
    await client.close();
  }
});

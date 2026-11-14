const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sources = new Map();
const replies = new Map();
const saveBlockSize = 1024 * 1024;
let fallbackEncodes = 0;
const streamTimeouts = [];
let now = Date.now();
let streamDeadline;
const window = { addEventListener() {} };
function response(id, result) {
  window.__miniRuntimeResolve({ id, success: true, result });
}
function request(source, request, offset, length, waitUntil) {
  const result = new Promise(resolve => replies.set(request, resolve));
  window.__miniRuntimeEvent('streams.read', { source, request, offset, length, waitUntil });
  return result;
}
window.MiniRuntime = {
  postMessage(raw) {
    const { id, method, params } = JSON.parse(raw);
    if (method === 'streams.open') {
      sources.set(params.source, id);
      response(id, 'https://media.miniapp.local/test');
    } else if (method === 'streams.save') {
      sources.set(params.source, id);
    } else if (method === 'streams.saveInDirectory') {
      assert.equal(params.directoryId, 'selected-dir');
      assert.deepEqual(params.folders, ['subfolder']);
      request(params.source, 'folder-save', 0, saveBlockSize).then(async data => {
        assert.ok(Buffer.from(data, 'base64').equals(Buffer.alloc(saveBlockSize, 213)));
        assert.equal(await request(params.source, 'folder-tail', saveBlockSize, 3), 'YWJj');
        response(id, { name: params.suggestedName, sizeBytes: params.size });
      });
    } else if (method === 'streams.close') {
      const saved = sources.get(params.source);
      sources.delete(params.source);
      response(saved, null);
      response(id, null);
    } else if (method === 'streams.reply') {
      replies.get(params.request)(params.data);
      replies.delete(params.request);
      response(id, null);
    } else if (method === 'telegramCloud.getSavedChannel') {
      response(id, '-10042');
    } else if (method === 'telegramCloud.rememberChannel') {
      assert.equal(params.id, '-10075');
      response(id, null);
    } else throw new Error(method);
  }
};
const source = path.resolve(__dirname, '../../Code/Framework/shared/web/runtime.js');
const context = vm.createContext({
  window, AbortController, clearTimeout, Date: { now: () => now },
  setTimeout(callback, delay) {
    streamTimeouts.push(delay);
    const timer = setTimeout(callback, delay);
    if (delay <= 40_000) streamDeadline = () => { clearTimeout(timer); callback(); };
    return timer;
  },
  btoa(binary) { fallbackEncodes++; return btoa(binary); }
});

vm.runInContext(fs.readFileSync(source, 'utf8'), context);

async function run() {
  assert.equal(window.mini.telegramCloud, undefined);
  assert.equal(window.mini.telegramSession, undefined);
  assert.equal(await window.mini.functions.call('telegramCloud.getSavedChannel'), '-10042');
  assert.equal(await window.mini.functions.call('telegramCloud.rememberChannel', { id: '-10075' }), null);
  const stream = await window.mini.streams.open({ size: 2_000_000_000, mimeType: 'video/webm' }, async (offset, length) => {
    assert.equal(offset, 1_999_999_997);
    assert.equal(length, 3);
    const bytes = new Uint8Array([255, 128, 0]);
    bytes.toBase64 = undefined;
    return bytes;
  });
  assert.equal(await request('stream-1', 'seek', 1_999_999_997, 3), '/4AA');
  assert.equal(await request('stream-1', 'short', 1_999_999_997, 4), undefined);
  await stream.close();
  assert.equal(await request('stream-1', 'revoked', 1_999_999_997, 3), undefined);

  const controller = new AbortController();
  let aborted = false;
  const save = window.mini.streams.save({ size: 2_000_000_000, mimeType: 'application/zip', suggestedName: 'file.zip' },
    (offset, length, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
    }), controller.signal);
  const later = now + 120_000;
  const read = request('stream-2', 'pending', 0, 512 * 1024);
  assert.ok(streamTimeouts.at(-1) <= 40_000, 'An ordinary read starts with its default timeout');
  window.__miniRuntimeEvent('streams.waitUntil', { source: 'stream-2', until: later });
  now += 40_000;
  streamDeadline();
  assert.ok(streamTimeouts.at(-1) > 110_000, 'An update extends a read already in flight');
  const next = request('stream-2', 'next', 0, 512 * 1024, later);
  assert.ok(streamTimeouts.at(-1) > 110_000, 'A new read starts with the native source deadline');
  const other = await window.mini.streams.open({ size: 3, mimeType: 'video/webm' }, async () => new Uint8Array(3));
  assert.equal(await request('stream-3', 'other', 0, 3), 'AAAA');
  assert.ok(streamTimeouts.at(-1) <= 40_000, 'The deadline does not affect another source');
  controller.abort();
  assert.equal(await save, null);
  assert.equal(await read, undefined);
  assert.equal(await next, undefined);
  await other.close();
  assert.equal(aborted, true);
  assert.equal(sources.size, 0);
  const folder = await window.mini.streams.save({
    directoryId: 'selected-dir', folders: ['subfolder'], suggestedName: 'nested.txt',
    size: saveBlockSize + 3, mimeType: 'text/plain'
  }, async (offset, length) => {
    if (offset === 0) {
      assert.equal(length, saveBlockSize);
      return new Uint8Array(length).fill(213);
    }
    assert.equal(offset, saveBlockSize);
    assert.equal(length, 3);
    return new Uint8Array([97, 98, 99]);
  });
  assert.deepEqual(folder, { name: 'nested.txt', sizeBytes: saveBlockSize + 3 });
  assert.equal(fallbackEncodes, typeof Uint8Array.prototype.toBase64 === 'function' ? 1 : 4);
  console.log('PASS: runtime bridge byte ranges, Base64 fallback, short reply, cancellation and exact 1 MiB save');
}

const timeout = setTimeout(() => { throw new Error('Stream bridge smoke timed out'); }, 5_000);
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));

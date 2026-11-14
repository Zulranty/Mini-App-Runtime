const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { addRangeSource } = require('./range-upload.cjs');

const entry = path.resolve(__dirname, '../../Cache/Telegram/module/node_modules/teleproto/client/methods/uploads.js');
const dependency = Module.createRequire(entry);
const { Api } = dependency('../../tl/generated/api.js');
const { ResourceManager } = dependency('../files/ResourceManager.js');
const uploads = new Module(entry);
uploads.filename = entry;
uploads.paths = Module._nodeModulePaths(path.dirname(entry));
uploads._compile(addRangeSource(fs.readFileSync(entry, 'utf8')), entry);
const { uploadFile } = uploads.exports;
const { setTimeout: delay } = require('node:timers/promises');

const slab = new Uint8Array(512 * 1024);
const large = 2_000_000_000;
const expectedParts = 3815;
const manager = new ResourceManager(2 * slab.length, 'baseline');
const parts = new Set();
let requested = 0;
let largestRead = 0;
let progress = 0;
const client = {
  session: { dcId: 2 },
  _files: {
    maxPartSize: slab.length,
    maxUploadParts: async () => 4000,
    manager: () => manager,
    async run(direction, dc, request) {
      const part = request();
      assert.equal(direction, 'upload');
      assert.equal(dc, 2);
      assert.ok(part instanceof Api.upload.SaveBigFilePart);
      assert.equal(part.fileTotalParts, expectedParts);
      assert.equal(part.bytes.length, Math.min(slab.length, large - part.filePart * slab.length));
      assert.ok(!parts.has(part.filePart));
      parts.add(part.filePart);
      return true;
    }
  }
};

async function run() {
  const file = {
    name: 'virtual.bin', size: large, preferLargeParts: true,
    async readRange(offset, length) {
      assert.equal(offset % slab.length, 0);
      assert.equal(length, Math.min(slab.length, large - offset));
      largestRead = Math.max(largestRead, length);
      requested += length;
      return slab.subarray(0, length);
    },
    arrayBuffer() { throw new Error('A large file was read in full'); }
  };
  const result = await uploadFile(client, { file, workers: 4, onProgress: value => { progress = value; } });
  assert.ok(result instanceof Api.InputFileBig);
  assert.equal(result.parts, expectedParts);
  assert.equal(parts.size, expectedParts);
  assert.equal(requested, large);
  assert.equal(largestRead, 524288);
  assert.equal(progress, 1);
  await assert.rejects(uploadFile(client, { file: { ...file, readRange: async () => slab.subarray(0, 1) } }),
    /CLOUD_FILE_INCOMPLETE/);
  console.log('PASS: 2,000,000,000 bytes, 3,815 Telegram parts, range reads at most 512 KiB, short-read failure');

  async function compare(preferLargeParts) {
    const size = 32 * 1024 * 1024 + 13;
    const workers = preferLargeParts ? 4 : 2;
    const partSize = preferLargeParts ? slab.length : 64 * 1024;
    const sent = new Set();
    let active = 0;
    let peak = 0;
    const benchmarkManager = new ResourceManager(8 * slab.length, 'greedy');
    const start = performance.now();
    const result = await uploadFile({ ...client, _files: {
      ...client._files, manager: () => benchmarkManager,
      async run(direction, dc, request) {
        const part = request();
        const offset = part.filePart * partSize;
        assert.equal(part.bytes.length, Math.min(partSize, size - offset));
        assert.equal(part.bytes[0], (offset / (64 * 1024)) % 251);
        assert.ok(!sent.has(part.filePart));
        sent.add(part.filePart);
        peak = Math.max(peak, ++active);
        await delay(5);
        active--;
        return true;
      }
    } }, { file: {
      name: 'benchmark.bin', size, preferLargeParts,
      async readRange(offset, length) { return Buffer.alloc(length, (offset / (64 * 1024)) % 251); }
    }, workers });
    assert.equal(result.parts, Math.ceil(size / partSize));
    assert.equal(sent.size, result.parts);
    assert.equal(peak, workers);
    return { ms: Math.round(performance.now() - start), requests: sent.size, peak };
  }

  const baseline = await compare(false);
  const optimized = await compare(true);
  console.log('PASS: 32 MiB + 13 byte upload with 5 ms simulated RPC latency', { baseline, optimized });
}

const timeout = setTimeout(() => { throw new Error('Upload smoke timed out'); }, 30_000);
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));

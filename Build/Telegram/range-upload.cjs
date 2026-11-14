const fs = require('node:fs');

// teleproto 1.232.1 buffers browser Files in openUploadSource. Supply the range
// reader and let the cloud opt into the configured maximum upload part size.
function addRangeSource(source) {
  const entry = 'async function openUploadSource(file, size, maxBufferSize) {';
  const partSize = 'let partSize = require_client_files_PartsManager.choosePartSize(size, client._files.maxPartSize);';
  if (source.split(entry).length !== 2 || source.split(partSize).length !== 2) {
    throw new Error('Review the teleproto upload hooks after upgrading');
  }
  return source.replace(partSize, partSize + '\n\tif (file.preferLargeParts) partSize = client._files.maxPartSize;')
    .replace(entry, entry + String.raw`
  if (typeof file.readRange === "function") {
    return {
      async read(offset, length) {
        const bytes = await file.readRange(offset, length);
        if (bytes.byteLength !== length) throw new Error("CLOUD_FILE_INCOMPLETE");
        return require_platform_buffer_index.Buffer.from(bytes);
      },
      close: async () => {}
    };
  }`);
}

module.exports = {
  addRangeSource,
  plugin: {
    name: 'teleproto-range-upload',
    setup(build) {
      build.onLoad({ filter: /[\\/]teleproto[\\/]client[\\/]methods[\\/]uploads\.js$/ }, args => ({
        contents: addRangeSource(fs.readFileSync(args.path, 'utf8')),
        loader: 'js'
      }));
    }
  }
};

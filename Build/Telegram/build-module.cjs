const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { plugin } = require('./range-upload.cjs');

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('Pass the destination module directory.');

  const result = await esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: ['telegram.js'],
    outfile: path.resolve(output, 'index.js'),
    bundle: true,
    plugins: [plugin],
    platform: 'browser',
    target: 'chrome90',
    format: 'iife',
    minify: true,
    legalComments: 'eof',
    metafile: true
  });

  const packages = new Set(Object.keys(result.metafile.inputs)
    .filter(file => file.startsWith('node_modules/'))
    .map(file => file.split('/').slice(1, file.startsWith('node_modules/@') ? 3 : 2).join('/')));
  const notices = [];
  for (const name of [...packages].sort()) {
    const folder = path.join(__dirname, 'node_modules', name);
    const { version } = require(path.join(folder, 'package.json'));
    const license = fs.readdirSync(folder).find(file => /^(license|licence)(\..+)?$/i.test(file));
    if (!license) throw new Error('Missing license for ' + name);
    notices.push(name + ' ' + version + '\n\n' + fs.readFileSync(path.join(folder, license), 'utf8').trim());
  }
  fs.writeFileSync(path.resolve(output, 'THIRD-PARTY.txt'), notices.join('\n\n---\n\n') + '\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyUpdate,
  checksumFromFile,
  compareVersions,
  normalizeRelativePath,
  readReleaseManifest,
  sha256,
} = require('../updater');

test('compares stable release versions', () => {
  assert.equal(compareVersions('v1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.2.0', 'v1.2.0'), 0);
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
});

test('parses and verifies checksums', () => {
  const buffer = Buffer.from('wordfx update');
  const expected = sha256(buffer);
  assert.equal(checksumFromFile(`${expected}  slashslash-windows.zip\n`), expected);
});

test('rejects paths that could overwrite personal data', () => {
  assert.throws(() => normalizeRelativePath('../credentials.json'), /Unsafe release path/);
  assert.throws(() => normalizeRelativePath('data/credentials.json'), /protected data/);
  assert.throws(() => normalizeRelativePath('theme.json'), /protected data/);
});

test('applies managed files while preserving runtime data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slashslash-updater-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });

  const files = ['package.json', 'wordfx.js', 'command-mode.js', 'updater.js', 'launch-wordfx.cmd'];
  for (const file of files) fs.writeFileSync(path.join(source, file), `new ${file}`);
  fs.writeFileSync(path.join(source, '.release-manifest.json'), JSON.stringify({ version: '2.0.0', files }));
  fs.writeFileSync(path.join(target, 'wordfx.js'), 'old wordfx.js');
  fs.writeFileSync(path.join(target, 'data', 'credentials.json'), 'personal');

  const manifest = readReleaseManifest(source);
  applyUpdate(source, target, manifest.files, backup);

  assert.equal(fs.readFileSync(path.join(target, 'wordfx.js'), 'utf8'), 'new wordfx.js');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'credentials.json'), 'utf8'), 'personal');
  assert.equal(fs.readFileSync(path.join(backup, 'wordfx.js'), 'utf8'), 'old wordfx.js');
});


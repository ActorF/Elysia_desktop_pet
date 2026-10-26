'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createRuntimeDependencies, validDependenciesManifest } = require('../electron/chat-runtime-dependencies.cjs');
const original = require('../electron/chat-bootstrap-manifest.json').runtimeDependencies;
const voiceAssets = require('../electron/voice-bootstrap-manifest.json').assets;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('chat dependency source matches the exact voice resource bundled with the application', () => {
  assert.deepEqual(original.archive, { file: voiceAssets.fileName, bytes: voiceAssets.bytes, sha256: voiceAssets.sha256 });
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = entry.data, crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const footer = Buffer.alloc(22), directory = Buffer.concat(central);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}
function fixture(t, { badMember = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-chat-dependencies-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('elysia-chat-dependencies-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'chat-runtime'), assets = path.join(root, 'assets'); fs.mkdirSync(directory); fs.mkdirSync(assets);
  const manifest = structuredClone(original), files = new Map();
  const entries = manifest.files.map(item => {
    const data = Buffer.from(`inert verified fixture for ${item.file}`); files.set(item.file, data);
    Object.assign(item, { bytes: data.length, sha256: hash(data) });
    return { name: item.entry, data: badMember && item.file === 'msvcp140.dll' ? Buffer.alloc(data.length) : data };
  });
  // Unselected members must never be unpacked or executed.
  entries.push({ name: 'python/python.exe', data: Buffer.from('unused interpreter') });
  const archive = zip(entries); Object.assign(manifest.archive, { bytes: archive.length, sha256: hash(archive) });
  const archivePath = path.join(assets, manifest.archive.file); fs.writeFileSync(archivePath, archive);
  return { root, directory, assets, manifest, files, archivePath };
}

test('dependency manifest rejects changed destinations and missing required libraries', () => {
  assert.equal(validDependenciesManifest(original), true);
  for (const mutate of [
    value => { value.files[0].entry = '../msvcp140.dll'; },
    value => { value.files[0].file = '../msvcp140.dll'; },
    value => { value.files[0] = value.files[1]; },
    value => { value.files[0] = null; },
    value => { value.files.pop(); },
    value => { value.archive.file = '../assets.zip'; },
  ]) {
    const invalid = structuredClone(original); mutate(invalid); assert.ok(!validDependenciesManifest(invalid));
  }
});

test('native dependency deployment selects pinned members, reuses them, and repairs changed bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); let extracted = 0;
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: (file, args, options) => {
      extracted++; assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
      return spawn(file, args, options);
    } });
  const signal = new AbortController().signal;
  assert.equal(dependencies.ready(f.directory), false); await dependencies.prepare(f.directory, signal);
  assert.equal(dependencies.ready(f.directory), true); assert.equal(extracted, 1);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [...f.files.keys()].sort());
  for (const [file, bytes] of f.files) assert.deepEqual(fs.readFileSync(path.join(f.directory, file)), bytes);
  await dependencies.prepare(f.directory, signal); assert.equal(extracted, 1);
  const changed = path.join(f.directory, 'vcruntime140.dll'); fs.writeFileSync(changed, Buffer.alloc(f.files.get('vcruntime140.dll').length));
  assert.equal(dependencies.ready(f.directory), false); await dependencies.prepare(f.directory, signal);
  assert.equal(dependencies.ready(f.directory), true); assert.equal(extracted, 2);
  const retained = fs.readdirSync(f.directory).find(file => file.startsWith('vcruntime140.dll.unverified-'));
  assert.ok(retained); assert.deepEqual(fs.readFileSync(path.join(f.directory, retained)), Buffer.alloc(f.files.get('vcruntime140.dll').length));
  assert.equal(fs.readdirSync(f.root).some(file => file.startsWith('chat-dependencies-staging-')), false);
});

test('archive digest mismatch fails before spawning a helper or changing runtime files', async t => {
  const f = fixture(t); fs.writeFileSync(f.archivePath, Buffer.alloc(f.manifest.archive.bytes));
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: () => { assert.fail('Unverified archive must not be extracted'); } });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { setupCode: 'dependencies-source' });
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('individual member digest mismatch rejects the complete extracted set', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t, { badMember: true });
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { setupCode: 'dependencies' });
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(fs.readdirSync(f.root).some(file => file.startsWith('chat-dependencies-staging-')), false);
});

test('cancelled extraction waits for its child and removes only its staging directory', async t => {
  const f = fixture(t), controller = new AbortController(); let child, stage;
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: (file, args, options) => {
      stage = options.env.ELYSIA_CHAT_DEPENDENCY_STAGE;
      child = new EventEmitter(); child.kill = () => { process.nextTick(() => child.emit('exit', 1)); return true; };
      controller.abort(); return child;
    } });
  await assert.rejects(dependencies.prepare(f.directory, controller.signal), { name: 'AbortError' });
  assert.ok(child); assert.equal(fs.existsSync(stage), false); assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(fs.existsSync(f.archivePath), true);
});

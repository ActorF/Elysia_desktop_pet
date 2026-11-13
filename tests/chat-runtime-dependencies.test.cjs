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
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { setupCode: 'dependencies-source', diagnosticKind: 'dependencies-source-integrity' });
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('individual member digest mismatch rejects the complete extracted set', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t, { badMember: true });
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { setupCode: 'dependencies', diagnosticKind: 'dependencies-invalid' });
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

test('dependency inspection separates absent libraries from changed libraries without changing files', t => {
  const f = fixture(t), dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets });
  const missing = dependencies.inspect(f.directory);
  assert.equal(missing.kind, 'dependencies-missing'); assert.equal(missing.missingCount, f.manifest.files.length);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  for (const [name, bytes] of f.files) fs.writeFileSync(path.join(f.directory, name), bytes);
  assert.deepEqual(dependencies.inspect(f.directory), { kind: null });
  const target = path.join(f.directory, f.manifest.files[0].file); fs.writeFileSync(target, 'changed bytes');
  assert.equal(dependencies.inspect(f.directory).kind, 'dependencies-invalid');
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed bytes');
});

test('dependency helpers preserve launch, timeout, unsafe archive and storage failure categories', async t => {
  const scenarios = [
    { code: 70, kind: 'archive-unsafe' }, { code: 71, kind: 'archive-layout' },
    { code: 72, kind: 'storage-space' }, { code: 73, kind: 'storage-permission' },
    { code: 74, kind: 'storage-busy' }, { code: 75, kind: 'storage-path' },
    { code: 79, kind: 'extraction-exit' }, { timeout: true, kind: 'extraction-timeout' },
    { launch: true, kind: 'extraction-launch' },
  ];
  for (const scenario of scenarios) {
    const f = fixture(t), dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
      extractionTimeoutMs: 3, spawnImpl: () => {
        if (scenario.launch) throw new Error('private launcher details');
        const child = new EventEmitter();
        child.kill = () => { process.nextTick(() => child.emit('exit', 1)); return true; };
        if (!scenario.timeout) process.nextTick(() => child.emit('exit', scenario.code));
        return child;
      } });
    await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), error => {
      assert.equal(error.diagnosticKind, scenario.kind);
      if (scenario.code) assert.equal(error.exitCode, scenario.code);
      return true;
    });
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('chat-dependencies-staging-')), false);
  }
});

test('unconfirmed dependency extraction preserves staging, refuses retry, and clears only after late exit', async t => {
  const f = fixture(t); let child, stage, spawns = 0;
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    extractionTimeoutMs: 5, processStopTimeoutMs: 5, spawnImpl: (file, args, options) => {
      spawns++; stage = options.env.ELYSIA_CHAT_DEPENDENCY_STAGE;
      fs.writeFileSync(path.join(stage, 'in-progress'), 'partial');
      child = new EventEmitter(); child.pid = 123; child.kill = () => { throw new Error('refused'); }; return child;
    } });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), error => error.diagnosticKind === 'extraction-timeout' && error.preserveStage);
  assert.equal(dependencies.pending(), true); assert.equal(fs.existsSync(stage), true);
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { diagnosticKind: 'storage-busy' });
  assert.equal(spawns, 1); assert.deepEqual(fs.readdirSync(f.directory), []);
  child.emit('exit', 1); await Promise.resolve(); assert.equal(dependencies.pending(), false);
  for (let i = 0; i < 100 && fs.existsSync(stage); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(fs.existsSync(stage), false);
});

test('real PowerShell extraction supports Unicode, spaces, hash signs and shell metacharacters in paths', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), directory = path.join(f.root, '聊天 東京 Ω # [runtime] &'), assets = path.join(f.root, '资源 # [assets] &');
  fs.renameSync(f.directory, directory); fs.renameSync(f.assets, assets);
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: assets });
  await dependencies.prepare(directory, new AbortController().signal);
  assert.equal(dependencies.ready(directory), true);
  for (const [file, bytes] of f.files) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
});

test('dependency preparation cannot modify a runtime directory replaced while extraction is pending', async t => {
  const f = fixture(t), replacement = Buffer.from('new directory content');
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: (file, args, options) => {
      fs.renameSync(f.directory, path.join(f.root, 'old-runtime')); fs.mkdirSync(f.directory);
      fs.writeFileSync(path.join(f.directory, f.manifest.files[0].file), replacement);
      for (const [name, bytes] of f.files) fs.writeFileSync(path.join(options.env.ELYSIA_CHAT_DEPENDENCY_STAGE, name), bytes);
      const child = new EventEmitter(); process.nextTick(() => child.emit('exit', 0)); return child;
    } });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { diagnosticKind: 'storage-busy' });
  assert.deepEqual(fs.readdirSync(f.directory), [f.manifest.files[0].file]);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.manifest.files[0].file)), replacement);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'old-runtime')), []);
});

test('a dependency child error keeps its late-exit cleanup across the public error wrapper', async t => {
  const f = fixture(t); let child, stage;
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets, processStopTimeoutMs: 5,
    spawnImpl: (file, args, options) => {
      stage = options.env.ELYSIA_CHAT_DEPENDENCY_STAGE; fs.writeFileSync(path.join(stage, 'partial'), 'owned');
      child = new EventEmitter(); child.pid = 123; child.kill = () => false;
      queueMicrotask(() => child.emit('error', Object.assign(new Error('IO failure'), { code: 'EIO' }))); return child;
    } });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), error =>
    error.diagnosticKind === 'storage-io' && error.preserveStage && error.setupProcessExit instanceof Promise);
  assert.equal(fs.existsSync(stage), true); assert.equal(dependencies.pending(), true);
  child.emit('exit', 1);
  for (let i = 0; i < 100 && fs.existsSync(stage); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(fs.existsSync(stage), false); assert.equal(dependencies.pending(), false);
});

test('dependency publication cannot overwrite a target created immediately before its atomic link', async t => {
  const f = fixture(t), realLink = fs.promises.link.bind(fs.promises), target = path.join(f.directory, f.manifest.files[0].file);
  t.mock.method(fs.promises, 'link', async (source, destination) => {
    if (destination === target) fs.writeFileSync(target, 'new user file', { flag: 'wx' });
    return realLink(source, destination);
  });
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: (file, args, options) => {
      for (const [name, bytes] of f.files) fs.writeFileSync(path.join(options.env.ELYSIA_CHAT_DEPENDENCY_STAGE, name), bytes);
      const child = new EventEmitter(); process.nextTick(() => child.emit('exit', 0)); return child;
    } });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), { diagnosticKind: 'storage-busy' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new user file'); assert.deepEqual(fs.readdirSync(f.directory), [f.manifest.files[0].file]);
});

test('dependency publication supports volumes without hardlinks using verified same-volume native moves', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(fs.promises, 'link', async () => { throw Object.assign(new Error('unsupported'), ++calls % 2
    ? { code: 'EISDIR', syscall: 'link' } : { code: 'ENOTSUP' }); });
  t.mock.method(fs.promises, 'copyFile', () => assert.fail('publication does not duplicate bytes'));
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: (file, args, options) => {
      for (const [name, bytes] of f.files) fs.writeFileSync(path.join(options.env.ELYSIA_CHAT_DEPENDENCY_STAGE, name), bytes);
      const child = new EventEmitter(); process.nextTick(() => child.emit('exit', 0)); return child;
    } });
  await dependencies.prepare(f.directory, new AbortController().signal);
  assert.equal(dependencies.ready(f.directory), true);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [...f.files.keys()].sort());
});

test('dependency publication preserves a source replaced while its verified inode is being linked', async t => {
  const f = fixture(t), realLink = fs.promises.link.bind(fs.promises); let replaced, stage;
  t.mock.method(fs.promises, 'link', async (source, destination) => {
    await realLink(source, destination);
    if (!replaced) {
      replaced = source; stage = path.dirname(source);
      fs.renameSync(source, source + '.saved'); fs.writeFileSync(source, 'unrelated replacement');
    }
  });
  const dependencies = createRuntimeDependencies({ manifest: f.manifest, assetDirectory: f.assets,
    spawnImpl: (file, args, options) => {
      for (const [name, bytes] of f.files) fs.writeFileSync(path.join(options.env.ELYSIA_CHAT_DEPENDENCY_STAGE, name), bytes);
      const child = new EventEmitter(); process.nextTick(() => child.emit('exit', 0)); return child;
    } });
  await assert.rejects(dependencies.prepare(f.directory, new AbortController().signal), error => error.diagnosticKind === 'storage-busy' && error.preserveStage);
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'unrelated replacement'); assert.equal(fs.existsSync(stage), true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.manifest.files[0].file)), f.files.get(f.manifest.files[0].file));
});

/** Repair old voice directories using only tiny verified fixtures and fake child processes. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createVoiceSetup } = require('../electron/voice-setup.cjs');
const { REQUIRED } = require('../electron/voice-installation.cjs');
const { createSetupDiagnostic } = require('../electron/setup-diagnostics.cjs');

const tempRoot = path.resolve(__dirname, '../artifacts/voice-setup-issue/temp');
const runtimeName = 'GPT-SoVITS-v2-240821';
const anchors = Array.from({ length: 20 }, (_, index) => `models/cache/${runtimeName}/runtime/anchor${index}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (root, relative, value = 'new trusted fixture') => {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
};
function snapshot(root) {
  const result = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file).replaceAll('\\', '/');
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) result.push([relative, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { result.push([relative, 'directory']); visit(file); }
      else result.push([relative, 'file', fs.readFileSync(file).toString('hex')]);
    }
  };
  visit(root); return result.sort((left, right) => left[0].localeCompare(right[0]));
}
function fixture(t, options = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'voice-repair-'));
  const userData = path.join(root, 'profile'), resources = path.join(root, 'resources');
  const assets = Buffer.from('tiny authenticated assets'), runtime = Buffer.from('tiny authenticated runtime');
  const extractor = Buffer.from('tiny authenticated extractor');
  const descriptor = (fileName, content, url) => ({ fileName, bytes: content.length, sha256: hash(content), url });
  const manifest = { version: 1,
    assets: descriptor('assets.zip', assets, 'https://github.com/ActorF/Elysia_desktop_pet/releases/download/test/assets.zip'),
    runtime: descriptor('runtime.7z', runtime, 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/test/runtime.7z'),
    extractor: { relativePath: 'tools/7za.exe', sha256: hash(extractor) } };
  write(resources, 'tools/7za.exe', extractor);
  for (const key of ['assets', 'runtime']) {
    const asset = manifest[key]; write(userData, `voice-downloads/${asset.sha256.slice(0, 16)}-${asset.fileName}`, key === 'assets' ? assets : runtime);
  }
  const calls = [], notices = [];
  const baseSpawn = (file, args, spawnOptions) => {
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; process.nextTick(() => child.emit('close', 1)); };
    process.nextTick(() => {
      if (args[0] === 'l') child.stdout.write('----------\r\nPath = safe\r\nSize = 64\r\nAttributes = A\r\n\r\n');
      if (args[0] === 'x') {
        const destination = args.find(arg => arg.startsWith('-o')).slice(2);
        if (args.at(-1).endsWith('.7z')) {
          write(destination, `${runtimeName}/runtime/python.exe`);
          for (let index = 0; index < 20; index++) write(destination, `${runtimeName}/runtime/anchor${index}`);
        } else for (const relative of REQUIRED.filter(value => !value.startsWith('models/cache/'))) write(destination, relative);
      }
      if (args[0] === '-I') child.stdout.write(JSON.stringify({ required: anchors }));
      child.stdout.end(); child.emit('close', 0);
    });
    return child;
  };
  const service = createVoiceSetup({ userData, resourcesPath: resources, manifest, env: {},
    allowDownloads: options.allowDownloads ?? true,
    statfsImpl: options.statfsImpl || (async () => ({ bsize: 1, bavail: 100 * 1024 ** 3 })),
    fetchImpl: () => assert.fail('repair must reuse the complete authenticated cache'),
    spawnImpl: (file, args, spawnOptions) => {
      calls.push({ file, args, options: spawnOptions });
      assert.ok(!file.startsWith(path.join(userData, 'voice-runtime') + path.sep), 'never execute an old interpreter');
      return options.spawnImpl ? options.spawnImpl(file, args, spawnOptions, baseSpawn) : baseSpawn(file, args, spawnOptions);
    }, onChange: state => notices.push(state) });
  const project = service.getProjectRoot();
  t.after(() => {
    service.dispose();
    const actual = fs.realpathSync(root), parent = fs.realpathSync(tempRoot);
    assert.equal(path.dirname(actual), parent); assert.match(path.basename(actual), /^voice-repair-/);
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return { root, userData, resources, project, service, manifest, calls, notices };
}
function seedOld(f, kind = 'missing-marker') {
  write(f.project, 'old-user-file.txt', Buffer.from([0, 19, 255, 42]));
  for (const relative of [...REQUIRED, ...anchors]) write(f.project, relative, `untrusted old content: ${relative}`);
  const marker = { version: 1, assets: f.manifest.assets.sha256, runtime: f.manifest.runtime.sha256, required: [...REQUIRED, ...anchors] };
  if (kind === 'invalid-marker') write(f.project, 'voice-setup-complete.json', '{ invalid old marker');
  else if (kind !== 'missing-marker') {
    if (kind === 'version-mismatch') marker.version = 2;
    if (kind === 'resource-mismatch') marker.runtime = 'a'.repeat(64);
    write(f.project, 'voice-setup-complete.json', JSON.stringify(marker));
    if (kind === 'missing-files') fs.unlinkSync(path.join(f.project, REQUIRED[0]));
  }
}
async function settled(service) {
  const deadline = Date.now() + 5000;
  while (service.getState().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.getState().busy, false, 'voice repair did not settle'); return service.getState();
}
function oldBackups(f) {
  return fs.readdirSync(f.userData, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'voice-runtime')
    .map(entry => path.join(f.userData, entry.name)).filter(directory => fs.existsSync(path.join(directory, 'old-user-file.txt')));
}

test('existing voice failures need explicit repair and rebuild from verified cache while preserving the old directory', async t => {
  for (const kind of ['missing-marker', 'invalid-marker', 'version-mismatch', 'resource-mismatch', 'missing-files']) {
    await t.test(kind, async t => {
      const f = fixture(t); seedOld(f, kind);
      const original = snapshot(f.project), cache = snapshot(path.join(f.userData, 'voice-downloads'));
      const initial = await f.service.inspect();
      assert.equal(initial.installation.code, kind); assert.equal(initial.repairAvailable, true);
      f.service.install(); const diagnosed = await settled(f.service);
      assert.equal(diagnosed.phase, 'error'); assert.equal(diagnosed.installation.code, kind);
      assert.deepEqual(snapshot(f.project), original); assert.equal(f.calls.length, 0); assert.deepEqual(oldBackups(f), []);
      assert.equal(f.service.repair().ok, true);
      const repaired = await settled(f.service);
      assert.equal(repaired.ready, true); assert.equal(repaired.phase, 'ready'); assert.equal(repaired.repairAvailable, false);
      assert.equal(repaired.diagnostic, null);
      const backups = oldBackups(f); assert.equal(backups.length, 1); assert.deepEqual(snapshot(backups[0]), original);
      assert.deepEqual(snapshot(path.join(f.userData, 'voice-downloads')), cache);
      assert.equal(fs.existsSync(path.join(f.project, 'old-user-file.txt')), false);
      assert.equal(fs.readFileSync(path.join(f.project, 'python/python.exe'), 'utf8'), 'new trusted fixture');
      const marker = JSON.parse(fs.readFileSync(path.join(f.project, 'voice-setup-complete.json'), 'utf8'));
      assert.equal(marker.assets, f.manifest.assets.sha256); assert.equal(marker.runtime, f.manifest.runtime.sha256);
      assert.ok(f.calls.some(call => call.args[0] === '-I'));
      assert.ok(f.calls.filter(call => call.args[0] === '-I').every(call => call.file.includes('voice-staging-')));
      assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
    });
  }
});

test('failed staged validation preserves all original voice bytes and leaves the cache reusable', async t => {
  const f = fixture(t, { spawnImpl: (file, args, options, baseSpawn) => {
    if (args[0] !== '-I') return baseSpawn(file, args, options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    process.nextTick(() => child.emit('close', 1)); return child;
  } });
  seedOld(f); const original = snapshot(f.project), cache = snapshot(path.join(f.userData, 'voice-downloads'));
  f.service.repair(); const state = await settled(f.service);
  assert.equal(state.phase, 'error'); assert.equal(state.ready, false); assert.equal(state.repairAvailable, true);
  assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'validation-exit').code);
  assert.deepEqual(snapshot(f.project), original); assert.deepEqual(snapshot(path.join(f.userData, 'voice-downloads')), cache);
  assert.deepEqual(oldBackups(f), []); assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
  const rechecked = await f.service.inspect();
  assert.deepEqual(rechecked.diagnostic, state.diagnostic); assert.equal(rechecked.error, state.error);
  assert.match(rechecked.message, /上次修复/);
  // Model a separate successful recovery changing the installation facts.
  write(f.project, 'voice-setup-complete.json', JSON.stringify({ version: 1,
    assets: f.manifest.assets.sha256, runtime: f.manifest.runtime.sha256, required: [...REQUIRED, ...anchors] }));
  const restored = await f.service.inspect();
  assert.equal(restored.ready, true); assert.equal(restored.diagnostic, null); assert.equal(restored.error, null);
  assert.equal(restored.repairAvailable, false); assert.doesNotMatch(restored.message, /上次修复/);
});

test('cancelling staged repair waits for its process and preserves all original voice bytes', async t => {
  let extraction;
  const f = fixture(t, { spawnImpl: (file, args, options, baseSpawn) => {
    if (args[0] !== 'x') return baseSpawn(file, args, options);
    extraction = new EventEmitter(); extraction.stdout = new PassThrough();
    extraction.kill = () => { extraction.killed = true; setTimeout(() => extraction.emit('close', 1), 10); };
    return extraction;
  } });
  seedOld(f); const original = snapshot(f.project), cache = snapshot(path.join(f.userData, 'voice-downloads'));
  f.service.repair();
  const deadline = Date.now() + 5000;
  while (!extraction && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(extraction, 'expected staged extraction');
  assert.equal(f.service.cancel().ok, true); assert.equal(extraction.killed, true); assert.equal(f.service.getState().busy, true);
  const state = await settled(f.service);
  assert.equal(state.phase, 'cancelled'); assert.equal(state.diagnostic, null);
  assert.deepEqual(snapshot(f.project), original); assert.deepEqual(snapshot(path.join(f.userData, 'voice-downloads')), cache);
  assert.deepEqual(oldBackups(f), []); assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('preview repair refuses downloads, processes and filesystem changes even with a complete cache', async t => {
  const f = fixture(t, { allowDownloads: false }); seedOld(f);
  const before = snapshot(f.userData), initial = await f.service.inspect(); assert.equal(initial.repairAvailable, false);
  const result = f.service.repair(); assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, createSetupDiagnostic('voice', 'preview-disabled').code);
  assert.deepEqual(snapshot(f.userData), before); assert.equal(f.calls.length, 0);
});

test('insufficient repair space stops before extraction and preserves the original installation', async t => {
  const f = fixture(t, { statfsImpl: async () => ({ bsize: 1, bavail: 0 }) }); seedOld(f);
  const before = snapshot(f.project), cache = snapshot(path.join(f.userData, 'voice-downloads'));
  f.service.repair(); const state = await settled(f.service);
  assert.equal(state.phase, 'error'); assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'storage-space').code);
  assert.ok(f.calls.every(call => !['x', '-I'].includes(call.args[0])));
  assert.deepEqual(snapshot(f.project), before); assert.deepEqual(snapshot(path.join(f.userData, 'voice-downloads')), cache);
  assert.deepEqual(oldBackups(f), []);
});

test('repair is a no-op for an already ready directory', async t => {
  const f = fixture(t); seedOld(f, 'ready'); const before = snapshot(f.userData);
  assert.equal((await f.service.inspect()).repairAvailable, false);
  f.service.repair(); const state = await settled(f.service);
  assert.equal(state.ready, true); assert.equal(state.repairAvailable, false);
  assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.userData), before);
});

test('repair refuses a linked root without following or changing its target', async t => {
  const f = fixture(t), target = path.join(f.root, 'outside-voice-target');
  write(target, 'old-user-file.txt', 'leave the junction target alone');
  fs.symlinkSync(target, f.project, process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(target), initial = await f.service.inspect();
  assert.equal(initial.installation.code, 'linked-directory'); assert.equal(initial.repairAvailable, false);
  f.service.repair(); const state = await settled(f.service);
  assert.equal(state.ready, false); assert.equal(fs.lstatSync(f.project).isSymbolicLink(), true);
  assert.deepEqual(snapshot(target), before); assert.equal(f.calls.length, 0); assert.deepEqual(oldBackups(f), []);
});

test('ordinary installation does not replace a directory created while its staged validation is running', async t => {
  let f, lateOriginal;
  f = fixture(t, { spawnImpl: (file, args, options, baseSpawn) => {
    if (args[0] === '-I') {
      write(f.project, 'late-user-file.txt', 'created by another installation while validation was running');
      lateOriginal = snapshot(f.project);
    }
    return baseSpawn(file, args, options);
  } });
  const cache = snapshot(path.join(f.userData, 'voice-downloads'));
  f.service.install(); const state = await settled(f.service);
  assert.ok(lateOriginal, 'the external directory must appear before commit');
  assert.equal(state.phase, 'error'); assert.equal(state.ready, false);
  assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'installation-conflict').code);
  assert.deepEqual(snapshot(f.project), lateOriginal); assert.deepEqual(snapshot(path.join(f.userData, 'voice-downloads')), cache);
  assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-runtime.backup-')));
  assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('recovering a pending replacement cannot accept cancellation and misreport an installed environment as cancelled', async t => {
  const f = fixture(t); seedOld(f);
  const original = snapshot(f.project), cache = snapshot(path.join(f.userData, 'voice-downloads'));
  const stageName = `voice-staging-${randomUUID()}`, stage = path.join(f.userData, stageName), project = path.join(stage, 'project');
  for (const relative of REQUIRED) write(project, relative);
  write(project, 'voice-setup-complete.json', JSON.stringify({ version: 1,
    assets: f.manifest.assets.sha256, runtime: f.manifest.runtime.sha256, required: REQUIRED }));
  const identity = file => { const value = fs.lstatSync(file, { bigint: true }); return { dev: String(value.dev), ino: String(value.ino) }; };
  write(f.userData, 'voice-repair-transaction.json', JSON.stringify({ version: 1, kind: 'voice', id: randomUUID(), stage: stageName,
    root: identity(f.userData), stageIdentity: identity(stage), previous: identity(f.project), replacement: identity(project) }));
  assert.equal(f.service.repair().ok, true);
  assert.equal(f.service.getState().canCancel, false);
  assert.equal(f.service.cancel().ok, false, 'an existing transaction must finish or roll back as one operation');
  const state = await settled(f.service);
  assert.equal(state.phase, 'ready'); assert.equal(state.ready, true); assert.equal(state.installation.ready, true);
  assert.equal(state.diagnostic, null); assert.equal(f.calls.length, 0);
  const backups = oldBackups(f); assert.equal(backups.length, 1); assert.deepEqual(snapshot(backups[0]), original);
  assert.deepEqual(snapshot(path.join(f.userData, 'voice-downloads')), cache);
  assert.equal(fs.existsSync(path.join(f.userData, 'voice-repair-transaction.json')), false);
  assert.equal(fs.existsSync(stage), false);
});

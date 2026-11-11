'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { createModelSetup, SETUP_MODEL, SETUP_BASE_URL } = require('../electron/model-setup.cjs');
const originalManifest = require('../electron/chat-bootstrap-manifest.json');
const { EXTRACT_SCRIPT } = require('../electron/chat-runtime-extract.cjs');
const { DEPENDENCIES_EXTRACT_SCRIPT } = require('../electron/chat-runtime-dependencies.cjs');
const json = value => new Response(JSON.stringify(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-llama-test-'));
  const assetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-llama-assets-test-'));
  const runtime = Buffer.from('test runtime archive'), model = Buffer.from('GGUFtest model bytes');
  const manifest = structuredClone(originalManifest);
  // Keep legacy single-source fixtures independent of packaged build resources.
  delete manifest.runtime.bundled;
  if (!options.domesticSources) delete manifest.model.sources;
  for (const [key, bytes] of [['runtime', runtime], ['model', model]]) Object.assign(manifest[key], { bytes: bytes.length, sha256: hash(bytes) });
  const dependencyArchive = Buffer.from('test dependency archive');
  Object.assign(manifest.runtimeDependencies.archive, { bytes: dependencyArchive.length, sha256: hash(dependencyArchive) });
  const dependencyFiles = new Map(manifest.runtimeDependencies.files.map(item => {
    const bytes = Buffer.from(`test dependency: ${item.file}`);
    Object.assign(item, { bytes: bytes.length, sha256: hash(bytes) }); return [item.file, bytes];
  }));
  fs.writeFileSync(path.join(assetDirectory, manifest.runtimeDependencies.archive.file), dependencyArchive);
  if (options.bundledRuntime) {
    manifest.runtime.bundled = true;
    fs.writeFileSync(path.join(assetDirectory, manifest.runtime.file), options.bundledRuntime === 'corrupt' ? Buffer.alloc(runtime.length) : runtime);
  }
  const calls = [], processes = [], notices = [];
  const f = { root, assetDirectory, manifest, runtime, model, dependencyFiles, calls, processes, notices, online: false };
  const spawnImpl = (file, args, spawnOptions) => {
    const actualArgs = args;
    if (spawnOptions.env?.ELYSIA_CHAT_ARGS) args = JSON.parse(spawnOptions.env.ELYSIA_CHAT_ARGS);
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; if (args.includes('--model')) f.online = false; process.nextTick(() => child.emit('exit', 1)); return true; };
    const record = { file, args, actualArgs, options: spawnOptions, child }; processes.push(record);
    if (options.spawn) { options.spawn(record, f); return child; }
    if (spawnOptions.env?.ELYSIA_CHAT_SERVER) f.online = true;
    else if (spawnOptions.env?.ELYSIA_CHAT_DEPENDENCY_STAGE) {
      assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), DEPENDENCIES_EXTRACT_SCRIPT);
      for (const [file, bytes] of dependencyFiles) fs.writeFileSync(path.join(spawnOptions.env.ELYSIA_CHAT_DEPENDENCY_STAGE, file), bytes);
      process.nextTick(() => child.emit('exit', 0));
    }
    else if (path.basename(file) === 'powershell.exe') {
      assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), EXTRACT_SCRIPT);
      for (const file of manifest.runtime.required) fs.writeFileSync(path.join(spawnOptions.env.ELYSIA_CHAT_STAGE, file), 'runtime');
      process.nextTick(() => child.emit('exit', 0));
    } else if (args.includes('--list-devices')) {
      process.nextTick(() => { child.stdout.end('Available devices:\n  Vulkan0: NVIDIA GeForce Test (8192 MiB)\n  Vulkan1: AMD Radeon(TM) Graphics (16384 MiB)\n'); child.emit('exit', 0); });
    } else f.online = true;
    return child;
  };
  const fetchImpl = async (url, request) => {
    calls.push({ url, options: request });
    if (options.fetch) return options.fetch(url, request, f);
    if (url === `${SETUP_BASE_URL}/health`) { if (!f.online) throw new Error('offline'); return json({ status: 'ok' }); }
    if (url === `${SETUP_BASE_URL}/v1/models`) return json({ data: [{ id: SETUP_MODEL }] });
    return new Response(url === manifest.runtime.url ? runtime : model);
  };
  const bundlePaths = options.packagedResources
    ? { resourcesPath: assetDirectory, assetDirectory: undefined, runtimeAssetDirectory: undefined }
    : { assetDirectory };
  f.service = createModelSetup({ userData: root, platform: 'win32', arch: 'x64', manifest, ...bundlePaths,
    env: { SystemRoot: 'C:\\Windows' }, fetchImpl, spawnImpl, onChange: value => notices.push(value),
    startTimeoutMs: 100, pollIntervalMs: 1, ...options.service });
  t.after(() => { f.service.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(assetDirectory, { recursive: true, force: true }); });
  return f;
}
async function settled(service) {
  const deadline = Date.now() + 3000;
  while (service.getState().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.getState().busy, false, 'setup did not settle'); return service.getState();
}
function installed(f) {
  const runtime = path.join(f.root, 'chat-runtime'), models = path.join(f.root, 'chat-models');
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(models, { recursive: true });
  for (const file of f.manifest.runtime.required) fs.writeFileSync(path.join(runtime, file), 'runtime');
  for (const [file, bytes] of f.dependencyFiles) fs.writeFileSync(path.join(runtime, file), bytes);
  fs.writeFileSync(path.join(runtime, 'elysia-runtime.json'), JSON.stringify(f.manifest.runtime));
  fs.writeFileSync(path.join(models, f.manifest.model.file), f.model);
  fs.writeFileSync(path.join(models, 'elysia-model.json'), JSON.stringify({ ...f.manifest.model, modifiedAt: fs.statSync(path.join(models, f.manifest.model.file)).mtimeMs }));
}
function interruptedRuntime(f, phase) {
  installed(f);
  const runtime = path.join(f.root, 'chat-runtime'), stage = fs.mkdtempSync(path.join(f.root, 'chat-staging-'));
  fs.writeFileSync(path.join(runtime, 'old.dll'), 'preserved original runtime');
  for (const file of f.manifest.runtime.required) fs.writeFileSync(path.join(stage, file), 'replacement runtime');
  for (const [file, bytes] of f.dependencyFiles) fs.writeFileSync(path.join(stage, file), bytes);
  fs.writeFileSync(path.join(stage, 'elysia-runtime.json'), JSON.stringify(f.manifest.runtime));
  const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); return { dev: stat.dev.toString(), ino: stat.ino.toString() }; };
  const id = randomUUID(), backup = path.join(f.root, `chat-runtime.unverified-${id}`), journal = path.join(f.root, 'chat-repair-transaction.json');
  const transaction = { version: 1, kind: 'chat', id, stage: path.basename(stage), root: identity(f.root),
    stageIdentity: identity(stage), previous: identity(runtime), replacement: identity(stage) };
  fs.writeFileSync(journal, JSON.stringify(transaction));
  if (phase !== 'prepared') fs.renameSync(runtime, backup);
  if (phase === 'installed') fs.renameSync(stage, runtime);
  return { runtime, stage, backup, journal };
}
const downloads = f => f.calls.filter(call => !call.url.startsWith(SETUP_BASE_URL));
const servers = f => f.processes.filter(child => child.args.includes('--model'));
const readyResponse = (url, item) => { if (!item.online) throw new Error('offline'); return url.endsWith('/health') ? json({ status: 'ok' }) : json({ data: [{ id: SETUP_MODEL }] }); };

test('construction and inspection are read-only and never launch or download', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.inspect()).phase, 'needs-install');
  assert.equal(f.processes.length, 0); assert.equal(downloads(f).length, 0);
  assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.service.getState().expectedModelBytes, f.model.length);
});

test('local preview rejects installation synchronously without network, extraction or profile changes', t => {
  const f = fixture(t, { service: { allowDownloads: false } });
  fs.writeFileSync(path.join(f.root, 'keep.json'), 'synthetic existing preferences');
  const before = f.service.getState();
  const result = f.service.installChatModel();
  assert.equal(result.ok, false); assert.equal(result.code, 'downloads-disabled');
  assert.equal(result.diagnostic.code, 'MODE-101');
  assert.match(result.error, /不会下载或安装/); assert.deepEqual(result.state, before);
  assert.deepEqual(f.service.getState(), before); assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
  assert.deepEqual(fs.readdirSync(f.root), ['keep.json']);
  assert.equal(fs.readFileSync(path.join(f.root, 'keep.json'), 'utf8'), 'synthetic existing preferences');
});

test('local preview inspects and starts existing resources without extracting or replacing them', async t => {
  const f = fixture(t, { service: { allowDownloads: false } }); installed(f);
  const modelFile = path.join(f.root, 'chat-models', f.manifest.model.file);
  const before = fs.statSync(modelFile).mtimeMs;
  const inspected = await f.service.inspect();
  assert.equal(inspected.modelReady, true); assert.equal(inspected.runtimeReady, true);
  assert.equal(f.service.ensureInstalledServer().ok, true);
  assert.equal(f.service.installChatModel().code, 'downloads-disabled', 'An install request cannot interfere with startup');
  const ready = await settled(f.service);
  assert.equal(ready.phase, 'ready'); assert.equal(ready.serverReady, true);
  assert.equal(downloads(f).length, 0); assert.equal(servers(f).length, 1);
  assert.equal(f.processes.some(item => item.options.env?.ELYSIA_CHAT_STAGE || item.options.env?.ELYSIA_CHAT_DEPENDENCY_STAGE), false);
  assert.equal(fs.statSync(modelFile).mtimeMs, before); assert.deepEqual(fs.readFileSync(modelFile), f.model);
});

test('local preview leaves missing or damaged VC dependencies untouched instead of repairing them', async t => {
  for (const damaged of [false, true]) {
    const f = fixture(t, { service: { allowDownloads: false } }); installed(f);
    const dependency = path.join(f.root, 'chat-runtime', 'vcruntime140.dll');
    if (damaged) fs.writeFileSync(dependency, 'keep this damaged fixture'); else fs.unlinkSync(dependency);
    const existingFiles = fs.readdirSync(path.dirname(dependency));
    f.service.ensureInstalledServer(); const state = await settled(f.service);
    assert.equal(state.phase, 'needs-install'); assert.equal(state.runtimeReady, false);
    assert.match(state.error, /不会下载或安装/); assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(dependency)), existingFiles);
    if (damaged) assert.equal(fs.readFileSync(dependency, 'utf8'), 'keep this damaged fixture');
    else assert.equal(fs.existsSync(dependency), false);
    assert.equal(fs.readdirSync(f.root).some(name => name.includes('staging')), false);
  }
});

test('local preview with no existing model reports missing resources without installing anything', async t => {
  const f = fixture(t, { service: { allowDownloads: false } });
  f.service.ensureInstalledServer(); const state = await settled(f.service);
  assert.equal(state.phase, 'needs-install'); assert.match(state.error, /已有聊天资源不完整/);
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0); assert.deepEqual(fs.readdirSync(f.root), []);
  const inspected = await f.service.inspect();
  assert.match(inspected.error, /不会下载或安装/); assert.equal(downloads(f).length, 0);
});

test('fresh pinned setup verifies resources and starts only its hidden llama-server', async t => {
  const f = fixture(t); assert.equal(f.service.installChatModel().ok, true); assert.equal(f.service.installChatModel().ok, false);
  f.service.ensureInstalledServer(); const state = await settled(f.service);
  assert.equal(state.phase, 'ready'); assert.equal(state.serverReady, true); assert.equal(state.modelReady, true); assert.equal(state.runtimeReady, true);
  assert.equal(downloads(f).length, 2); assert.equal(servers(f).length, 1);
  const server = servers(f)[0]; assert.equal(path.basename(server.file), 'powershell.exe');
  assert.equal(path.basename(server.options.env.ELYSIA_CHAT_SERVER), 'llama-server.exe');
  assert.equal(server.options.env.ELYSIA_CHAT_PARENT_PID, String(process.pid));
  assert.match(server.actualArgs.at(-1), /chat-runtime-host\.ps1$/);
  for (const item of f.processes) { assert.equal(item.options.windowsHide, true); assert.equal(item.options.shell, false); }
  for (const [flag, value] of [['--alias', SETUP_MODEL], ['--host', '127.0.0.1'], ['--port', '18434'], ['--ctx-size', '16384'], ['--parallel', '1'], ['--fit-target', '3072'], ['--device', 'Vulkan0'], ['--reasoning-budget', '0']]) assert.equal(server.args[server.args.indexOf(flag) + 1], value);
  assert.ok(server.args.includes('--no-webui'));
  assert.deepEqual(JSON.parse(server.args[server.args.indexOf('--chat-template-kwargs') + 1]), { enable_thinking: false });
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('chat-staging-')), false);
  assert.ok(f.calls.every(call => !/ollama|api\/pull|api\/tags/.test(call.url)));
  f.service.dispose(); assert.equal(server.child.killed, true);
});

test('completed resources restart without downloads and duplicate requests reuse one server', async t => {
  const f = fixture(t); installed(f); f.service.ensureInstalledServer(); f.service.ensureInstalledServer();
  assert.equal((await settled(f.service)).phase, 'ready'); f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(servers(f).length, 1); assert.equal(downloads(f).length, 0);
});

test('existing 1.4.2 resources gain private VC libraries on startup without model downloads', async t => {
  const f = fixture(t); installed(f);
  for (const file of f.dependencyFiles.keys()) fs.unlinkSync(path.join(f.root, 'chat-runtime', file));
  assert.equal((await f.service.inspect()).runtimeReady, false);
  f.service.ensureInstalledServer(); const state = await settled(f.service);
  assert.equal(state.phase, 'ready'); assert.equal(state.runtimeReady, true);
  assert.equal(downloads(f).length, 0); assert.equal(servers(f).length, 1);
  assert.equal(f.processes.filter(item => item.options.env?.ELYSIA_CHAT_DEPENDENCY_STAGE).length, 1);
  for (const [file, bytes] of f.dependencyFiles) assert.deepEqual(fs.readFileSync(path.join(f.root, 'chat-runtime', file)), bytes);
});

test('damaged private VC library is repaired from the pinned bundle before startup', async t => {
  const f = fixture(t); installed(f);
  const damaged = path.join(f.root, 'chat-runtime', 'vcruntime140.dll'); fs.writeFileSync(damaged, 'damaged');
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.deepEqual(fs.readFileSync(damaged), f.dependencyFiles.get('vcruntime140.dll'));
  assert.equal(downloads(f).length, 0);
  assert.ok(fs.readdirSync(path.dirname(damaged)).some(name => name.startsWith('vcruntime140.dll.unverified-')));
});

test('invalid bundled VC resources stop before model download and report a specific repair message', async t => {
  const f = fixture(t);
  const archive = path.join(f.assetDirectory, f.manifest.runtimeDependencies.archive.file);
  const original = fs.readFileSync(archive); fs.writeFileSync(archive, Buffer.alloc(original.length));
  f.service.installChatModel(); const failed = await settled(f.service);
  assert.equal(failed.phase, 'error'); assert.match(failed.error, /聊天运行库资源缺失或校验失败/);
  assert.deepEqual(downloads(f).map(item => item.url), [f.manifest.runtime.url]); assert.equal(servers(f).length, 0);
  fs.writeFileSync(archive, original); f.service.installChatModel();
  assert.equal((await settled(f.service)).phase, 'ready');
});

test('startup never downloads missing resources', async t => {
  const f = fixture(t); f.service.startInstalledServer(); assert.equal((await settled(f.service)).phase, 'needs-install');
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('copied matching GGUF is verified and reused instead of downloaded again', async t => {
  const f = fixture(t), folder = path.join(f.root, 'chat-models'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, f.manifest.model.file), f.model);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.deepEqual(downloads(f).map(call => call.url), [f.manifest.runtime.url]);
});

test('corrupt downloads never extract or launch, and fixed retry works', async t => {
  let corrupt = true;
  const f = fixture(t, { fetch: async (url, request, item) => {
    if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
    return new Response(url === item.manifest.runtime.url ? corrupt ? Buffer.alloc(item.runtime.length) : item.runtime : item.model);
  } });
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'error'); assert.equal(f.processes.length, 0);
  corrupt = false; f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
});

test('cancellation preserves partial bytes and retry validates ranged download', async t => {
  let first = true, readerCancelled = false;
  const f = fixture(t, { fetch: async (url, request, item) => {
    if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
    if (url === item.manifest.runtime.url) return new Response(item.runtime);
    if (first) { first = false; return new Response(new ReadableStream({ start(controller) { controller.enqueue(item.model.subarray(0, 4)); }, cancel() { readerCancelled = true; } })); }
    assert.equal(request.headers.Range, 'bytes=4-');
    return new Response(item.model.subarray(4), { status: 206, headers: { 'content-range': `bytes 4-${item.model.length - 1}/${item.model.length}`, 'content-length': String(item.model.length - 4) } });
  } });
  f.service.installChatModel(); const part = path.join(f.root, 'chat-models', f.manifest.model.file + '.part');
  while (!fs.existsSync(part) || fs.statSync(part).size !== 4) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.service.cancel().ok, true); assert.equal((await settled(f.service)).phase, 'cancelled'); assert.equal(readerCancelled, true); assert.equal(fs.statSync(part).size, 4);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
});

test('untrusted redirects and mismatched byte counts never create executable runtime', async t => {
  for (const mode of ['redirect', 'length']) {
    const f = fixture(t, { fetch: async () => mode === 'redirect' ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) : new Response('bad', { headers: { 'content-length': '999' } }) });
    f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'error'); assert.equal(f.processes.length, 0); assert.equal(fs.existsSync(path.join(f.root, 'chat-runtime')), false);
  }
});

test('occupied local port is reported without spawning or killing another service', async t => {
  const f = fixture(t); installed(f); f.online = true; f.service.ensureInstalledServer(); const state = await settled(f.service);
  assert.equal(state.phase, 'error'); assert.match(state.error, /18434/); assert.equal(f.processes.length, 0); assert.equal(f.online, true);
});

test('integrated-only adapter uses CPU and an unexpected server exit is visible', async t => {
  const f = fixture(t, { spawn: (record, item) => {
    if (record.args.includes('--list-devices')) process.nextTick(() => { record.child.stdout.end('Vulkan0: AMD Radeon(TM) Graphics (16384 MiB)\n'); record.child.emit('exit', 0); });
    else item.online = true;
  } }); installed(f); f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'ready');
  const server = servers(f)[0]; assert.equal(server.args[server.args.indexOf('--device') + 1], 'none'); server.child.emit('exit', 1);
  assert.equal(f.service.getState().phase, 'error'); assert.equal(f.service.getState().serverReady, false);
});

test('startup queued behind inspection runs once; cancel clears queued startup', async t => {
  for (const cancel of [false, true]) {
    let release;
    const f = fixture(t, { fetch: async (url, request, item) => {
      if (!release) { await new Promise(resolve => { release = resolve; }); if (request.signal.aborted) throw new Error('aborted'); }
      return readyResponse(url, item);
    } }); installed(f);
    const inspection = f.service.inspect(); f.service.ensureInstalledServer(); f.service.ensureInstalledServer();
    if (cancel) f.service.cancel(); release(); await inspection;
    assert.equal((await settled(f.service)).phase, cancel ? 'cancelled' : 'ready'); assert.equal(servers(f).length, cancel ? 0 : 1); assert.equal(downloads(f).length, 0);
  }
});

test('dispose stops only its own server without late publishes', async t => {
  const f = fixture(t); installed(f); f.service.ensureInstalledServer(); await settled(f.service);
  const count = f.notices.length; f.service.dispose(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers(f)[0].child.killed, true); assert.equal(f.notices.length, count); assert.equal(f.service.ensureInstalledServer().ok, false); assert.equal(f.service.installChatModel().ok, false);
});

test('unsupported platforms and invalid manifests do not download', async t => {
  for (const service of [{ platform: 'linux' }, { arch: 'arm64' }, { manifest: {} }]) {
    const f = fixture(t, { service }); f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'error'); assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
  }
});

test('Retry repairs incomplete runtime and corrupt model while retaining the old files', async t => {
  const f = fixture(t);
  const runtime = path.join(f.root, 'chat-runtime'), models = path.join(f.root, 'chat-models');
  fs.mkdirSync(runtime); fs.writeFileSync(path.join(runtime, 'old.dll'), 'preserve me');
  fs.mkdirSync(models); fs.writeFileSync(path.join(models, f.manifest.model.file), 'corrupt model');
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  const oldRuntime = fs.readdirSync(f.root).find(name => name.startsWith('chat-runtime.unverified-'));
  assert.equal(fs.readFileSync(path.join(f.root, oldRuntime, 'old.dll'), 'utf8'), 'preserve me');
  const oldModel = fs.readdirSync(models).find(name => name.startsWith(f.manifest.model.file + '.unverified-'));
  assert.equal(fs.readFileSync(path.join(models, oldModel), 'utf8'), 'corrupt model');
  assert.deepEqual(fs.readFileSync(path.join(models, f.manifest.model.file)), f.model);
});

test('failed replacement validation and extraction leave the original runtime at its original path', async t => {
  for (const outcome of ['bundle', 'extract', 'layout', 'dependencies', 'cancel']) {
    const customSpawn = ['extract', 'layout', 'cancel'].includes(outcome) ? (record, item) => {
      assert.equal(fs.readFileSync(path.join(item.root, 'chat-runtime', 'old.dll'), 'utf8'), 'original runtime');
      assert.ok(record.options.env?.ELYSIA_CHAT_STAGE);
      if (outcome === 'cancel') { item.service.cancel(); return; }
      if (outcome === 'layout') fs.writeFileSync(path.join(record.options.env.ELYSIA_CHAT_STAGE, 'llama-server.exe'), 'incomplete new runtime');
      process.nextTick(() => record.child.emit('exit', outcome === 'extract' ? 71 : 0));
    } : undefined;
    const f = fixture(t, { bundledRuntime: outcome === 'bundle' ? 'corrupt' : true, spawn: customSpawn });
    const runtime = path.join(f.root, 'chat-runtime'); fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'old.dll'), 'original runtime');
    fs.writeFileSync(path.join(f.root, 'preferences.json'), 'keep personal settings');
    if (outcome === 'dependencies') fs.writeFileSync(path.join(f.assetDirectory, f.manifest.runtimeDependencies.archive.file), 'broken dependency archive');
    f.service.installChatModel(); const state = await settled(f.service);
    assert.equal(state.phase, outcome === 'cancel' ? 'cancelled' : 'error');
    assert.equal(fs.readFileSync(path.join(runtime, 'old.dll'), 'utf8'), 'original runtime');
    assert.deepEqual(fs.readdirSync(runtime), ['old.dll']);
    assert.equal(fs.readFileSync(path.join(f.root, 'preferences.json'), 'utf8'), 'keep personal settings');
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('chat-runtime.unverified-') || name.startsWith('chat-staging-')), false);
    assert.equal(downloads(f).length, 0); assert.equal(servers(f).length, 0);
    if (outcome === 'cancel') assert.equal(state.diagnostic, null);
  }
});

test('runtime replacement keeps the original visible until the complete replacement is verified', async t => {
  const f = fixture(t, { bundledRuntime: true });
  const runtime = path.join(f.root, 'chat-runtime'); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'old.dll'), 'original runtime');
  let sawExtract = false, sawDependencies = false;
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (source === runtime) {
      const stages = fs.readdirSync(f.root).filter(name => name.startsWith('chat-staging-'));
      assert.equal(stages.length, 1);
      const replacement = path.join(f.root, stages[0]);
      sawExtract = f.manifest.runtime.required.every(name => fs.existsSync(path.join(replacement, name)));
      sawDependencies = [...f.dependencyFiles].every(([name, bytes]) => fs.readFileSync(path.join(replacement, name)).equals(bytes));
      assert.equal(sawExtract, true); assert.equal(sawDependencies, true);
      assert.equal(fs.existsSync(path.join(replacement, 'elysia-runtime.json')), true);
      assert.equal(fs.readFileSync(path.join(runtime, 'old.dll'), 'utf8'), 'original runtime');
      assert.equal(path.dirname(source), path.dirname(destination), 'backup must be a same-volume sibling rename');
    }
    return originalRename(source, destination);
  };
  try { f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready'); }
  finally { fs.renameSync = originalRename; }
  assert.equal(sawExtract, true); assert.equal(sawDependencies, true);
  const backup = fs.readdirSync(f.root).find(name => name.startsWith('chat-runtime.unverified-'));
  assert.equal(fs.readFileSync(path.join(f.root, backup, 'old.dll'), 'utf8'), 'original runtime');
});

test('failed or cancelled runtime commit restores the original directory without copying it', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t, { bundledRuntime: true });
    const runtime = path.join(f.root, 'chat-runtime'); fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'old.dll'), 'original runtime');
    const originalRename = fs.renameSync; let backedUp = false, restored = false;
    fs.renameSync = (source, destination) => {
      if (source === runtime) {
        originalRename(source, destination); backedUp = true;
        if (cancel) f.service.cancel();
        return;
      }
      if (destination === runtime && path.basename(source).startsWith('chat-staging-')) {
        assert.equal(backedUp, true);
        throw Object.assign(new Error('synthetic commit blocked'), { code: 'EACCES' });
      }
      if (destination === runtime && path.basename(source).startsWith('chat-runtime.unverified-')) restored = true;
      return originalRename(source, destination);
    };
    let state;
    try { f.service.installChatModel(); state = await settled(f.service); }
    finally { fs.renameSync = originalRename; }
    assert.equal(state.phase, cancel ? 'cancelled' : 'error'); assert.equal(restored, true);
    assert.equal(fs.readFileSync(path.join(runtime, 'old.dll'), 'utf8'), 'original runtime');
    assert.deepEqual(fs.readdirSync(runtime), ['old.dll']);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('chat-runtime.unverified-') || name.startsWith('chat-staging-')), false);
    assert.equal(servers(f).length, 0);
  }
});

test('cancellation during the final runtime rename rolls back before removing the new staging files', async t => {
  const f = fixture(t, { bundledRuntime: true });
  const runtime = path.join(f.root, 'chat-runtime'); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'old.dll'), 'original runtime');
  const originalRename = fs.renameSync; let cancelledCommit = false;
  fs.renameSync = (source, destination) => {
    originalRename(source, destination);
    if (destination === runtime && path.basename(source).startsWith('chat-staging-')) {
      cancelledCommit = true; f.service.cancel();
    }
  };
  let state;
  try { f.service.installChatModel(); state = await settled(f.service); }
  finally { fs.renameSync = originalRename; }
  assert.equal(cancelledCommit, true); assert.equal(state.phase, 'cancelled'); assert.equal(state.diagnostic, null);
  assert.deepEqual(fs.readdirSync(runtime), ['old.dll']);
  assert.equal(fs.readFileSync(path.join(runtime, 'old.dll'), 'utf8'), 'original runtime');
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('chat-runtime.unverified-') || name.startsWith('chat-staging-')), false);
  assert.equal(servers(f).length, 0);
});

test('a runtime directory created during preparation is preserved instead of overwritten', async t => {
  const f = fixture(t, { bundledRuntime: true });
  const runtime = path.join(f.root, 'chat-runtime'), originalWrite = fs.promises.writeFile;
  fs.promises.writeFile = async (file, ...args) => {
    const result = await originalWrite(file, ...args);
    if (path.basename(file) === 'elysia-runtime.json' && path.basename(path.dirname(file)).startsWith('chat-staging-')) {
      fs.mkdirSync(runtime); fs.writeFileSync(path.join(runtime, 'concurrent.txt'), 'preserve concurrent resources');
    }
    return result;
  };
  let state;
  try { f.service.installChatModel(); state = await settled(f.service); }
  finally { fs.promises.writeFile = originalWrite; }
  assert.equal(state.phase, 'error'); assert.equal(state.diagnostic.code, 'FS-103');
  assert.deepEqual(fs.readdirSync(runtime), ['concurrent.txt']);
  assert.equal(fs.readFileSync(path.join(runtime, 'concurrent.txt'), 'utf8'), 'preserve concurrent resources');
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('chat-runtime.unverified-') || name.startsWith('chat-staging-')), false);
  assert.equal(servers(f).length, 0);
});

test('explicit retry resumes all durable runtime replacement checkpoints without downloading or extracting again', async t => {
  for (const checkpoint of ['prepared', 'backed-up', 'installed']) {
    const f = fixture(t), transaction = interruptedRuntime(f, checkpoint);
    const before = fs.readdirSync(f.root, { recursive: true }), journalBytes = fs.readFileSync(transaction.journal);
    await f.service.inspect();
    assert.deepEqual(fs.readdirSync(f.root, { recursive: true }), before, 'inspection must not finish a pending transaction');
    assert.deepEqual(fs.readFileSync(transaction.journal), journalBytes);
    f.service.installChatModel(); const state = await settled(f.service);
    assert.equal(state.phase, 'ready'); assert.equal(state.diagnostic, null);
    assert.equal(fs.readFileSync(path.join(transaction.runtime, 'llama-server.exe'), 'utf8'), 'replacement runtime');
    assert.equal(fs.readFileSync(path.join(transaction.backup, 'old.dll'), 'utf8'), 'preserved original runtime');
    assert.equal(fs.existsSync(transaction.journal), false); assert.equal(fs.existsSync(transaction.stage), false);
    assert.equal(downloads(f).length, 0);
    assert.equal(f.processes.some(item => item.options.env?.ELYSIA_CHAT_STAGE || item.options.env?.ELYSIA_CHAT_DEPENDENCY_STAGE), false);
  }
});

test('a pending commit preserves its staging tree and journal until a later explicit retry can finish', async t => {
  const f = fixture(t, { bundledRuntime: true }); installed(f);
  const runtime = path.join(f.root, 'chat-runtime'), journal = path.join(f.root, 'chat-repair-transaction.json');
  fs.unlinkSync(path.join(runtime, 'elysia-runtime.json')); fs.writeFileSync(path.join(runtime, 'old.dll'), 'original runtime');
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === runtime) throw Object.assign(new Error('synthetic commit and rollback interruption'), { code: 'EACCES' });
    return originalRename(source, destination);
  };
  let failed;
  try { f.service.installChatModel(); failed = await settled(f.service); }
  finally { fs.renameSync = originalRename; }
  assert.equal(failed.phase, 'error'); assert.equal(fs.existsSync(runtime), false);
  const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));
  const stage = path.join(f.root, transaction.stage), backup = path.join(f.root, `chat-runtime.unverified-${transaction.id}`);
  assert.equal(fs.existsSync(path.join(stage, 'elysia-runtime.json')), true);
  assert.equal(fs.readFileSync(path.join(backup, 'old.dll'), 'utf8'), 'original runtime');
  const extracted = f.processes.filter(item => item.options.env?.ELYSIA_CHAT_STAGE || item.options.env?.ELYSIA_CHAT_DEPENDENCY_STAGE).length;
  await f.service.inspect(); assert.equal(fs.existsSync(runtime), false); assert.equal(fs.existsSync(journal), true);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(fs.existsSync(journal), false); assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.readFileSync(path.join(backup, 'old.dll'), 'utf8'), 'original runtime');
  assert.equal(f.processes.filter(item => item.options.env?.ELYSIA_CHAT_STAGE || item.options.env?.ELYSIA_CHAT_DEPENDENCY_STAGE).length, extracted);
  assert.equal(downloads(f).length, 0);
});

test('preview and read-only inspection leave an interrupted replacement and original backup untouched', async t => {
  const f = fixture(t, { service: { allowDownloads: false } }), transaction = interruptedRuntime(f, 'backed-up');
  const before = fs.readdirSync(f.root, { recursive: true }), journalBytes = fs.readFileSync(transaction.journal);
  await f.service.inspect(); f.service.ensureInstalledServer(); await settled(f.service);
  assert.equal(f.service.installChatModel().ok, false);
  assert.equal(fs.existsSync(transaction.runtime), false);
  assert.deepEqual(fs.readdirSync(f.root, { recursive: true }), before);
  assert.deepEqual(fs.readFileSync(transaction.journal), journalBytes);
  assert.equal(fs.readFileSync(path.join(transaction.backup, 'old.dll'), 'utf8'), 'preserved original runtime');
  assert.equal(f.processes.length, 0); assert.equal(downloads(f).length, 0);
});

test('complete existing GGUF repairs missing, invalid and outdated markers without downloading or replacing model bytes', async t => {
  for (const marker of [null, '{broken', JSON.stringify({ bytes: 1, sha256: '0'.repeat(64) })]) {
    const f = fixture(t, { fetch: (url, request, item) => {
      assert.ok(url.startsWith(SETUP_BASE_URL), 'matching GGUF must not request a download');
      return readyResponse(url, item);
    } }); installed(f);
    const model = path.join(f.root, 'chat-models', f.manifest.model.file), markerPath = path.join(f.root, 'chat-models', 'elysia-model.json');
    const before = fs.statSync(model);
    if (marker === null) fs.unlinkSync(markerPath); else fs.writeFileSync(markerPath, marker);
    assert.equal((await f.service.inspect()).modelReady, false);
    f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
    const restored = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(restored.sha256, hash(f.model)); assert.equal(restored.bytes, f.model.length);
    assert.equal(restored.modifiedAt, before.mtimeMs);
    assert.deepEqual(fs.readFileSync(model), f.model); assert.equal(fs.statSync(model).ino, before.ino);
    assert.equal(fs.statSync(model).mtimeMs, before.mtimeMs); assert.equal(downloads(f).length, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(model)).sort(), [f.manifest.model.file, 'elysia-model.json'].sort());
  }
});

test('preview does not regenerate a missing model marker or repair an incomplete runtime', async t => {
  const f = fixture(t, { service: { allowDownloads: false } }); installed(f);
  const runtime = path.join(f.root, 'chat-runtime'), marker = path.join(f.root, 'chat-models', 'elysia-model.json');
  fs.unlinkSync(marker); fs.unlinkSync(path.join(runtime, f.manifest.runtime.required[0]));
  const before = fs.readdirSync(f.root, { recursive: true });
  f.service.ensureInstalledServer(); await settled(f.service);
  assert.equal(f.service.installChatModel().ok, false); await f.service.inspect();
  assert.deepEqual(fs.readdirSync(f.root, { recursive: true }), before);
  assert.equal(fs.existsSync(marker), false); assert.equal(f.processes.length, 0); assert.equal(downloads(f).length, 0);
});

test('same-size model edits invalidate readiness and startup does not load the changed file', async t => {
  const f = fixture(t); installed(f);
  const model = path.join(f.root, 'chat-models', f.manifest.model.file);
  fs.writeFileSync(model, Buffer.alloc(f.model.length));
  fs.utimesSync(model, new Date(), new Date(Date.now() + 10000));
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'needs-model');
  assert.equal(servers(f).length, 0); assert.equal(downloads(f).length, 0);
});

test('missing required DLL invalidates runtime and explicit retry repairs it', async t => {
  for (const filename of ['llama-server-impl.dll', 'mtmd.dll']) {
  const f = fixture(t); installed(f);
  fs.unlinkSync(path.join(f.root, 'chat-runtime', filename));
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'needs-install'); assert.equal(servers(f).length, 0);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.ok(fs.existsSync(path.join(f.root, 'chat-runtime', filename)));
  assert.deepEqual(downloads(f).map(call => call.url), [f.manifest.runtime.url]);
  }
});

test('pinned Hugging Face model follows the official CDN redirect used by the live asset', async t => {
  const f = fixture(t, { fetch: async (url, request, item) => {
    if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
    if (url === item.manifest.runtime.url) return new Response(item.runtime);
    if (url === item.manifest.model.url) return new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/model-blob' } });
    assert.equal(url, 'https://us.aws.cdn.hf.co/model-blob'); return new Response(item.model);
  } });
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
});

test('bundled llama.cpp and an existing model configure without external downloads', async t => {
  const f = fixture(t, { bundledRuntime: true });
  const models = path.join(f.root, 'chat-models'); fs.mkdirSync(models);
  fs.writeFileSync(path.join(models, f.manifest.model.file), f.model);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(downloads(f).length, 0);
  const extractor = f.processes.find(item => item.options.env?.ELYSIA_CHAT_ARCHIVE);
  assert.equal(extractor.options.env.ELYSIA_CHAT_ARCHIVE, path.join(f.assetDirectory, f.manifest.runtime.file));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'chat-downloads')), []);
});

test('packaged resourcesPath alone supplies both runtime and private dependencies without GitHub access', async t => {
  const f = fixture(t, { bundledRuntime: true, packagedResources: true });
  const models = path.join(f.root, 'chat-models'); fs.mkdirSync(models);
  fs.writeFileSync(path.join(models, f.manifest.model.file), f.model);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(downloads(f).length, 0);
  assert.equal(f.processes.find(item => item.options.env?.ELYSIA_CHAT_ARCHIVE).options.env.ELYSIA_CHAT_ARCHIVE,
    path.join(f.assetDirectory, f.manifest.runtime.file));
  assert.equal(f.processes.find(item => item.options.env?.ELYSIA_CHAT_DEPENDENCY_ARCHIVE).options.env.ELYSIA_CHAT_DEPENDENCY_ARCHIVE,
    path.join(f.assetDirectory, f.manifest.runtimeDependencies.archive.file));
});

test('missing or damaged mandatory runtime bundle stops before any external download', async t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t, { bundledRuntime: corrupt ? 'corrupt' : true });
    if (!corrupt) fs.unlinkSync(path.join(f.assetDirectory, f.manifest.runtime.file));
    f.service.installChatModel(); const state = await settled(f.service);
    assert.equal(state.phase, 'error'); assert.match(state.error, /安装包中的聊天运行环境缺失或校验失败/);
    assert.equal(downloads(f).length, 0); assert.equal(f.processes.length, 0);
  }
});

test('ModelScope primary follows only its digest-specific CDN object', async t => {
  const f = fixture(t, { domesticSources: true, bundledRuntime: true, fetch: async (url, request, item) => {
    if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
    const digest = item.manifest.model.sha256;
    const target = `https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest.slice(4)}?signed=example`;
    if (url === item.manifest.model.sources[0]) return new Response(null, { status: 302, headers: { location: target } });
    assert.equal(url, target); return new Response(item.model);
  } });
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(downloads(f).length, 2);
  assert.equal(downloads(f)[0].url, f.manifest.model.sources[0]);
  assert.equal(downloads(f).some(item => item.url === f.manifest.model.url), false);
});

test('unavailable domestic source automatically falls back to the pinned original', async t => {
  const f = fixture(t, { domesticSources: true, bundledRuntime: true, fetch: async (url, request, item) => {
    if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
    if (url === item.manifest.model.sources[0]) return new Response(null, { status: 503 });
    assert.equal(url, item.manifest.model.url); return new Response(item.model);
  } });
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.deepEqual(downloads(f).map(item => item.url), f.manifest.model.sources);
  assert.ok(f.notices.some(item => item.message.includes('切换聊天资源下载源')));
});

test('ModelScope redirect cannot switch to an unrelated CDN object or host', async t => {
  for (const target of ['https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/aa/bb/unrelated', 'https://malicious.modelscope.cn/model']) {
    const f = fixture(t, { domesticSources: true, bundledRuntime: true, fetch: async (url, request, item) => {
      if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
      if (url === item.manifest.model.sources[0]) return new Response(null, { status: 302, headers: { location: target } });
      assert.equal(url, item.manifest.model.url); return new Response(item.model);
    } });
    f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
    assert.equal(downloads(f).some(item => item.url === target), false);
  }
});

test('untrusted or mutable ModelScope manifest sources are rejected before networking', async t => {
  for (const source of [
    'https://www.modelscope.cn/models/empero-ai/Qwen3.8-9B-Distill-GGUF/resolve/master/Qwen3.8-9B-Q4_K_M.gguf',
    'http://www.modelscope.cn/models/empero-ai/Qwen3.8-9B-Distill-GGUF/resolve/' + 'a'.repeat(40) + '/Qwen3.8-9B-Q4_K_M.gguf',
    'https://unexpected.example/model.gguf',
  ]) {
    const manifest = structuredClone(originalManifest); manifest.model.sources = [source];
    const f = fixture(t, { service: { manifest } });
    f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'error');
    assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
  }
});

test('read-only inspection distinguishes missing files, old markers and damaged resources', async t => {
  const scenarios = [
    { code: 'RUN-102', remove: ['chat-runtime', 'llama-server.exe'], missing: 'llama-server.exe' },
    { code: 'RUN-109', remove: ['chat-runtime', 'elysia-runtime.json'] },
    { code: 'RUN-110', change: ['chat-runtime', 'elysia-runtime.json'], bytes: '{bad json' },
    { code: 'RUN-111', change: ['chat-runtime', 'elysia-runtime.json'], marker: 'runtime' },
    { code: 'RUN-104', removeModel: true },
    { code: 'RUN-112', remove: ['chat-models', 'elysia-model.json'] },
    { code: 'RUN-113', change: ['chat-models', 'elysia-model.json'], bytes: 'null' },
    { code: 'RUN-114', change: ['chat-models', 'elysia-model.json'], marker: 'model' },
    { code: 'RUN-105', damageModel: true },
    { code: 'RUN-106', removeDependency: true },
    { code: 'RUN-107', damageDependency: true },
  ];
  for (const scenario of scenarios) {
    const f = fixture(t, { service: { allowDownloads: false } }); installed(f);
    const modelFile = path.join(f.root, 'chat-models', f.manifest.model.file);
    const dependencyFile = path.join(f.root, 'chat-runtime', f.manifest.runtimeDependencies.files[0].file);
    if (scenario.remove) fs.unlinkSync(path.join(f.root, ...scenario.remove));
    if (scenario.change) fs.writeFileSync(path.join(f.root, ...scenario.change), scenario.marker
      ? JSON.stringify({ ...f.manifest[scenario.marker], sha256: '0'.repeat(64) }) : scenario.bytes);
    if (scenario.removeModel) fs.unlinkSync(modelFile);
    if (scenario.damageModel) fs.writeFileSync(modelFile, 'damaged');
    if (scenario.removeDependency) fs.unlinkSync(dependencyFile);
    if (scenario.damageDependency) fs.writeFileSync(dependencyFile, 'damaged');
    const originalFiles = fs.readdirSync(f.root, { recursive: true });
    const first = await f.service.inspect(), second = await f.service.inspect();
    assert.equal(first.diagnostic.code, scenario.code); assert.deepEqual(second.diagnostic, first.diagnostic);
    if (scenario.missing) assert.ok(first.diagnostic.details.missingFiles.includes(scenario.missing));
    assert.equal(f.processes.length, 0); assert.equal(downloads(f).length, 0);
    assert.deepEqual(fs.readdirSync(f.root, { recursive: true }), originalFiles);
  }
});

test('download diagnosis survives repeated read-only checks until a successful explicit retry', async t => {
  let fail = true;
  const f = fixture(t, { fetch: (url, request, item) => {
    if (url.startsWith(SETUP_BASE_URL)) return readyResponse(url, item);
    if (fail) throw new Error('request https://private.invalid/resource?token=secret', { cause: Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }) });
    return new Response(url === item.manifest.runtime.url ? item.runtime : item.model);
  } });
  f.service.installChatModel(); const failed = await settled(f.service);
  assert.equal(failed.diagnostic.code, 'NET-101');
  assert.equal(failed.diagnostic.stage, 'download');
  assert.equal(failed.diagnostic.details.systemCode, 'ENOTFOUND');
  for (let count = 0; count < 2; count++) assert.deepEqual((await f.service.inspect()).diagnostic, failed.diagnostic);
  assert.doesNotMatch(JSON.stringify(failed.diagnostic), /private|secret|https:|DNS failed/);
  fail = false; f.service.installChatModel();
  assert.equal(f.service.getState().diagnostic, null);
  const ready = await settled(f.service); assert.equal(ready.phase, 'ready'); assert.equal(ready.diagnostic, null);
});

test('extraction failures retain controlled category and exit status through setup', async t => {
  for (const [exitCode, code] of [[70, 'EXT-106'], [71, 'EXT-107'], [72, 'FS-101'], [73, 'FS-102'], [79, 'EXT-104']]) {
    const f = fixture(t, { spawn: record => process.nextTick(() => record.child.emit('exit', exitCode)) });
    f.service.installChatModel(); const state = await settled(f.service);
    assert.equal(state.diagnostic.code, code); assert.equal(state.diagnostic.stage, 'extract');
    assert.equal(state.diagnostic.details.exitCode, exitCode); assert.equal(servers(f).length, 0);
    assert.deepEqual((await f.service.inspect()).diagnostic, state.diagnostic);
  }
});

test('server launch, premature exit, readiness timeout and protocol errors stay distinct', async t => {
  for (const scenario of ['launch', 'exit', 'timeout', 'protocol']) {
    const f = fixture(t, { service: { startTimeoutMs: 8 }, spawn: (record, item) => {
      if (record.args.includes('--list-devices')) { process.nextTick(() => record.child.emit('exit', 0)); return; }
      if (scenario === 'launch') throw new Error('private launch details');
      if (scenario === 'exit') process.nextTick(() => record.child.emit('exit', 7));
      if (scenario === 'protocol') item.online = true;
    }, fetch: (url, request, item) => {
      if (!item.online) throw new Error('offline');
      return json({ status: 'wrong-service' });
    } }); installed(f);
    f.service.ensureInstalledServer(); const state = await settled(f.service);
    assert.equal(state.diagnostic.code, ({ launch: 'RUN-202', exit: 'RUN-203', timeout: 'RUN-204', protocol: 'RUN-205' })[scenario]);
    if (scenario === 'exit') assert.equal(state.diagnostic.details.exitCode, 7);
    for (let count = 0; count < 2; count++) assert.deepEqual((await f.service.inspect()).diagnostic, state.diagnostic);
    assert.equal(downloads(f).length, 0);
  }
});

test('a recovered port clears its prior conflict while an unexpected owned-server exit stays visible', async t => {
  const f = fixture(t); installed(f); f.online = true;
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).diagnostic.code, 'RUN-201');
  f.online = false; assert.equal((await f.service.inspect()).diagnostic, null);
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).diagnostic, null);
  f.online = false; servers(f)[0].child.emit('exit', 12);
  assert.equal(f.service.getState().diagnostic.code, 'RUN-203');
  assert.equal(f.service.getState().diagnostic.details.exitCode, 12);
  assert.equal((await f.service.inspect()).diagnostic.code, 'RUN-203');
});

test('unidentified and filesystem failures do not become generic download failures', async t => {
  for (const [systemCode, code] of [[null, 'SETUP-999'], ['EIO', 'FS-105'], ['EACCES', 'FS-102'], ['ENOSPC', 'FS-101']]) {
    const f = fixture(t), originalMkdir = fs.promises.mkdir;
    fs.promises.mkdir = async () => { throw Object.assign(new Error('private filesystem details'), systemCode ? { code: systemCode } : {}); };
    let state;
    try { f.service.installChatModel(); state = await settled(f.service); }
    finally { fs.promises.mkdir = originalMkdir; }
    assert.equal(state.diagnostic.code, code); assert.doesNotMatch(state.error, /下载|网络|private/);
    if (systemCode) assert.equal(state.diagnostic.details.systemCode, systemCode);
    assert.equal(downloads(f).length, 0); assert.equal(f.processes.length, 0);
  }
});

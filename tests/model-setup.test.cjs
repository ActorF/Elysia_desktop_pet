'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { createModelSetup, SETUP_MODEL, SETUP_BASE_URL } = require('../electron/model-setup.cjs');
const originalManifest = require('../electron/chat-bootstrap-manifest.json');
const { EXTRACT_SCRIPT } = require('../electron/chat-runtime-extract.cjs');
const json = value => new Response(JSON.stringify(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-llama-test-'));
  const runtime = Buffer.from('test runtime archive'), model = Buffer.from('GGUFtest model bytes');
  const manifest = structuredClone(originalManifest);
  for (const [key, bytes] of [['runtime', runtime], ['model', model]]) Object.assign(manifest[key], { bytes: bytes.length, sha256: hash(bytes) });
  const calls = [], processes = [], notices = [];
  const f = { root, manifest, runtime, model, calls, processes, notices, online: false };
  const spawnImpl = (file, args, spawnOptions) => {
    const actualArgs = args;
    if (spawnOptions.env?.ELYSIA_CHAT_ARGS) args = JSON.parse(spawnOptions.env.ELYSIA_CHAT_ARGS);
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; if (args.includes('--model')) f.online = false; process.nextTick(() => child.emit('exit', 1)); return true; };
    const record = { file, args, actualArgs, options: spawnOptions, child }; processes.push(record);
    if (options.spawn) { options.spawn(record, f); return child; }
    if (spawnOptions.env?.ELYSIA_CHAT_SERVER) f.online = true;
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
  f.service = createModelSetup({ userData: root, platform: 'win32', arch: 'x64', manifest,
    env: { SystemRoot: 'C:\\Windows' }, fetchImpl, spawnImpl, onChange: value => notices.push(value),
    startTimeoutMs: 100, pollIntervalMs: 1, ...options.service });
  t.after(() => { f.service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
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
  fs.writeFileSync(path.join(runtime, 'elysia-runtime.json'), JSON.stringify(f.manifest.runtime));
  fs.writeFileSync(path.join(models, f.manifest.model.file), f.model);
  fs.writeFileSync(path.join(models, 'elysia-model.json'), JSON.stringify({ ...f.manifest.model, modifiedAt: fs.statSync(path.join(models, f.manifest.model.file)).mtimeMs }));
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
  for (const [flag, value] of [['--alias', SETUP_MODEL], ['--host', '127.0.0.1'], ['--port', '18434'], ['--ctx-size', '8192'], ['--parallel', '1'], ['--fit-target', '3072'], ['--device', 'Vulkan0'], ['--reasoning-budget', '0']]) assert.equal(server.args[server.args.indexOf(flag) + 1], value);
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

test('same-size model edits invalidate readiness and startup does not load the changed file', async t => {
  const f = fixture(t); installed(f);
  const model = path.join(f.root, 'chat-models', f.manifest.model.file);
  fs.writeFileSync(model, Buffer.alloc(f.model.length));
  fs.utimesSync(model, new Date(), new Date(Date.now() + 10000));
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'needs-model');
  assert.equal(servers(f).length, 0); assert.equal(downloads(f).length, 0);
});

test('missing required DLL invalidates runtime and explicit retry repairs it', async t => {
  const f = fixture(t); installed(f);
  fs.unlinkSync(path.join(f.root, 'chat-runtime', 'llama-server-impl.dll'));
  f.service.ensureInstalledServer(); assert.equal((await settled(f.service)).phase, 'needs-install'); assert.equal(servers(f).length, 0);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.ok(fs.existsSync(path.join(f.root, 'chat-runtime', 'llama-server-impl.dll')));
  assert.deepEqual(downloads(f).map(call => call.url), [f.manifest.runtime.url]);
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

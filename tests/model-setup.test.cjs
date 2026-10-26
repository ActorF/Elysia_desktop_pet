/** First-run installation boundary, streaming progress, cancellation and retries. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createModelSetup, SETUP_MODEL, SETUP_BASE_URL, MODEL_BYTES } = require('../electron/model-setup.cjs');

const json = object => new Response(JSON.stringify(object));
const models = ready => json({ models: ready ? [{ name: SETUP_MODEL }] : [] });
const stream = lines => new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-setup-test-'));
  const notices = [], processes = [];
  const env = { LOCALAPPDATA: path.join(root, 'local'), SystemRoot: 'C:\\Windows' };
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.unref = () => { child.unrefed = true; };
    processes.push({ file, args, options, child });
    process.nextTick(() => child.emit('exit', 0));
    return child;
  };
  const service = createModelSetup({ userData: root, env, platform: 'win32', spawnImpl,
    onChange: state => notices.push(state), startTimeoutMs: 100, pollIntervalMs: 1, ...overrides });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, env, service, notices, processes };
}
async function settled(service) {
  const deadline = Date.now() + 3000;
  while (service.getState().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.getState().busy, false, 'setup did not settle');
  await new Promise(resolve => setImmediate(resolve));
  return service.getState();
}
function localApp(fixture) {
  const file = path.join(fixture.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama app.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'local-test');
  return file;
}

test('construction is inert; inspection detects existing model without downloading or starting processes', async t => {
  const requests = [];
  const f = fixture(t, { fetchImpl: async (url, options) => { requests.push({ url, options }); return models(true); } });
  assert.equal(requests.length, 0);
  assert.equal(f.service.getState().expectedModelBytes, MODEL_BYTES);
  const state = await f.service.inspect();
  assert.equal(state.phase, 'ready'); assert.equal(state.modelReady, true);
  assert.deepEqual(requests.map(request => request.url), [`${SETUP_BASE_URL}/api/tags`]);
  assert.equal(f.processes.length, 0);
  state.modelReady = false; assert.equal(f.service.getState().modelReady, true);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('inspection of an offline service never installs or launches even when a binary exists', async t => {
  const f = fixture(t, { fetchImpl: async () => { throw new Error('offline'); } });
  localApp(f);
  assert.equal((await f.service.inspect()).phase, 'needs-install');
  assert.equal(f.processes.length, 0);
});

test('existing Ollama streams fixed model progress and verifies tags before reporting ready', async t => {
  let pulled = false; const requests = [];
  const f = fixture(t, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/tags')) return models(pulled);
    pulled = true;
    return stream([{ status: 'pulling manifest' }, { digest: 'one', total: 100, completed: 40 },
      { digest: 'one', total: 100, completed: 100 }, { status: 'verifying sha256 digest' }, { status: 'success' }]);
  } });
  assert.equal(f.service.installChatModel().ok, true);
  assert.equal(f.service.installChatModel().ok, false);
  const state = await settled(f.service);
  assert.equal(state.phase, 'ready'); assert.equal(state.progress, 1);
  const pull = requests.find(request => request.url.endsWith('/api/pull'));
  assert.deepEqual(JSON.parse(pull.options.body), { model: SETUP_MODEL, stream: true });
  assert.equal(pull.options.redirect, 'error');
  assert.equal(f.processes.length, 0);
  assert.ok(f.notices.some(notice => notice.phase === 'pulling-model'));
});

test('a failed or incomplete download preserves a retry path without exposing remote error strings', async t => {
  let tries = 0, ready = false;
  const f = fixture(t, { fetchImpl: async url => {
    if (url.endsWith('/api/tags')) return models(ready);
    if (++tries === 1) return stream([{ error: 'SECRET server message' }]);
    ready = true; return stream([{ status: 'success' }]);
  } });
  f.service.installChatModel();
  assert.equal((await settled(f.service)).phase, 'error');
  assert.doesNotMatch(f.service.getState().error, /SECRET/);
  f.service.installChatModel();
  assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(tries, 2);
});

test('cancelling an active pull aborts its reader and a retry can finish', async t => {
  let signal, cancelled = false, count = 0, ready = false;
  const f = fixture(t, { fetchImpl: async (url, options) => {
    if (url.endsWith('/api/tags')) return models(ready);
    signal = options.signal;
    if (++count === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    ready = true; return stream([{ status: 'success' }]);
  } });
  f.service.installChatModel();
  while (!signal) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.cancel().ok, true);
  assert.equal((await settled(f.service)).phase, 'cancelled');
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
});

test('existing inactive Ollama launches hidden without killing the independent server on dispose', async t => {
  let online = false, f;
  f = fixture(t, { fetchImpl: async () => { if (!online) throw new Error('offline'); return models(true); },
    spawnImpl: (file, args, options) => {
      assert.equal(path.basename(file), 'ollama app.exe'); assert.deepEqual(args, []);
      assert.equal(options.windowsHide, true); assert.equal(options.detached, true); assert.equal(options.shell, false);
      online = true; const child = new EventEmitter(); child.unref = () => {}; child.kill = () => assert.fail('shared server killed'); return child;
    } });
  localApp(f); f.service.installChatModel();
  assert.equal((await settled(f.service)).phase, 'ready'); f.service.dispose();
});

test('new installation follows official redirects, verifies signature, uses per-user Inno flags, and cleans its installer', async t => {
  let online = false, f; const spawned = [], urls = [];
  f = fixture(t, { fetchImpl: async url => {
    urls.push(url);
    if (url.endsWith('/api/tags')) { if (!online) throw new Error('offline'); return models(true); }
    if (url === 'https://ollama.com/download/OllamaSetup.exe') return new Response(null, { status: 302,
      headers: { location: 'https://github.com/ollama/ollama/releases/download/v1.2.3/OllamaSetup.exe' } });
    return new Response('MZtest-installer');
  }, spawnImpl: (file, args, options) => {
    spawned.push({ file, args, options });
    const child = new EventEmitter(); child.kill = () => {}; child.unref = () => {};
    if (path.basename(file).startsWith('OllamaSetup-')) {
      assert.equal(f.service.getState().canCancel, false);
      assert.equal(f.service.cancel().ok, false);
      localApp(f);
    }
    if (path.basename(file) === 'ollama app.exe') online = true;
    process.nextTick(() => child.emit('exit', 0)); return child;
  } });
  f.service.installChatModel(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(spawned.length, 3);
  const signature = spawned[0];
  assert.equal(path.basename(signature.file), 'powershell.exe');
  const program = Buffer.from(signature.args.at(-1), 'base64').toString('utf16le');
  assert.match(program, /Get-AuthenticodeSignature/); assert.match(program, /Ollama Inc/);
  assert.doesNotMatch(program, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(signature.options.env.ELYSIA_OLLAMA_INSTALLER.startsWith(path.join(f.root, 'setup-downloads')));
  assert.deepEqual(spawned[1].args, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-']);
  assert.ok(spawned.every(item => item.options.windowsHide === true && item.options.shell === false));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'setup-downloads')), []);
  assert.ok(urls.includes('https://github.com/ollama/ollama/releases/download/v1.2.3/OllamaSetup.exe'));
});

test('untrusted redirect and invalid publisher signature never run an installer', async t => {
  for (const mode of ['redirect', 'signature']) {
    const f = fixture(t, { fetchImpl: async url => {
      if (url.endsWith('/api/tags')) throw new Error('offline');
      return mode === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://example.com/evil.exe' } }) : new Response('MZtest-installer');
    }, spawnImpl: (file, args, options) => {
      assert.equal(mode, 'signature'); assert.equal(path.basename(file), 'powershell.exe');
      const child = new EventEmitter(); child.kill = () => {}; process.nextTick(() => child.emit('exit', 1)); return child;
    } });
    f.service.installChatModel(); const state = await settled(f.service);
    assert.equal(state.phase, 'error');
    assert.match(state.error, mode === 'redirect' ? /来源或文件校验/ : /数字签名/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'setup-downloads')), []);
  }
});

test('truncated model stream and false success cannot report a model as ready', async t => {
  for (const response of [stream([{ status: 'pulling manifest' }]), stream([{ status: 'success' }])]) {
    const f = fixture(t, { fetchImpl: async url => url.endsWith('/api/tags') ? models(false) : response });
    f.service.installChatModel(); const state = await settled(f.service);
    assert.equal(state.phase, 'error'); assert.equal(state.modelReady, false);
  }
});

test('dispose cancels setup without publishing late updates or accepting another install', async t => {
  let signal;
  const f = fixture(t, { fetchImpl: async (url, options) => {
    if (url.endsWith('/api/tags')) return models(false);
    signal = options.signal; return new Response(new ReadableStream());
  } });
  f.service.installChatModel();
  while (!signal) await new Promise(resolve => setImmediate(resolve));
  const count = f.notices.length;
  f.service.dispose(); await settled(f.service);
  assert.equal(signal.aborted, true); assert.equal(f.notices.length, count);
  assert.equal(f.service.installChatModel().ok, false);
});

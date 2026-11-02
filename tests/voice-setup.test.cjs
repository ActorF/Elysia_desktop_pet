/** Verify isolated voice deployment without downloading or launching real models. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createVoiceSetup } = require('../electron/voice-setup.cjs');
const hash = content => createHash('sha256').update(content).digest('hex');
const write = (root, name, data = 'fixture') => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const runtimeName = 'GPT-SoVITS-v2-240821';
const modelScopeRuntime = `https://www.modelscope.cn/models/fixture/voice-runtime/resolve/${'a'.repeat(40)}/${runtimeName}.7z`;
const modelScopeCdn = sha256 => `https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256.slice(4)}`;
const assetsFiles = ['config/settings.py', 'python/python.exe', 'python/python314.zip', 'voice/managed_gpt_sovits.py',
  'scripts/gpt_sovits_worker.py', 'workspace/settings/voice-profiles.json', `models/cache/${runtimeName}/runtime/nltk_data/overlay`];
const anchors = Array.from({ length: 20 }, (_, index) => `models/cache/${runtimeName}/runtime/anchor${index}`);
function fixture(t, overrides = {}) {
  const { mutateManifest, ...serviceOverrides } = overrides;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-voice-setup-'));
  const userData = path.join(root, 'data'), resources = path.join(root, 'resources'), offline = path.join(root, 'offline');
  const assets = Buffer.from('zip fixture'), runtime = Buffer.from('7z fixture'), executable = Buffer.from('7za fixture');
  const descriptor = (fileName, data, url) => ({ fileName, bytes: data.length, sha256: hash(data), url });
  const manifest = { version: 1,
    assets: descriptor('assets.zip', assets, 'https://github.com/ActorF/Elysia_desktop_pet/releases/download/test/assets.zip'),
    runtime: descriptor('runtime.7z', runtime, 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/test/runtime.7z'),
    extractor: { relativePath: 'tools/7za.exe', sha256: hash(executable) } };
  mutateManifest?.(manifest);
  write(resources, 'tools/7za.exe', executable);
  const calls = [], notices = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { child.killed = true; process.nextTick(() => child.emit('close', 1)); };
    process.nextTick(() => {
      if (args[0] === 'l') child.stdout.write('Path = fixture\r\nType = 7z\r\n\r\n----------\r\nPath = safe\r\nSize = 1\r\nAttributes = A\r\n\r\n');
      if (args[0] === 'x') {
        const destination = args.find(arg => arg.startsWith('-o')).slice(2);
        if (args.at(-1).endsWith('.7z')) {
          write(destination, `${runtimeName}/runtime/python.exe`);
          for (let index = 0; index < 20; index++) write(destination, `${runtimeName}/runtime/anchor${index}`);
        } else for (const name of assetsFiles) write(destination, name);
      }
      if (args[0] === '-I') child.stdout.write(JSON.stringify({ required: anchors }));
      child.stdout.end(); child.emit('close', 0);
    });
    return child;
  };
  const service = createVoiceSetup({ userData, resourcesPath: resources, assetDirectory: offline, manifest,
    env: {}, spawnImpl, onChange: value => notices.push(value), fetchImpl: async url => new Response(url.endsWith('.zip') ? assets : runtime), ...serviceOverrides });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, userData, resources, offline, manifest, assets, runtime, service, calls, notices, spawnImpl };
}
async function settled(service) {
  const deadline = Date.now() + 3000;
  while (service.getState().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.getState().busy, false, 'voice setup did not settle');
  return service.getState();
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'expected download progress did not arrive');
}

test('construction and inspection do not download, create user state or launch interpreters', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('unexpected download') });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.inspect()).phase, 'needs-install');
  assert.equal(fs.existsSync(f.userData), false);
  assert.equal(f.service.getProjectRoot(), path.join(f.userData, 'voice-runtime'));
});

test('verified offline archives deploy runtime then overlays and validate before ready', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('offline cache should be reused') });
  write(f.offline, 'assets.zip', f.assets); write(f.offline, 'runtime.7z', f.runtime);
  f.service.install(); assert.equal(f.service.install().ok, false);
  assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(f.service.getState().ready, true);
  const extracts = f.calls.filter(call => call.args[0] === 'x');
  assert.ok(extracts[0].args.at(-1).endsWith('runtime.7z'));
  assert.ok(extracts[1].args.at(-1).endsWith('assets.zip'));
  assert.ok(fs.existsSync(path.join(f.service.getProjectRoot(), `models/cache/${runtimeName}/runtime/nltk_data/overlay`)));
  const validate = f.calls.at(-1);
  assert.equal(path.basename(validate.file), 'python.exe'); assert.equal(validate.args[0], '-I');
  assert.match(validate.args[3], /compute_runtime_manifest_digest\(runtime\)/);
  assert.match(validate.args[3], /hashlib.file_digest/);
  assert.ok(f.calls.every(call => call.options.windowsHide && call.options.shell === false));
  assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
  const count = f.calls.length;
  assert.equal((await f.service.inspect()).ready, true); assert.equal(f.calls.length, count);
  fs.rmSync(path.join(f.service.getProjectRoot(), anchors[0]));
  assert.equal((await f.service.inspect()).ready, false);
});

test('network archives are hash checked, cached, and no incomplete project is reported ready', async t => {
  const f = fixture(t);
  f.service.install(); const state = await settled(f.service);
  assert.equal(state.phase, 'ready');
  const cache = fs.readdirSync(path.join(f.userData, 'voice-downloads'));
  assert.equal(cache.length, 2); assert.ok(cache.every(name => !name.endsWith('.part')));
  assert.ok(f.notices.some(notice => notice.phase === 'validating'));
});

test('bad digests and off-host redirects never reach the extraction process', async t => {
  for (const [response, expectedError] of [
    [() => new Response('zip corrupt'), /校验/],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example/asset.zip' } }), /下载/],
  ]) {
    const f = fixture(t, { fetchImpl: async () => response() });
    f.service.install(); const state = await settled(f.service);
    assert.equal(state.phase, 'error'); assert.match(state.error, expectedError);
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
    assert.deepEqual(fs.readdirSync(path.join(f.userData, 'voice-downloads')), []);
  }
});

test('an unavailable download is retryable without claiming the resource was never published', async t => {
  const f = fixture(t, { fetchImpl: async () => new Response('', { status: 404 }) });
  f.service.install(); const state = await settled(f.service);
  assert.equal(state.phase, 'error'); assert.equal(state.ready, false); assert.match(state.error, /下载未完成/);
  assert.doesNotMatch(state.error, /尚未发布/);
});

test('the pinned Hugging Face archive may redirect to its current official CDN', async t => {
  let f; const visited = [];
  f = fixture(t, { fetchImpl: async url => {
    visited.push(url);
    if (url.includes('huggingface.co/')) return new Response(null, { status: 302,
      headers: { location: 'https://us.aws.cdn.hf.co/xet-bridge-us/fixture?signature=opaque' } });
    return new Response(url.endsWith('.zip') ? f.assets : f.runtime);
  } });
  f.service.install(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.ok(visited.some(url => url.startsWith('https://us.aws.cdn.hf.co/')));
});

test('archive traversal, drive paths, Windows aliases, duplicates and links are rejected before extraction', async t => {
  for (const record of ['Path = ../escape\nSize = 1', 'Path = C:\\escape\nSize = 1', 'Path = safe:ads\nSize = 1',
    'Path = AUX.txt\nSize = 1', 'Path = folder.\nSize = 0', 'Path = safe\nSymbolic Link = ../escape',
    'Path = safe\nAttributes = A_ lrwxrwxrwx', 'Path = safe\n\nPath = SAFE']) {
    const f = fixture(t, { spawnImpl: (file, args) => {
      assert.equal(args[0], 'l', 'unsafe archive was extracted');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
      process.nextTick(() => { child.stdout.write('----------\n' + record + '\n'); child.stdout.end(); child.emit('close', 0); }); return child;
    } });
    f.service.install(); assert.equal((await settled(f.service)).phase, 'error');
    assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
    assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
  }
});

test('cancel retains a partial and retry resumes it while preserving unrelated user data', async t => {
  let signal, cancelled = false, f, requests = 0;
  f = fixture(t, { fetchImpl: async (url, options) => {
    requests++;
    if (url.endsWith('.7z')) return new Response(f.runtime);
    if (requests > 1) {
      assert.equal(options.headers.Range, 'bytes=4-');
      return new Response(f.assets.subarray(4), { status: 206,
        headers: { 'content-range': `bytes 4-${f.assets.length - 1}/${f.assets.length}` } });
    }
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(f.assets.subarray(0, 4)); },
      cancel() { cancelled = true; },
    }));
  } });
  write(f.userData, 'keep.txt', 'keep');
  f.service.install();
  await waitFor(() => f.service.getState().completedBytes === 4);
  assert.equal(f.service.cancel().ok, true);
  assert.equal((await settled(f.service)).phase, 'cancelled'); assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  assert.equal(fs.readFileSync(path.join(f.userData, 'keep.txt'), 'utf8'), 'keep');
  const partial = path.join(f.userData, 'voice-downloads', `${f.manifest.assets.sha256.slice(0, 16)}-assets.zip.part`);
  assert.deepEqual(fs.readFileSync(partial), f.assets.subarray(0, 4));
  f.service.install(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(fs.existsSync(partial), false);
  assert.equal(requests, 3);
});

test('a failed voice source resumes from its verified-byte-compatible fallback automatically', async t => {
  let f, runtimeCalls = 0;
  f = fixture(t, {
    mutateManifest(manifest) {
      manifest.runtime.sources = [manifest.runtime.url,
        'https://github.com/ActorF/Elysia_desktop_pet/releases/download/test/runtime.7z'];
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith('.zip')) return new Response(f.assets);
      runtimeCalls++;
      if (runtimeCalls === 1) {
        let sent = false;
        return new Response(new ReadableStream({
          async pull(controller) {
            if (!sent) { sent = true; controller.enqueue(f.runtime.subarray(0, 4)); return; }
            await waitFor(() => f.service.getState().completedBytes === 4);
            controller.error(new Error('connection interrupted'));
          },
        }));
      }
      assert.ok(url.startsWith('https://github.com/ActorF/'));
      assert.equal(options.headers.Range, 'bytes=4-');
      return new Response(f.runtime.subarray(4), { status: 206,
        headers: { 'content-range': `bytes 4-${f.runtime.length - 1}/${f.runtime.length}` } });
    },
  });
  f.service.install(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(runtimeCalls, 2);
  assert.ok(f.notices.some(notice => /切换.*下载源/.test(notice.message)));
});

test('untrusted source lists are rejected before any download or extraction', async t => {
  for (const sources of [[], ['http://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/test/runtime.7z'],
    ['https://evil.example/runtime.7z'], ['https://huggingface.co.evil.example/runtime.7z'],
    ['https://github.com/someone/unknown/releases/download/test/runtime.7z']]) {
    const f = fixture(t, { mutateManifest(manifest) { manifest.runtime.sources = sources; },
      fetchImpl: () => assert.fail('invalid manifest must not fetch') });
    assert.equal((await f.service.inspect()).phase, 'error');
    f.service.install(); const state = await settled(f.service);
    assert.equal(state.phase, 'error'); assert.match(state.error, /资源清单/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.userData), false);
  }
});

test('a corrupt completed cache or partial returns to downloading and leaves no duplicate bad cache', async t => {
  for (const suffix of ['', '.part']) {
    let f, finishDownload;
    f = fixture(t, { fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(f.runtime.subarray(0, 4));
        finishDownload = () => { controller.enqueue(f.runtime.subarray(4)); controller.close(); };
      },
    })) });
    write(f.offline, 'assets.zip', f.assets);
    // A bad nearby user-supplied archive is not part of the managed cache cleanup.
    const badArchive = Buffer.alloc(f.runtime.length, 0x58);
    write(f.offline, 'runtime.7z', badArchive);
    const cacheName = `${f.manifest.runtime.sha256.slice(0, 16)}-runtime.7z`;
    write(f.userData, `voice-downloads/${cacheName}${suffix}`, badArchive);
    f.service.install();
    await waitFor(() => f.service.getState().completedBytes === 4);
    assert.equal(f.service.getState().phase, 'downloading');
    assert.match(f.service.getState().message, /正在下载/);
    finishDownload();
    assert.equal((await settled(f.service)).phase, 'ready');
    const cacheFiles = fs.readdirSync(path.join(f.userData, 'voice-downloads'));
    assert.deepEqual(cacheFiles, [cacheName]);
    assert.deepEqual(fs.readFileSync(path.join(f.offline, 'runtime.7z')), badArchive);
  }
});

test('a pinned ModelScope runtime follows only its digest-addressed CDN and deploys normally', async t => {
  let f; const visited = [];
  f = fixture(t, {
    mutateManifest(manifest) {
      manifest.runtime.fileName = `${runtimeName}.7z`;
      manifest.runtime.sources = [modelScopeRuntime];
    },
    fetchImpl: async url => {
      visited.push(url);
      if (url.endsWith('.zip')) return new Response(f.assets);
      if (url === modelScopeRuntime) return new Response(null, { status: 302,
        headers: { location: `${modelScopeCdn(f.manifest.runtime.sha256)}?signed=fixture` } });
      return new Response(f.runtime);
    },
  });
  f.service.install(); assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(visited.length, 3);
  assert.equal(visited[1], modelScopeRuntime);
  assert.equal(visited[2], `${modelScopeCdn(f.manifest.runtime.sha256)}?signed=fixture`);
});

test('ModelScope runtime sources reject unpinned revisions, wrong repository paths and other archive files', async t => {
  for (const source of [modelScopeRuntime.replace('/models/', '/datasets/'),
    modelScopeRuntime.replace('/fixture/voice-runtime/', '/fixture/'),
    modelScopeRuntime.replace('a'.repeat(40), 'master'),
    modelScopeRuntime.replace('GPT-SoVITS-v2-240821.7z', 'different-runtime.7z'),
    modelScopeRuntime.replace('www.modelscope.cn', 'www.modelscope.cn.evil.example'),
    modelScopeRuntime.replace('www.modelscope.cn', 'modelscope.cn'),
    modelScopeRuntime + '?revision=master']) {
    const f = fixture(t, {
      mutateManifest(manifest) {
        manifest.runtime.fileName = `${runtimeName}.7z`;
        manifest.runtime.sources = [source];
      },
      fetchImpl: () => assert.fail('invalid source must not fetch'),
    });
    f.service.install(); assert.equal((await settled(f.service)).phase, 'error');
    assert.match(f.service.getState().error, /资源清单/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.userData), false);
  }
});

test('ModelScope redirects reject the wrong digest, changed repository and unrelated hosts', async t => {
  for (const target of [modelScopeCdn('0'.repeat(64)),
    modelScopeRuntime.replace('/fixture/voice-runtime/', '/other/voice-runtime/'),
    'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/test/runtime.7z',
    'https://cdn-lfs-cn-1.modelscope.cn.evil.example/prod/lfs-objects/unknown']) {
    let f, requests = 0;
    f = fixture(t, {
      mutateManifest(manifest) {
        manifest.runtime.fileName = `${runtimeName}.7z`;
        manifest.runtime.sources = [modelScopeRuntime];
      },
      fetchImpl: async url => {
        requests++;
        assert.equal(url, modelScopeRuntime, 'an untrusted redirect must not be requested');
        return new Response(null, { status: 302, headers: { location: target } });
      },
    });
    write(f.offline, 'assets.zip', f.assets);
    f.service.install(); assert.equal((await settled(f.service)).phase, 'error');
    assert.match(f.service.getState().error, /下载未完成/);
    assert.equal(requests, 1); assert.equal(f.calls.length, 0);
  }
});

test('the ModelScope CDN cannot be configured directly or reached from an unrelated source', async t => {
  let f;
  f = fixture(t, { fetchImpl: async () => new Response(null, { status: 302,
    headers: { location: modelScopeCdn(f.manifest.runtime.sha256) } }) });
  write(f.offline, 'assets.zip', f.assets);
  f.service.install(); assert.equal((await settled(f.service)).phase, 'error');
  assert.equal(f.calls.length, 0);
  const direct = fixture(t, {
    mutateManifest(manifest) { manifest.runtime.sources = [modelScopeCdn(manifest.runtime.sha256)]; },
    fetchImpl: () => assert.fail('a CDN object is not an allowed initial source'),
  });
  direct.service.install(); assert.equal((await settled(direct.service)).phase, 'error');
  assert.match(direct.service.getState().error, /资源清单/);
});

test('failed Python validation preserves no installed runtime and a retry reuses cached archives', async t => {
  let f, failed = true, downloads = 0;
  f = fixture(t, { fetchImpl: async url => { downloads++; return new Response(url.endsWith('.zip') ? f.assets : f.runtime); },
    spawnImpl: (file, args, options) => {
      if (args[0] !== '-I' || !failed) return f.spawnImpl(file, args, options);
      failed = false; const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
      process.nextTick(() => { child.stdout.end(); child.emit('close', 1); }); return child;
    } });
  f.service.install(); assert.equal((await settled(f.service)).phase, 'error');
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  f.service.install(); assert.equal((await settled(f.service)).phase, 'ready'); assert.equal(downloads, 2);
});

test('cancelling extraction waits for its own process to close before clearing staging', async t => {
  let child, destination, f;
  f = fixture(t, { spawnImpl: (file, args, options) => {
    if (args[0] !== 'x') return f.spawnImpl(file, args, options);
    destination = args.find(arg => arg.startsWith('-o')).slice(2);
    child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; setTimeout(() => child.emit('close', 1), 15); };
    return child;
  } });
  f.service.install();
  while (!child) await new Promise(resolve => setImmediate(resolve));
  f.service.cancel(); assert.equal(child.killed, true);
  assert.equal(f.service.getState().busy, true); assert.equal(fs.existsSync(destination), true);
  assert.equal((await settled(f.service)).phase, 'cancelled');
  assert.equal(fs.existsSync(destination), false);
});

test('an unknown existing voice directory is preserved; a corrupt extractor never runs', async t => {
  const existing = fixture(t); write(existing.service.getProjectRoot(), 'keep.txt', 'keep');
  existing.service.install(); assert.equal((await settled(existing.service)).phase, 'error');
  assert.equal(fs.readFileSync(path.join(existing.service.getProjectRoot(), 'keep.txt'), 'utf8'), 'keep'); assert.equal(existing.calls.length, 0);
  const corrupt = fixture(t); write(corrupt.resources, 'tools/7za.exe', 'different');
  corrupt.service.install(); const state = await settled(corrupt.service);
  assert.equal(state.phase, 'error'); assert.match(state.error, /解压工具/); assert.equal(corrupt.calls.length, 0);
});

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
const { createSetupDiagnostic } = require('../electron/setup-diagnostics.cjs');
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
  const temporary = os.tmpdir();
  const root = fs.mkdtempSync(path.join(temporary, 'elysia-voice-setup-'));
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
  t.after(() => {
    service.dispose(); const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(temporary));
    fs.rmSync(actual, { recursive: true, force: true });
  });
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

test('an unconfirmed voice extractor stop settles and retains its stage until real exit', async t => {
  for (const mode of ['timeout', 'cancel']) await t.test(mode, async t => {
    let stuck = true, child, stage;
    const f = fixture(t, { extractionTimeoutMs: 8, processStopTimeoutMs: 5, spawnImpl: (file, args, options) => {
      if (!stuck || args[0] !== 'x') return f.spawnImpl(file, args, options);
      const target = args.find(arg => arg.startsWith('-o')).slice(2); stage = path.dirname(target);
      write(target, 'in-progress', 'owned partial');
      child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough();
      child.kill = () => { if (mode === 'cancel') throw new Error('refused'); return false; };
      if (mode === 'cancel') queueMicrotask(() => f.service.cancel());
      return child;
    } });
    f.service.install(); const state = await settled(f.service);
    assert.equal(state.phase, mode === 'cancel' ? 'cancelled' : 'error');
    assert.equal(state.diagnostic?.code || null, mode === 'cancel' ? null : 'EXT-103');
    assert.equal(fs.existsSync(path.join(stage, 'runtime', 'in-progress')), true);
    assert.equal(f.service.install().ok, false); assert.equal(f.service.repair().ok, false);
    stuck = false; child.emit('exit', 1); child.emit('close', 1);
    await waitFor(() => !fs.existsSync(stage));
    assert.equal(f.service.install().ok, true); assert.equal((await settled(f.service)).phase, 'ready');
  });
});

test('late extractor exit cannot remove a different directory substituted for its retained stage', async t => {
  let child, stage;
  const f = fixture(t, { extractionTimeoutMs: 8, processStopTimeoutMs: 5, spawnImpl: (file, args, options) => {
    if (args[0] !== 'x') return f.spawnImpl(file, args, options);
    stage = path.dirname(args.find(arg => arg.startsWith('-o')).slice(2));
    child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.kill = () => false; return child;
  } });
  f.service.install(); await settled(f.service);
  fs.renameSync(stage, path.join(f.userData, 'saved-owned-stage')); fs.mkdirSync(stage); write(stage, 'keep', 'unrelated data');
  child.emit('exit', 1); child.emit('close', 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fs.readFileSync(path.join(stage, 'keep'), 'utf8'), 'unrelated data');
});

test('replacing an owned corrupt cache counts the bytes freed before downloading its replacement', async t => {
  let fetched = 0, cached;
  const f = fixture(t, { statfsImpl: async () => ({ bsize: 1, bavail: 64 * 1024 ** 2 + (fs.existsSync(cached) ? 5 : 5 + f.runtime.length) }),
    fetchImpl: async url => { fetched++; assert.ok(url.endsWith('.7z')); return new Response(f.runtime); } });
  write(f.offline, 'assets.zip', f.assets);
  cached = path.join(f.userData, 'voice-downloads', `${f.manifest.runtime.sha256.slice(0, 16)}-${f.manifest.runtime.fileName}`);
  write(path.dirname(cached), path.basename(cached), Buffer.alloc(f.runtime.length));
  f.service.install();
  assert.equal((await settled(f.service)).phase, 'ready'); assert.equal(fetched, 1);
  assert.deepEqual(fs.readFileSync(cached), f.runtime);
  assert.deepEqual(fs.readdirSync(path.dirname(cached)), [path.basename(cached)]);
});

test('construction and inspection do not download, create user state or launch interpreters', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('unexpected download') });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.inspect()).phase, 'needs-install');
  assert.equal(fs.existsSync(f.userData), false);
  assert.equal(f.service.getProjectRoot(), path.join(f.userData, 'voice-runtime'));
});

test('local preview refuses voice installation even when complete offline archives are available', async t => {
  const f = fixture(t, { allowDownloads: false, fetchImpl: () => assert.fail('preview must not fetch') });
  write(f.offline, 'assets.zip', f.assets); write(f.offline, 'runtime.7z', f.runtime);
  const before = f.service.getState();
  const result = f.service.install();
  assert.equal(result.ok, false); assert.equal(result.code, 'downloads-disabled'); assert.match(result.error, /不会下载或安装/);
  assert.deepEqual(result.state, before); assert.deepEqual(f.service.getState(), before);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.userData), false);
  assert.equal(result.diagnostic.code, createSetupDiagnostic('voice', 'preview-disabled').code);
  const state = await f.service.inspect();
  assert.equal(state.phase, 'needs-install'); assert.match(state.error, /文字聊天仍可使用/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.userData), false);
});

test('local preview recognizes an existing voice environment without replacing files or launching Python', async t => {
  const f = fixture(t, { allowDownloads: false, fetchImpl: () => assert.fail('preview must not fetch') });
  const project = f.service.getProjectRoot();
  const required = [...assetsFiles, `models/cache/${runtimeName}/runtime/python.exe`, ...anchors];
  for (const relative of required) write(project, relative);
  const marker = JSON.stringify({ version: 1, assets: f.manifest.assets.sha256, runtime: f.manifest.runtime.sha256, required });
  write(project, 'voice-setup-complete.json', marker);
  const state = await f.service.inspect();
  assert.equal(state.phase, 'ready'); assert.equal(state.ready, true); assert.equal(state.error, null);
  assert.equal(f.service.install().code, 'downloads-disabled');
  assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(path.join(project, 'voice-setup-complete.json'), 'utf8'), marker);
  assert.deepEqual(fs.readdirSync(f.userData), ['voice-runtime']);
});

test('verified offline archives deploy runtime then overlays and validate before ready', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('offline cache should be reused') });
  write(f.offline, 'assets.zip', f.assets); write(f.offline, 'runtime.7z', f.runtime);
  f.service.install(); assert.equal(f.service.install().ok, false);
  assert.equal((await settled(f.service)).phase, 'ready');
  assert.equal(f.service.getState().ready, true);
  assert.equal(f.service.getState().diagnostic, null);
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

test('pinned voice archives accept official European, Asian and GCP download hosts', async t => {
  for (const host of ['cdn-lfs-eu-1.hf.co', 'eu-west-3.aws.cdn.hf.co', 'europe-west4.us.gcp.cdn.hf.co',
    'asia-southeast1.us.gcp.cdn.hf.co', 'transfer.xethub-eu.hf.co']) await t.test(host, async t => {
    const visited = [];
    const f = fixture(t, { fetchImpl: async url => {
      visited.push(url);
      if (url === f.manifest.runtime.url) return new Response(null, { status: 302, headers: { location: `https://${host}/pinned-blob?signature=opaque` } });
      return new Response(url.endsWith('.zip') ? f.assets : f.runtime);
    } });
    f.service.install(); assert.equal((await settled(f.service)).phase, 'ready');
    assert.equal(visited.filter(url => new URL(url).hostname === host).length, 1);
  });
});

test('regional voice redirects still reject lookalike domains, unsafe URLs and cross-source ModelScope redirects', async t => {
  const urls = ['https://us.gcp.cdn.hf.co.evil.example/asset', 'https://fake-us.gcp.cdn.hf.co/asset',
    'https://unlisted.cdn.hf.co/asset', 'https://user:password@us.gcp.cdn.hf.co/asset',
    'https://us.gcp.cdn.hf.co:8443/asset', 'http://us.gcp.cdn.hf.co/asset', 'https://s3.us-east-1.amazonaws.com/arbitrary/asset'];
  for (const location of urls) {
    const visited = [];
    const f = fixture(t, { fetchImpl: async url => {
      visited.push(url);
      if (url === f.manifest.runtime.url) return new Response(null, { status: 302, headers: { location } });
      assert.equal(url, f.manifest.assets.url); return new Response(f.assets);
    } });
    f.service.install(); const state = await settled(f.service);
    assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'network-redirect').code);
    assert.equal(visited.includes(location), false); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t, { mutateManifest: manifest => { manifest.runtime.fileName = `${runtimeName}.7z`; manifest.runtime.sources = [modelScopeRuntime]; },
    fetchImpl: async url => {
      if (url === modelScopeRuntime) return new Response(null, { status: 302, headers: { location: 'https://eu-west-3.aws.cdn.hf.co/asset' } });
      assert.equal(url, f.manifest.assets.url); return new Response(f.assets);
    } });
  f.service.install(); assert.equal((await settled(f.service)).diagnostic.code, createSetupDiagnostic('voice', 'network-redirect').code);
});

test('archive traversal, drive paths, Windows aliases, duplicates and links are rejected before extraction', async t => {
  for (const record of ['Path = ../escape\nSize = 1', 'Path = C:\\escape\nSize = 1', 'Path = safe:ads\nSize = 1',
    'Path = AUX.txt\nSize = 1', 'Path = folder.\nSize = 0', 'Path = safe\nSymbolic Link = ../escape',
    'Path = safe\nAttributes = A_ lrwxrwxrwx', 'Path = safe\n\nPath = SAFE',
    'Path = folder#tag/../escape', 'Path = folder#tag/file:stream',
    ...['?', '*', '<', '>', '"', '|', '\u0001'].map(character => `Path = file${character}name`)]) {
    const f = fixture(t, { spawnImpl: (file, args) => {
      assert.equal(args[0], 'l', 'unsafe archive was extracted');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
      process.nextTick(() => { child.stdout.write('----------\n' + record + '\n'); child.stdout.end(); child.emit('close', 0); }); return child;
    } });
    f.service.install(); assert.equal((await settled(f.service)).phase, 'error');
    assert.equal(f.service.getState().diagnostic.code, createSetupDiagnostic('voice', 'archive-unsafe').code);
    assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
    assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
  }
});

test('a verified cached runtime with the real hash-sign filename retries without downloading and remains inspectable', async t => {
  // Exact entry from GPT-SoVITS-v2-240821.7z; # is a legal Windows filename character.
  const archiveEntry = `${runtimeName}/runtime/Lib/site-packages/pandas/tests/io/data/legacy_pickle/1.2.4/empty_frame_v1_2_4-GH#42345.pkl`;
  const installedEntry = `models/cache/${archiveEntry}`;
  const outputChild = output => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    // Real child-process close follows drained stdout; keep that ordering in the mock.
    process.nextTick(() => { child.stdout.once('end', () => child.emit('close', 0)); child.stdout.end(output); }); return child;
  };
  let f;
  f = fixture(t, { fetchImpl: () => assert.fail('previously verified cached archives must not download again'),
    spawnImpl: (file, args, options) => {
      if (args[0] === 'l' && args.at(-1).endsWith('.7z')) {
        return outputChild(`----------\r\nPath = ${archiveEntry.replaceAll('/', '\\')}\r\nSize = 1\r\nAttributes = A\r\n\r\n`);
      }
      if (args[0] === '-I') return outputChild(JSON.stringify({ required: [...anchors, installedEntry] }));
      if (args[0] === 'x' && args.at(-1).endsWith('.7z')) {
        const destination = args.find(arg => arg.startsWith('-o')).slice(2);
        // Materialize the fake extraction before any child completion event.
        write(destination, archiveEntry, 'small synthetic pandas fixture');
      }
      return f.spawnImpl(file, args, options);
    } });
  const cachedAssets = `voice-downloads/${f.manifest.assets.sha256.slice(0, 16)}-${f.manifest.assets.fileName}`;
  const cachedRuntime = `voice-downloads/${f.manifest.runtime.sha256.slice(0, 16)}-${f.manifest.runtime.fileName}`;
  write(f.userData, cachedAssets, f.assets); write(f.userData, cachedRuntime, f.runtime);
  f.service.install(); const state = await settled(f.service);
  assert.equal(state.phase, 'ready', JSON.stringify(state.diagnostic)); assert.equal(state.diagnostic, null);
  assert.equal(fs.readFileSync(path.join(f.service.getProjectRoot(), installedEntry), 'utf8'), 'small synthetic pandas fixture');
  const marker = JSON.parse(fs.readFileSync(path.join(f.service.getProjectRoot(), 'voice-setup-complete.json'), 'utf8'));
  assert.ok(marker.required.includes(installedEntry)); assert.equal((await f.service.inspect()).ready, true);
  assert.deepEqual(fs.readFileSync(path.join(f.userData, cachedAssets)), f.assets);
  assert.deepEqual(fs.readFileSync(path.join(f.userData, cachedRuntime)), f.runtime);
});

test('the internal Windows runtime move retries temporary errors within the same staging tree', { skip: process.platform !== 'win32' }, async t => {
  const failures = ['EPERM', 'EBUSY', 'EACCES'], attempts = [];
  const f = fixture(t, { fetchImpl: () => assert.fail('offline fixtures must not download'),
    renameRuntimeImpl: async (source, destination) => {
      attempts.push([source, destination]);
      const code = failures[attempts.length - 1];
      if (code) throw Object.assign(new Error('temporary fixture move error'), { code });
      return fs.promises.rename(source, destination);
    } });
  write(f.offline, 'assets.zip', f.assets); write(f.offline, 'runtime.7z', f.runtime);
  f.service.install(); const state = await settled(f.service);
  assert.equal(state.phase, 'ready', JSON.stringify(state.diagnostic)); assert.equal(attempts.length, 4);
  for (const attempt of attempts) {
    assert.deepEqual(attempt, attempts[0]);
    const relative = path.relative(f.userData, attempt[0]);
    assert.match(relative, /^voice-staging-[0-9a-f-]{36}[\\/]runtime[\\/]GPT-SoVITS-v2-240821$/);
    assert.equal(attempt[1], path.join(f.userData, relative.split(path.sep)[0], 'project', 'models', 'cache', runtimeName));
  }
  assert.equal(fs.readFileSync(path.join(f.service.getProjectRoot(), `models/cache/${runtimeName}/runtime/python.exe`), 'utf8'), 'fixture');
});

test('permanent Windows runtime move refusal exhausts its bound and preserves the original system error', { skip: process.platform !== 'win32' }, async t => {
  let attempts = 0;
  const f = fixture(t, { renameRuntimeImpl: async () => {
    attempts++; throw Object.assign(new Error('private permanent fixture refusal'), { code: 'EACCES' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(attempts, 5); assert.equal(state.phase, 'error');
  assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'storage-permission').code);
  assert.equal(state.diagnostic.details.systemCode, 'EACCES'); assert.doesNotMatch(JSON.stringify(state), /private permanent/);
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('cancellation during the Windows runtime move backoff prevents another rename attempt', { skip: process.platform !== 'win32' }, async t => {
  let f, attempts = 0, cancelled;
  f = fixture(t, { renameRuntimeImpl: async () => {
    attempts++; setImmediate(() => { cancelled = f.service.cancel(); });
    throw Object.assign(new Error('temporary fixture move error'), { code: 'EBUSY' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(cancelled?.ok, true); assert.equal(attempts, 1);
  assert.equal(state.phase, 'cancelled'); assert.equal(state.diagnostic, null);
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('a target that appears during runtime move backoff is not overwritten', { skip: process.platform !== 'win32' }, async t => {
  let attempts = 0, originalSource, externalTarget;
  const f = fixture(t, { renameRuntimeImpl: async (source, destination) => {
    attempts++;
    assert.equal(attempts, 1, 'an external target must prevent a second rename call');
    originalSource = source; externalTarget = destination;
    write(destination, 'external.fixture', 'external target contents');
    throw Object.assign(new Error('temporary fixture move error'), { code: 'EBUSY' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(attempts, 1); assert.equal(state.phase, 'error');
  assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'installation-conflict').code);
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  assert.equal(fs.readFileSync(path.join(externalTarget, 'external.fixture'), 'utf8'), 'external target contents');
  assert.equal(fs.readFileSync(path.join(originalSource, 'runtime/python.exe'), 'utf8'), 'fixture');
  assert.ok(fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('a changed source identity during runtime move backoff prevents another rename attempt', { skip: process.platform !== 'win32' }, async t => {
  let attempts = 0, substitutedSource;
  const f = fixture(t, { renameRuntimeImpl: async (source) => {
    attempts++;
    assert.equal(attempts, 1, 'a substituted source must prevent a second rename call');
    substitutedSource = source;
    fs.renameSync(source, source + '.saved-fixture'); write(source, 'external.fixture', 'different source directory');
    throw Object.assign(new Error('temporary fixture move error'), { code: 'EPERM' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(attempts, 1); assert.equal(state.phase, 'error');
  assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'installation-conflict').code);
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  assert.equal(fs.readFileSync(path.join(substitutedSource, 'external.fixture'), 'utf8'), 'different source directory');
  assert.equal(fs.readFileSync(path.join(substitutedSource + '.saved-fixture', 'runtime/python.exe'), 'utf8'), 'fixture');
  assert.ok(fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('an external target appearing on the final runtime move failure is preserved with the source', { skip: process.platform !== 'win32' }, async t => {
  let attempts = 0, originalSource, externalTarget;
  const f = fixture(t, { renameRuntimeImpl: async (source, destination) => {
    attempts++; originalSource = source; externalTarget = destination;
    if (attempts === 5) write(destination, 'external.fixture', 'target appeared on the last attempt');
    throw Object.assign(new Error('temporary fixture move error'), { code: 'EBUSY' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(attempts, 5); assert.equal(state.phase, 'error'); assert.equal(state.ready, false);
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  assert.equal(fs.readFileSync(path.join(externalTarget, 'external.fixture'), 'utf8'), 'target appeared on the last attempt');
  assert.equal(fs.readFileSync(path.join(originalSource, 'runtime/python.exe'), 'utf8'), 'fixture');
  assert.ok(fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('cancelling runtime move backoff preserves a newly appeared target and the original source', { skip: process.platform !== 'win32' }, async t => {
  let f, attempts = 0, originalSource, externalTarget, cancellation;
  f = fixture(t, { renameRuntimeImpl: async (source, destination) => {
    attempts++; originalSource = source; externalTarget = destination;
    setImmediate(() => {
      write(destination, 'external.fixture', 'target appeared while waiting to retry');
      cancellation = f.service.cancel();
    });
    throw Object.assign(new Error('temporary fixture move error'), { code: 'EBUSY' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(cancellation?.ok, true); assert.equal(attempts, 1);
  assert.equal(state.phase, 'cancelled'); assert.equal(state.diagnostic, null); assert.equal(state.ready, false);
  assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  assert.equal(fs.readFileSync(path.join(externalTarget, 'external.fixture'), 'utf8'), 'target appeared while waiting to retry');
  assert.equal(fs.readFileSync(path.join(originalSource, 'runtime/python.exe'), 'utf8'), 'fixture');
  assert.ok(fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
});

test('a non-transient runtime move error is reported without retrying', async t => {
  let attempts = 0;
  const f = fixture(t, { renameRuntimeImpl: async () => {
    attempts++; throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
  } });
  f.service.install(); const state = await settled(f.service);
  assert.equal(attempts, 1); assert.equal(state.phase, 'error');
  assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'storage-space').code);
  assert.equal(state.diagnostic.details.systemCode, 'ENOSPC'); assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
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
  assert.equal(f.service.getState().diagnostic, null, 'explicit cancellation is not a failure');
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
  f.service.install(); const state = await settled(f.service);
  assert.equal(state.phase, 'ready', JSON.stringify({ phase: state.phase, error: state.error, message: state.message }));
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

test('inspection and retry explain an existing unmarked directory without erasing or downloading', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('existing directory must not download') });
  write(f.service.getProjectRoot(), 'keep.txt', 'user-file');
  const first = await f.service.inspect();
  assert.equal(first.phase, 'error'); assert.equal(first.installation.code, 'missing-marker');
  assert.equal(first.installation.recognized, false); assert.match(first.error, /标记|记录/);
  assert.equal(first.diagnostic.code, createSetupDiagnostic('voice', 'installation-missing-marker').code);
  f.service.install(); const retried = await settled(f.service);
  assert.equal(retried.error, first.error); assert.equal(retried.installation.code, first.installation.code);
  const inspected = await f.service.inspect();
  assert.equal(inspected.error, first.error); assert.equal(inspected.phase, 'error');
  assert.deepEqual(fs.readdirSync(f.service.getProjectRoot()), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(f.service.getProjectRoot(), 'keep.txt'), 'utf8'), 'user-file');
  assert.equal(f.calls.length, 0);
});

test('incompatible voice installation reports its actual and expected marker versions without modifying it', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('existing directory must not download') });
  const root = f.service.getProjectRoot(), marker = JSON.stringify({ version: 2 });
  write(root, 'voice-setup-complete.json', marker); write(root, 'keep.txt', 'existing user resource');
  const inspected = await f.service.inspect();
  assert.equal(inspected.diagnostic.code, createSetupDiagnostic('voice', 'installation-version-mismatch').code);
  assert.equal(inspected.diagnostic.details.actualVersion, 2);
  assert.equal(inspected.diagnostic.details.expectedVersion, f.manifest.version);
  f.service.install(); const retried = await settled(f.service);
  assert.deepEqual(retried.diagnostic, inspected.diagnostic);
  assert.equal(fs.readFileSync(path.join(root, 'voice-setup-complete.json'), 'utf8'), marker);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'existing user resource');
  assert.equal(f.calls.length, 0);
});

test('a recognized installation missing one file reports its name and recovers after that file is restored', async t => {
  const f = fixture(t, { fetchImpl: () => assert.fail('offline files must be reused') });
  write(f.offline, 'assets.zip', f.assets); write(f.offline, 'runtime.7z', f.runtime);
  f.service.install(); assert.equal((await settled(f.service)).ready, true);
  const root = f.service.getProjectRoot(), markerPath = path.join(root, 'voice-setup-complete.json');
  const marker = fs.readFileSync(markerPath, 'utf8'), count = f.calls.length;
  fs.unlinkSync(path.join(root, anchors[0]));
  const broken = await f.service.inspect();
  assert.equal(broken.phase, 'error'); assert.equal(broken.installation.recognized, true);
  assert.equal(broken.installation.code, 'missing-files'); assert.deepEqual(broken.installation.missingFiles, [anchors[0]]);
  assert.equal(broken.diagnostic.code, createSetupDiagnostic('voice', 'installation-missing-files').code);
  assert.deepEqual(broken.diagnostic.details.missingFiles, [anchors[0]]);
  assert.match(broken.error, /anchor0/); assert.doesNotMatch(broken.error, /另一套/);
  f.service.install(); const retry = await settled(f.service);
  assert.equal(retry.error, broken.error); assert.equal(f.calls.length, count);
  assert.equal(fs.readFileSync(markerPath, 'utf8'), marker, 'never manufacture a completion marker for an incomplete installation');
  write(root, anchors[0]); const restored = await f.service.inspect();
  assert.equal(restored.ready, true); assert.equal(restored.error, null); assert.equal(restored.installation.code, 'ready');
  assert.equal(restored.diagnostic, null);
  f.service.install(); assert.equal((await settled(f.service)).ready, true); assert.equal(f.calls.length, count);
});

test('missing and corrupt extractors have different diagnostics without launching a process', async t => {
  for (const [corrupt, kind] of [[false, 'extractor-missing'], [true, 'extractor-integrity']]) {
    const f = fixture(t, { fetchImpl: () => assert.fail('tool verification must precede downloads') });
    const executable = path.join(f.resources, 'tools/7za.exe');
    if (corrupt) fs.writeFileSync(executable, 'broken'); else fs.unlinkSync(executable);
    f.service.install(); const state = await settled(f.service);
    assert.equal(state.phase, 'error'); assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', kind).code);
    assert.equal(state.diagnostic.stage, 'verify'); assert.equal(f.calls.length, 0);
  }
});

test('extractor and Python validation launch, exit and timeout failures keep their own stage and metadata', async t => {
  for (const stage of ['extract', 'validate']) for (const outcome of ['launch', 'exit', 'timeout']) {
    await t.test(`${stage}: ${outcome}`, async t => {
      let f;
      f = fixture(t, { extractionTimeoutMs: 20, spawnImpl: (file, args, options) => {
        const intercept = stage === 'validate' ? args[0] === '-I' : args[0] === 'l';
        if (!intercept) return f.spawnImpl(file, args, options);
        if (outcome === 'launch') throw Object.assign(new Error('private C:\\Users\\Secret\\file token=secret'), { code: 'ENOENT' });
        const child = new EventEmitter(); child.stdout = new PassThrough();
        child.kill = () => { child.killed = true; process.nextTick(() => child.emit('close', 1)); };
        if (outcome === 'exit') process.nextTick(() => child.emit('close', 2));
        return child;
      } });
      write(f.offline, 'assets.zip', f.assets); write(f.offline, 'runtime.7z', f.runtime);
      f.service.install(); const state = await settled(f.service);
      const kind = `${stage === 'validate' ? 'validation' : outcome === 'launch' ? 'extractor' : 'extraction'}-${outcome}`;
      assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', kind).code);
      assert.equal(state.diagnostic.stage, stage);
      if (outcome === 'launch') assert.equal(state.diagnostic.details.systemCode, 'ENOENT');
      if (outcome === 'exit') assert.equal(state.diagnostic.details.exitCode, 2);
      assert.doesNotMatch(JSON.stringify(state.diagnostic), /Secret|token=|C:\\\\Users/);
      assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
      assert.ok(!fs.readdirSync(f.userData).some(name => name.startsWith('voice-staging-')));
      const rechecked = await f.service.inspect();
      assert.equal(rechecked.phase, 'error'); assert.deepEqual(rechecked.diagnostic, state.diagnostic);
      assert.match(rechecked.message, /上次/);
    });
  }
});

test('malformed validation output is distinct from unsafe archive contents', async t => {
  for (const output of ['not json', 'null', '{"required":["../../escape"]}']) {
    let f;
    f = fixture(t, { spawnImpl: (file, args, options) => {
      if (args[0] !== '-I') return f.spawnImpl(file, args, options);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
      process.nextTick(() => { child.stdout.end(output); child.emit('close', 0); }); return child;
    } });
    f.service.install(); const state = await settled(f.service);
    assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'validation-output').code);
    assert.equal(state.diagnostic.stage, 'validate'); assert.equal(fs.existsSync(f.service.getProjectRoot()), false);
  }
});

test('typed HTTP download failures survive the voice wrapper and reinspection without signed URL leakage', async t => {
  const f = fixture(t, { fetchImpl: async () => new Response('not exposed', { status: 403 }) });
  f.service.install(); const state = await settled(f.service);
  assert.equal(state.phase, 'error'); assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', 'network-http', { httpStatus: 403 }).code);
  assert.equal(state.diagnostic.details.httpStatus, 403); assert.equal(state.diagnostic.stage, 'download');
  assert.doesNotMatch(JSON.stringify(state.diagnostic), /not exposed|https?:\/\//);
  const inspected = await f.service.inspect(); assert.deepEqual(inspected.diagnostic, state.diagnostic);
  assert.equal(inspected.error, state.error); assert.equal(f.calls.length, 0);
});

test('filesystem errors keep disk, permission, busy and path categories rather than becoming download failures', async t => {
  for (const [systemCode, kind] of [['ENOSPC', 'storage-space'], ['EACCES', 'storage-permission'], ['EBUSY', 'storage-busy'], ['ENAMETOOLONG', 'storage-path']]) {
    const f = fixture(t, { fetchImpl: () => assert.fail('a failed destination must never download') });
    const original = fs.promises.mkdir;
    fs.promises.mkdir = async (directory, options) => {
      if (directory === f.userData) throw Object.assign(new Error('private absolute path and token'), { code: systemCode });
      return original(directory, options);
    };
    try {
      f.service.install(); const state = await settled(f.service);
      assert.equal(state.diagnostic.code, createSetupDiagnostic('voice', kind).code);
      assert.equal(state.diagnostic.stage, 'storage'); assert.equal(state.diagnostic.details.systemCode, systemCode);
      assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.userData), false);
      assert.doesNotMatch(JSON.stringify(state.diagnostic), /private absolute path|token/);
    } finally { fs.promises.mkdir = original; }
  }
});

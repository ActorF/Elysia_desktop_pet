/** Pinned llama.cpp runtime/model preparation and a private, GUI-free local server. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const manifestDefault = require('./chat-bootstrap-manifest.json');
const { EXTRACT_SCRIPT } = require('./chat-runtime-extract.cjs');
const { createRuntimeDependencies, validDependenciesManifest } = require('./chat-runtime-dependencies.cjs');

const SETUP_MODEL = 'elysia-chat';
const SETUP_BASE_URL = 'http://127.0.0.1:18434';
const MODEL_BYTES = manifestDefault.model.bytes;
const ERRORS = Object.freeze({
  unsupported: '本地聊天环境目前仅支持 Windows x64。',
  manifest: '聊天资源清单无效，请重新安装桌宠。',
  download: '聊天资源下载未完成，请检查网络后重试；已下载部分会继续使用。',
  integrity: '聊天资源校验失败，请重试下载。',
  archive: '聊天运行环境解压失败，请检查磁盘空间后重试。',
  storage: '无法保存聊天资源，请检查用户目录权限和磁盘空间。',
  conflict: '暂时无法替换聊天运行环境，请关闭正在使用该目录的程序后重试。',
  'dependencies-source': '安装包中的聊天运行库资源缺失或校验失败，请重新下载完整安装包后重试。无需自行安装系统运行库。',
  dependencies: '聊天运行库准备失败，请退出桌宠后重试，并检查用户目录权限和磁盘空间。',
  port: '本地聊天端口 18434 已被其他程序占用，请关闭占用程序后重试。',
  start: '本地聊天服务未能启动，请检查可用内存和显卡驱动后重试。',
});
const failure = code => Object.assign(new Error(code), { setupCode: code });
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const checkAbort = signal => { if (signal.aborted) throw cancelled(); };
const ordinaryFile = file => { try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
function validManifest(value) {
  return value?.version === 1 && value.backend === 'llama.cpp-v1' && value.runtime?.arch === 'x64'
    && validDependenciesManifest(value.runtimeDependencies)
    && Array.isArray(value.runtime.required) && value.runtime.required.includes('llama-server.exe') && value.runtime.required.length < 100
    && value.runtime.required.every(file => /^[a-zA-Z0-9_-]+\.(?:exe|dll)$/.test(file))
    && ['runtime', 'model'].every(key => {
      const a = value[key];
      return a && /^[a-zA-Z0-9._-]+$/.test(a.file) && !a.file.startsWith('.')
        && /^[a-f0-9]{64}$/.test(a.sha256) && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.bytes <= 16 * 1024 ** 3
        && typeof a.url === 'string' && allowedDownload(new URL(a.url))
        && (key === 'runtime' ? new URL(a.url).hostname === 'github.com'
          : new URL(a.url).hostname === 'huggingface.co' && /\/resolve\/[a-f0-9]{40}\//.test(new URL(a.url).pathname));
    });
}
function allowedDownload(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (url.hostname === 'github.com') return /^\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\/llama-[\w.-]+\.zip$/.test(url.pathname);
  if (['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) return /^\/github-production-release-asset(?:-2e65be)?\//.test(url.pathname);
  return url.hostname === 'huggingface.co' || url.hostname === 'cdn-lfs.huggingface.co'
    || url.hostname === 'cdn-lfs-us-1.hf.co' || url.hostname === 'cdn-lfs-eu-1.hf.co'
    || url.hostname === 'cdn.hf.co' || url.hostname.endsWith('.cdn.hf.co')
    || url.hostname === 'cas-bridge.xethub.hf.co';
}

function createModelSetup({ userData, onChange = () => {}, fetchImpl = globalThis.fetch, spawnImpl = spawn,
  platform = process.platform, arch = process.arch, env = process.env, manifest = manifestDefault,
  resourcesPath = process.resourcesPath, assetDirectory,
  probeTimeoutMs = 1500, startTimeoutMs = 180000, pollIntervalMs = 500,
  downloadTimeoutMs = 4 * 60 * 60 * 1000, extractionTimeoutMs = 5 * 60 * 1000 } = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new TypeError('userData must be an absolute directory.');
  let manifestValid = false;
  try { manifestValid = validManifest(manifest); } catch {}
  const runtimeDependencies = createRuntimeDependencies({ manifest: manifest?.runtimeDependencies,
    resourcesPath, assetDirectory, env, spawnImpl, extractionTimeoutMs });
  const runtimeRoot = path.join(userData, 'chat-runtime');
  const modelRoot = path.join(userData, 'chat-models');
  const modelPath = path.join(modelRoot, manifestValid ? manifest.model.file : 'invalid.gguf');
  const serverPath = path.join(runtimeRoot, 'llama-server.exe');
  const runtimeMarker = path.join(runtimeRoot, 'elysia-runtime.json');
  const modelMarker = path.join(modelRoot, 'elysia-model.json');
  let disposed = false, active = null, server = null, startAfterInspection = false, lastNotice = 0;
  let state = { phase: 'idle', busy: false, canCancel: false, backend: 'llama.cpp',
    runtimeReady: false, serverReady: false, modelReady: false, model: SETUP_MODEL, baseUrl: SETUP_BASE_URL,
    expectedModelBytes: manifestValid ? manifest.model.bytes : 0, completedBytes: 0, totalBytes: 0,
    progress: null, error: null, message: '准备桌宠专用的本地聊天环境。' };
  const getState = () => structuredClone(state);
  function update(patch, throttle = false) {
    Object.assign(state, patch);
    if (disposed || (throttle && Date.now() - lastNotice < 150)) return;
    lastNotice = Date.now(); onChange(getState());
  }
  function phase(value, message) {
    update({ phase: value, message, busy: true, canCancel: true, error: null, completedBytes: 0, totalBytes: 0, progress: null });
  }
  function markerMatches(file, asset, payload) {
    try {
      if (!ordinaryFile(file) || fs.statSync(file).size > 4096) return false;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value.sha256 === asset.sha256 && value.bytes === asset.bytes
        && (!payload || value.modifiedAt === fs.statSync(payload).mtimeMs);
    } catch { return false; }
  }
  function runtimeInstalled() {
    return manifestValid && manifest.runtime.required.every(file => ordinaryFile(path.join(runtimeRoot, file))) && markerMatches(runtimeMarker, manifest.runtime);
  }
  function resources() {
    const runtimeReady = runtimeInstalled() && runtimeDependencies.ready(runtimeRoot);
    let modelReady = false;
    try { modelReady = manifestValid && ordinaryFile(modelPath) && fs.statSync(modelPath).size === manifest.model.bytes && markerMatches(modelMarker, manifest.model, modelPath); } catch {}
    return { runtimeReady, modelReady };
  }
  async function probe(signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(probeTimeoutMs)]);
    let response;
    try { response = await fetchImpl(`${SETUP_BASE_URL}/health`, { signal: combined, redirect: 'error' }); }
    catch { checkAbort(signal); return 'offline'; }
    try {
      if (response.status === 503) { await response.body?.cancel(); return 'loading'; }
      if (!response.ok) { await response.body?.cancel(); return 'occupied'; }
      const health = JSON.parse(await readLimited(response, combined, 65536));
      if (health.status !== 'ok') return 'occupied';
      const models = await fetchImpl(`${SETUP_BASE_URL}/v1/models`, { signal: combined, redirect: 'error' });
      if (!models.ok) { await models.body?.cancel(); return 'occupied'; }
      const data = JSON.parse(await readLimited(models, combined, 65536));
      return data.data?.some(item => item.id === SETUP_MODEL) ? 'ready' : 'occupied';
    } catch { checkAbort(signal); return 'occupied'; }
  }
  async function consume(response, signal, accept) {
    if (!response.body) throw failure('download');
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        await accept(value);
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  async function readLimited(response, signal, limit) {
    let bytes = 0; const chunks = [];
    await consume(response, signal, chunk => {
      bytes += chunk.length; if (bytes > limit) throw failure('download');
      chunks.push(Buffer.from(chunk));
    });
    return Buffer.concat(chunks).toString('utf8');
  }
  async function verified(file, asset, signal) {
    if (!ordinaryFile(file) || fs.statSync(file).size !== asset.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) { checkAbort(signal); hash.update(chunk); }
    checkAbort(signal); return hash.digest('hex') === asset.sha256;
  }
  async function download(asset, destination, signal) {
    if (ordinaryFile(destination)) phase('verifying-installer', '正在校验已有聊天资源…');
    if (await verified(destination, asset, signal)) return destination;
    if (fs.existsSync(destination)) {
      if (!ordinaryFile(destination)) throw failure('storage');
      // Preserve imported/corrupt files while allowing Retry to obtain the
      // digest-pinned replacement; never silently delete a user's old model.
      await fs.promises.rename(destination, `${destination}.unverified-${randomUUID()}`);
    }
    const partial = destination + '.part';
    let completed = ordinaryFile(partial) ? fs.statSync(partial).size : 0;
    if (fs.existsSync(partial) && !ordinaryFile(partial)) throw failure('storage');
    if (completed > asset.bytes) { await fs.promises.rm(partial); completed = 0; }
    if (completed < asset.bytes) {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(downloadTimeoutMs)]);
      let url = new URL(asset.url), response;
      for (let redirects = 0; redirects <= 8; redirects++) {
        if (!allowedDownload(url)) throw failure('download');
        response = await fetchImpl(url.href, { signal: combined, redirect: 'manual', headers: completed ? { Range: `bytes=${completed}-` } : {} });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || redirects === 8) throw failure('download');
        url = new URL(location, url);
      }
      if (!response?.ok) { await response?.body?.cancel(); throw failure('download'); }
      if (response.status === 206) {
        if (response.headers.get('content-range') !== `bytes ${completed}-${asset.bytes - 1}/${asset.bytes}`) { await response.body?.cancel(); throw failure('download'); }
      } else if (response.status === 200) completed = 0;
      else { await response.body?.cancel(); throw failure('download'); }
      const expected = Number(response.headers.get('content-length') || 0);
      if (expected && expected !== asset.bytes - completed) { await response.body?.cancel(); throw failure('integrity'); }
      const handle = await fs.promises.open(partial, completed ? 'a' : 'w', 0o600);
      try {
        await consume(response, combined, async chunk => {
          if (completed + chunk.length > asset.bytes) throw failure('integrity');
          await handle.writeFile(chunk); completed += chunk.length;
          update({ completedBytes: completed, totalBytes: asset.bytes, progress: completed / asset.bytes }, true);
        });
      } finally { await handle.close(); }
    }
    if (completed !== asset.bytes) throw failure('download');
    phase('verifying-installer', '正在校验下载内容…');
    if (!await verified(partial, asset, signal)) { await fs.promises.rm(partial); throw failure('integrity'); }
    checkAbort(signal); await fs.promises.rename(partial, destination); return destination;
  }
  function extract(archive, stage, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      let child, failureReason = null, finished = false;
      try {
        child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(EXTRACT_SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, shell: false, stdio: 'ignore', env: { ...env, ELYSIA_CHAT_ARCHIVE: archive, ELYSIA_CHAT_STAGE: stage } });
      } catch { reject(failure('archive')); return; }
      const finish = error => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => { failureReason = cancelled(); child.kill(); };
      const timer = setTimeout(() => { failureReason = failure('archive'); child.kill(); }, extractionTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => finish(failureReason || failure('archive')));
      // Wait until file handles close before the caller removes the staging tree.
      child.once('exit', code => finish(failureReason || (code === 0 ? null : failure('archive'))));
      if (signal.aborted) abort();
    });
  }
  async function prepare(signal) {
    if (!manifestValid) throw failure('manifest');
    let available = resources();
    if (!runtimeInstalled()) {
      if (fs.existsSync(runtimeRoot)) {
        const existing = await fs.promises.lstat(runtimeRoot);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw failure('conflict');
        // Keep incomplete or old runtime files recoverable. The destination is
        // a sibling inside this same app-owned userData directory.
        const quarantine = path.join(userData, `chat-runtime.unverified-${randomUUID()}`);
        try { await fs.promises.rename(runtimeRoot, quarantine); } catch { throw failure('conflict'); }
      }
      const cache = path.join(userData, 'chat-downloads');
      await fs.promises.mkdir(cache, { recursive: true });
      const archive = path.join(cache, `${manifest.runtime.sha256.slice(0, 16)}-${manifest.runtime.file}`);
      phase('downloading-installer', '正在下载桌宠专用的聊天运行环境…');
      await download(manifest.runtime, archive, signal);
      const stage = await fs.promises.mkdtemp(path.join(userData, 'chat-staging-'));
      try {
        phase('installing', '正在解压聊天运行环境…');
        await extract(archive, stage, signal); checkAbort(signal);
        if (!manifest.runtime.required.every(file => ordinaryFile(path.join(stage, file)))) throw failure('archive');
        await fs.promises.writeFile(path.join(stage, 'elysia-runtime.json'), JSON.stringify({ bytes: manifest.runtime.bytes, sha256: manifest.runtime.sha256 }), { flag: 'wx' });
        await fs.promises.rename(stage, runtimeRoot);
      } finally { await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {}); }
    }
    await prepareRuntimeDependencies(signal);
    if (!available.modelReady) {
      await fs.promises.mkdir(modelRoot, { recursive: true });
      phase('pulling-model', '正在下载本地聊天模型，取消后可继续下载…');
      await download(manifest.model, modelPath, signal);
      checkAbort(signal);
      const temp = modelMarker + `.${randomUUID()}.tmp`;
      await fs.promises.writeFile(temp, JSON.stringify({ bytes: manifest.model.bytes, sha256: manifest.model.sha256, modifiedAt: fs.statSync(modelPath).mtimeMs }));
      await fs.promises.rename(temp, modelMarker);
    }
  }
  async function prepareRuntimeDependencies(signal) {
    if (!runtimeDependencies.ready(runtimeRoot)) {
      phase('installing', '正在准备桌宠专用的聊天运行库…');
      await runtimeDependencies.prepare(runtimeRoot, signal);
    }
  }
  function stopServer() {
    const owned = server; server = null;
    if (owned && !owned.exited) { try { owned.child.kill(); } catch {} }
  }
  async function waitTick(signal) {
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, pollIntervalMs);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  async function selectDevice(signal) {
    // Integrated GPUs report shared RAM as VRAM. Prefer a recognizable discrete
    // device; CPU is safer than filling system memory on an unknown adapter.
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      let child, output = '', aborted = false, finished = false;
      try { child = spawnImpl(serverPath, ['--list-devices'], { cwd: runtimeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env }); }
      catch { resolve('none'); return; }
      const finish = () => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (aborted) { reject(cancelled()); return; }
        const match = output.split(/\r?\n/).map(line => line.match(/^\s*(Vulkan\d+):\s*(?:NVIDIA\b|AMD Radeon RX\b|Intel\(R\) Arc\b|Intel Arc\b)/i)).find(Boolean);
        resolve(match?.[1] || 'none');
      };
      const abort = () => { aborted = true; child.kill(); };
      const timer = setTimeout(() => { child.kill(); }, 10000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.setEncoding('utf8'); child.stdout?.on('data', chunk => { output = (output + chunk).slice(0, 65536); });
      child.once('error', finish); child.once('exit', finish);
      if (signal.aborted) abort();
    });
  }
  async function startServer(signal) {
    const observed = await probe(signal); checkAbort(signal);
    if (server && observed === 'ready') return;
    if (!server && observed !== 'offline') throw failure('port');
    if (!server) {
      const device = await selectDevice(signal); checkAbort(signal);
      let child;
      const args = ['--model', modelPath, '--alias', SETUP_MODEL, '--host', '127.0.0.1', '--port', '18434',
        '--ctx-size', '16384', '--parallel', '1', '--jinja', '--no-webui', '--fit', 'on', '--fit-target', '3072',
        '--device', device, '--threads', '8', '--reasoning-budget', '0', '--reasoning-format', 'deepseek',
        '--chat-template-kwargs', '{"enable_thinking":false}'];
      const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const hostScript = path.join(__dirname, 'chat-runtime-host.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      try { child = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScript],
        { cwd: runtimeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...env, ELYSIA_CHAT_SERVER: serverPath, ELYSIA_CHAT_ARGS: JSON.stringify(args), ELYSIA_CHAT_PARENT_PID: String(process.pid) } }); }
      catch { throw failure('start'); }
      const owner = { child, exited: false }; server = owner;
      const ended = () => {
        owner.exited = true;
        if (server !== owner) return; server = null;
        if (!active) update({ phase: 'error', serverReady: false, busy: false, canCancel: false, error: ERRORS.start, message: ERRORS.start });
      };
      child.once('error', ended); child.once('exit', ended);
    }
    const owner = server, deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      checkAbort(signal);
      if (!owner || owner.exited || server !== owner) throw failure('start');
      if (await probe(signal) === 'ready') {
        checkAbort(signal);
        if (owner.exited || server !== owner) throw failure('start');
        return;
      }
      await waitTick(signal);
    }
    throw failure('start');
  }
  function terminalError(error, signal) {
    return { phase: signal.aborted ? 'cancelled' : 'error', busy: false, canCancel: false, serverReady: false,
      error: signal.aborted ? null : ERRORS[error.setupCode] || ERRORS.download,
      message: signal.aborted ? '已取消配置，重试时可继续下载。' : ERRORS[error.setupCode] || ERRORS.download,
      ...resources() };
  }
  async function run(operation, install) {
    const signal = operation.controller.signal; let result;
    try {
      if (platform !== 'win32' || arch !== 'x64') throw failure('unsupported');
      if (!manifestValid) throw failure('manifest');
      if (install) await prepare(signal);
      else if (runtimeInstalled()) await prepareRuntimeDependencies(signal);
      const available = resources();
      if (!available.runtimeReady || !available.modelReady) {
        result = { phase: available.runtimeReady ? 'needs-model' : 'needs-install', ...available,
          serverReady: false, busy: false, canCancel: false, error: null, message: '本地聊天资源尚未准备好，可在设置中继续配置。' };
      } else {
        phase('starting', '正在启动本地聊天服务，首次加载模型需要一些时间…');
        await startServer(signal); checkAbort(signal);
        result = { phase: 'ready', ...available, serverReady: true, busy: false, canCancel: false,
          progress: 1, error: null, message: '本地聊天模型已就绪，可以开始聊天。' };
      }
    } catch (error) {
      stopServer(); result = terminalError(error, signal);
    } finally {
      if (active === operation) active = null;
      update(result);
    }
  }
  function begin(kind) {
    if (disposed) return { ok: false, error: '配置服务已关闭。' };
    if (active) {
      if (kind === 'start') {
        if (active.kind === 'inspect') startAfterInspection = true;
        return { ok: true, state: getState() };
      }
      return { ok: false, error: '配置正在进行，请等待当前操作完成。' };
    }
    const operation = { controller: new AbortController(), kind }; active = operation;
    phase('checking', '正在检测本地聊天环境…'); void run(operation, kind === 'install');
    return { ok: true, state: getState() };
  }
  async function inspect() {
    if (disposed || active) return getState();
    const operation = { controller: new AbortController(), kind: 'inspect' }; active = operation;
    phase('checking', '正在检测本地聊天环境…');
    try {
      const available = resources(), status = await probe(operation.controller.signal);
      const ready = !!server && status === 'ready';
      update({ ...available, serverReady: ready, phase: ready ? 'ready' : !available.runtimeReady ? 'needs-install' : !available.modelReady ? 'needs-model' : 'idle',
        busy: false, canCancel: false, error: null, message: ready ? '本地聊天模型已就绪。' : '本地聊天服务尚未启动。' });
    } catch (error) { update(terminalError(error, operation.controller.signal)); }
    finally {
      if (active === operation) active = null;
      if (startAfterInspection) { startAfterInspection = false; begin('start'); }
    }
    return getState();
  }
  function cancel() {
    if (!active || !state.canCancel) return { ok: false, state: getState() };
    startAfterInspection = false; active.controller.abort(); return { ok: true, state: getState() };
  }
  function dispose() { disposed = true; startAfterInspection = false; active?.controller.abort(); stopServer(); }
  const ensureInstalledServer = () => begin('start');
  return { getState, inspect, installChatModel: () => begin('install'), ensureInstalledServer,
    startInstalledServer: ensureInstalledServer, cancel, dispose };
}
module.exports = { createModelSetup, SETUP_MODEL, SETUP_BASE_URL, MODEL_BYTES };

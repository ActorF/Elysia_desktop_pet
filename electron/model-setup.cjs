/** Pinned llama.cpp runtime/model preparation and a private, GUI-free local server. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const manifestDefault = require('./chat-bootstrap-manifest.json');
const { EXTRACT_SCRIPT } = require('./chat-runtime-extract.cjs');
const { createRuntimeDependencies, validDependenciesManifest } = require('./chat-runtime-dependencies.cjs');
const { downloadResource, verifyResource } = require('./resource-download.cjs');
const { createSetupDiagnostic, classifySetupFailure } = require('./setup-diagnostics.cjs');
const { createRuntimeRepair } = require('./voice-repair.cjs');

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
  'runtime-source': '安装包中的聊天运行环境缺失或校验失败，请重新下载完整安装包后重试。',
  'dependencies-source': '安装包中的聊天运行库资源缺失或校验失败，请重新下载完整安装包后重试。无需自行安装系统运行库。',
  dependencies: '聊天运行库准备失败，请退出桌宠后重试，并检查用户目录权限和磁盘空间。',
  port: '本地聊天端口 18434 已被其他程序占用，请关闭占用程序后重试。',
  start: '本地聊天服务未能启动，请检查可用内存和显卡驱动后重试。',
  'downloads-disabled': '本地测试模式只使用已有聊天资源，不会下载或安装。',
  'preview-resources': '已有聊天资源不完整，暂时无法启动；本地测试模式不会下载或安装资源。',
});
const FAILURE_KINDS = Object.freeze({ unsupported: 'platform-unsupported', manifest: 'manifest-invalid', download: 'network-unknown',
  integrity: 'integrity-hash', archive: 'extraction-exit', storage: 'storage-io', conflict: 'storage-busy',
  'runtime-source': 'runtime-source-missing', 'dependencies-source': 'dependencies-source-missing', dependencies: 'dependencies-invalid',
  port: 'server-port-busy', start: 'server-launch', 'downloads-disabled': 'preview-disabled' });
const failure = (code, diagnosticKind = FAILURE_KINDS[code] || 'unknown', details = {}, cause) =>
  Object.assign(new Error(code, cause ? { cause } : undefined), { setupCode: code, diagnosticKind, ...details });
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const checkAbort = signal => { if (signal.aborted) throw cancelled(); };
const ordinaryFile = file => { try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
function sourceUrls(asset) { return asset.sources === undefined ? [asset.url] : asset.sources; }
function validSource(raw, key) {
  if (typeof raw !== 'string') return false;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false;
  if (key === 'runtime') return url.hostname === 'github.com'
    && /^\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\/llama-[\w.-]+\.zip$/.test(url.pathname);
  if (url.hostname === 'huggingface.co') return /^\/empero-ai\/Qwen3\.8-9B-Distill-GGUF\/resolve\/[a-f0-9]{40}\/Qwen3\.8-9B-Q4_K_M\.gguf$/.test(url.pathname);
  return ['www.modelscope.cn', 'modelscope.cn'].includes(url.hostname)
    && /^\/models\/empero-ai\/Qwen3\.8-9B-Distill-GGUF\/resolve\/[a-f0-9]{40}\/Qwen3\.8-9B-Q4_K_M\.gguf$/.test(url.pathname);
}
function validManifest(value) {
  return value?.version === 1 && value.backend === 'llama.cpp-v1' && value.runtime?.arch === 'x64'
    && validDependenciesManifest(value.runtimeDependencies)
    && Array.isArray(value.runtime.required) && value.runtime.required.includes('llama-server.exe') && value.runtime.required.length < 100
    && value.runtime.required.every(file => /^[a-zA-Z0-9_-]+\.(?:exe|dll)$/.test(file))
    && ['runtime', 'model'].every(key => {
      const a = value[key];
      return a && /^[a-zA-Z0-9._-]+$/.test(a.file) && !a.file.startsWith('.')
        && /^[a-f0-9]{64}$/.test(a.sha256) && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.bytes <= 16 * 1024 ** 3
        && (a.bundled === undefined || typeof a.bundled === 'boolean')
        && validSource(a.url, key)
        && Array.isArray(sourceUrls(a)) && sourceUrls(a).length > 0 && sourceUrls(a).length <= 4
        && new Set(sourceUrls(a)).size === sourceUrls(a).length
        && sourceUrls(a).every(url => validSource(url, key));
    });
}
function allowedDownload(url, source, asset) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const original = new URL(source);
  if (['www.modelscope.cn', 'modelscope.cn'].includes(original.hostname)) {
    if (['www.modelscope.cn', 'modelscope.cn'].includes(url.hostname)) return url.pathname === original.pathname && !url.search && !url.hash;
    const hash = asset.sha256;
    return url.hostname === 'cdn-lfs-cn-1.modelscope.cn'
      && url.pathname === `/prod/lfs-objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
  }
  if (original.hostname === 'github.com') {
    if (url.hostname === 'github.com') return url.pathname === original.pathname;
    return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
      && /^\/github-production-release-asset(?:-2e65be)?\//.test(url.pathname);
  }
  return (url.hostname === 'huggingface.co' && url.pathname === original.pathname) || url.hostname === 'cdn-lfs.huggingface.co'
    || url.hostname === 'cdn-lfs-us-1.hf.co' || url.hostname === 'cdn-lfs-eu-1.hf.co'
    || url.hostname === 'cdn.hf.co' || url.hostname.endsWith('.cdn.hf.co')
    || url.hostname === 'cas-bridge.xethub.hf.co';
}

function createModelSetup({ userData, onChange = () => {}, fetchImpl = globalThis.fetch, spawnImpl = spawn, allowDownloads = true,
  platform = process.platform, arch = process.arch, env = process.env, manifest = manifestDefault,
  resourcesPath = process.resourcesPath, assetDirectory, runtimeAssetDirectory,
  probeTimeoutMs = 1500, startTimeoutMs = 180000, pollIntervalMs = 500,
  downloadTimeoutMs = 4 * 60 * 60 * 1000, requestTimeoutMs = 15000, idleTimeoutMs = 30000,
  extractionTimeoutMs = 5 * 60 * 1000 } = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new TypeError('userData must be an absolute directory.');
  if (typeof allowDownloads !== 'boolean') throw new TypeError('allowDownloads must be a boolean.');
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
    progress: null, error: null, diagnostic: null, allowDownloads, message: '准备桌宠专用的本地聊天环境。' };
  const getState = () => structuredClone(state);
  function update(patch, throttle = false) {
    Object.assign(state, patch);
    if (disposed || (throttle && Date.now() - lastNotice < 150)) return;
    lastNotice = Date.now(); onChange(getState());
  }
  function phase(value, message) {
    update({ phase: value, message, busy: true, canCancel: true, error: null, diagnostic: null, completedBytes: 0, totalBytes: 0, progress: null });
  }
  function markerMatches(file, asset, payload) {
    try {
      if (!ordinaryFile(file) || fs.statSync(file).size > 4096) return false;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value.sha256 === asset.sha256 && value.bytes === asset.bytes
        && (!payload || value.modifiedAt === fs.statSync(payload).mtimeMs);
    } catch { return false; }
  }
  function runtimeInstalled(directory = runtimeRoot) {
    return manifestValid && manifest.runtime.required.every(file => ordinaryFile(path.join(directory, file)))
      && markerMatches(path.join(directory, 'elysia-runtime.json'), manifest.runtime);
  }
  function resources() {
    const runtimeReady = runtimeInstalled() && runtimeDependencies.ready(runtimeRoot);
    let modelReady = false;
    try { modelReady = manifestValid && ordinaryFile(modelPath) && fs.statSync(modelPath).size === manifest.model.bytes && markerMatches(modelMarker, manifest.model, modelPath); } catch {}
    return { runtimeReady, modelReady };
  }
  function resourceProblem(available = resources()) {
    if (!manifestValid) return { kind: 'manifest-invalid' };
    const check = file => {
      try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() ? stat : false; }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
    };
    const markerProblem = (file, asset, prefix, payload) => {
      const stat = check(file);
      if (stat === null) return `${prefix}-marker-missing`;
      if (!stat || stat.size > 4096) return `${prefix}-marker-invalid`;
      let value;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) return `${prefix}-marker-invalid`; throw error; }
      if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
        || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return `${prefix}-marker-invalid`;
      if (value.bytes !== asset.bytes || value.sha256 !== asset.sha256) return `${prefix}-resource-mismatch`;
      if (payload && value.modifiedAt !== fs.statSync(payload).mtimeMs) return `${prefix}-invalid`;
      return null;
    };
    if (!runtimeInstalled()) {
      let directory;
      try { directory = fs.lstatSync(runtimeRoot); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) return { kind: 'runtime-invalid' };
      const absent = manifest.runtime.required.filter(file => check(path.join(runtimeRoot, file)) === null);
      if (absent.length) return { kind: 'runtime-missing', missingFiles: absent, missingCount: absent.length };
      if (manifest.runtime.required.some(file => !check(path.join(runtimeRoot, file)))) return { kind: 'runtime-invalid' };
      return { kind: markerProblem(runtimeMarker, manifest.runtime, 'runtime') || 'runtime-invalid' };
    }
    if (!available.runtimeReady) return runtimeDependencies.inspect(runtimeRoot);
    if (!available.modelReady) {
      const file = check(modelPath);
      if (file === null) return { kind: 'model-missing', missingFiles: [manifest.model.file], missingCount: 1 };
      if (!file || file.size !== manifest.model.bytes) return { kind: 'model-invalid' };
      return { kind: markerProblem(modelMarker, manifest.model, 'model', modelPath) || 'model-invalid' };
    }
    return null;
  }
  const diagnosticFor = (error, stage) => {
    const chain = [], seen = new Set();
    for (let current = error; current && typeof current === 'object' && chain.length < 6 && !seen.has(current); current = current.cause) {
      seen.add(current); chain.push(current);
    }
    return createSetupDiagnostic('chat', classifySetupFailure(error, FAILURE_KINDS[error?.setupCode] || 'unknown'),
      { stage, httpStatus: chain.find(item => Number.isInteger(item.httpStatus))?.httpStatus,
        systemCode: chain.find(item => typeof item.code === 'string' && /^(?:E[A-Z0-9_]{1,35}|UND_ERR_[A-Z_]{1,35})$/.test(item.code))?.code,
        exitCode: chain.find(item => Number.isInteger(item.exitCode))?.exitCode });
  };
  const stageForPhase = () => ({ checking: 'inspection', 'downloading-installer': 'download', 'pulling-model': 'download',
    'verifying-installer': 'verify', installing: 'extract', starting: 'start' })[state.phase] || 'inspection';
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
  const verified = verifyResource;
  async function download(asset, destination, signal) {
    if (!allowDownloads) throw failure('downloads-disabled');
    const downloadPhase = asset === manifest.model ? 'pulling-model' : 'downloading-installer';
    const message = asset === manifest.model ? '正在下载本地聊天模型，取消后可继续下载…' : '正在下载桌宠专用的聊天运行环境…';
    return downloadResource({ asset, destination, sources: sourceUrls(asset), fetchImpl, signal,
      isAllowedUrl: (url, source) => allowedDownload(url, source, asset),
      requestTimeoutMs, idleTimeoutMs, downloadTimeoutMs,
      onVerify: () => phase('verifying-installer', '正在校验聊天资源…'),
      onSourceChange: () => phase(downloadPhase, '正在切换聊天资源下载源，已下载部分会继续使用…'),
      onProgress: (completed, total) => update({ phase: downloadPhase, message, completedBytes: completed,
        totalBytes: total, progress: completed / total }, true) });
  }
  async function bundledRuntime(signal) {
    const directories = runtimeAssetDirectory ? [runtimeAssetDirectory] : assetDirectory ? [assetDirectory]
      : [resourcesPath, path.join(__dirname, '..', 'build-resources', 'chat-bootstrap')].filter(Boolean);
    for (const directory of [...new Set(directories)]) {
      const candidate = path.join(directory, manifest.runtime.file);
      try { await fs.promises.lstat(candidate); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      phase('verifying-installer', '正在校验安装包内的聊天运行环境…');
      if (await verified(candidate, manifest.runtime, signal)) return candidate;
      throw failure('runtime-source', 'runtime-source-integrity');
    }
    if (manifest.runtime.bundled) throw failure('runtime-source');
    return null;
  }
  function extract(archive, stage, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      let child, failureReason = null, finished = false;
      try {
        child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(EXTRACT_SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, shell: false, stdio: 'ignore', env: { ...env, ELYSIA_CHAT_ARCHIVE: archive, ELYSIA_CHAT_STAGE: stage } });
      } catch (error) { reject(failure('archive', classifySetupFailure(error, 'extraction-launch'), {}, error)); return; }
      const finish = error => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => { failureReason = cancelled(); child.kill(); };
      const timer = setTimeout(() => { failureReason = failure('archive', 'extraction-timeout'); child.kill(); }, extractionTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', error => finish(failureReason || failure('archive', classifySetupFailure(error, 'extraction-launch'), {}, error)));
      // Wait until file handles close before the caller removes the staging tree.
      child.once('exit', code => finish(failureReason || (code === 0 ? null : failure('archive',
        ({ 70: 'archive-unsafe', 71: 'archive-layout', 72: 'storage-space', 73: 'storage-permission', 74: 'storage-busy', 75: 'storage-path' })[code] || 'extraction-exit', { exitCode: code }))));
      if (signal.aborted) abort();
    });
  }
  async function runtimeDirectory() {
    let stat;
    try { stat = await fs.promises.lstat(runtimeRoot); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('conflict');
    return stat;
  }
  const sameDirectory = (left, right) => Boolean(left) === Boolean(right) && (!left
    || left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs);
  async function prepare(signal) {
    if (!manifestValid) throw failure('manifest');
    const repair = createRuntimeRepair({ kind: 'chat', userData, verifyInstallation: directory => {
      checkAbort(signal);
      return runtimeInstalled(directory) && runtimeDependencies.ready(directory);
    } });
    // Only explicit configuration may finish a journal left by an interrupted
    // replacement. Inspection and local-preview startup remain read-only.
    await repair.recover(); checkAbort(signal);
    let available = resources();
    if (!runtimeInstalled()) {
      const previous = await runtimeDirectory();
      const cache = path.join(userData, 'chat-downloads');
      await fs.promises.mkdir(cache, { recursive: true });
      let archive = await bundledRuntime(signal);
      if (!archive) {
        archive = path.join(cache, `${manifest.runtime.sha256.slice(0, 16)}-${manifest.runtime.file}`);
        phase('downloading-installer', '正在下载桌宠专用的聊天运行环境…');
        await download(manifest.runtime, archive, signal);
      }
      const stage = await fs.promises.mkdtemp(path.join(userData, 'chat-staging-'));
      let preserveStage = false;
      try {
        phase('installing', '正在解压聊天运行环境…');
        await extract(archive, stage, signal); checkAbort(signal);
        if (!manifest.runtime.required.every(file => ordinaryFile(path.join(stage, file)))) throw failure('archive', 'archive-layout');
        await prepareRuntimeDependencies(signal, stage); checkAbort(signal);
        await fs.promises.writeFile(path.join(stage, 'elysia-runtime.json'), JSON.stringify({ bytes: manifest.runtime.bytes, sha256: manifest.runtime.sha256 }), { flag: 'wx' });
        if (!runtimeInstalled(stage) || !runtimeDependencies.ready(stage)) throw failure('archive', 'archive-layout');
        if (!sameDirectory(await runtimeDirectory(), previous)) throw failure('conflict');
        checkAbort(signal);
        await repair.commit(stage, { allowReplace: Boolean(previous) });
      } catch (error) { preserveStage = error.preserveStage === true; throw error; }
      finally { if (!preserveStage) await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {}); }
    }
    await prepareRuntimeDependencies(signal);
    if (!available.modelReady) {
      await fs.promises.mkdir(modelRoot, { recursive: true });
      if (ordinaryFile(modelPath)) phase('verifying-installer', '正在校验已有聊天模型，完整文件会直接复用…');
      else phase('pulling-model', '正在下载本地聊天模型，取消后可继续下载…');
      await download(manifest.model, modelPath, signal);
      checkAbort(signal);
      const temp = modelMarker + `.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temp, JSON.stringify({ bytes: manifest.model.bytes, sha256: manifest.model.sha256, modifiedAt: fs.statSync(modelPath).mtimeMs }), { flag: 'wx' });
        checkAbort(signal);
        await fs.promises.rename(temp, modelMarker);
      } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
    }
  }
  async function prepareRuntimeDependencies(signal, directory = runtimeRoot) {
    if (!runtimeDependencies.ready(directory)) {
      phase('installing', '正在准备桌宠专用的聊天运行库…');
      await runtimeDependencies.prepare(directory, signal);
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
      catch (error) { throw failure('start', classifySetupFailure(error, 'server-launch'), {}, error); }
      const owner = { child, exited: false, failure: null }; server = owner;
      const ended = error => {
        if (owner.exited) return;
        owner.exited = true;
        owner.failure = error;
        if (server !== owner) return; server = null;
        if (!active) update({ phase: 'error', serverReady: false, busy: false, canCancel: false, error: ERRORS.start, message: ERRORS.start,
          diagnostic: diagnosticFor(error, 'start') });
      };
      child.once('error', error => ended(failure('start', classifySetupFailure(error, 'server-launch'), {}, error)));
      child.once('exit', code => ended(failure('start', 'server-exit', { exitCode: code })));
    }
    const owner = server, deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      checkAbort(signal);
      if (!owner || owner.exited || server !== owner) throw owner?.failure || failure('start', 'server-exit');
      const status = await probe(signal);
      if (status === 'ready') {
        checkAbort(signal);
        if (owner.exited || server !== owner) throw owner.failure || failure('start', 'server-exit');
        return;
      }
      if (status === 'occupied') throw failure('start', 'server-protocol');
      await waitTick(signal);
    }
    throw failure('start', 'server-timeout');
  }
  function terminalError(error, signal) {
    const diagnostic = signal.aborted ? null : diagnosticFor(error, stageForPhase());
    const message = signal.aborted ? '已取消配置，重试时可继续下载。' : ERRORS[error.setupCode] || diagnostic.summary;
    return { phase: signal.aborted ? 'cancelled' : 'error', busy: false, canCancel: false, serverReady: false,
      error: signal.aborted ? null : message, diagnostic, message,
      ...resources() };
  }
  async function run(operation, install) {
    const signal = operation.controller.signal; let result;
    try {
      if (platform !== 'win32' || arch !== 'x64') throw failure('unsupported');
      if (!manifestValid) throw failure('manifest');
      if (install) await prepare(signal);
      else if (allowDownloads && runtimeInstalled()) await prepareRuntimeDependencies(signal);
      const available = resources();
      if (!available.runtimeReady || !available.modelReady) {
        const problem = resourceProblem(available);
        const diagnostic = createSetupDiagnostic('chat', problem?.kind || 'resources-unavailable', { ...problem, stage: 'inspection' });
        result = { phase: available.runtimeReady ? 'needs-model' : 'needs-install', ...available,
          serverReady: false, busy: false, canCancel: false, diagnostic, error: allowDownloads ? diagnostic.summary : ERRORS['preview-resources'],
          message: allowDownloads ? diagnostic.summary : ERRORS['preview-resources'] };
      } else {
        phase('starting', '正在启动本地聊天服务，首次加载模型需要一些时间…');
        await startServer(signal); checkAbort(signal);
        result = { phase: 'ready', ...available, serverReady: true, busy: false, canCancel: false,
          progress: 1, error: null, diagnostic: null, message: '本地聊天模型已就绪，可以开始聊天。' };
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
    if (kind === 'install' && !allowDownloads) {
      return { ok: false, code: 'downloads-disabled', error: ERRORS['downloads-disabled'], diagnostic: createSetupDiagnostic('chat', 'preview-disabled', { stage: 'inspection' }), state: getState() };
    }
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
    const previousFailure = state.diagnostic;
    const operation = { controller: new AbortController(), kind: 'inspect' }; active = operation;
    phase('checking', '正在检测本地聊天环境…');
    try {
      if (platform !== 'win32' || arch !== 'x64') throw failure('unsupported');
      if (!manifestValid) throw failure('manifest');
      const available = resources(), status = await probe(operation.controller.signal);
      const ready = !!server && status === 'ready' && available.runtimeReady && available.modelReady;
      const missingPreviewResources = !allowDownloads && (!available.runtimeReady || !available.modelReady);
      const problem = resourceProblem(available);
      let diagnostic = ready ? null : !server && status !== 'offline' ? createSetupDiagnostic('chat', 'server-port-busy', { stage: 'start' })
        : server && status === 'occupied' ? createSetupDiagnostic('chat', 'server-protocol', { stage: 'start' })
          : problem ? createSetupDiagnostic('chat', problem.kind, { ...problem, stage: 'inspection' }) : null;
      // Inspection checks files and a running owned server; it cannot prove a
      // failed download, extraction or stopped-server launch has been repaired.
      if (!ready && previousFailure && status === 'offline') {
        const previousStage = previousFailure.stage;
        if (['download', 'verify', 'extract', 'validate', 'storage', 'start'].includes(previousStage)
          && previousFailure.code !== createSetupDiagnostic('chat', 'server-port-busy', { stage: 'start' }).code) diagnostic = previousFailure;
      }
      const error = missingPreviewResources ? ERRORS['preview-resources'] : diagnostic?.summary || null;
      update({ ...available, serverReady: ready, phase: ready ? 'ready' : !available.runtimeReady ? 'needs-install' : !available.modelReady ? 'needs-model' : diagnostic ? 'error' : 'idle',
        busy: false, canCancel: false, diagnostic, error,
        message: ready ? '本地聊天模型已就绪。' : error || '本地聊天服务尚未启动。' });
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

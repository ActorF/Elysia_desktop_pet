/** Deploy digest-pinned voice archives into a private, relocatable user runtime. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const RUNTIME_NAME = 'GPT-SoVITS-v2-240821';
const REQUIRED = ['config/settings.py', 'python/python.exe', 'python/python314.zip', 'voice/managed_gpt_sovits.py',
  'scripts/gpt_sovits_worker.py', 'workspace/settings/voice-profiles.json', `models/cache/${RUNTIME_NAME}/runtime/python.exe`];
const MESSAGES = Object.freeze({
  manifest: '语音资源清单尚未准备好，请使用包含完整配置资源的安装包。',
  unavailable: '语音资源尚未发布或暂时无法下载，请稍后重试。文字聊天仍可使用。',
  integrity: '语音资源校验未通过，未安装该文件。请重新下载后重试。',
  extractor: '安装包中的解压工具缺失或校验失败，请重新下载安装包。',
  archive: '语音压缩包目录或文件结构不符合预期，未部署该资源。',
  storage: '语音资源部署失败，请检查用户目录权限和剩余磁盘空间后重试。',
  conflict: '语音目录中存在另一套未识别的文件，已保留原文件；请检查安装状态后重试。',
});
const failure = code => Object.assign(new Error(code), { voiceSetupCode: code });
const aborted = signal => { if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
const digestPattern = /^[0-9a-f]{64}$/i;

function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (url.hostname === 'github.com') return url.pathname.startsWith('/ActorF/Elysia_desktop_pet/releases/download/');
  if (url.hostname === 'huggingface.co') return url.pathname.startsWith('/lj1995/GPT-SoVITS-windows-package/resolve/');
  if (['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    return /^\/github-production-release-asset(?:-2e65be)?\//.test(url.pathname);
  }
  return ['cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs.hf.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co'].includes(url.hostname);
}

function validManifest(value) {
  if (value?.version !== 1 || !value.extractor || value.extractor.relativePath !== 'tools/7za.exe'
    || !digestPattern.test(value.extractor.sha256)) return false;
  return ['assets', 'runtime'].every(key => {
    const item = value[key];
    return item && typeof item.fileName === 'string' && /^[A-Za-z0-9_.-]+\.(?:zip|7z)$/.test(item.fileName)
      && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= 12 * 1024 ** 3
      && digestPattern.test(item.sha256) && (item.url === undefined || item.url === null || allowedUrl(item.url));
  });
}

function safeEntry(name) {
  if (!name || /[\u0000-\u001f\u007f:]/.test(name) || /^[\\/]/.test(name)) return false;
  const parts = name.replace(/\\/g, '/').split('/');
  return parts.every(part => part && !['.', '..'].includes(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/** Create a lazy installer. No model or interpreter is launched during setup. */
function createVoiceSetup({ userData, onChange = () => {}, resourcesPath = process.resourcesPath,
  assetDirectory, fetchImpl = globalThis.fetch, spawnImpl = spawn, env = process.env,
  manifest: suppliedManifest, manifestPath = path.join(__dirname, 'voice-bootstrap-manifest.json'),
  downloadTimeoutMs = 4 * 60 * 60 * 1000, extractionTimeoutMs = 45 * 60 * 1000 } = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new TypeError('userData must be absolute.');
  const projectRoot = path.join(userData, 'voice-runtime');
  let manifest;
  try { manifest = suppliedManifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  if (!validManifest(manifest)) manifest = null;
  let active = null, disposed = false, lastNotice = 0;
  const state = { phase: 'idle', busy: false, canCancel: false, ready: false,
    completedBytes: 0, totalBytes: 0, progress: null, error: null,
    expectedBytes: manifest ? manifest.assets.bytes + manifest.runtime.bytes : 0, message: '准备独立的本地语音环境。' };
  const getState = () => structuredClone(state);
  const getProjectRoot = () => projectRoot;
  function update(patch, throttle = false) {
    Object.assign(state, patch);
    if (disposed || (throttle && Date.now() - lastNotice < 150)) return;
    lastNotice = Date.now(); onChange(getState());
  }
  function phase(name, message) { update({ phase: name, message, busy: true, canCancel: true,
    completedBytes: 0, totalBytes: 0, progress: null, error: null }); }
  function ordinaryFile(file) {
    try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
  }
  function ready() {
    if (!manifest || !REQUIRED.every(relative => ordinaryFile(path.join(projectRoot, relative)))) return false;
    try {
      const marker = path.join(projectRoot, 'voice-setup-complete.json');
      if (fs.statSync(marker).size > 65536) return false;
      const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
      return value.version === 1 && value.assets === manifest.assets.sha256 && value.runtime === manifest.runtime.sha256
        && Array.isArray(value.required) && value.required.length >= REQUIRED.length && value.required.length <= 200
        && value.required.every(relative => typeof relative === 'string' && safeEntry(relative) && ordinaryFile(path.join(projectRoot, relative)));
    } catch { return false; }
  }
  async function inspect() {
    if (active || disposed) return getState();
    const installed = ready();
    update({ phase: installed ? 'ready' : manifest ? 'needs-install' : 'error', ready: installed,
      error: manifest ? null : MESSAGES.manifest, message: installed ? '本地语音环境已就绪。' : manifest ? '首次配置将自动准备语音环境。' : MESSAGES.manifest });
    return getState();
  }
  async function digest(file, signal) {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    const stop = () => stream.destroy();
    signal.addEventListener('abort', stop, { once: true });
    try { for await (const chunk of stream) { aborted(signal); hash.update(chunk); } aborted(signal); return hash.digest('hex'); }
    finally { signal.removeEventListener('abort', stop); stream.destroy(); }
  }
  async function matches(file, item, signal) {
    if (!ordinaryFile(file) || fs.statSync(file).size !== item.bytes) return false;
    return (await digest(file, signal)).toLowerCase() === item.sha256.toLowerCase();
  }
  async function ensureDirectory(directory) {
    await fs.promises.mkdir(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink()) throw failure('storage');
  }
  async function verifiedArchive(item, kind, signal) {
    phase('verifying', `正在检查${kind}资源…`);
    const candidates = [assetDirectory, env.PORTABLE_EXECUTABLE_DIR,
      env.PORTABLE_EXECUTABLE_FILE && path.dirname(env.PORTABLE_EXECUTABLE_FILE),
      path.dirname(process.execPath), resourcesPath].filter(Boolean);
    const cacheDirectory = path.join(userData, 'voice-downloads');
    await ensureDirectory(cacheDirectory);
    const cached = path.join(cacheDirectory, `${item.sha256.slice(0, 16)}-${item.fileName}`);
    for (const file of [...new Set(candidates.map(directory => path.join(directory, item.fileName))), cached]) {
      if (await matches(file, item, signal)) return file;
    }
    aborted(signal);
    if (!item.url) throw failure('unavailable');
    phase('downloading', `正在下载${kind}，完成后会自动配置…`);
    update({ totalBytes: item.bytes });
    const partial = path.join(cacheDirectory, `${randomUUID()}.partial`);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(downloadTimeoutMs)]);
    let response, url = item.url, handle;
    try {
      for (let count = 0; count <= 8; count++) {
        if (!allowedUrl(url)) throw failure('integrity');
        try { response = await fetchImpl(url, { signal: combined, redirect: 'manual' }); } catch { throw failure('unavailable'); }
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const target = response.headers.get('location'); await response.body?.cancel();
        if (!target || count === 8) throw failure('integrity');
        url = new URL(target, url).href;
      }
      if (!response?.ok || !response.body) throw failure('unavailable');
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) !== item.bytes) throw failure('integrity');
      handle = await fs.promises.open(partial, 'wx', 0o600);
      const hash = createHash('sha256'), reader = response.body.getReader(); let completed = 0;
      const stop = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener('abort', stop, { once: true });
      try {
        for (;;) {
          aborted(combined);
          const { done, value } = await reader.read(); aborted(combined);
          if (done) break;
          completed += value.length;
          if (completed > item.bytes) throw failure('integrity');
          hash.update(value); await handle.writeFile(value);
          update({ completedBytes: completed, progress: completed / item.bytes }, true);
        }
      } finally { combined.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      await handle.close(); handle = null;
      if (completed !== item.bytes || hash.digest('hex').toLowerCase() !== item.sha256.toLowerCase()) throw failure('integrity');
      aborted(signal);
      // Cache names contain the expected digest. Replace only this exact failed
      // cache entry; unrelated versions and concurrent partials are never pruned.
      await fs.promises.rm(cached, { force: true });
      await fs.promises.rename(partial, cached);
      return cached;
    } catch (error) { throw error.voiceSetupCode ? error : failure(combined.aborted && !signal.aborted ? 'unavailable' : 'storage'); }
    finally { await handle?.close().catch(() => {}); await fs.promises.rm(partial, { force: true }).catch(() => {}); }
  }
  function runExtractor(executable, args, signal) {
    return new Promise((resolve, reject) => {
      aborted(signal);
      let child;
      try { child = spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { reject(failure('extractor')); return; }
      const operation = active; operation.child = child;
      const decoder = new StringDecoder('utf8');
      let output = '', failed = false, finished = false;
      const stop = () => { failed = true; child.kill(); };
      const timer = setTimeout(stop, extractionTimeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      child.stdout?.on('data', chunk => {
        if (output.length + chunk.length > 64 * 1024 * 1024) { stop(); return; }
        output += decoder.write(chunk);
      });
      const finish = (error, code) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal.removeEventListener('abort', stop);
        operation.child = null;
        if (error || failed || code !== 0) reject(failure('archive')); else resolve(output + decoder.end());
      };
      child.once('error', error => finish(error)); child.once('close', code => finish(null, code));
    });
  }
  async function unpack(executable, archive, destination, signal) {
    phase('extracting', '正在解压语音资源，请保持足够的可用磁盘空间…');
    const listing = await runExtractor(executable, ['l', '-slt', '-sccUTF-8', archive], signal);
    const separator = listing.search(/^----------\r?$/m);
    if (separator < 0) throw failure('archive');
    const records = listing.slice(separator + 10).trim().split(/\r?\n\r?\n/);
    if (!records.length || records.length > 200000) throw failure('archive');
    const paths = new Set(); let uncompressed = 0;
    for (const record of records) {
      const entries = record.split(/\r?\n/).map(line => line.match(/^([^=]+?) = (.*)$/)).filter(Boolean);
      const fields = Object.fromEntries(entries.map(match => [match[1], match[2]]));
      if (!safeEntry(fields.Path) || fields['Symbolic Link'] || fields['Hard Link'] || /^l/.test(fields.Mode || '')
        || /L|(?:^|\s)l[rwx-]{9}/.test(fields.Attributes || '')) throw failure('archive');
      const key = fields.Path.replace(/\\/g, '/').toLowerCase();
      if (paths.has(key)) throw failure('archive');
      paths.add(key);
      const size = Number(fields.Size || 0);
      if (!Number.isSafeInteger(size) || size < 0) throw failure('archive');
      uncompressed += size;
      if (uncompressed > 40 * 1024 ** 3) throw failure('archive');
    }
    await ensureDirectory(destination);
    await runExtractor(executable, ['x', '-y', '-aoa', '-sccUTF-8', `-o${destination}`, archive], signal);
    await rejectLinks(destination, signal);
  }
  async function rejectLinks(directory, signal) {
    aborted(signal);
    if (fs.lstatSync(directory).isSymbolicLink()) throw failure('archive');
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink()) throw failure('archive');
      if (stat.isDirectory()) await rejectLinks(file, signal);
      else if (!stat.isFile()) throw failure('archive');
    }
  }
  async function removeStage(directory) {
    if (!directory || !fs.existsSync(directory)) return;
    const realParent = await fs.promises.realpath(userData), stat = await fs.promises.lstat(directory);
    if (stat.isSymbolicLink()) return;
    const actual = await fs.promises.realpath(directory), relative = path.relative(realParent, actual);
    if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || !/^voice-staging-[0-9a-f-]{36}$/.test(relative)) return;
    await fs.promises.rm(actual, { recursive: true, force: true });
  }
  async function deploy(operation) {
    const signal = operation.controller.signal; let stage, terminal;
    try {
      if (!manifest) throw failure('manifest');
      if (ready()) { terminal = { phase: 'ready', ready: true, progress: 1, message: '本地语音环境已就绪。' }; return; }
      await ensureDirectory(userData);
      if (fs.existsSync(projectRoot)) throw failure('conflict');
      const executable = resourcesPath && path.join(resourcesPath, manifest.extractor.relativePath);
      if (!executable || !ordinaryFile(executable) || (await digest(executable, signal)).toLowerCase() !== manifest.extractor.sha256.toLowerCase()) throw failure('extractor');
      const assets = await verifiedArchive(manifest.assets, '语音模型及配置', signal);
      const runtime = await verifiedArchive(manifest.runtime, '语音运行环境', signal);
      stage = path.join(userData, `voice-staging-${randomUUID()}`);
      await ensureDirectory(stage);
      const project = path.join(stage, 'project'), runtimeExtraction = path.join(stage, 'runtime');
      await ensureDirectory(project);
      await unpack(executable, runtime, runtimeExtraction, signal);
      let runtimeSource = runtimeExtraction;
      if (!ordinaryFile(path.join(runtimeSource, 'runtime', 'python.exe'))) {
        runtimeSource = path.join(runtimeExtraction, RUNTIME_NAME);
        if (!ordinaryFile(path.join(runtimeSource, 'runtime', 'python.exe'))) throw failure('archive');
      }
      const cache = path.join(project, 'models', 'cache'); await ensureDirectory(cache);
      await fs.promises.rename(runtimeSource, path.join(cache, RUNTIME_NAME));
      // The small asset archive also carries pronunciation-data overlays absent
      // from the original upstream runtime. Apply it only after runtime placement.
      await unpack(executable, assets, project, signal);
      if (!REQUIRED.every(relative => ordinaryFile(path.join(project, relative)))) throw failure('archive');
      phase('validating', '正在验证语音环境和模型文件，不会启动声音模型…');
      const program = [
        'import hashlib,json,sys',
        'from pathlib import Path',
        'root=Path(sys.argv[1]); sys.path.insert(0,str(root))',
        'from config.settings import SETTINGS',
        'from voice.managed_gpt_sovits import ManagedGptSovitsRuntime',
        'from voice.profiles import JsonVoiceProfileCatalog',
        'from scripts.gpt_sovits_worker import compute_runtime_manifest_digest',
        'from scripts.gpt_sovits_protocol import MANAGED_RUNTIME_MANIFEST_RELATIVE_FILES',
        'runtime=SETTINGS.model_assets_root / "cache" / "GPT-SoVITS-v2-240821"',
        'compute_runtime_manifest_digest(runtime)',
        'weights=SETTINGS.model_assets_root / "weights" / "gpt-sovits"',
        'catalog=JsonVoiceProfileCatalog.load(SETTINGS.data_layout.settings / "voice-profiles.json",weights,allow_local_evaluation=True)',
        'data=json.loads((SETTINGS.data_layout.settings / "voice-profiles.json").read_text(encoding="utf-8"))',
        'required=[str((runtime / relative).relative_to(root)).replace("\\\\","/") for _,relative in MANAGED_RUNTIME_MANIFEST_RELATIVE_FILES]',
        'for profile in data["profiles"]:',
        ' for ref in profile["references"]: catalog.resolve_selection(profile["profile_id"],ref["emotion"])',
        ' for asset in [profile["gpt_weights"],profile["sovits_weights"],*[ref["audio"] for ref in profile["references"]]]:',
        '  file=weights / asset["path"]; assert file.is_file() and file.stat().st_size==asset["bytes"]',
        '  with file.open("rb") as stream: assert hashlib.file_digest(stream,"sha256").hexdigest()==asset["sha256"]',
        '  required.append(str(file.relative_to(root)).replace("\\\\","/"))',
        'print(json.dumps({"required":required}))',
      ].join('\n');
      const validation = JSON.parse(await runExtractor(path.join(project, 'python', 'python.exe'), ['-I', '-B', '-c', program, project], signal));
      if (!Array.isArray(validation.required) || validation.required.length < 20 || validation.required.length > 150
        || !validation.required.every(relative => typeof relative === 'string' && safeEntry(relative) && ordinaryFile(path.join(project, relative)))) throw failure('archive');
      await fs.promises.writeFile(path.join(project, 'voice-setup-complete.json'), JSON.stringify({ version: 1,
        assets: manifest.assets.sha256, runtime: manifest.runtime.sha256,
        required: [...new Set([...REQUIRED, ...validation.required])] }), { flag: 'wx', mode: 0o600 });
      aborted(signal);
      await fs.promises.rename(project, projectRoot);
      terminal = { phase: 'ready', ready: true, progress: 1, error: null, message: '本地语音环境已就绪，可以朗读聊天回答。' };
    } catch (error) {
      const cancelled = signal.aborted;
      terminal = { phase: cancelled ? 'cancelled' : 'error', ready: false,
        error: cancelled ? null : MESSAGES[error.voiceSetupCode] || MESSAGES.storage,
        message: cancelled ? '已取消语音配置，重试时会复用已校验的下载文件。' : MESSAGES[error.voiceSetupCode] || MESSAGES.storage };
    } finally {
      if (!operation.child) await removeStage(stage).catch(() => {});
      if (active === operation) active = null;
      update({ ...terminal, busy: false, canCancel: false });
    }
  }
  function install() {
    if (disposed) return { ok: false, error: '语音配置服务已关闭。' };
    if (active) return { ok: false, error: '语音配置正在进行。' };
    const operation = { controller: new AbortController(), child: null }; active = operation;
    phase('checking', '正在检查本地语音环境…'); void deploy(operation);
    return { ok: true, state: getState() };
  }
  function cancel() { if (!active) return { ok: false, state: getState() }; active.controller.abort(); return { ok: true, state: getState() }; }
  function dispose() { disposed = true; active?.controller.abort(); }
  return { getState, inspect, install, cancel, dispose, getProjectRoot };
}

module.exports = { createVoiceSetup };

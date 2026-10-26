/** Explicit, cancellable first-run setup for the fixed local Ollama chat model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const SETUP_MODEL = 'tobestyledintro/qwen3.8-9b-distill:latest';
const SETUP_BASE_URL = 'http://localhost:11434';
const MODEL_BYTES = 6698268088;
const INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
const MAX_INSTALLER_BYTES = 8 * 1024 ** 3;
const ERRORS = Object.freeze({
  unsupported: '自动配置目前仅支持 Windows。',
  download_failed: 'Ollama 安装程序下载失败，请检查网络后重试。',
  invalid_download: 'Ollama 下载来源或文件校验未通过，请稍后重试。',
  signature_failed: 'Ollama 安装程序的官方数字签名未通过验证，未执行安装。请检查系统时间和网络后重试。',
  install_failed: 'Ollama 安装未完成，请重试，或手动安装 Ollama 后重新检测。',
  start_failed: 'Ollama 尚未启动，请从开始菜单打开 Ollama 后重试。',
  pull_failed: '模型下载未完成，请检查网络和可用磁盘空间后重试；已下载部分会继续使用。',
  storage_failed: '无法保存 Ollama 安装程序，请检查用户目录权限和可用磁盘空间。',
});
const fail = code => Object.assign(new Error(code), { setupCode: code });
const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const isAborted = signal => { if (signal.aborted) throw abortError(); };

function officialDownload(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (url.hostname === 'ollama.com') return url.pathname === '/download/OllamaSetup.exe';
  if (url.hostname === 'github.com') return /^\/ollama\/ollama\/releases\/(?:latest\/download|download\/v[\w.-]+)\/OllamaSetup\.exe$/.test(url.pathname);
  return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    && /^\/github-production-release-asset(?:-2e65be)?\//.test(url.pathname);
}

/** Create the host-only setup service. Construction and inspect never install or start software. */
function createModelSetup({ userData, onChange = () => {}, fetchImpl = globalThis.fetch, spawnImpl = spawn,
  platform = process.platform, env = process.env, probeTimeoutMs = 3000, startTimeoutMs = 60000,
  pollIntervalMs = 1000, installTimeoutMs = 20 * 60 * 1000, downloadTimeoutMs = 60 * 60 * 1000,
  pullTimeoutMs = 4 * 60 * 60 * 1000 } = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new TypeError('userData must be an absolute directory.');
  let disposed = false, active = null, noticeTime = 0;
  let state = { phase: 'idle', busy: false, canCancel: false, ollamaReady: false, modelReady: false,
    model: SETUP_MODEL, baseUrl: SETUP_BASE_URL, expectedModelBytes: MODEL_BYTES,
    completedBytes: 0, totalBytes: 0, progress: null, error: null, message: '检测本地聊天模型，或下载并自动配置。' };
  const getState = () => structuredClone(state);
  function update(patch, throttle = false) {
    Object.assign(state, patch);
    if (disposed || (throttle && Date.now() - noticeTime < 150)) return;
    noticeTime = Date.now();
    onChange(getState());
  }
  function phase(name, message, canCancel = true) {
    update({ phase: name, message, busy: true, canCancel, error: null, completedBytes: 0, totalBytes: 0, progress: null });
  }
  function localBinary() {
    const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Ollama'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Ollama'), ...(env.PATH || env.Path || '').split(path.delimiter)].filter(Boolean);
    for (const root of roots) {
      for (const name of ['ollama app.exe', 'ollama.exe']) {
        const file = path.resolve(root.replace(/^"|"$/g, ''), name);
        try { if (fs.statSync(file).isFile()) return file; } catch {}
      }
    }
    return null;
  }
  async function tags(signal) {
    const timeout = AbortSignal.timeout(probeTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetchImpl(`${SETUP_BASE_URL}/api/tags`, { signal: combined, redirect: 'error' });
      if (!response.ok) return null;
      const content = await readLimited(response, combined, 1024 * 1024);
      const data = JSON.parse(content);
      return Array.isArray(data.models) ? data.models : null;
    } catch { isAborted(signal); return null; }
  }
  const hasModel = models => models.some(item => item?.name === SETUP_MODEL || item?.model === SETUP_MODEL);
  async function inspect() {
    if (active || disposed) return getState();
    const operation = { controller: new AbortController(), installer: null };
    active = operation;
    phase('checking', '正在检测本地 Ollama 和聊天模型…');
    try {
      const models = await tags(operation.controller.signal);
      isAborted(operation.controller.signal);
      const ready = models !== null, modelReady = ready && hasModel(models);
      update({ ollamaReady: ready, modelReady, busy: false, canCancel: false,
        phase: modelReady ? 'ready' : ready ? 'needs-model' : 'needs-install',
        message: modelReady ? '本地聊天模型已就绪。' : ready ? 'Ollama 已就绪，下载约 6.7 GB 聊天模型后即可使用。'
          : localBinary() ? '已找到 Ollama，点击自动配置以启动服务并准备聊天模型。' : '点击自动配置以安装 Ollama 并下载约 6.7 GB 聊天模型。' });
    } catch { if (!disposed) update({ phase: 'cancelled', busy: false, canCancel: false, message: '已取消检测。' }); }
    finally { if (active === operation) active = null; }
    return getState();
  }
  async function readLimited(response, signal, limit) {
    let length = 0; const chunks = [];
    await consume(response, signal, chunk => {
      length += chunk.length;
      if (length > limit) throw fail('invalid_download');
      chunks.push(Buffer.from(chunk));
    });
    return Buffer.concat(chunks).toString('utf8');
  }
  async function consume(response, signal, accept) {
    if (!response.body) throw fail('download_failed');
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        isAborted(signal);
        const { done, value } = await reader.read();
        isAborted(signal);
        if (done) break;
        await accept(value);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function downloadInstaller(signal, destination) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(downloadTimeoutMs)]);
    let url = new URL(INSTALLER_URL), response;
    for (let redirects = 0; redirects <= 8; redirects++) {
      if (!officialDownload(url)) throw fail('invalid_download');
      response = await fetchImpl(url.href, { signal: combined, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 8) throw fail('invalid_download');
      url = new URL(location, url);
    }
    if (!response?.ok) throw fail('download_failed');
    const declared = Number(response.headers.get('content-length') || 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_INSTALLER_BYTES) throw fail('invalid_download');
    let handle;
    try { handle = await fs.promises.open(destination, 'wx', 0o600); } catch { throw fail('storage_failed'); }
    let completed = 0;
    try {
      await consume(response, combined, async chunk => {
        completed += chunk.length;
        if (completed > MAX_INSTALLER_BYTES) throw fail('invalid_download');
        try { await handle.writeFile(chunk); } catch { throw fail('storage_failed'); }
        update({ completedBytes: completed, totalBytes: declared, progress: declared ? Math.min(1, completed / declared) : null }, true);
      });
      if (completed < 2 || (declared && completed !== declared)) throw fail('invalid_download');
    } finally { await handle.close(); }
    const header = Buffer.alloc(2), read = await fs.promises.open(destination, 'r');
    try { await read.read(header, 0, 2, 0); } finally { await read.close(); }
    if (header.toString('ascii') !== 'MZ') throw fail('invalid_download');
  }
  function runChild(file, args, signal, options = {}) {
    return new Promise((resolve, reject) => {
      isAborted(signal);
      let child;
      try { child = spawnImpl(file, args, { windowsHide: true, shell: false, stdio: 'ignore', env: options.env || env }); }
      catch { reject(fail(options.code)); return; }
      const operation = active;
      if (options.installer) operation.installer = child;
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => {
        // Inno Setup must finish its file writes. Cancelling downloads is safe;
        // killing an installer could corrupt an otherwise working Ollama install.
        if (!options.installer) child.kill(); else child.unref?.();
        finish(abortError());
      };
      const timer = setTimeout(() => {
        if (!options.installer) child.kill(); else child.unref?.();
        finish(fail(options.code));
      }, options.timeout);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => { if (operation?.installer === child) operation.installer = null; finish(fail(options.code)); });
      child.once('exit', code => { if (operation?.installer === child) operation.installer = null; finish(code === 0 ? null : fail(options.code)); });
    });
  }
  async function verifyInstaller(file, signal) {
    // Fixed PowerShell program; the downloaded path is data in the environment,
    // never shell source. Valid Authenticode must belong to the Ollama publisher.
    const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:ELYSIA_OLLAMA_INSTALLER; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(?:^|, )O=Ollama Inc\\.(?:,|$)') { exit 1 }; exit 0";
    const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await runChild(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], signal,
      { code: 'signature_failed', timeout: 120000, env: { ...env, ELYSIA_OLLAMA_INSTALLER: file } });
  }
  async function waitForServer(signal) {
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const models = await tags(signal);
      if (models !== null) return models;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(abortError()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, pollIntervalMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw fail('start_failed');
  }
  function startServer(binary, signal) {
    isAborted(signal);
    // Ollama is a separately installed user application. Do not kill a shared
    // server when the pet exits or change OLLAMA_MODELS / existing model storage.
    let child;
    try {
      child = spawnImpl(binary, path.basename(binary).toLowerCase() === 'ollama.exe' ? ['serve'] : [],
        { windowsHide: true, shell: false, detached: true, stdio: 'ignore', env });
      child.on('error', () => {}); child.unref?.();
    } catch { throw fail('start_failed'); }
  }
  async function pullModel(signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(pullTimeoutMs)]);
    const response = await fetchImpl(`${SETUP_BASE_URL}/api/pull`, { method: 'POST', redirect: 'error', signal: combined,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: SETUP_MODEL, stream: true }) });
    if (!response.ok) throw fail('pull_failed');
    const decoder = new TextDecoder(), layers = new Map(); let buffer = '', success = false;
    const line = text => {
      if (!text.trim()) return;
      let event;
      try { event = JSON.parse(text); } catch { throw fail('pull_failed'); }
      if (!event || event.error) throw fail('pull_failed');
      if (event.status === 'success') success = true;
      if (typeof event.digest === 'string' && Number.isSafeInteger(event.total) && event.total >= 0) {
        if (layers.size > 200) throw fail('pull_failed');
        layers.set(event.digest, { total: event.total, completed: Number.isSafeInteger(event.completed) ? Math.max(0, Math.min(event.total, event.completed)) : 0 });
        const total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
        const completed = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0);
        update({ completedBytes: completed, totalBytes: total, progress: total ? Math.min(1, completed / total) : null }, true);
      }
      if (/verifying|writing manifest/.test(event.status || '')) update({ message: '模型已下载，正在校验并完成配置…' });
    };
    await consume(response, combined, chunk => {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 1024 * 1024) throw fail('pull_failed');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    buffer += decoder.decode(); line(buffer);
    if (!success) throw fail('pull_failed');
  }
  async function install(operation) {
    const signal = operation.controller.signal; let installer = null, terminal;
    try {
      if (platform !== 'win32') throw fail('unsupported');
      let models = await tags(signal);
      if (models === null) {
        let binary = localBinary();
        if (!binary) {
          phase('downloading-installer', '正在从 Ollama 官方下载 Windows 安装程序…');
          const directory = path.join(userData, 'setup-downloads');
          try { await fs.promises.mkdir(directory, { recursive: true }); } catch { throw fail('storage_failed'); }
          installer = path.join(directory, `OllamaSetup-${randomUUID()}.exe`);
          try { await downloadInstaller(signal, installer); } catch (error) { throw error.setupCode ? error : fail('download_failed'); }
          phase('verifying-installer', '正在验证 Ollama 官方数字签名…');
          await verifyInstaller(installer, signal);
          isAborted(signal);
          phase('installing', '正在为当前用户安装 Ollama，请等待安装完成…', false);
          await runChild(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], signal,
            { code: 'install_failed', timeout: installTimeoutMs, installer: true });
          binary = localBinary();
          if (!binary) throw fail('install_failed');
        }
        phase('starting', '正在启动本地 Ollama…');
        models = await tags(signal);
        if (models === null) { startServer(binary, signal); models = await waitForServer(signal); }
      }
      update({ ollamaReady: true, modelReady: hasModel(models) });
      if (!hasModel(models)) {
        phase('pulling-model', '正在下载约 6.7 GB 聊天模型，取消后可继续下载…');
        try { await pullModel(signal); } catch (error) { throw error.setupCode ? error : fail('pull_failed'); }
        models = await tags(signal);
        if (!models || !hasModel(models)) throw fail('pull_failed');
      }
      isAborted(signal);
      terminal = { phase: 'ready', busy: false, canCancel: false, ollamaReady: true, modelReady: true, progress: 1, error: null, message: '本地聊天模型已就绪，可以开始聊天。' };
    } catch (error) {
      const cancelled = signal.aborted;
      terminal = { phase: cancelled ? 'cancelled' : 'error', busy: false, canCancel: false,
        error: cancelled ? null : ERRORS[error.setupCode] || ERRORS.pull_failed,
        message: cancelled ? '已取消配置，点击重试可继续模型下载。' : ERRORS[error.setupCode] || ERRORS.pull_failed };
    } finally {
      // Only delete this operation's own file; never prune another launch's files.
      if (installer && !operation.installer) await fs.promises.rm(installer, { force: true }).catch(() => {});
      if (active === operation) active = null;
      update(terminal);
    }
  }
  function installChatModel() {
    if (disposed) return { ok: false, error: '配置服务已关闭。' };
    if (active) return { ok: false, error: '配置正在进行，请等待当前操作完成。' };
    const operation = { controller: new AbortController(), installer: null };
    active = operation;
    phase('checking', '正在检测本地 Ollama 和聊天模型…');
    void install(operation);
    return { ok: true, state: getState() };
  }
  function cancel() {
    if (!active || !state.canCancel) return { ok: false, state: getState() };
    active.controller.abort();
    return { ok: true, state: getState() };
  }
  function dispose() { disposed = true; active?.controller.abort(); }
  return { getState, inspect, installChatModel, cancel, dispose };
}

module.exports = { createModelSetup, SETUP_MODEL, SETUP_BASE_URL, MODEL_BYTES };

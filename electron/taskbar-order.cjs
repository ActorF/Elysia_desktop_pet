'use strict';
const path = require('node:path');
const { spawn: nativeSpawn } = require('node:child_process');

// Electron's floating level only handles Shell_TrayWnd. This Windows helper
// keeps visible shell taskbars above our HWND and our HWND above other apps.
// Native repairs preserve taskbar geometry/visibility and never activate a window.
function createTaskbarOrderer(window, options = {}) {
  const spawn = options.spawn ?? nativeSpawn;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const parentProcessId = options.parentProcessId ?? process.pid;
  const retryDelayMs = options.retryDelayMs ?? 3000;
  const maxAttempts = options.maxAttempts ?? 3;
  const startupTimeoutMs = options.startupTimeoutMs ?? 15000;
  const script = options.script ?? path.join(__dirname, 'taskbar-order.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const executable = options.executable ?? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const processes = new Set();
  let current = null, disposed = false, attempts = 0, retryAfter = 0;

  function clearStartup(record) {
    if (record.timer !== null) { cancel(record.timer); record.timer = null; }
  }
  function detach(record) {
    clearStartup(record);
    if (current === record) current = null;
  }
  function report(error) { options.onError?.(error); }
  function kill(record) {
    try { record.child.kill(); } catch (error) { report(error); }
  }
  function fail(record, error) {
    if (current !== record || record.cancelled || record.finished || record.failed) return;
    record.failed = true; retryAfter = now() + retryDelayMs;
    detach(record); report(error); kill(record);
  }
  function finish(record, code, signal) {
    if (record.finished) return;
    record.finished = true;
    const unexpected = !record.cancelled && !record.failed;
    detach(record); processes.delete(record);
    if (unexpected) {
      retryAfter = now() + retryDelayMs;
      report(new Error(`Taskbar ordering helper stopped (${code ?? signal ?? 'unknown'}).${record.stderr ? ' ' + record.stderr.trim() : ''}`));
    }
    // Even an obsolete, killed helper may have completed one last SetWindowPos
    // before exiting. Its owner must reapply the *current* requested mode now.
    options.onStopped?.();
  }
  function start() {
    if (disposed || platform !== 'win32') return false;
    if (window.isDestroyed()) { dispose(); return false; }
    if (current || processes.size || attempts >= maxAttempts || now() < retryAfter) return Boolean(current?.ready);
    attempts++;
    let record;
    try {
      const handle = window.getNativeWindowHandle();
      if (handle.length !== 8 && handle.length !== 4) throw new Error('Invalid native window handle.');
      const hwnd = '0x' + (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16);
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-TargetHwnd', hwnd, '-ParentProcessId', String(parentProcessId)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      record = { child, ready: false, cancelled: false, failed: false, finished: false, pending: '', stderr: '', timer: null };
      current = record; processes.add(record);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (current !== record || record.cancelled || record.finished) return;
        record.pending += chunk;
        const lines = record.pending.split(/\r?\n/);
        record.pending = lines.pop();
        for (const line of lines) {
          if (line.replace(/^\uFEFF/, '') === 'READY') { record.ready = true; clearStartup(record); }
        }
        if (record.pending.length > 2048) record.pending = '';
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        if (current === record) record.stderr = (record.stderr + chunk).slice(-2048);
      });
      child.once('error', error => fail(record, error));
      child.once('exit', (code, signal) => finish(record, code, signal));
      // Failed spawning can emit error/close without exit.
      child.once('close', (code, signal) => finish(record, code, signal));
      record.timer = schedule(() => fail(record, new Error('Taskbar ordering helper startup timed out.')), startupTimeoutMs);
      record.timer?.unref?.();
      return false;
    } catch (error) {
      retryAfter = now() + retryDelayMs;
      if (record) fail(record, error); else report(error);
      return false;
    }
  }
  function stop() {
    const record = current;
    current = null; attempts = 0; retryAfter = 0;
    if (record) { record.cancelled = true; clearStartup(record); kill(record); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stop(); window.removeListener?.('closed', dispose);
  }
  window.once?.('closed', dispose);
  return { start, stop, dispose, get running() { return Boolean(current?.ready); } };
}

module.exports = { createTaskbarOrderer };

'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

function createVoiceEnvironment({ powerMonitor, isSmokeTest = false, onBlocked = () => {},
  spawnImpl = spawn, platform = process.platform, restartDelays = [1000, 2000, 5000, 15000, 30000], clock = () => performance.now() }) {
  let locked = false, suspended = false, helper = null, ready = platform !== 'win32', fullscreen = false;
  let updatedAt = 0, disposed = false, retryTimer = null, retryCount = 0;
  let notifiedUnavailable = false;
  const bindings = [];
  const listen = (name, fn) => { powerMonitor.on(name, fn); bindings.push([name, fn]); };
  listen('lock-screen', () => { locked = true; onBlocked('locked'); });
  listen('unlock-screen', () => { locked = false; });
  listen('suspend', () => { suspended = true; onBlocked('suspended'); });
  listen('resume', () => { suspended = false; });
  function retry() {
    if (disposed || retryTimer) return;
    const wait = restartDelays[Math.min(retryCount++, restartDelays.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; startHelper(); }, wait);
    retryTimer.unref?.();
  }
  function unavailable() {
    ready = false; updatedAt = 0;
    // A synchronous spawn failure can happen while the controller that owns
    // us is still being constructed. Publish only after it has its environment.
    if (!notifiedUnavailable) {
      notifiedUnavailable = true;
      queueMicrotask(() => { if (!disposed && !ready) onBlocked('monitor-unavailable'); });
    }
    if (!helper) retry();
  }
  function retire(owner) {
    if (disposed || helper !== owner || owner.stopping) return;
    owner.stopping = true;
    unavailable();
    // A failed kill is not an exit. Keep this owner and ignore its old output
    // until exit/close confirms that another monitor may be started.
    try { owner.child.kill(); } catch {}
  }
  function startHelper() {
    if (disposed || helper || platform !== 'win32' || isSmokeTest) return;
    const script = path.join(__dirname, 'voice-environment.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentProcessId', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { unavailable(); return; }
    const owner = { child, stopping: false, startedAt: clock() };
    helper = owner;
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (disposed || helper !== owner || owner.stopping) return;
      pending += chunk;
      const rows = pending.split(/\r?\n/); pending = rows.pop().slice(-32);
      for (const row of rows) {
        if (row !== 'BLOCKED' && row !== 'CLEAR') continue;
        const next = row === 'BLOCKED';
        const wasBlocked = fullscreen;
        ready = true; updatedAt = clock(); retryCount = 0; fullscreen = next; notifiedUnavailable = false;
        if (next && !wasBlocked) onBlocked('fullscreen');
      }
    });
    child.stderr.on('data', () => {});
    const failed = () => {
      if (disposed || helper !== owner) return;
      helper = null; unavailable();
    };
    child.on('error', () => { if (child.pid) retire(owner); else failed(); });
    child.on('exit', failed);
    child.on('close', failed);
  }
  startHelper();
  function sample() {
    if (!disposed && helper && !helper.stopping
      && clock() - (ready ? updatedAt : helper.startedAt) >= (ready ? 5000 : 15000)) retire(helper);
    let idleSeconds = Infinity, systemLocked = locked;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); systemLocked ||= powerMonitor.getSystemIdleState(60) === 'locked'; } catch {}
    const monitorReady = isSmokeTest || (ready && (platform !== 'win32' || clock() - updatedAt < 5000));
    return { now: Date.now(), idleSeconds, locked: systemLocked, suspended,
      fullscreen: fullscreen || !monitorReady, monitorReady };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const [name, fn] of bindings) powerMonitor.removeListener(name, fn);
    clearTimeout(retryTimer); retryTimer = null;
    const owner = helper; helper = null; ready = false;
    try { owner?.child.kill(); } catch {}
  }
  return { sample, dispose };
}
module.exports = { createVoiceEnvironment };

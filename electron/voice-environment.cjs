'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

function createVoiceEnvironment({ powerMonitor, isSmokeTest = false, onBlocked = () => {} }) {
  let locked = false, suspended = false, helper = null, ready = process.platform !== 'win32', fullscreen = false;
  let updatedAt = 0, pending = '', disposed = false;
  const bindings = [];
  const listen = (name, fn) => { powerMonitor.on(name, fn); bindings.push([name, fn]); };
  listen('lock-screen', () => { locked = true; onBlocked('locked'); });
  listen('unlock-screen', () => { locked = false; });
  listen('suspend', () => { suspended = true; onBlocked('suspended'); });
  listen('resume', () => { suspended = false; });
  if (process.platform === 'win32' && !isSmokeTest) {
    const script = path.join(__dirname, 'voice-environment.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentProcessId', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', chunk => {
      pending += chunk;
      const rows = pending.split(/\r?\n/); pending = rows.pop().slice(-32);
      for (const row of rows) {
        if (row !== 'BLOCKED' && row !== 'CLEAR') continue;
        const next = row === 'BLOCKED';
        ready = true; updatedAt = Date.now();
        if (next && !fullscreen) onBlocked('fullscreen');
        fullscreen = next;
      }
    });
    helper.stderr.on('data', () => {});
    helper.on('error', () => { ready = false; });
    helper.on('exit', () => { ready = false; helper = null; });
  }
  function sample() {
    let idleSeconds = Infinity, systemLocked = locked;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); systemLocked ||= powerMonitor.getSystemIdleState(60) === 'locked'; } catch {}
    const monitorReady = isSmokeTest || (ready && (process.platform !== 'win32' || Date.now() - updatedAt < 5000));
    return { now: Date.now(), idleSeconds, locked: systemLocked, suspended,
      fullscreen: fullscreen || !monitorReady, monitorReady };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const [name, fn] of bindings) powerMonitor.removeListener(name, fn);
    helper?.kill(); helper = null;
  }
  return { sample, dispose };
}
module.exports = { createVoiceEnvironment };

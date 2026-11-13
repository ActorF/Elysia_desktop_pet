'use strict';
const { actionForKey } = require('./host-policy.cjs');

/** Own one Space-chord helper until its exit is confirmed, including failed kills. */
function createLegacyHotkeyListener({ spawn, platform = process.platform, script, parentProcessId = process.pid, onAction, onStatus }) {
  let child = null, stopping = null, wanted = false;
  const status = (active, error = null) => onStatus({ active, error });
  const waiting = () => status(false, '旧快捷键监听尚未退出，正在等待结束；不会重复启动。');
  function stop() {
    wanted = false;
    const previous = child || stopping; child = null;
    if (previous) {
      stopping = previous;
      try { previous.kill(); } catch { /* Keep ownership until exit/close. */ }
    }
    if (stopping) waiting(); else status(false);
  }
  function start(enabled = true) {
    stop(); wanted = enabled === true;
    if (!wanted) return;
    if (stopping) { waiting(); return; }
    launch();
  }
  function launch() {
    if (!wanted || child || stopping) return;
    if (platform !== 'win32') { status(false, '原版 Space 组合键仅支持 Windows；可启用备用快捷键。'); return; }
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentProcessId', String(parentProcessId)], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { status(false, '无法启动原版快捷键监听；可启用备用快捷键。'); return; }
    const current = child;
    let pending = '', failure = '';
    current.stdout.setEncoding('utf8'); current.stderr.setEncoding('utf8');
    current.stdout.on('data', text => {
      if (child !== current) return;
      pending += text;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) {
        if (child !== current) break;
        if (line.trim() === 'READY') { status(true); continue; }
        const mapped = actionForKey(line.trim()); if (mapped) onAction(mapped);
      }
      if (pending.length > 1024) pending = '';
    });
    current.stderr.on('data', text => { if (child === current) failure = (failure + text).slice(-2000); });
    current.on('error', () => {
      if (child !== current) return;
      if (current.pid) stop(); else { child = null; wanted = false; }
      status(false, '无法启动原版快捷键监听；可启用备用快捷键。');
    });
    const exited = code => {
      if (stopping === current) {
        stopping = null;
        if (wanted) launch(); else status(false);
        return;
      }
      if (child !== current) return;
      child = null; wanted = false;
      status(false, `原版快捷键监听已停止（${code ?? 'unknown'}）${failure ? '，请启用备用快捷键。' : '。'}`);
    };
    current.on('exit', exited); current.on('close', exited);
  }
  return { start, stop };
}

module.exports = { createLegacyHotkeyListener };

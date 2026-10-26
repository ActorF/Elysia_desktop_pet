'use strict';

// The native helper sends numeric code points, never a growing text buffer.
function characterFromLine(line) {
  const match = /^KEY:(\d{2,3})$/.exec(line);
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : null;
}

function createTypedKeyListener({ spawn, platform = process.platform, script, macExecutable, parentProcessId = process.pid, onCharacter, onStatus }) {
  let child = null;
  const status = (active, error = null, permissionRequired = false) => onStatus({ active, error, permissionRequired });
  function stop() {
    const previous = child;
    child = null;
    if (previous) previous.kill();
    status(false);
  }
  function start(enabled = true) {
    stop();
    if (!enabled) return;
    if (!['win32','darwin'].includes(platform)) { status(false, '全局按键显示仅支持 Windows 和 macOS。'); return; }
    if(platform==='darwin'&&!macExecutable){status(false,'Mac 按键助手未构建，请通过 npm start 启动。');return;}
    try {
      const executable=platform==='darwin'?macExecutable:'powershell.exe';
      const args=platform==='darwin'?['--parent-pid',String(parentProcessId)]
        :['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentProcessId', String(parentProcessId)];
      child = spawn(executable, args, {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { status(false, '无法启动按键显示监听。'); return; }
    const current = child;
    let pending = '', terminalError = null;
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', chunk => {
      if (child !== current) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      let latest = null;
      for (const line of lines) {
        if (line === 'READY') status(true);
        else if(line==='ERROR:PERMISSION'){terminalError='需要在 macOS 系统设置中允许输入监控，然后点击授权／重试。';status(false,terminalError,true);}
        else if(line==='ERROR:UNAVAILABLE'){terminalError='无法创建 Mac 按键监听，请检查输入监控权限后重试。';status(false,terminalError,true);}
        else {
          const character = characterFromLine(line);
          if (character !== null) latest = character;
        }
      }
      if (latest !== null) onCharacter(latest);
      if (pending.length > 1024) pending = '';
    });
    current.on('error', () => {
      if (child !== current) return;
      child = null; status(false, platform==='darwin'?'无法启动 Mac 按键助手，请通过 npm start 构建后重试。':'无法启动按键显示监听。');
    });
    current.on('exit', () => {
      if (child !== current) return;
      child = null; if(!terminalError)status(false, '按键显示监听已停止，可在设置中关闭后重新打开。');
    });
  }
  return { start, stop };
}

module.exports = { characterFromLine, createTypedKeyListener };

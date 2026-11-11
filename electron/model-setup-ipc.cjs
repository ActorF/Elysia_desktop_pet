'use strict';
const { isSettingsSender } = require('./settings-policy.cjs');
const { createSetupDiagnostic, DEFINITIONS } = require('./setup-diagnostics.cjs');

function registerModelSetupIpc({ ipcMain, settingsWindow, setup, voiceSetup, clipboard, getAppInfo = () => ({ version: 'unknown', mode: 'unknown' }) }) {
  const trusted = event => isSettingsSender(event, settingsWindow.getWindow(), settingsWindow.url);
  const latest = { chat: null, voice: null };
  for (const [channel, action] of [
    ['settings:model-setup-get', () => setup.getState()],
    ['settings:model-setup-inspect', () => setup.inspect()],
    ['settings:model-setup-install', () => setup.installChatModel()],
    ['settings:model-setup-cancel', () => setup.cancel()],
    ['settings:voice-setup-get', () => voiceSetup.getState()],
    ['settings:voice-setup-inspect', () => voiceSetup.inspect()],
    ['settings:voice-setup-install', () => voiceSetup.install()],
    ['settings:voice-setup-repair', () => voiceSetup.repair()],
    ['settings:voice-setup-cancel', () => voiceSetup.cancel()],
  ]) ipcMain.handle(channel, event => {
    if (!trusted(event)) return null;
    const scope = channel.startsWith('settings:voice-') ? 'voice' : 'chat';
    const remember = result => {
      latest[scope] = result?.ok === false && result.diagnostic ? { diagnostic: result.diagnostic,
        state: JSON.stringify(result.state ?? (scope === 'voice' ? voiceSetup : setup).getState()) } : null;
      return result;
    };
    const result = action();
    return result && typeof result.then === 'function' ? result.then(remember) : remember(result);
  });
  ipcMain.handle('settings:setup-diagnostic-copy', (event, scope) => {
    if (!trusted(event) || !['chat', 'voice'].includes(scope)) return null;
    const state = (scope === 'voice' ? voiceSetup : setup).getState();
    if (latest[scope] && latest[scope].state !== JSON.stringify(state)) latest[scope] = null;
    const current = latest[scope]?.diagnostic ?? state.diagnostic;
    const kind = Object.keys(DEFINITIONS).find(key => DEFINITIONS[key][0] === current?.code);
    if (!kind) return { ok: false, error: '当前没有可复制的配置错误，请重新检测后再试。' };
    const info = getAppInfo();
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
      appVersion: typeof info.version === 'string' && /^[0-9a-z.+_-]{1,64}$/i.test(info.version) ? info.version : 'unknown',
      mode: ['release', 'local-preview', 'development'].includes(info.mode) ? info.mode : 'unknown',
      component: scope, phase: typeof state.phase === 'string' && /^[a-z-]{1,32}$/.test(state.phase) ? state.phase : 'unknown',
      diagnostic: createSetupDiagnostic(scope, kind, { ...current.details, stage: current.stage }) };
    try { clipboard.writeText(JSON.stringify(report, null, 2)); return { ok: true }; }
    catch { return { ok: false, error: '暂时无法复制错误信息，请重试。' }; }
  });
}
module.exports = { registerModelSetupIpc };

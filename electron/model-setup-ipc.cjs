'use strict';
const { isSettingsSender } = require('./settings-policy.cjs');

function registerModelSetupIpc({ ipcMain, settingsWindow, setup, voiceSetup }) {
  const trusted = event => isSettingsSender(event, settingsWindow.getWindow(), settingsWindow.url);
  for (const [channel, action] of [
    ['settings:model-setup-get', () => setup.getState()],
    ['settings:model-setup-inspect', () => setup.inspect()],
    ['settings:model-setup-install', () => setup.installChatModel()],
    ['settings:model-setup-cancel', () => setup.cancel()],
    ['settings:voice-setup-get', () => voiceSetup.getState()],
    ['settings:voice-setup-inspect', () => voiceSetup.inspect()],
    ['settings:voice-setup-install', () => voiceSetup.install()],
    ['settings:voice-setup-cancel', () => voiceSetup.cancel()],
  ]) ipcMain.handle(channel, event => trusted(event) ? action() : null);
}
module.exports = { registerModelSetupIpc };

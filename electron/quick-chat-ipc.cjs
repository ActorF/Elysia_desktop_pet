'use strict';
const { isSettingsSender } = require('./settings-policy.cjs');
function registerQuickChatIpc({ ipcMain, controller, window, settingsWindow, shortcut, speech, isSpeechTarget = () => true }) {
  const quick = event => isSettingsSender(event, window.getWindow(), window.url);
  const settings = event => isSettingsSender(event, settingsWindow.getWindow(), settingsWindow.url);
  const handle = (channel, trusted, action) => ipcMain.handle(channel, (event, value) => trusted(event) ? action(value) : null);
  handle('quick-chat:get-state', quick, () => controller.getState());
  handle('quick-chat:send', quick, text => controller.send(text));
  handle('quick-chat:cancel', quick, () => controller.cancel());
  handle('quick-chat:hide', quick, () => { window.hide(); return true; });
  ipcMain.on('quick-chat:speech-report', (event, packet) => { if (quick(event) && isSpeechTarget()) speech.report(packet); });
  handle('settings:quick-chat-get', settings, () => shortcut.getState());
  handle('settings:quick-chat-set', settings, patch => shortcut.setSettings(patch));
  handle('settings:quick-chat-open', settings, async () => Boolean(await window.open()));
  let captureWindow = null;
  function releaseCapture() {
    if (captureWindow) {
      captureWindow.removeListener('blur', releaseCapture);
      captureWindow.removeListener('closed', releaseCapture);
      captureWindow.webContents.removeListener('render-process-gone', releaseCapture);
      captureWindow = null;
    }
    return shortcut.setCapturing(false);
  }
  handle('settings:quick-chat-capture', settings, active => {
    if (typeof active !== 'boolean') return false;
    releaseCapture();
    if (active) {
      captureWindow = settingsWindow.getWindow();
      captureWindow.on('blur', releaseCapture);
      captureWindow.on('closed', releaseCapture);
      captureWindow.webContents.on('render-process-gone', releaseCapture);
    }
    return shortcut.setCapturing(active);
  });
  return { dispose: releaseCapture };
}
module.exports = { registerQuickChatIpc };

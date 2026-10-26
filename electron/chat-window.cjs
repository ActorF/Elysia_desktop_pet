/** Independent, sandboxed chat composer; its lifetime never owns the pet or model request. */
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { settingsWindowBounds } = require('./settings-policy.cjs');

function createChatWindow({ BrowserWindow, screen, root, icon, isSmokeTest = false, isPackaged = false, getState, onClosed = () => {} }) {
  const url = pathToFileURL(path.join(root, 'renderer', 'chat.html')).href;
  let current = null, lastBounds = null, disposed = false;
  const getWindow = () => current && !current.window.isDestroyed() ? current.window : null;
  const getWindowState = () => ({ maximized: getWindow()?.isMaximized() === true });
  const publish = snapshot => {
    const window = getWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.send('chat:state', snapshot);
  };
  const publishWindowState = () => {
    const window = getWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.send('chat:window-state', getWindowState());
  };
  async function open() {
    if (disposed) return null;
    if (!getWindow()) {
      const display = lastBounds ? screen.getDisplayMatching(lastBounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const window = new BrowserWindow({
        ...settingsWindowBounds(display.workArea, lastBounds ?? { width: 540, height: 680 }),
        title: '爱莉希雅 · 聊天', icon, show: false, frame: false, roundedCorners: true, thickFrame: true,
        transparent: false, backgroundColor: '#fffafc', resizable: true, movable: true,
        minimizable: true, maximizable: true, fullscreenable: false, skipTaskbar: false,
        alwaysOnTop: false, autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(root, 'electron', 'chat-preload.cjs'), sandbox: true,
          contextIsolation: true, nodeIntegration: false, webSecurity: true,
          webviewTag: false, devTools: !isPackaged,
        },
      });
      window.setMenu(null);
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, value => value.preventDefault());
      for (const event of ['maximize', 'unmaximize', 'restore']) window.on(event, publishWindowState);
      window.on('close', () => { if (!window.isDestroyed()) lastBounds = window.getNormalBounds(); });
      window.on('closed', () => { if (current?.window === window) { current = null; onClosed(); } });
      const entry = { window, ready: null };
      current = entry;
      entry.ready = window.loadURL(url).catch(error => {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      });
    }
    const entry = current;
    await entry.ready;
    if (disposed || entry.window.isDestroyed() || current !== entry) return null;
    publishWindowState(); publish(getState());
    if (!isSmokeTest) {
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show(); entry.window.focus();
    }
    return entry.window;
  }
  function windowControl(action) {
    const window = getWindow();
    if (!window) return false;
    if (action === 'minimize') { window.minimize(); return true; }
    if (action === 'toggle-maximize') {
      if (window.isMaximized()) window.unmaximize(); else window.maximize();
      return true;
    }
    if (action === 'close') { window.close(); return true; }
    return false;
  }
  function dispose() { disposed = true; getWindow()?.destroy(); current = null; }
  return { url, open, getWindow, getWindowState, publish, windowControl, dispose };
}
module.exports = { createChatWindow };

'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { settingsWindowBounds } = require('./settings-policy.cjs');

function createSettingsWindow({ BrowserWindow, screen, root, icon, isSmokeTest = false, isPackaged = false, getState }) {
  const url = pathToFileURL(path.join(root, 'renderer', 'settings.html')).href;
  let current = null, lastBounds = null, disposed = false;
  const getWindow = () => current && !current.window.isDestroyed() ? current.window : null;
  const getWindowState = () => ({ maximized: getWindow()?.isMaximized() === true });
  const publishWindowState = () => {
    const window = getWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.send('settings:window-state', getWindowState());
  };
  const publish = snapshot => {
    const window = getWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.send('settings:state', snapshot);
  };
  async function open() {
    if (disposed) return null;
    if (!getWindow()) {
      const display = lastBounds ? screen.getDisplayMatching(lastBounds)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const window = new BrowserWindow({
        ...settingsWindowBounds(display.workArea, lastBounds),
        title: '设置', icon,
        show: false, frame: false, roundedCorners: true, thickFrame: true, transparent: false, backgroundColor: '#fffafc',
        resizable: true, movable: true, minimizable: true, maximizable: true,
        fullscreenable: false, skipTaskbar: false, alwaysOnTop: false, autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(root, 'electron', 'settings-preload.cjs'),
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          webSecurity: true, webviewTag: false, devTools: !isPackaged,
        },
      });
      window.setMenu(null);
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
        window.webContents.on(event, value => value.preventDefault());
      }
      for (const event of ['maximize', 'unmaximize', 'restore']) window.on(event, publishWindowState);
      window.on('close', () => { if (!window.isDestroyed()) lastBounds = window.getNormalBounds(); });
      window.on('closed', () => { if (current?.window === window) current = null; });
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
    publishWindowState();
    publish(getState());
    if (!isSmokeTest) {
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show();
      entry.window.focus();
    }
    return entry.window;
  }
  function dispose() {
    disposed = true;
    const window = getWindow();
    if (window) window.destroy();
    current = null;
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
  return { url, open, getWindow, getWindowState, publish, windowControl, dispose };
}

module.exports = { createSettingsWindow };

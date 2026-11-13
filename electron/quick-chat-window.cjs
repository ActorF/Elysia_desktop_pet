/** A reusable, sandboxed desktop composer; hiding it preserves its draft. */
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function quickChatBounds(area) {
  const width = Math.min(Math.max(1, Math.floor(area.width) - 32), Math.max(320, Math.round(area.width / 3)));
  const height = Math.min(140, Math.max(1, Math.floor(area.height)));
  return { x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(Math.max(area.y, area.y + area.height - height - 24)), width, height };
}

function createQuickChatWindow({ BrowserWindow, screen, root, icon, isSmokeTest = false, isPackaged = false,
  getState, onHide = () => {} }) {
  const url = pathToFileURL(path.join(root, 'renderer', 'quick-chat.html')).href;
  let current = null, disposed = false, wantedVisible = false, intent = 0;
  const getWindow = () => current && !current.window.isDestroyed() ? current.window : null;
  const bounds = () => quickChatBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
  function publish(snapshot) {
    const window = getWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.send('quick-chat:state', snapshot);
  }
  function hide() {
    const wasOpen = wantedVisible;
    wantedVisible = false; intent++;
    const window = getWindow();
    window?.hide();
    if (wasOpen) onHide();
    return Boolean(window);
  }
  function reposition() {
    const window = getWindow();
    if (!window) return;
    // Display removal and work-area changes are expressed in DIP by Electron.
    // No scaleFactor conversion is needed, including negative monitor origins.
    try { window.setBounds(bounds()); } catch { /* A later open retries after display reconfiguration. */ }
  }
  for (const event of ['display-removed', 'display-metrics-changed']) screen.on(event, reposition);
  async function open() {
    if (disposed) return null;
    wantedVisible = true;
    const request = ++intent;
    if (!getWindow()) {
      const window = new BrowserWindow({
        ...bounds(), title: '爱莉希雅 · 快捷聊天', icon, show: false,
        frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        roundedCorners: true, resizable: false, movable: false, minimizable: false,
        maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
        focusable: true, autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(root, 'electron', 'quick-chat-preload.cjs'), sandbox: true,
          contextIsolation: true, nodeIntegration: false, webSecurity: true,
          webviewTag: false, devTools: !isPackaged,
          autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
        },
      });
      window.setMenu(null);
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, value => value.preventDefault());
      window.on('close', event => { if (!disposed) { event.preventDefault(); hide(); } });
      window.on('closed', () => {
        if (current?.window !== window) return;
        current = null;
        if (wantedVisible) { wantedVisible = false; intent++; onHide(); }
      });
      window.webContents.on('render-process-gone', () => {
        if (current?.window !== window) return;
        // The native window survives a renderer crash, but its document cannot
        // receive input. Discard it so the next explicit open can load again.
        if (!window.isDestroyed()) window.destroy();
      });
      const entry = { window, ready: null };
      current = entry;
      entry.ready = Promise.resolve().then(() => !window.isDestroyed() && !disposed ? window.loadURL(url) : undefined).catch(error => {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      });
    }
    const entry = current;
    await entry.ready;
    if (disposed || !wantedVisible || request !== intent || current !== entry || entry.window.isDestroyed()) return null;
    entry.window.setBounds(bounds());
    publish(getState());
    if (!isSmokeTest) {
      entry.window.show(); entry.window.focus();
      entry.window.webContents.send('quick-chat:focus');
    }
    return entry.window;
  }
  function toggle() {
    if (disposed) return Promise.resolve(null);
    if (wantedVisible) { hide(); return Promise.resolve(null); }
    return open();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; hide();
    for (const event of ['display-removed', 'display-metrics-changed']) screen.removeListener(event, reposition);
    getWindow()?.destroy(); current = null;
  }
  return { url, open, toggle, hide, getWindow, publish, dispose };
}

module.exports = { createQuickChatWindow, quickChatBounds };

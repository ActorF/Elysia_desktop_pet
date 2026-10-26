/** Invisible external-process window used only by taskbar-layer-check.cjs. */
'use strict';
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const profileIndex = process.argv.indexOf('--profile');
const profile = process.argv[profileIndex + 1];
if (profileIndex < 0 || !path.isAbsolute(profile) || typeof process.send !== 'function') {
  throw new Error('This isolated test peer requires its parent IPC channel and temporary profile.');
}
app.setPath('userData', profile);
app.disableHardwareAcceleration();
let window, focusEvents = 0;
app.on('window-all-closed', () => {});
process.on('disconnect', () => app.exit());
app.whenReady().then(() => {
  window = new BrowserWindow({ x: 8, y: 8, width: 32, height: 32,
    show: false, opacity: 0, frame: false, transparent: true, focusable: false, skipTaskbar: true,
    resizable: false, minimizable: false, maximizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.setIgnoreMouseEvents(true);
  window.on('focus', () => { focusEvents++; });
  const handle = window.getNativeWindowHandle();
  const hwnd = '0x' + (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16);
  process.send({ ready: true, hwnd, processId: process.pid });
  process.on('message', message => {
    if (message.action === 'stop') { window.destroy(); app.exit(); return; }
    if (message.action !== 'raise') { process.send({ sequence: message.sequence, error: 'Unknown peer action' }); return; }
    window.setAlwaysOnTop(true, 'screen-saver');
    if (!window.isVisible()) window.showInactive();
    window.moveTop();
    process.send({ sequence: message.sequence, focusEvents });
  });
}).catch(error => { console.error(error); app.exit(1); });

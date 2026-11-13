'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createQuickChatWindow, quickChatBounds } = require('../electron/quick-chat-window.cjs');

function fixture(t, options = {}) {
  const windows = [], screen = new EventEmitter(), snapshot = { busy: false, error: null };
  let hidden = 0;
  const display = { workArea: { x: -1920, y: -200, width: 1920, height: 1040 }, scaleFactor: 1.5 };
  screen.getCursorScreenPoint = () => ({ x: -500, y: 100 });
  screen.getDisplayNearestPoint = point => { assert.deepEqual(point, screen.getCursorScreenPoint()); return display; };
  class Window extends EventEmitter {
    constructor(value) {
      super(); this.options = value; this.visible = false; this.destroyed = false; this.calls = []; this.bounds = value;
      this.webContents = new EventEmitter(); this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.sent = []; this.webContents.send = (...args) => this.webContents.sent.push(args);
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    setMenu(value) { this.menu = value; }
    loadURL(url) { this.url = url; return options.load ? options.load(this) : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    setBounds(value) { this.bounds = value; this.calls.push('bounds'); }
    show() { this.visible = true; this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    hide() { this.visible = false; this.calls.push('hide'); }
    close() { let blocked = false; this.emit('close', { preventDefault() { blocked = true; } }); if (!blocked) this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const controller = createQuickChatWindow({ BrowserWindow: Window, screen, root: path.resolve(__dirname, '..'),
    getState: () => snapshot, onHide: () => { hidden++; }, ...options });
  t.after(() => controller.dispose());
  return { windows, screen, display, controller, snapshot, hidden: () => hidden };
}

test('quick composer is transparent, focused on open, sandboxed and navigation-blocked', async t => {
  const f = fixture(t, { isPackaged: true }), window = await f.controller.open();
  assert.equal(window.options.parent, undefined); assert.equal(window.options.modal, undefined);
  for (const property of ['transparent', 'skipTaskbar', 'alwaysOnTop', 'focusable']) assert.equal(window.options[property], true);
  for (const property of ['frame', 'thickFrame', 'resizable', 'minimizable', 'maximizable', 'fullscreenable']) assert.equal(window.options[property], false);
  assert.equal(window.options.backgroundColor, '#00000000'); assert.equal(window.menu, null);
  assert.deepEqual(window.options.webPreferences, { preload: path.resolve(__dirname, '../electron/quick-chat-preload.cjs'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false,
    autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false });
  assert.deepEqual(window.calls.slice(-2), ['show', 'focus']);
  assert.deepEqual(window.webContents.sent, [['quick-chat:state', f.snapshot], ['quick-chat:focus']]);
  assert.deepEqual(window.openHandler({ url: 'https://external.example' }), { action: 'deny' });
  let prevented = 0;
  for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.emit(event, { preventDefault() { prevented++; } });
  window.emit('page-title-updated', { preventDefault() { prevented++; } });
  assert.equal(prevented, 4);
});

test('bounds use cursor-monitor DIP work area, negative origins and narrow screens', async t => {
  assert.deepEqual(quickChatBounds({ x: -1920, y: -200, width: 1920, height: 1040 }), { x: -1280, y: 676, width: 640, height: 140 });
  assert.deepEqual(quickChatBounds({ x: 0, y: 0, width: 3840, height: 2160 }), { x: 1280, y: 1996, width: 1280, height: 140 });
  assert.deepEqual(quickChatBounds({ x: 100, y: 60, width: 800, height: 600 }), { x: 340, y: 496, width: 320, height: 140 });
  assert.deepEqual(quickChatBounds({ x: -300, y: 0, width: 300, height: 120 }), { x: -284, y: 0, width: 268, height: 120 });
  const f = fixture(t), window = await f.controller.open();
  assert.deepEqual(window.bounds, quickChatBounds(f.display.workArea));
  f.display.scaleFactor = 2; f.display.workArea = { x: 0, y: 0, width: 1536, height: 824 };
  f.screen.emit('display-metrics-changed', {}, f.display, ['scaleFactor', 'workArea']);
  assert.deepEqual(window.bounds, { x: 512, y: 660, width: 512, height: 140 });
  f.display.workArea = { x: 1536, y: -500, width: 1440, height: 860 };
  f.screen.emit('display-removed', {}, { id: 'old-monitor' });
  assert.deepEqual(window.bounds, quickChatBounds(f.display.workArea));
  f.controller.hide();
  f.display.workArea = { x: 0, y: 0, width: 1024, height: 728 };
  await f.controller.open(); assert.deepEqual(window.bounds, quickChatBounds(f.display.workArea));
});

test('toggle and native close hide the same document without losing its draft or service state', async t => {
  const f = fixture(t), window = await f.controller.toggle();
  window.draft = '尚未发送的文字';
  await f.controller.toggle(); assert.equal(window.visible, false); assert.equal(window.destroyed, false);
  assert.equal(await f.controller.toggle(), window); assert.equal(window.draft, '尚未发送的文字');
  window.close(); assert.equal(window.visible, false); assert.equal(f.controller.getWindow(), window);
  f.controller.publish({ busy: true }); assert.deepEqual(window.webContents.sent.at(-1), ['quick-chat:state', { busy: true }]);
  assert.equal(await f.controller.open(), window); assert.equal(f.windows.length, 1);
  assert.deepEqual(f.snapshot, { busy: false, error: null }); assert.equal(f.hidden(), 2);
});

test('rapid toggles while loading honor the latest hide/open intent', async t => {
  let loaded;
  const f = fixture(t, { load: () => new Promise(resolve => { loaded = resolve; }) });
  const first = f.controller.toggle(); await Promise.resolve();
  await f.controller.toggle(); loaded();
  assert.equal(await first, null); assert.equal(f.windows[0].calls.includes('show'), false);
  const opened = await f.controller.open(); assert.equal(opened, f.windows[0]);
  f.controller.hide();
  const [earlier, latest] = await Promise.all([f.controller.open(), f.controller.open()]);
  assert.equal(earlier, null); assert.equal(latest, opened); assert.equal(f.windows.length, 1);
});

test('smoke windows stay hidden, and disposal during loading never reveals or revives them', async t => {
  const f = fixture(t, { isSmokeTest: true }), window = await f.controller.open();
  assert.equal(window.visible, false); assert.equal(window.calls.includes('focus'), false);
  assert.deepEqual(window.webContents.sent, [['quick-chat:state', f.snapshot]]);
  f.controller.dispose();
  assert.equal(f.screen.listenerCount('display-removed'), 0); assert.equal(f.screen.listenerCount('display-metrics-changed'), 0);
  assert.equal(await f.controller.open(), null); assert.equal(await f.controller.toggle(), null);
  const count = window.webContents.sent.length; f.controller.publish({ busy: true }); assert.equal(window.webContents.sent.length, count);
  let loaded;
  const pending = fixture(t, { load: () => new Promise(resolve => { loaded = resolve; }) });
  const opening = pending.controller.open(); await Promise.resolve(); pending.controller.dispose(); loaded();
  assert.equal(await opening, null); assert.equal(pending.windows[0].calls.includes('show'), false);
  const immediate = fixture(t), early = immediate.controller.open(); immediate.controller.dispose();
  assert.equal(await early, null);
});

test('load rejection releases only its own window and permits a clean retry', async t => {
  let attempts = 0;
  const f = fixture(t, { load: () => ++attempts === 1 ? Promise.reject(new Error('fixture-load-failed')) : Promise.resolve() });
  const attemptsTogether = await Promise.allSettled([f.controller.open(), f.controller.open()]);
  assert.ok(attemptsTogether.every(result => result.status === 'rejected'));
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.controller.getWindow(), null);
  assert.equal(await f.controller.toggle(), f.windows[1]);
});

test('a crashed quick renderer is discarded and an explicit reopen creates a working document', async t => {
  const f = fixture(t), crashed = await f.controller.open();
  crashed.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(crashed.destroyed, true, 'A crashed document cannot be shown again');
  assert.equal(f.controller.getWindow(), null);
  const recovered = await f.controller.toggle();
  assert.notEqual(recovered, crashed);
  assert.equal(recovered.visible, true);
  assert.equal(f.windows.length, 2);
  assert.equal(f.hidden(), 1);
  crashed.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.controller.getWindow(), recovered, 'A stale crash cannot destroy the replacement');
});

test('a renderer crash during initial loading cannot revive the old window after a new open', async t => {
  let finishOld;
  const f = fixture(t, { load: () => finishOld ? Promise.resolve() : new Promise(resolve => { finishOld = resolve; }) });
  const opening = f.controller.open(); await Promise.resolve();
  const old = f.windows[0]; old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const replacement = await f.controller.open();
  finishOld();
  assert.equal(await opening, null);
  assert.equal(f.controller.getWindow(), replacement);
  assert.equal(old.calls.includes('show'), false);
  assert.equal(replacement.visible, true);
});

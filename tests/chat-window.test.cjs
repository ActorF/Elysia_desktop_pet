/** Exercise the independent chat window, its isolation and asynchronous reopen lifecycle. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatWindow } = require('../electron/chat-window.cjs');

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.calls = [];
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.webContents = new EventEmitter();
    this.webContents.isDestroyed = () => this.destroyed;
    this.webContents.sent = [];
    this.webContents.send = (...args) => this.webContents.sent.push(args);
    this.webContents.setWindowOpenHandler = fn => { this.windowOpen = fn; };
  }
  setMenu(value) { this.menu = value; }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return !!this.minimized; }
  isMaximized() { return !!this.maximized; }
  minimize() { this.minimized = true; this.calls.push('minimize'); }
  restore() { this.minimized = false; this.calls.push('restore'); this.emit('restore'); }
  maximize() { this.normalBounds = { ...this.bounds }; this.maximized = true; this.emit('maximize'); }
  unmaximize() { this.maximized = false; this.emit('unmaximize'); }
  show() { this.calls.push('show'); }
  focus() { this.calls.push('focus'); }
  getNormalBounds() { return { ...(this.maximized ? this.normalBounds : this.bounds) }; }
  close() { this.emit('close'); this.destroy(); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function fixture(options = {}) {
  const windows = [], snapshot = { settings: { username: '小星' }, conversations: [], pending: null };
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  const screen = { getCursorScreenPoint: () => ({ x: -300, y: 100 }), getDisplayNearestPoint: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) };
  class Window extends FakeWindow {
    constructor(value) { super(value); windows.push(this); }
    loadURL(url) { this.url = url; return options.load ? options.load(this) : Promise.resolve(); }
  }
  const controller = createChatWindow({ BrowserWindow: Window, screen, root: path.resolve(__dirname, '..'), getState: () => snapshot, ...options });
  return { windows, snapshot, controller, area };
}

test('chat is one independent sandboxed window, blocks navigation and restores itself when reopened', async () => {
  const f = fixture({ isPackaged: true });
  const [window, again] = await Promise.all([f.controller.open(), f.controller.open()]);
  assert.equal(window, again);
  assert.equal(f.windows.length, 1);
  assert.equal(window.options.parent, undefined);
  assert.equal(window.options.modal, undefined);
  assert.equal(window.options.frame, false);
  assert.equal(window.options.skipTaskbar, false);
  assert.equal(window.options.alwaysOnTop, false);
  assert.equal(window.options.resizable, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.webSecurity, true);
  assert.equal(window.options.webPreferences.webviewTag, false);
  assert.equal(window.options.webPreferences.devTools, false);
  assert.equal(path.basename(window.options.webPreferences.preload), 'chat-preload.cjs');
  assert.equal(window.menu, null);
  assert.deepEqual(window.windowOpen({ url: 'https://example.com' }), { action: 'deny' });
  let blocked = 0;
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.emit(name, { preventDefault() { blocked++; } });
  window.emit('page-title-updated', { preventDefault() { blocked++; } });
  assert.equal(blocked, 4);
  window.minimized = true;
  await f.controller.open();
  assert.deepEqual(window.calls.slice(-3), ['restore', 'show', 'focus']);
  assert.deepEqual(window.webContents.sent.findLast(([channel]) => channel === 'chat:state'), ['chat:state', f.snapshot]);
  window.bounds = { x: -900, y: 30, width: 600, height: 720 };
  window.maximize();
  window.close();
  assert.equal(f.controller.getWindow(), null);
  const reopened = await f.controller.open();
  assert.notEqual(reopened, window);
  assert.deepEqual(reopened.getNormalBounds(), { x: -900, y: 30, width: 600, height: 720 });
  assert.deepEqual(reopened.webContents.sent.at(-1), ['chat:state', f.snapshot]);
  f.controller.dispose();
  assert.equal(reopened.isDestroyed(), true);
  assert.equal(await f.controller.open(), null);
});

test('window controls affect only chat, reject unrelated commands and publish real maximize state', async () => {
  const f = fixture();
  assert.equal(f.controller.windowControl('close'), false);
  const window = await f.controller.open();
  const initialCalls = [...window.calls];
  for (const invalid of ['quit', 'destroy', 'maximize', 'restore', null, {}, ['close']]) assert.equal(f.controller.windowControl(invalid), false);
  assert.deepEqual(window.calls, initialCalls);
  assert.equal(f.controller.windowControl('minimize'), true);
  assert.equal(window.isMinimized(), true);
  assert.equal(f.controller.windowControl('toggle-maximize'), true);
  assert.deepEqual(f.controller.getWindowState(), { maximized: true });
  assert.deepEqual(window.webContents.sent.at(-1), ['chat:window-state', { maximized: true }]);
  assert.equal(f.controller.windowControl('toggle-maximize'), true);
  assert.deepEqual(f.controller.getWindowState(), { maximized: false });
  assert.equal(f.controller.windowControl('close'), true);
  assert.equal(f.controller.getWindow(), null);
  assert.deepEqual(f.snapshot, { settings: { username: '小星' }, conversations: [], pending: null }, 'Closing chat does not clear its service state');
  assert.ok(await f.controller.open(), 'Closing the composer leaves its controller available');
  f.controller.dispose();
});

test('hidden smoke windows receive updates without stealing focus and ignore broadcasts after close', async () => {
  const f = fixture({ isSmokeTest: true });
  const window = await f.controller.open();
  window.minimized = true;
  await f.controller.open();
  assert.deepEqual(window.calls, []);
  const update = { ...f.snapshot, pending: { conversationId: '1' } };
  f.controller.publish(update);
  assert.deepEqual(window.webContents.sent.at(-1), ['chat:state', update]);
  window.close();
  const count = window.webContents.sent.length;
  f.controller.publish(update);
  assert.equal(window.webContents.sent.length, count);
  f.controller.dispose();
});

test('failed loading releases the window and concurrent opens can retry safely', async () => {
  let attempts = 0;
  const f = fixture({ load: () => ++attempts === 1 ? Promise.reject(new Error('load failed')) : Promise.resolve() });
  const failures = await Promise.allSettled([f.controller.open(), f.controller.open()]);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.message === 'load failed'));
  assert.equal(f.windows[0].isDestroyed(), true);
  assert.equal(f.controller.getWindow(), null);
  const reopened = await f.controller.open();
  assert.equal(reopened, f.windows[1]);
  f.controller.dispose();
});

test('disposing while a document loads never reveals or revives the closed window', async () => {
  let loaded;
  const f = fixture({ load: () => new Promise(resolve => { loaded = resolve; }) });
  const opening = f.controller.open();
  f.controller.dispose();
  loaded();
  assert.equal(await opening, null);
  assert.deepEqual(f.windows[0].calls, []);
  assert.equal(await f.controller.open(), null);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerQuickChatIpc } = require('../electron/quick-chat-ipc.cjs');
const { createQuickChatShortcut } = require('../electron/quick-chat-shortcut.cjs');

function fixture(t, { realShortcut = false } = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [], bindings = new Map();
  function windowController(name) {
    const window = new EventEmitter(), webContents = new EventEmitter(), frame = { url: `file:///${name}.html` };
    webContents.mainFrame = frame; webContents.isDestroyed = () => false;
    window.webContents = webContents; window.isDestroyed = () => false;
    return { window, url: frame.url, event: { sender: webContents, senderFrame: frame }, getWindow: () => window,
      open: async () => { calls.push([`${name}:open`]); return window; }, hide: () => calls.push([`${name}:hide`]) };
  }
  const window = windowController('quick'), settingsWindow = windowController('settings');
  const controller = Object.fromEntries(['getState', 'send', 'cancel'].map(method => [method, (...args) => {
    calls.push([method, ...args]); return { method, accepted: method === 'send' };
  }]));
  let speechTarget = true, shortcut;
  if (realShortcut) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-quick-ipc-'));
    const globalShortcut = { register(key, callback) { if (bindings.has(key)) return false; bindings.set(key, callback); return true; },
      unregister(key) { bindings.delete(key); } };
    shortcut = createQuickChatShortcut({ globalShortcut, directory, onActivate: () => calls.push(['activate']) });
    t.after(() => { shortcut.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  } else shortcut = Object.fromEntries(['getState', 'setSettings', 'setCapturing'].map(method => [method, (...args) => {
    calls.push([method, ...args]); return { method };
  }]));
  const ipc = registerQuickChatIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => listeners.set(name, callback) },
    controller, window, settingsWindow, shortcut, isSpeechTarget: () => speechTarget,
    speech: { report: packet => calls.push(['speech:report', packet]) } });
  t.after(() => ipc.dispose());
  return { handlers, listeners, calls, window, settingsWindow, shortcut, bindings, ipc,
    setSpeechTarget: value => { speechTarget = value; } };
}

test('every quick-chat IPC operation authenticates its exact live main-frame document', async t => {
  const f = fixture(t); assert.equal(f.handlers.size, 8);
  for (const [channel, invoke] of f.handlers) {
    const owner = channel.startsWith('settings:') ? f.settingsWindow : f.window;
    const other = owner === f.window ? f.settingsWindow : f.window;
    for (const event of [other.event, { sender: {}, senderFrame: owner.event.senderFrame },
      { sender: owner.event.sender, senderFrame: { url: owner.url } }, { sender: owner.event.sender, senderFrame: null }]) {
      assert.equal(await invoke(event, true), null, `${channel} must reject foreign windows and subframes`);
    }
    const frame = owner.event.senderFrame;
    frame.url = owner.url + '?changed'; assert.equal(await invoke(owner.event, true), null); frame.url = owner.url;
    owner.window.isDestroyed = () => true; assert.equal(await invoke(owner.event, true), null); owner.window.isDestroyed = () => false;
    owner.window.webContents.isDestroyed = () => true; assert.equal(await invoke(owner.event, true), null); owner.window.webContents.isDestroyed = () => false;
    const getWindow = owner.getWindow; owner.getWindow = () => null;
    assert.equal(await invoke(owner.event, true), null); owner.getWindow = getWindow;
  }
  assert.deepEqual(f.calls, [], 'untrusted messages cannot send, cancel, hide or alter global bindings');
});

test('authorized requests forward only documented values and retain the real accepted result', async t => {
  const f = fixture(t);
  const requests = [
    ['quick-chat:get-state', 'ignored', ['getState']],
    ['quick-chat:send', '一条草稿', ['send', '一条草稿']],
    ['quick-chat:cancel', 'ignored', ['cancel']],
    ['quick-chat:hide', 'ignored', ['quick:hide']],
    ['settings:quick-chat-get', 'ignored', ['getState']],
    ['settings:quick-chat-set', { enabled: false }, ['setSettings', { enabled: false }]],
    ['settings:quick-chat-open', 'ignored', ['quick:open']],
  ];
  for (const [channel, argument, expected] of requests) {
    const owner = channel.startsWith('settings:') ? f.settingsWindow : f.window;
    const result = await f.handlers.get(channel)(owner.event, argument, { extra: 'not forwarded' });
    assert.deepEqual(f.calls.at(-1), expected);
    if (channel === 'quick-chat:send') assert.equal(result.accepted, true);
    if (channel.endsWith(':hide') || channel.endsWith('-open')) assert.equal(result, true);
  }
  f.window.open = async () => null;
  assert.equal(await f.handlers.get('settings:quick-chat-open')(f.settingsWindow.event), false);
  const capture = f.handlers.get('settings:quick-chat-capture');
  for (const invalid of [undefined, null, 0, 1, 'true', {}]) assert.equal(capture(f.settingsWindow.event, invalid), false);
  assert.equal(f.calls.some(([method]) => method === 'setCapturing'), false);
  assert.deepEqual(capture(f.settingsWindow.event, true), { method: 'setCapturing' });
  assert.deepEqual(f.calls.slice(-2), [['setCapturing', false], ['setCapturing', true]]);
});

test('speech reports require the quick main frame and current quick speech ownership', t => {
  const f = fixture(t), report = f.listeners.get('quick-chat:speech-report'), packet = { token: 'test-token', type: 'ended' };
  assert.deepEqual([...f.listeners.keys()], ['quick-chat:speech-report']);
  for (const event of [f.settingsWindow.event, { sender: {}, senderFrame: f.window.event.senderFrame },
    { sender: f.window.event.sender, senderFrame: { url: f.window.url } }, { sender: f.window.event.sender, senderFrame: null }]) report(event, packet);
  const frame = f.window.event.senderFrame;
  frame.url = 'https://outside.example/'; report(f.window.event, packet); frame.url = f.window.url;
  f.window.window.isDestroyed = () => true; report(f.window.event, packet); f.window.window.isDestroyed = () => false;
  f.window.window.webContents.isDestroyed = () => true; report(f.window.event, packet); f.window.window.webContents.isDestroyed = () => false;
  f.setSpeechTarget(false); report(f.window.event, packet);
  assert.deepEqual(f.calls, []);
  f.setSpeechTarget(true); report(f.window.event, packet, 'extra'); assert.deepEqual(f.calls, [['speech:report', packet]]);
});

test('capture suspends a real binding and restores it on blur, close or renderer failure without leaked listeners', async t => {
  for (const event of ['blur', 'closed', 'render-process-gone']) await t.test(event, t => {
    const f = fixture(t, { realShortcut: true }), capture = f.handlers.get('settings:quick-chat-capture');
    const window = f.settingsWindow.window, contents = window.webContents;
    assert.equal(f.shortcut.getState().registered, true);
    assert.equal(capture(f.settingsWindow.event, true).registered, false); assert.equal(f.bindings.size, 0);
    capture(f.settingsWindow.event, true);
    assert.equal(window.listenerCount('blur'), 1); assert.equal(window.listenerCount('closed'), 1);
    assert.equal(contents.listenerCount('render-process-gone'), 1);
    assert.equal(capture(f.window.event, false), null); assert.equal(f.bindings.size, 0);
    assert.equal(capture(f.settingsWindow.event, 'false'), false); assert.equal(f.bindings.size, 0);
    (event === 'render-process-gone' ? contents : window).emit(event);
    assert.equal(f.shortcut.getState().registered, true); assert.deepEqual([...f.bindings.keys()], ['Control+Alt+E']);
    assert.equal(window.listenerCount('blur'), 0); assert.equal(window.listenerCount('closed'), 0);
    assert.equal(contents.listenerCount('render-process-gone'), 0);
    f.bindings.get('Control+Alt+E')(); assert.deepEqual(f.calls, [['activate']]);
  });
});

test('saving during capture restores the new key; cancelling or disposing restores the current saved key', t => {
  const f = fixture(t, { realShortcut: true }), capture = f.handlers.get('settings:quick-chat-capture');
  capture(f.settingsWindow.event, true);
  const saved = f.handlers.get('settings:quick-chat-set')(f.settingsWindow.event, { accelerator: 'Ctrl+Shift+Q' });
  assert.equal(saved.accelerator, 'Control+Shift+Q'); assert.equal(saved.registered, false); assert.equal(f.bindings.size, 0);
  capture(f.settingsWindow.event, false);
  assert.deepEqual([...f.bindings.keys()], ['Control+Shift+Q']);
  capture(f.settingsWindow.event, true); f.settingsWindow.window.emit('blur');
  assert.deepEqual([...f.bindings.keys()], ['Control+Shift+Q']);
  capture(f.settingsWindow.event, true); f.ipc.dispose();
  assert.deepEqual([...f.bindings.keys()], ['Control+Shift+Q']);
  assert.equal(f.settingsWindow.window.listenerCount('blur'), 0);
  assert.equal(f.settingsWindow.window.webContents.listenerCount('render-process-gone'), 0);
});

test('capture can repair a collided binding and reports a new collision after focus leaves', t => {
  const f = fixture(t, { realShortcut: true }), capture = f.handlers.get('settings:quick-chat-capture');
  capture(f.settingsWindow.event, true);
  const foreign = () => {};
  f.bindings.set('Control+Alt+E', foreign); f.settingsWindow.window.emit('blur');
  assert.equal(f.shortcut.getState().registered, false); assert.ok(f.shortcut.getState().error);
  const paused = capture(f.settingsWindow.event, true);
  assert.equal(paused.error, null, 'a previous collision must not block recording a replacement');
  f.handlers.get('settings:quick-chat-set')(f.settingsWindow.event, { accelerator: 'Alt+Q' });
  f.settingsWindow.window.emit('blur'); assert.equal(f.shortcut.getState().registered, true);
  assert.equal(f.bindings.get('Control+Alt+E'), foreign, 'capture never unregisters another owner’s shortcut');
  assert.ok(f.bindings.has('Alt+Q'));
});

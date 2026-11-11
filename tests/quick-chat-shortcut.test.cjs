'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQuickChatShortcut, normalizeAccelerator, DEFAULT_QUICK_CHAT_SETTINGS } = require('../electron/quick-chat-shortcut.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-quick-shortcut-'));
  const registered = new Map(), occupied = new Set(), calls = [], callbacks = [], controllers = [];
  const file = path.join(directory, 'quick-chat-settings.json');
  let activated = 0;
  const globalShortcut = {
    register(key, callback) {
      calls.push(['register', key]); callbacks.push({ key, callback });
      if (occupied.has(key) || registered.has(key)) return false;
      registered.set(key, callback); return true;
    },
    unregister(key) { calls.push(['unregister', key]); registered.delete(key); },
    unregisterAll() { assert.fail('must never unregister shortcuts owned by another feature'); },
  };
  const create = () => {
    const service = createQuickChatShortcut({ globalShortcut, directory, onActivate: () => { activated++; } }); controllers.push(service); return service;
  };
  t.after(() => { controllers.forEach(service => service.dispose()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, registered, occupied, calls, callbacks, globalShortcut, create, activated: () => activated };
}

test('normalization accepts single keys and modifier aliases but reserves recovery and interaction bindings', () => {
  for (const [input, expected] of [['Alt+ctrl+e', 'Control+Alt+E'], ['Shift+Command+k', 'Shift+Super+K'],
    ['Meta+ArrowUp', 'Super+Up'], ['CmdOrCtrl+Return', 'Control+Enter'], ['Alt+F24', 'Alt+F24'], ['Control+Alt+Shift+P', 'Control+Alt+Shift+P']]) {
    assert.equal(normalizeAccelerator(input), expected);
  }
  for (const input of ['', 'E', 'Shift+E', 'Control+Control+E', 'Ctrl+E+F', 'Ctrl+', 'Ctrl+Escape', 'Alt+Esc', 'Control+F25', null, {},
    'constructor+A', '__proto__+A', 'Control+constructor', 'Control+__proto__',
    'Control+Alt+P', ...Array.from({ length: 10 }, (_, value) => `Ctrl+Alt+${value}`),
    ...Array.from({ length: 6 }, (_, value) => `Ctrl+Alt+F${value + 1}`), 'Ctrl+Alt+Backspace']) assert.throws(() => normalizeAccelerator(input), String(input));
});

test('default binding is registered without writing settings; enabled state and canonical key survive restart', t => {
  const f = fixture(t), service = f.create();
  assert.deepEqual(service.getState(), { ...DEFAULT_QUICK_CHAT_SETTINGS, registered: true, error: null });
  assert.equal(fs.existsSync(f.file), false); f.registered.get('Control+Alt+E')(); assert.equal(f.activated(), 1);
  assert.equal(service.setSettings({ accelerator: 'Meta+Shift+k' }).accelerator, 'Shift+Super+K');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { enabled: true, accelerator: 'Shift+Super+K' });
  service.dispose();
  const restored = f.create(); assert.equal(restored.getState().registered, true); assert.equal(restored.getState().accelerator, 'Shift+Super+K');
  assert.equal(restored.setSettings({ enabled: false }).registered, false); restored.dispose();
  const disabled = f.create(); assert.equal(disabled.getState().enabled, false); assert.equal(f.registered.size, 0);
});

test('changing keys registers the new binding before releasing the old; stale callbacks remain inert', t => {
  const f = fixture(t), service = f.create(), old = f.registered.get('Control+Alt+E');
  const start = f.calls.length;
  assert.equal(service.setSettings({ accelerator: 'Control+Alt+Q' }).error, null);
  assert.deepEqual(f.calls.slice(start), [['register', 'Control+Alt+Q'], ['unregister', 'Control+Alt+E']]);
  old(); assert.equal(f.activated(), 0); f.registered.get('Control+Alt+Q')(); assert.equal(f.activated(), 1);
  const count = f.calls.length; service.setSettings({ accelerator: 'Alt+Ctrl+q' }); assert.equal(f.calls.length, count);
});

test('collisions and registration exceptions preserve the old binding and saved bytes', t => {
  const f = fixture(t), service = f.create(); service.setSettings({});
  const saved = fs.readFileSync(f.file); f.occupied.add('Control+Alt+Q');
  assert.match(service.setSettings({ accelerator: 'Ctrl+Alt+Q' }).error, /占用/);
  assert.equal(service.getState().accelerator, 'Control+Alt+E'); assert.equal(service.getState().registered, true);
  assert.deepEqual(fs.readFileSync(f.file), saved); assert.ok(f.registered.has('Control+Alt+E'));
  const original = f.globalShortcut.register; f.globalShortcut.register = () => { throw new Error('native registration failure'); };
  assert.match(service.setSettings({ accelerator: 'Ctrl+Alt+R' }).error, /注册/); f.globalShortcut.register = original;
  assert.deepEqual(fs.readFileSync(f.file), saved); assert.equal(service.getState().accelerator, 'Control+Alt+E');
});

test('a failed atomic save rolls back the newly registered key and keeps old settings and disk bytes', t => {
  const f = fixture(t), service = f.create(); service.setSettings({});
  const before = fs.readFileSync(f.file), original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file) throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' });
    return original(source, destination);
  });
  const result = service.setSettings({ accelerator: 'Alt+R' });
  assert.match(result.error, /保存/); assert.equal(result.accelerator, 'Control+Alt+E'); assert.equal(result.registered, true);
  assert.deepEqual([...f.registered.keys()], ['Control+Alt+E']); assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.directory), ['quick-chat-settings.json']);
  assert.match(service.setSettings({ enabled: false }).error, /保存/); assert.equal(service.getState().enabled, true);
});

test('startup collision is nonfatal and capture permits choosing a replacement without activating during capture', t => {
  const f = fixture(t); f.occupied.add('Control+Alt+E'); const service = f.create();
  assert.equal(service.getState().registered, false); assert.match(service.getState().error, /占用/);
  assert.equal(service.setCapturing(true).error, null);
  const changed = service.setSettings({ accelerator: 'Alt+R' });
  assert.equal(changed.error, null); assert.equal(changed.registered, false); assert.equal(f.registered.size, 0);
  f.callbacks.findLast(item => item.key === 'Alt+R').callback(); assert.equal(f.activated(), 0);
  assert.equal(service.setCapturing(false).registered, true);
  f.registered.get('Alt+R')(); assert.equal(f.activated(), 1);
});

test('capture cancellation restores the old binding; save failures stay visible and closing capture restores it', t => {
  const f = fixture(t), service = f.create();
  service.setSettings({}); const previous = fs.readFileSync(f.file), old = f.registered.get('Control+Alt+E');
  assert.equal(service.setCapturing(true).registered, false); old(); assert.equal(f.activated(), 0);
  assert.equal(service.setCapturing(false).registered, true); assert.deepEqual(fs.readFileSync(f.file), previous);
  service.setCapturing(true); f.occupied.add('Alt+R');
  assert.match(service.setSettings({ accelerator: 'Alt+R' }).error, /占用/);
  const restored = service.setCapturing(false); assert.equal(restored.registered, true); assert.match(restored.error, /占用/);
  assert.equal(service.setCapturing(true).error, null, 'A previous failed save must not prevent another recording attempt');
  f.occupied.add('Control+Alt+E'); assert.match(service.setCapturing(false).error, /占用/);
});

test('disabling during capture does not re-register on release and disposal never touches unrelated bindings', t => {
  const f = fixture(t), service = f.create();
  f.registered.set('Control+Alt+P', () => {});
  service.setCapturing(true); service.setSettings({ enabled: false }); service.setCapturing(false);
  assert.deepEqual([...f.registered.keys()], ['Control+Alt+P']);
  service.dispose(); service.dispose();
  assert.deepEqual([...f.registered.keys()], ['Control+Alt+P']); assert.equal(service.getState().registered, false);
  assert.match(service.setSettings({ enabled: true }).error, /已关闭/);
});

test('invalid stored preferences are preserved on startup and an explicit valid save repairs them', t => {
  const f = fixture(t), raw = '{ invalid settings'; fs.writeFileSync(f.file, raw);
  const service = f.create(); assert.match(service.getState().error, /读取失败/); assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
  assert.equal(service.setSettings({ enabled: false }).error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { enabled: false, accelerator: 'Control+Alt+E' });
  for (const patch of [null, [], { enabled: 'true' }, { accelerator: 'Shift+Q' }]) assert.ok(service.setSettings(patch).error);
  assert.equal(service.getState().enabled, false);
});

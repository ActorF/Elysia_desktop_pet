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
  const create = (options = {}) => {
    const service = createQuickChatShortcut({ globalShortcut, directory, onActivate: () => { activated++; }, ...options }); controllers.push(service); return service;
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

test('an old callback stays inert when the same shortcut is registered again after editing', t => {
  const f = fixture(t), service = f.create(), previous = f.registered.get('Control+Alt+E');
  service.setCapturing(true); service.setCapturing(false);
  previous(); assert.equal(f.activated(), 0, 'A queued callback belongs to its original registration');
  f.registered.get('Control+Alt+E')(); assert.equal(f.activated(), 1);
});

test('late activation failure cannot overwrite newer disabled, rebound or editing shortcut state', async t => {
  for (const change of [service => service.setSettings({ enabled: false }), service => service.setSettings({ accelerator: 'Alt+R' }), service => service.setCapturing(true)]) {
    const f = fixture(t); let reject;
    const service = f.create({ onActivate: () => new Promise((_resolve, fail) => { reject = fail; }) });
    f.registered.get('Control+Alt+E')(); change(service);
    reject(new Error('old window failed')); await Promise.resolve(); await Promise.resolve();
    assert.equal(service.getState().error, null);
  }
});

test('a successful activation retry clears only its previous activation error', async t => {
  const f = fixture(t); let fail = true;
  const service = f.create({ onActivate: async () => { if (fail) throw new Error('fixture window error'); } });
  f.registered.get('Control+Alt+E')(); await Promise.resolve(); await Promise.resolve();
  assert.match(service.getState().error, /无法打开/);
  fail = false; f.registered.get('Control+Alt+E')(); await Promise.resolve(); await Promise.resolve();
  assert.equal(service.getState().error, null);
  service.setSettings({ accelerator: 'invalid' });
  const validationError = service.getState().error;
  f.registered.get('Control+Alt+E')(); await Promise.resolve(); await Promise.resolve();
  assert.equal(service.getState().error, validationError, 'Opening successfully does not erase an unsaved settings error');
});

test('shortcut unregister failure cannot abort disposal and its stale callback remains inert', t => {
  const f = fixture(t), service = f.create(), callback = f.registered.get('Control+Alt+E'), original = f.globalShortcut.unregister;
  try {
    f.globalShortcut.unregister = () => { throw new Error('fixture native unregister failed'); };
    assert.doesNotThrow(() => service.dispose()); callback();
    assert.equal(f.activated(), 0); assert.equal(service.getState().registered, false);
  } finally { f.globalShortcut.unregister = original; service.dispose(); }
  assert.equal(f.registered.size, 0, 'A repeated disposal can release a previously failed native binding');
});

test('rebinding preserves ownership and reports an old shortcut that could not be released', t => {
  const f = fixture(t), service = f.create(), old = f.registered.get('Control+Alt+E'), original = f.globalShortcut.unregister;
  try {
    f.globalShortcut.unregister = key => { if (key === 'Control+Alt+E') throw new Error('fixture native unregister failed'); original(key); };
    let result; assert.doesNotThrow(() => { result = service.setSettings({ accelerator: 'Alt+R' }); });
    assert.equal(result.accelerator, 'Alt+R'); assert.equal(result.registered, true); assert.match(result.error, /释放/);
    old(); assert.equal(f.activated(), 0);
    f.registered.get('Alt+R')(); assert.equal(f.activated(), 1);
  } finally { f.globalShortcut.unregister = original; }
  const result = service.setSettings({}); assert.equal(result.error, null);
  assert.deepEqual([...f.registered.keys()], ['Alt+R']);
});

test('reverse audit: a newer activation and disposal each invalidate an older rejection', async t => {
  const f = fixture(t), failures = []; const publications = [];
  const service = f.create({ onActivate: () => new Promise((_resolve, reject) => failures.push(reject)), onChange: value => publications.push(value) });
  const activate = f.registered.get('Control+Alt+E'); activate(); activate();
  failures[0](new Error('old activation')); await Promise.resolve();
  assert.equal(service.getState().error, null);
  service.dispose(); const count = publications.length; failures[1](new Error('closing activation')); await Promise.resolve();
  assert.equal(publications.length, count); assert.equal(service.getState().registered, false);
});

test('reverse audit: failed capture release is visible, suppresses activation and remains recoverable', t => {
  const f = fixture(t), service = f.create(), previous = f.registered.get('Control+Alt+E'), original = f.globalShortcut.unregister;
  try {
    f.globalShortcut.unregister = () => { throw new Error('fixture release denied'); };
    const state = service.setCapturing(true); assert.match(state.error, /释放/); assert.equal(state.registered, false);
    previous(); assert.equal(f.activated(), 0);
  } finally { f.globalShortcut.unregister = original; }
  assert.equal(service.setCapturing(false).registered, true);
  service.setCapturing(true); service.setCapturing(false); previous();
  assert.equal(f.activated(), 0, 'The later successful edit invalidates the old native callback');
  f.registered.get('Control+Alt+E')(); assert.equal(f.activated(), 1);
});

test('reverse audit: failed save and failed rollback keep old bytes and quarantine the temporary binding', t => {
  const f = fixture(t), service = f.create(); service.setSettings({}); const before = fs.readFileSync(f.file);
  const rename = fs.renameSync, unregister = f.globalShortcut.unregister; let denied = true;
  t.mock.method(fs, 'renameSync', (from, to) => { if (denied && to === f.file) throw new Error('fixture disk denied'); return rename(from, to); });
  try {
    f.globalShortcut.unregister = key => { if (key === 'Alt+R') throw new Error('fixture rollback denied'); unregister(key); };
    const state = service.setSettings({ accelerator: 'Alt+R' });
    assert.match(state.error, /新快捷键.*释放/); assert.deepEqual(fs.readFileSync(f.file), before);
    f.registered.get('Alt+R')(); assert.equal(f.activated(), 0);
    f.registered.get('Control+Alt+E')(); assert.equal(f.activated(), 1);
  } finally { denied = false; f.globalShortcut.unregister = unregister; }
  assert.equal(service.setSettings({}).error, null); assert.deepEqual([...f.registered.keys()], ['Control+Alt+E']);
});

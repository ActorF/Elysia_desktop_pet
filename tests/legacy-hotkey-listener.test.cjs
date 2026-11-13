'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { createLegacyHotkeyListener } = require('../electron/legacy-hotkey-listener.cjs');

function fixture(options = {}) {
  const children = [], statuses = [], actions = [], invocations = [];
  const spawn = (...args) => {
    invocations.push(args);
    const child = new EventEmitter(); child.pid = children.length + 42;
    for (const name of ['stdout', 'stderr']) { child[name] = new EventEmitter(); child[name].setEncoding = () => {}; }
    child.kill = () => { child.emit('exit', 0); return true; };
    children.push(child); return child;
  };
  const listener = createLegacyHotkeyListener({ spawn, platform: 'win32', script: 'D:\\fixture-中文\\legacy-hotkeys.ps1', parentProcessId: 7,
    onStatus: value => statuses.push(value), onAction: value => actions.push(value), ...options });
  return { listener, spawn, children, statuses, actions, invocations };
}

test('legacy helper parses split lines and only maps known actions without injecting native keys', () => {
  const f = fixture(); f.listener.start();
  f.children[0].stdout.emit('data', 'REA'); f.children[0].stdout.emit('data', 'DY\r\n1\nF'); f.children[0].stdout.emit('data', '6\nunknown\nBackspace\n');
  assert.deepEqual(f.actions, [{ type: 'expression', id: 'blush' }, { type: 'pose', id: 'tea' }, { type: 'reset' }]);
  assert.equal(f.statuses.at(-1).active, true);
  assert.equal(f.invocations[0][2].windowsHide, true);
  assert.equal(f.invocations[0][1].at(-1), '7');
  f.listener.stop();
});

test('failed legacy kills retain ownership and permit exactly one replacement after exit', () => {
  for (const kind of ['false', 'throw']) {
    const f = fixture(); f.listener.start(); const previous = f.children[0];
    previous.kill = () => { if (kind === 'throw') throw new Error('fixture denial'); return false; };
    assert.doesNotThrow(() => f.listener.start(false)); f.listener.start(); f.listener.start();
    assert.equal(f.children.length, 1); assert.equal(f.statuses.at(-1).active, false);
    previous.stdout.emit('data', 'READY\n1\n'); assert.deepEqual(f.actions, []);
    previous.emit('exit', 0); assert.equal(f.children.length, 2);
    previous.emit('close', 0); previous.emit('error', new Error('late old error')); previous.stdout.emit('data', 'READY\n1\n');
    assert.equal(f.children.length, 2); assert.deepEqual(f.actions, []);
    f.children[1].stdout.emit('data', 'READY\n2\n'); assert.equal(f.statuses.at(-1).active, true);
    assert.deepEqual(f.actions, [{ type: 'expression', id: 'angry' }]); f.listener.stop();
  }
});

test('a disabled or quitting legacy listener never restarts from a delayed close', () => {
  const f = fixture(); f.listener.start(); const previous = f.children[0]; previous.kill = () => false;
  f.listener.start(); f.listener.stop(); previous.emit('close', 0);
  assert.equal(f.children.length, 1); assert.equal(f.statuses.at(-1).active, false);
});

test('legacy synchronous spawn failure and unsupported platforms remain nonfatal', () => {
  for (const options of [{ spawn: () => { throw new Error('fixture spawn failure'); } }, { platform: 'linux', spawn: () => assert.fail('must not spawn') }]) {
    const f = fixture(options); assert.doesNotThrow(() => f.listener.start());
    assert.equal(f.statuses.at(-1).active, false); assert.equal(typeof f.statuses.at(-1).error, 'string');
  }
});

test('legacy process errors retain live owners but a spawn error with no pid can be retried', () => {
  const f = fixture(); f.listener.start(); const previous = f.children[0]; previous.kill = () => false;
  previous.emit('error', new Error('fixture error')); f.listener.start();
  assert.equal(f.children.length, 1); previous.emit('close', 1); assert.equal(f.children.length, 2);
  delete f.children[1].pid; f.children[1].emit('error', new Error('spawn failed')); f.listener.start();
  assert.equal(f.children.length, 3); f.listener.stop();
});

test('stopping from a status callback suppresses the rest of that native output chunk', () => {
  let listener; const actions = [];
  const f = fixture({ onStatus: value => { if (value.active) listener.stop(); }, onAction: value => actions.push(value) });
  listener = f.listener; listener.start(); f.children[0].stdout.emit('data', 'READY\n1\n');
  assert.deepEqual(actions, []);
});

test('actual main legacy adapter and quit retain a failed-kill owner without spawning duplicates', async () => {
  const entry = path.resolve(__dirname, '../electron/main.cjs'), requireLocal = createRequire(entry), app = new EventEmitter(), f = fixture();
  Object.assign(app, { setName() {}, setAppUserModelId() {}, setPath() {}, getPath: () => path.dirname(entry), requestSingleInstanceLock: () => false, quit() {}, commandLine: { appendSwitch() {} } });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nmodule.exports={configure:enabled=>{preferences.legacyHotkeys=enabled;configureLegacyHotkeys();},quit:()=>quitCoordinator.beforeQuit({preventDefault(){}})};', {
    module, exports: module.exports, __dirname: path.dirname(entry), process: { argv: [], env: {}, platform: 'win32', pid: 7 },
    console: { error() {} }, structuredClone, setTimeout, clearTimeout, clearInterval,
    require: name => name === 'electron' ? { app, globalShortcut: { unregisterAll() {} } } : name === 'node:child_process' ? { spawn: f.spawn }
      : name === './legacy-hotkey-listener.cjs' ? { createLegacyHotkeyListener: options => createLegacyHotkeyListener({ ...options, platform: 'win32' }) } : requireLocal(name),
  }, { filename: entry });
  module.exports.configure(true); const previous = f.children[0]; previous.kill = () => { throw new Error('fixture kill denied'); };
  assert.doesNotThrow(() => module.exports.configure(false)); module.exports.configure(true);
  assert.equal(f.children.length, 1); await module.exports.quit(); previous.emit('exit', 0);
  assert.equal(f.children.length, 1, 'Quit clears restart intent even if the old process exits later');
});

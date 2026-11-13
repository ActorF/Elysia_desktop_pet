'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createTaskbarOrderer } = require('../electron/taskbar-order.cjs');

function fixture(options = {}) {
  const window = new EventEmitter();
  window.destroyed = false;
  window.isDestroyed = () => window.destroyed;
  window.getNativeWindowHandle = () => { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(0x12345678n); return handle; };
  const children = [], timers = new Set(), errors = [], stopped = [];
  let clock = 0;
  const orderer = createTaskbarOrderer(window, { platform: 'win32', parentProcessId: 123, now: () => clock,
    onError: error => errors.push(error), onStopped: () => stopped.push(true),
    setTimeout(fn) { const timer = { fn, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    spawn(executable, args, settings) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
      child.kills = 0; child.kill = () => { child.kills++; };
      Object.assign(child, { executable, args, settings }); children.push(child); return child;
    }, ...options });
  return { window, orderer, children, timers, errors, stopped, advance(ms) { clock += ms; } };
}

test('starts one hidden persistent process and becomes running only after READY', () => {
  const f = fixture();
  assert.equal(f.orderer.start(), false); f.orderer.start();
  assert.equal(f.children.length, 1); assert.equal(f.orderer.running, false);
  const child = f.children[0];
  assert.equal(child.settings.windowsHide, true);
  assert.deepEqual(child.settings.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(child.args[child.args.indexOf('-TargetHwnd') + 1], '0x12345678');
  assert.equal(child.args[child.args.indexOf('-ParentProcessId') + 1], '123');
  child.stdout.emit('data', 'REA'); assert.equal(f.orderer.running, false);
  child.stdout.emit('data', 'DY\r\n'); assert.equal(f.orderer.running, true);
  assert.equal(f.timers.size, 0); assert.equal(f.orderer.start(), true); assert.equal(f.children.length, 1);
  f.orderer.dispose();
});

test('stop immediately kills, rejects late callbacks, and notifies only after actual exit', () => {
  const f = fixture(); f.orderer.start(); const old = f.children[0];
  old.stdout.emit('data', 'READY\n'); f.orderer.stop();
  assert.equal(old.kills, 1); assert.equal(f.orderer.running, false); assert.equal(f.stopped.length, 0);
  old.stdout.emit('data', 'READY\n'); old.emit('error', new Error('obsolete error'));
  f.orderer.start(); assert.equal(f.children.length, 1, 'Do not overlap a still-exiting helper');
  assert.equal(f.orderer.running, false); assert.equal(f.errors.length, 0);
  old.emit('exit', 0); old.emit('close', 0); assert.equal(f.stopped.length, 1);
  f.orderer.start(); assert.equal(f.children.length, 2);
  old.stdout.emit('data', 'READY\n'); assert.equal(f.orderer.running, false);
  f.children[1].stdout.emit('data', 'READY\n'); assert.equal(f.orderer.running, true);
  f.orderer.dispose();
});

test('window close disposes once, kills helper, and still reports its late exit', () => {
  const f = fixture(); f.orderer.start(); const child = f.children[0];
  f.window.emit('closed'); f.orderer.dispose(); f.orderer.start();
  assert.equal(child.kills, 1); assert.equal(f.children.length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.window.listenerCount('closed'), 0);
  child.stdout.emit('data', 'READY\n'); assert.equal(f.orderer.running, false);
  child.emit('exit', 0); assert.equal(f.stopped.length, 1); assert.equal(f.errors.length, 0);
});

test('unexpected exits have cooldown and a finite attempt budget until explicit stop', () => {
  const f = fixture({ retryDelayMs: 1000, maxAttempts: 3 });
  for (let attempt = 0; attempt < 3; attempt++) {
    f.orderer.start(); const child = f.children.at(-1);
    child.stdout.emit('data', 'READY\n'); child.emit('exit', 1);
    assert.equal(f.orderer.running, false); f.orderer.start();
    assert.equal(f.children.length, attempt + 1);
    f.advance(1000);
  }
  f.orderer.start(); assert.equal(f.children.length, 3); assert.equal(f.errors.length, 3);
  f.orderer.stop(); f.orderer.start(); assert.equal(f.children.length, 4);
  f.orderer.dispose();
});

test('startup errors, close-without-exit, and timeout cannot leave running state or timers', () => {
  const f = fixture({ retryDelayMs: 100 }); f.orderer.start(); const first = f.children[0];
  first.emit('error', new Error('cannot launch')); first.emit('close', -1);
  assert.equal(first.kills, 1); assert.equal(f.orderer.running, false); assert.equal(f.timers.size, 0);
  assert.equal(f.errors.length, 1); assert.equal(f.stopped.length, 1);
  f.advance(100); f.orderer.start(); const second = f.children[1];
  const timeout = [...f.timers][0].fn; timeout();
  assert.equal(second.kills, 1); assert.equal(f.orderer.running, false); assert.equal(f.errors.length, 2);
  second.stdout.emit('data', 'READY\n'); assert.equal(f.orderer.running, false);
  second.emit('exit', 1); assert.equal(f.stopped.length, 2); f.orderer.dispose();
});

test('synchronous spawning failures are cooled down and unsupported/destroyed windows never spawn', () => {
  let attempts = 0;
  const f = fixture({ spawn() { attempts++; throw new Error('missing executable'); }, retryDelayMs: 100 });
  f.orderer.start(); f.orderer.start(); assert.equal(attempts, 1); assert.equal(f.errors.length, 1);
  f.advance(100); f.orderer.start(); assert.equal(attempts, 2); f.orderer.dispose();
  const linux = fixture({ platform: 'linux' }); linux.orderer.start(); assert.equal(linux.children.length, 0); linux.orderer.dispose();
  const dead = fixture(); dead.window.destroyed = true; dead.orderer.start(); assert.equal(dead.children.length, 0);
});

test('32-bit HWNDs are passed without truncating or changing their numeric representation', () => {
  const f = fixture();
  f.window.getNativeWindowHandle = () => Buffer.from([0xfe, 0xdc, 0xba, 0x98]);
  f.orderer.start(); const args = f.children[0].args;
  assert.equal(args[args.indexOf('-TargetHwnd') + 1], '0x98badcfe'); f.orderer.dispose();
});

test('native helper retry delay is independent of wall-clock corrections', t => {
  let elapsed = 0, wall = 1_800_000_000_000;
  t.mock.method(performance, 'now', () => elapsed); t.mock.method(Date, 'now', () => wall);
  const f = fixture({ now: undefined, retryDelayMs: 1000 });
  f.orderer.start(); f.children[0].emit('exit', 1);
  wall -= 60 * 60 * 1000; elapsed += 1000;
  f.orderer.start(); assert.equal(f.children.length, 2);
  f.orderer.dispose();
});

test('explicit stop retries a previously failed helper kill without releasing its owner early', () => {
  const f = fixture(); f.orderer.start(); const old = f.children[0];
  old.kill = () => { old.kills++; if (old.kills === 1) throw new Error('first kill failed'); };
  old.emit('error', new Error('native helper error'));
  assert.equal(old.kills, 1); assert.equal(f.orderer.running, false);
  f.orderer.stop(); assert.equal(old.kills, 2);
  f.orderer.start(); assert.equal(f.children.length, 1);
  old.emit('exit', 0); f.orderer.start(); assert.equal(f.children.length, 2);
  f.orderer.dispose();
});

test('a refused ordinary stop is retried on the next stop or disposal without releasing the live owner', async t => {
  for (const failure of ['throw', 'false']) for (const nextAction of ['stop', 'dispose']) await t.test(`${failure}: ${nextAction}`, () => {
    const f = fixture(); f.orderer.start(); const child = f.children[0];
    child.stdout.emit('data', 'READY\n');
    child.kill = () => {
      child.kills++;
      if (child.kills === 1) {
        if (failure === 'throw') throw new Error('temporary termination refusal');
        return false;
      }
      return true;
    };
    f.orderer.stop(); assert.equal(child.kills, 1); assert.equal(f.orderer.running, false);
    f.orderer[nextAction](); assert.equal(child.kills, 2);
    f.orderer.stop(); assert.equal(child.kills, 2, 'a successful kill request is not repeated');
    f.orderer.start(); assert.equal(f.children.length, 1, 'confirmation of exit is still required');
    child.emit('exit', 0);
    f.orderer.start(); assert.equal(f.children.length, nextAction === 'dispose' ? 1 : 2);
    f.orderer.dispose();
  });
});

test('repeated late native errors do not become unhandled events or disturb a new helper', () => {
  const f = fixture(); f.orderer.start(); const old = f.children[0];
  old.emit('error', new Error('first failure'));
  assert.doesNotThrow(() => old.emit('error', new Error('kill failure')));
  old.emit('exit', 1); f.advance(3000); f.orderer.start();
  f.children[1].stdout.emit('data', 'READY\n');
  assert.doesNotThrow(() => old.emit('error', new Error('late failure')));
  assert.equal(f.orderer.running, true); f.orderer.dispose();
});

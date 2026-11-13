/** Exercise the actual Windows helper policy without changing desktop focus or settings. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createVoiceEnvironment } = require('../electron/voice-environment.cjs');

function monitorFixture(t, extra = {}) {
  const powerMonitor = new EventEmitter(), children = [], blocked = [];
  powerMonitor.getSystemIdleTime = () => 0;
  powerMonitor.getSystemIdleState = () => 'active';
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.killCount = 0;
    child.pid = 2000 + children.length;
    child.kill = () => { child.killCount++; return true; };
    children.push(child); return child;
  };
  const environment = createVoiceEnvironment({ powerMonitor, platform: 'win32', spawnImpl,
    restartDelays: [5, 10], onBlocked: reason => blocked.push({ reason, state: environment.sample() }), ...extra });
  t.after(() => environment.dispose());
  return { environment, powerMonitor, children, blocked, spawnImpl };
}
async function until(predicate) {
  for (let count = 0; count < 100 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(Boolean(predicate()), true, 'monitor should recover within a bounded interval');
}

test('fullscreen notification observes the new blocked state immediately', t => {
  const f = monitorFixture(t);
  f.children[0].stdout.emit('data', 'CLEAR\n');
  assert.equal(f.environment.sample().fullscreen, false);
  f.children[0].stdout.emit('data', 'BLOCKED\n');
  assert.deepEqual(f.blocked.map(item => [item.reason, item.state.fullscreen, item.state.monitorReady]), [['fullscreen', true, true]]);
});

test('heartbeat expiry follows elapsed time when the system clock moves in either direction', async t => {
  let elapsed = 100, wall = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => wall);
  const f = monitorFixture(t, { clock: () => elapsed });
  f.children[0].stdout.emit('data', 'CLEAR\n');
  wall -= 60 * 60 * 1000; elapsed += 6000;
  assert.equal(f.environment.sample().monitorReady, false, 'A clock rollback cannot keep stale CLEAR trusted');
  f.children[0].emit('exit', 0);
  await until(() => f.children.length === 2);
  f.children[1].stdout.emit('data', 'CLEAR\n');
  wall += 2 * 60 * 60 * 1000; elapsed += 20;
  assert.equal(f.environment.sample().monitorReady, true, 'A clock jump cannot expire a fresh helper update');
  assert.equal(f.environment.sample().now, wall, 'Greeting schedules still receive the local wall clock');
});

test('a failed environment helper blocks speech and restarts without trusting late events', async t => {
  const f = monitorFixture(t), old = f.children[0];
  old.stdout.emit('data', 'CLEAR\n');
  old.emit('error', new Error('helper failed')); old.emit('exit', 1);
  assert.equal(f.environment.sample().monitorReady, false);
  await until(() => f.children.length === 2);
  assert.equal(f.blocked.filter(item => item.reason === 'monitor-unavailable').length, 1);
  old.stdout.emit('data', 'CLEAR\n');
  assert.equal(f.environment.sample().monitorReady, false);
  f.children[1].stdout.emit('data', 'CLEAR\n');
  old.emit('exit', 0);
  assert.equal(f.environment.sample().monitorReady, true);
});

test('dispose cancels helper recovery and ignores remaining output and process events', async t => {
  const f = monitorFixture(t), child = f.children[0];
  f.environment.dispose(); f.environment.dispose();
  child.stdout.emit('data', 'BLOCKED\n'); child.emit('exit', 0);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(child.killCount, 1); assert.equal(f.children.length, 1); assert.deepEqual(f.blocked, []);
  for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) assert.equal(f.powerMonitor.listenerCount(event), 0);
});

test('a live helper error keeps ownership until exit and rejects its later CLEAR messages', async t => {
  const f = monitorFixture(t), child = f.children[0];
  child.stdout.emit('data', 'CLEAR\n');
  child.kill = () => { child.killCount++; return false; };
  child.emit('error', new Error('temporary process error'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(child.killCount, 1);
  assert.equal(f.children.length, 1, 'A failed kill must not spawn a second native monitor');
  child.stdout.emit('data', 'CLEAR\n');
  assert.equal(f.environment.sample().monitorReady, false);
  child.emit('exit', 1);
  await until(() => f.children.length === 2);
  f.children[1].stdout.emit('data', 'CLEAR\n');
  assert.equal(f.environment.sample().monitorReady, true);
});

test('a stalled heartbeat or startup is retired once and recovers only after its process exits', async t => {
  for (const sendsInitialHeartbeat of [false, true]) {
    let elapsed = 100;
    const f = monitorFixture(t, { clock: () => elapsed }), child = f.children[0];
    if (sendsInitialHeartbeat) child.stdout.emit('data', 'CLEAR\n');
    elapsed += sendsInitialHeartbeat ? 6000 : 16000;
    assert.equal(f.environment.sample().monitorReady, false);
    await Promise.resolve();
    assert.equal(child.killCount, 1);
    assert.equal(f.blocked.at(-1).reason, 'monitor-unavailable');
    f.environment.sample();
    assert.equal(child.killCount, 1, 'Polling does not repeatedly terminate the same owner');
    child.stdout.emit('data', 'CLEAR\n');
    assert.equal(f.environment.sample().monitorReady, false);
    child.emit('close', 1);
    await until(() => f.children.length === 2);
    f.children[1].stdout.emit('data', 'CLEAR\n');
    assert.equal(f.environment.sample().monitorReady, true);
    f.environment.dispose();
  }
});

test('monitor disposal contains native termination failures and never restarts afterward', async t => {
  const f = monitorFixture(t), child = f.children[0];
  child.kill = () => { throw new Error('termination unavailable'); };
  assert.doesNotThrow(() => f.environment.dispose());
  child.emit('error', new Error('late error')); child.emit('exit', 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.children.length, 1);
  assert.equal(f.powerMonitor.listenerCount('resume'), 0);
});

test('a synchronous spawn failure does not abort controller construction or report before it returns', async t => {
  const powerMonitor = new EventEmitter(), events = [];
  powerMonitor.getSystemIdleTime = () => 0; powerMonitor.getSystemIdleState = () => 'active';
  const environment = createVoiceEnvironment({ powerMonitor, platform: 'win32', restartDelays: [1000],
    spawnImpl: () => { throw new Error('start unavailable'); },
    onBlocked: reason => events.push([reason, environment.sample().monitorReady]) });
  t.after(() => environment.dispose());
  assert.deepEqual(events, []);
  await Promise.resolve();
  assert.deepEqual(events, [['monitor-unavailable', false]]);
});

test('Windows BUSY does not silence our focused chat, while external fullscreen and explicit interruption states stay blocked', {
  skip: process.platform !== 'win32' ? 'The native helper uses Windows PowerShell and Win32 APIs' : false,
}, () => {
  const helper = fs.readFileSync(path.join(__dirname, '../electron/voice-environment.ps1'), 'utf8');
  const source = helper.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(source, 'Compile the production helper rather than a separate policy copy');
  const checks = [
    // Reproduction: ordinary focused Elysia chat, QUNS_BUSY from Windows.
    { state: 2, own: true, blocked: false },
    // Another application's BUSY/fullscreen must still pause speech.
    { state: 2, own: false, blocked: true },
    // Not present, exclusive Direct3D, presentation, and quiet time still win.
    ...[1, 3, 4, 6].flatMap(state => [true, false].map(own => ({ state, own, blocked: true }))),
    ...[5, 7].flatMap(state => [true, false].map(own => ({ state, own, blocked: false }))),
  ];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'", source[1], "'@",
    ...checks.map(({ state, own, blocked }) =>
      `if ([VoiceEnvironment]::BlocksNotification(${state}, $${own}) -ne $${blocked}) { throw 'Unexpected notification policy: state=${state}, own=${own}' }`),
    "[Console]::WriteLine('notification-policy-ok')",
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /notification-policy-ok/);
});

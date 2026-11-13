'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { characterFromLine, createTypedKeyListener } = require('../electron/typed-key-listener.cjs');

test('typing protocol accepts every printable ASCII character including space, rejects control keys and text buffers', () => {
  for (let code = 0; code < 160; code++) {
    assert.equal(characterFromLine(`KEY:${code}`), code >= 32 && code <= 126 ? String.fromCharCode(code) : null);
  }
  for (const value of ['a', 'Enter', 'Ctrl', 'KEY:AA', 'KEY:65:66', 'KEY:6566', 'KEY:32 ', 'KEY:-1', 'KEY:']) assert.equal(characterFromLine(value), null);
});

function fixture() {
  const children = [], characters = [], statuses = [], invocations = [];
  const listener = createTypedKeyListener({
    platform: 'win32', script: 'D:\\example\\typed-keys.ps1', parentProcessId: 42,
    onCharacter: character => characters.push(character), onStatus: status => statuses.push(status),
    spawn: (...args) => {
      invocations.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.killed = false; child.kill = () => { child.killed = true; child.emit('exit', 1); };
      children.push(child); return child;
    },
  });
  return { listener, children, characters, statuses, invocations };
}

test('listener coalesces rapid characters, preserves space and parses split native chunks', () => {
  const f = fixture(); f.listener.start();
  const child = f.children[0];
  child.stdout.emit('data', 'REA'); child.stdout.emit('data', 'DY\r\nKEY:65\nKEY:');
  assert.equal(f.statuses.at(-1).active, true);
  assert.deepEqual(f.characters, ['A']);
  child.stdout.emit('data', '97\nKEY:63\nKEY:32\n');
  assert.deepEqual(f.characters, ['A', ' '], 'Only the newest character in a chunk crosses IPC');
  child.stdout.emit('data', 'KEY:13\nKEY:127\n');
  assert.deepEqual(f.characters, ['A', ' ']);
  assert.equal(f.invocations[0][2].windowsHide, true);
  assert.deepEqual(f.invocations[0][2].stdio, ['ignore','pipe','ignore']);
});

test('turning typing off stops native collection and ignores late output from old processes', () => {
  const f = fixture(); f.listener.start(); const original = f.children[0];
  original.stdout.emit('data', 'READY\n');
  f.listener.start(false);
  assert.equal(original.killed, true);
  original.stdout.emit('data', 'READY\nKEY:65\n');
  assert.deepEqual(f.characters, []); assert.equal(f.statuses.at(-1).active, false);
  f.listener.start(); const replacement = f.children[1];
  original.emit('error', new Error('old process'));
  replacement.stdout.emit('data', 'READY\nKEY:33\n');
  assert.equal(f.statuses.at(-1).active, true); assert.deepEqual(f.characters, ['!']);
  replacement.emit('exit', 7);
  assert.equal(f.statuses.at(-1).active, false); assert.match(f.statuses.at(-1).error, /停止/);
});

test('unavailable native support stays inactive without claiming global capture works', () => {
  const statuses = [];
  createTypedKeyListener({platform:'linux',onStatus:value=>statuses.push(value),spawn:()=>assert.fail('must not spawn')}).start();
  assert.equal(statuses.at(-1).active, false); assert.match(statuses.at(-1).error, /Windows/);
});

test('failed listener termination never throws or starts overlapping native listeners', () => {
  for (const kind of ['false', 'throw']) {
    const f = fixture(); f.listener.start(); const previous = f.children[0]; previous.pid = 123;
    previous.kill = () => { if (kind === 'throw') throw new Error('fixture kill failure'); return false; };
    assert.doesNotThrow(() => f.listener.start(false));
    previous.stdout.emit('data', 'READY\nKEY:65\n'); assert.deepEqual(f.characters, []);
    f.listener.start(); f.listener.start();
    assert.equal(f.children.length, 1, 'Re-enabling must wait for the old process to exit');
    assert.equal(f.statuses.at(-1).active, false); assert.ok(f.statuses.at(-1).error);
    previous.emit('exit', 0);
    assert.equal(f.children.length, 2, 'A late confirmed exit may start the one requested replacement');
    previous.emit('close', 0); assert.equal(f.children.length, 2);
    f.listener.stop();
  }
});

test('a disabled listener cannot restart after a delayed process exit', () => {
  const f = fixture(); f.listener.start(); const previous = f.children[0];
  previous.kill = () => false;
  f.listener.start(); f.listener.stop(); previous.emit('close', 0);
  assert.equal(f.children.length, 1); assert.equal(f.statuses.at(-1).active, false);
});

test('Windows native translation handles Shift, Caps Lock, punctuation, numpad and ignored controls without injecting keys', { skip: process.platform !== 'win32', timeout: 20000 }, () => {
  const result = spawnSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','electron','typed-keys.ps1'),'-SelfTest'], {windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SELFTEST:OK:174/);
});

test('Windows global listener installs and exits after its owning process disappears', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','electron','typed-keys.ps1'),'-ParentProcessId','2147483647'], {windowsHide:true,stdio:['ignore','pipe','pipe']});
  let ready = false, error = '';
  child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) ready = true; });
  child.stderr.on('data', chunk => { error += chunk.toString(); });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {child.kill();reject(new Error('Native listener did not close after parent exit'));},10000);
    child.on('error', value => {clearTimeout(timeout);reject(value);});
    child.on('exit', code => {clearTimeout(timeout);resolve(code);});
  });
  assert.equal(result, 0, error); assert.equal(ready, true);
});

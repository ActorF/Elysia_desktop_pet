'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Evaluate the real host with no Electron launch or user-profile access.
function fixture({ saved, readError } = {}) {
  const entry = path.resolve(__dirname, '../electron/main.cjs'), requireLocal = createRequire(entry);
  const app = new EventEmitter(), files = new Map(), broadcasts = [], timers = new Map();
  let failure = null, nextTimer = 0, nativeQuitCount = 0;
  if (saved !== undefined) files.set('fixture-settings.json', saved);
  Object.assign(app, { setName() {}, setAppUserModelId() {}, setPath() {}, getPath: () => path.dirname(entry),
    requestSingleInstanceLock: () => false, quit() { nativeQuitCount++; }, commandLine: { appendSwitch() {} } });
  const fakeFs = { mkdirSync() {},
    readFileSync(file, encoding) {
      if (readError) throw Object.assign(new Error('fixture read failure'), { code: readError });
      if (!files.has(file)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      const value = Buffer.from(files.get(file)); return encoding ? value.toString(encoding) : value;
    },
    writeFileSync(file, text) { files.set(file, text); },
    renameSync(from, to) { if (failure) throw Object.assign(new Error('fixture error'), { code: failure }); files.set(to, files.get(from)); files.delete(from); } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8') + `
    settingsFile = 'fixture-settings.json';
    settingsWindow = { publish: snapshot => broadcasts.push(snapshot), dispose() {} };
    module.exports = { saveSettings, loadSettings, state, requestQuit, prepareSessionEnd, change: patch => Object.assign(preferences, patch),
      setQuitServices: services => { chatSpeech = services.speech; voices = services.voices; },
      setSessionServices: services => { quickChat = services.quick; chat = services.chat; chatSpeech = services.speech; voices = services.voices; cursorTrail = services.trail; },
      quit: () => quitCoordinator.beforeQuit({ preventDefault() {} }) };
  `, { module, exports: module.exports, __dirname: path.dirname(entry), broadcasts,
    process: { argv: [], env: {}, platform: process.platform }, console: { error() {} },
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    clearInterval() {},
    structuredClone,
    require: name => name === 'electron' ? { app, globalShortcut: { unregisterAll() {} } } : name === 'node:fs' ? fakeFs : requireLocal(name),
  }, { filename: entry });
  return { ...module.exports, files, broadcasts, fail: code => { failure = code; },
    get nativeQuitCount() { return nativeQuitCount; },
    flush: () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); } };
}

test('pet preference write failure is published without losing live settings or overwriting the saved file', () => {
  const f = fixture(); f.saveSettings(); f.flush();
  const original = f.files.get('fixture-settings.json');
  f.fail('ENOSPC'); f.change({ cursorTrailDuration: 2.7 }); f.saveSettings(); f.flush();
  assert.equal(f.files.get('fixture-settings.json'), original);
  assert.equal(f.state().settings.cursorTrailDuration, 2.7);
  assert.equal(typeof f.state().storageError, 'string');
  assert.equal(f.broadcasts.at(-1).storageError, f.state().storageError);
  f.fail(null); f.saveSettings(); f.flush();
  assert.equal(f.state().storageError, null);
  assert.equal(f.broadcasts.at(-1).storageError, null);
  assert.equal(JSON.parse(f.files.get('fixture-settings.json')).settings.cursorTrailDuration, 2.7);
});

test('damaged or unreadable desktop settings are never overwritten by automatic or quit saves', async () => {
  const invalidUtf8 = Buffer.concat([Buffer.from('{"settings":{"cursorTrailStyle":"'), Buffer.from([0xc0]), Buffer.from('"}}')]);
  for (const saved of ['{"settings":', 'null', '[]', invalidUtf8, '{"settings":null}', '{"settings":[]}', '{"settings":"damaged"}']) {
    const f = fixture({ saved }); f.loadSettings();
    assert.match(f.state().storageError || '', /读取/);
    f.change({ scale: 1.3 }); f.saveSettings(); f.flush(); await f.quit();
    assert.deepEqual(f.files.get('fixture-settings.json'), saved);
  }
  const saved = '{"settings":{"scale":1.5}}', f = fixture({ saved, readError: 'EACCES' });
  f.loadSettings(); f.saveSettings(); f.flush();
  assert.equal(f.files.get('fixture-settings.json'), saved);
});

test('cancelled Windows session shutdown leaves controllers usable and flushes pending preferences', () => {
  const f = fixture(), calls = [];
  const component = method => ({ [method]: () => calls.push(method), dispose: () => calls.push('disposed') });
  f.setSessionServices({ quick: component('interrupt'), chat: component('cancel'), speech: component('release'),
    voices: component('stopVoice'), trail: component('setBlocked') });
  f.change({ scale: 1.6 }); f.saveSettings();
  f.prepareSessionEnd();
  assert.deepEqual(calls, ['interrupt', 'cancel', 'release', 'stopVoice']);
  assert.equal(JSON.parse(f.files.get('fixture-settings.json')).settings.scale, 1.6);
  // Windows may cancel its shutdown because a different application refuses it.
  calls.length = 0; f.prepareSessionEnd();
  assert.deepEqual(calls, ['interrupt', 'cancel', 'release', 'stopVoice']);
});

test('one failing shutdown component cannot skip later cleanup or the final settings flush', async () => {
  const f = fixture(), calls = [];
  f.setSessionServices({
    quick: { dispose() { calls.push('quick'); throw new Error('native cleanup failed'); } },
    chat: { dispose: () => calls.push('chat') },
    speech: { dispose: () => calls.push('speech'), whenReleased: async () => calls.push('drain') },
    voices: { dispose: () => calls.push('voices') }, trail: { dispose: () => calls.push('trail') },
  });
  f.change({ scale: 1.8 }); f.saveSettings();
  await f.quit();
  assert.deepEqual(calls, ['quick', 'speech', 'chat', 'voices', 'trail', 'drain']);
  assert.equal(JSON.parse(f.files.get('fixture-settings.json')).settings.scale, 1.8);
});

test('session-shutdown preparation still releases audio and saves when one interruption fails', () => {
  const f = fixture(), calls = [];
  f.setSessionServices({ quick: { interrupt() { throw new Error('interruption failed'); } },
    chat: { cancel: () => calls.push('cancel') }, speech: { release: () => calls.push('release') },
    voices: { stopVoice: () => calls.push('stopVoice') } });
  f.change({ scale: 1.7 }); f.saveSettings();
  assert.doesNotThrow(() => f.prepareSessionEnd());
  assert.deepEqual(calls, ['cancel', 'release', 'stopVoice']);
  assert.equal(JSON.parse(f.files.get('fixture-settings.json')).settings.scale, 1.7);
});

test('tray quit reaches shutdown after native interruption or farewell failures', () => {
  const f = fixture(), calls = [];
  f.setSessionServices({ quick: { interrupt() { throw new Error('native stop failure'); } },
    chat: { cancel: () => calls.push('cancel') },
    speech: { isActive: () => true, release: () => calls.push('release') },
    voices: { requestQuit: options => calls.push(['voice-quit', options.skipFarewell]) } });
  assert.doesNotThrow(() => f.requestQuit());
  assert.deepEqual(calls, ['cancel', 'release', ['voice-quit', true]]);
  const quitCount = f.nativeQuitCount;
  f.setQuitServices({ speech: { isActive: () => false, release() {} }, voices: { requestQuit() { throw new Error('farewell failed'); } } });
  assert.doesNotThrow(() => f.requestQuit());
  assert.equal(f.nativeQuitCount, quitCount + 1);
});

test('UTF-8 BOM preferences load normally and a missing file remains writable', () => {
  const f = fixture({ saved: '\uFEFF{"settings":{"scale":1.5}}' }); f.loadSettings();
  assert.equal(f.state().settings.scale, 1.5); assert.equal(f.state().storageError, null);
  f.change({ scale: 1.4 }); f.saveSettings(); f.flush();
  assert.equal(JSON.parse(f.files.get('fixture-settings.json')).settings.scale, 1.4);
  const missing = fixture(); missing.loadSettings(); missing.saveSettings(); missing.flush();
  assert.equal(missing.state().storageError, null);
  assert.ok(missing.files.has('fixture-settings.json'));
});

test('closing the pet before the save debounce expires still flushes its final preferences on quit', async () => {
  const f = fixture(); f.saveSettings(); f.flush();
  f.change({ cursorTrailDuration: 3.2 }); f.saveSettings();
  // The production closed handler has already set pet=null when quitting.
  await f.quit();
  assert.equal(JSON.parse(f.files.get('fixture-settings.json')).settings.cursorTrailDuration, 3.2);
});

test('the real quit entry captures ongoing chat speech before release clears its audio ownership', () => {
  for (const initiallyActive of [true, false]) {
    const f = fixture(), calls = [];
    let active = initiallyActive;
    f.setQuitServices({
      speech: { isActive: () => { calls.push('sample'); return active; }, release: () => { calls.push('release'); active = false; } },
      voices: { requestQuit: options => { calls.push(['voice-quit', options.skipFarewell]); assert.equal(active, false); } },
    });
    f.requestQuit();
    assert.deepEqual(calls, ['sample', 'release', ['voice-quit', initiallyActive]]);
  }
});

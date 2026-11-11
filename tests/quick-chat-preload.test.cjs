'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('quick-chat bridge exposes only fixed operations and strips Electron events and speech extras', () => {
  const calls = [], listeners = new Map(); let bridge, exposedName;
  const electron = { contextBridge: { exposeInMainWorld(name, value) { exposedName = name; bridge = value; } },
    ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({}); }, send(...args) { calls.push(args); },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/quick-chat-preload.cjs'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; },
  });
  assert.equal(exposedName, 'elysiaQuickChat'); assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), ['cancel', 'getState', 'hide', 'onFocus', 'onSpeechAudio', 'onSpeechStop', 'onState', 'reportSpeech', 'send']);
  bridge.getState('arbitrary-channel'); bridge.send('你好', 'extra'); bridge.cancel('extra'); bridge.hide('extra');
  assert.deepEqual(calls, [['quick-chat:get-state'], ['quick-chat:send', '你好'], ['quick-chat:cancel'], ['quick-chat:hide']]);
  for (const [method, channel] of [['onState', 'quick-chat:state'], ['onFocus', 'quick-chat:focus'],
    ['onSpeechAudio', 'quick-chat:speech-audio'], ['onSpeechStop', 'quick-chat:speech-stop']]) {
    let received;
    const unsubscribe = bridge[method]((...args) => { received = args; });
    const value = { text: 'fixture' };
    listeners.get(channel)({ sender: 'privileged', ports: ['private'] }, value);
    assert.deepEqual(received, [value]); unsubscribe(); unsubscribe();
    assert.equal(listeners.has(channel), false); assert.equal(typeof bridge[method](null), 'function');
  }
  const before = calls.length;
  for (const value of [null, {}, { token: '', type: 'ended' }, { token: 'x'.repeat(101), type: 'ended' }, { token: 'x', type: 'execute' }]) bridge.reportSpeech(value);
  assert.equal(calls.length, before);
  for (const type of ['started', 'ended', 'error']) bridge.reportSpeech({ token: 'audio-1', type, path: 'private', extra: 'secret' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(before))), ['started', 'ended', 'error'].map(type => ['quick-chat:speech-report', { token: 'audio-1', type }]));
});

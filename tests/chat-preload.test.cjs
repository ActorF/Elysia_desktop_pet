/** Verify the chat renderer's narrow bridge without exposing Electron event objects. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('chat bridge exposes only chat operations, filters window commands and unsubscribes listeners', () => {
  const calls = [], listeners = new Map();
  let bridge, exposedName;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { exposedName = name; bridge = value; } },
    ipcRenderer: {
      invoke(...args) { calls.push(args); return Promise.resolve({}); },
      send(...args) { calls.push(args); },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'chat-preload.cjs'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; },
  });
  assert.equal(exposedName, 'elysiaChat');
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), ['cancel', 'copyMessage', 'getState', 'getWindowState', 'newConversation', 'onSpeechAudio', 'onSpeechStop', 'onState', 'onWindowState', 'openSettings', 'readAloud', 'reportSpeech', 'send', 'windowControl']);
  for (const forbidden of ['invoke', 'quit', 'setSettings', 'setChatSettings', 'dragStart', 'readFile', 'fetch', 'writeText', 'deleteConversation', 'clearChatHistory']) assert.equal(bridge[forbidden], undefined);
  bridge.getState();
  bridge.send('你好', { role: 'system' });
  bridge.cancel();
  bridge.newConversation();
  bridge.openSettings();
  bridge.getWindowState();
  const reference = { conversationId: 'conversation-1', messageId: 'message-1' };
  bridge.copyMessage(reference, 'arbitrary text must not be forwarded as another argument');
  bridge.readAloud(reference, 'arbitrary text must not be forwarded as another argument');
  for (const action of ['minimize', 'toggle-maximize', 'close']) bridge.windowControl(action);
  for (const action of [null, undefined, {}, ['close'], 'quit', 'destroy', 'maximize']) bridge.windowControl(action);
  assert.deepEqual(calls, [
    ['chat:get-state'], ['chat:send', '你好'], ['chat:cancel'], ['chat:new-conversation'],
    ['chat:open-settings'], ['chat:get-window-state'], ['chat:copy-message', reference], ['chat:read-aloud', reference], ['chat:window-control', 'minimize'],
    ['chat:window-control', 'toggle-maximize'], ['chat:window-control', 'close'],
  ]);
  for (const [method, channel, snapshot] of [
    ['onState', 'chat:state', { settings: { username: '小星' }, conversations: [] }],
    ['onWindowState', 'chat:window-state', { maximized: true }],
    ['onSpeechAudio', 'chat:speech-audio', { token: 'audio-1', base64: 'UklGRg==', mime: 'audio/wav', volume: .5 }],
    ['onSpeechStop', 'chat:speech-stop', { token: 'audio-1' }],
  ]) {
    let received;
    const unsubscribe = bridge[method]((...args) => { received = args; });
    listeners.get(channel)({ sender: 'private metadata', ports: ['privileged'] }, snapshot);
    assert.deepEqual(received, [snapshot]);
    unsubscribe();
    unsubscribe();
    assert.equal(listeners.has(channel), false);
    assert.equal(typeof bridge[method](null), 'function');
  }
  assert.equal(listeners.size, 0);
  const before = calls.length;
  for (const event of [null, undefined, {}, 'ended', { token: 1, type: 'ended' }, { token: 'x'.repeat(101), type: 'ended' }, { token: 'audio-1', type: 'execute' }]) bridge.reportSpeech(event);
  assert.equal(calls.length, before, 'Malformed speech reports never cross IPC');
  for (const type of ['started', 'ended', 'error']) bridge.reportSpeech({ token: 'audio-1', type, secret: 'must be stripped', path: 'C:/private' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(before))), [
    ['chat:speech-report', { token: 'audio-1', type: 'started' }],
    ['chat:speech-report', { token: 'audio-1', type: 'ended' }],
    ['chat:speech-report', { token: 'audio-1', type: 'error' }],
  ]);
});

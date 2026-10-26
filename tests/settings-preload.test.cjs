'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('settings preload exposes only its narrow independent-window bridge', () => {
  const listeners = new Map(), calls = [];
  let name, bridge;
  const electron = {
    contextBridge: { exposeInMainWorld(key, api) { name = key; bridge = api; } },
    ipcRenderer: {
      invoke(...args) { calls.push(args); return Promise.resolve({}); },
      send(...args) { calls.push(args); },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'settings-preload.cjs'), 'utf8'), {
    require(moduleName) { assert.equal(moduleName, 'electron'); return electron; },
  });
  assert.equal(name, 'elysiaSettings');
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), ['action', 'cancelModelSetup', 'cancelVoiceSetup', 'clearChatHistory', 'deleteChatConversation', 'getChatState', 'getModelSetup', 'getState', 'getVoiceSetup', 'getVoiceState', 'getWindowState', 'inspectModelSetup', 'inspectVoiceSetup', 'installChatModel', 'installVoiceSetup', 'onChatState', 'onModelSetup', 'onState', 'onVoiceSetup', 'onVoiceState', 'onWindowState', 'openChat', 'recover', 'resize', 'selectChatConversation', 'setChatSettings', 'setSettings', 'setVoiceSettings', 'stopVoice', 'windowControl']);
  for (const forbidden of ['invoke', 'send', 'dragStart', 'setHitRegion', 'setAppearance', 'quit', 'playVoice', 'simulateVoice', 'deleteFile', 'installExecutable', 'downloadFile', 'copyMessage']) assert.equal(bridge[forbidden], undefined);
  bridge.getState();
  bridge.getWindowState();
  bridge.setSettings({ motionAmplitude: .75, eyeWarpStrength: 1.5 });
  bridge.action({ type: 'expression', id: 'heart' });
  bridge.resize(.01);
  bridge.recover();
  bridge.recover(true);
  bridge.windowControl('minimize');
  bridge.windowControl('toggle-maximize');
  bridge.windowControl('close');
  for (const invalid of [null, 'quit', 'maximize', {}, ['close']]) bridge.windowControl(invalid);
  assert.deepEqual(calls, [
    ['settings:get-state'], ['settings:get-window-state'], ['settings:set-settings', { motionAmplitude: .75, eyeWarpStrength: 1.5 }],
    ['settings:action', { type: 'expression', id: 'heart' }], ['settings:resize', .01],
    ['settings:recover', false], ['settings:recover', true],
    ['settings:window-control', 'minimize'], ['settings:window-control', 'toggle-maximize'], ['settings:window-control', 'close'],
  ]);
  let received;
  const stop = bridge.onState((...args) => { received = args; });
  const snapshot = { settings: { eyeTracking: true }, appearance: { expression: 'heart', pose: 'tea' } };
  listeners.get('settings:state')({ sender: 'private Electron metadata' }, snapshot);
  assert.deepEqual(received, [snapshot]);
  stop();
  assert.equal(listeners.has('settings:state'), false);
  assert.equal(typeof bridge.onState(null), 'function');
  const stopWindowState = bridge.onWindowState((...args) => { received = args; });
  const windowState = { maximized: true };
  listeners.get('settings:window-state')({sender:'private metadata'}, windowState);
  assert.deepEqual(received, [windowState]);
  stopWindowState();
  assert.equal(listeners.has('settings:window-state'), false);
  assert.equal(typeof bridge.onWindowState(null), 'function');
  bridge.getVoiceState();
  bridge.setVoiceSettings({ volume: .45, birthday: '02-29' });
  bridge.stopVoice();
  assert.deepEqual(calls.slice(-3), [
    ['settings:voice-get'], ['settings:voice-settings', { volume: .45, birthday: '02-29' }],
    ['settings:voice-stop'],
  ]);
  assert.ok(calls.every(([channel]) => !['settings:voice-play', 'settings:voice-simulate'].includes(channel)), 'Production settings expose no audition or simulation IPC');
  const stopVoiceState = bridge.onVoiceState((...args) => { received = args; });
  const voiceState = { settings: { enabled: true, dnd: false, volume: .45, birthday: '02-29' }, playback: { lineId: '01-1', status: 'playing' } };
  listeners.get('settings:voice-state')({ sender: 'private metadata' }, voiceState);
  assert.deepEqual(received, [voiceState]);
  stopVoiceState();
  assert.equal(listeners.has('settings:voice-state'), false);
  assert.equal(typeof bridge.onVoiceState(null), 'function');
  bridge.getChatState();
  bridge.setChatSettings({ username: '小星' });
  bridge.selectChatConversation('conversation-1');
  bridge.openChat();
  assert.deepEqual(calls.slice(-4), [
    ['settings:chat-get'], ['settings:chat-settings', { username: '小星' }],
    ['settings:chat-select', 'conversation-1'], ['settings:chat-open'],
  ]);
  for (const forbidden of ['send', 'sendChat', 'cancelChat', 'newConversation']) assert.equal(bridge[forbidden], undefined);
  const stopChatState = bridge.onChatState((...args) => { received = args; });
  const chatState = { settings: { username: '小星' }, conversations: [] };
  listeners.get('settings:chat-state')({ sender: 'private metadata' }, chatState);
  assert.deepEqual(received, [chatState]);
  stopChatState();
  assert.equal(listeners.has('settings:chat-state'), false);
  assert.equal(typeof bridge.onChatState(null), 'function');
  bridge.deleteChatConversation('conversation-1', 'arbitrary path must not be forwarded');
  bridge.clearChatHistory('arbitrary path must not be forwarded');
  bridge.getModelSetup('ignored');
  bridge.inspectModelSetup('ignored');
  bridge.installChatModel('https://untrusted.example/installer.exe');
  bridge.cancelModelSetup('ignored');
  assert.deepEqual(calls.slice(-6), [
    ['settings:chat-delete', 'conversation-1'], ['settings:chat-clear'], ['settings:model-setup-get'],
    ['settings:model-setup-inspect'], ['settings:model-setup-install'], ['settings:model-setup-cancel'],
  ]);
  const setupState = { phase: 'pulling-model', busy: true, progress: .4 };
  const stopSetup = bridge.onModelSetup((...args) => { received = args; });
  listeners.get('settings:model-setup-state')({ sender: 'private metadata' }, setupState);
  assert.deepEqual(received, [setupState]); stopSetup(); stopSetup();
  assert.equal(listeners.has('settings:model-setup-state'), false);
  assert.equal(typeof bridge.onModelSetup(null), 'function');
  bridge.getVoiceSetup('ignored');
  bridge.inspectVoiceSetup('ignored');
  bridge.installVoiceSetup('https://untrusted.example/voice.zip');
  bridge.cancelVoiceSetup('ignored');
  assert.deepEqual(calls.slice(-4), [
    ['settings:voice-setup-get'], ['settings:voice-setup-inspect'], ['settings:voice-setup-install'], ['settings:voice-setup-cancel'],
  ]);
  const voiceSetupState = { phase: 'downloading', busy: true, ready: false, progress: .6 };
  const stopVoiceSetup = bridge.onVoiceSetup((...args) => { received = args; });
  listeners.get('settings:voice-setup-state')({ sender: 'private metadata' }, voiceSetupState);
  assert.deepEqual(received, [voiceSetupState]); stopVoiceSetup(); stopVoiceSetup();
  assert.equal(listeners.has('settings:voice-setup-state'), false);
  assert.equal(typeof bridge.onVoiceSetup(null), 'function');
  assert.equal(listeners.size, 0);
});

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
  assert.deepEqual(Object.keys(bridge).sort(), ['action', 'getState', 'getVoiceState', 'getWindowState', 'onState', 'onVoiceState', 'onWindowState', 'recover', 'resize', 'setSettings', 'setVoiceSettings', 'stopVoice', 'windowControl']);
  for (const forbidden of ['invoke', 'send', 'dragStart', 'setHitRegion', 'setAppearance', 'quit', 'playVoice', 'simulateVoice']) assert.equal(bridge[forbidden], undefined);
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
  assert.equal(listeners.size, 0);
});

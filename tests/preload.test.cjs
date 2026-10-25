// Check that the renderer bridge never exposes raw IPC events or unrestricted channel access.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('preload keeps event metadata private and removes subscriptions cleanly', () => {
  const listeners = new Map();
  const invocations = [];
  let exposedName, bridge;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld(name, api) { exposedName = name; bridge = api; } },
    ipcRenderer: {
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
      invoke(...args) { invocations.push(args); return Promise.resolve({}); },
      send(...args) { invocations.push(args); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return fakeElectron; },
  });
  assert.equal(exposedName, 'elysiaDesktop');
  assert.equal(bridge.send, undefined);
  assert.equal(bridge.invoke, undefined);
  let received;
  const unsubscribe = bridge.onPointer((...args) => { received = args; });
  const payload = { localX: 12, localY: 34 };
  listeners.get('pet:pointer')({ sender: 'must remain hidden' }, payload);
  assert.deepEqual(received, [payload]);
  unsubscribe();
  assert.equal(listeners.has('pet:pointer'), false);
  bridge.setSettings({ clickThrough: true });
  bridge.setAppearance({ cat: true, pose: 'tea' });
  assert.equal(bridge.showMenu, undefined, 'Settings are only available from the tray');
  assert.deepEqual(invocations, [['pet:set-settings', { clickThrough: true }], ['pet:set-appearance', { cat: true, pose: 'tea' }]]);
  const zoom={steps:2,anchorX:42,anchorY:80};
  bridge.zoomBy(zoom);assert.deepEqual(invocations.at(-1),['pet:zoom-by',zoom]);
  const stopViewport=bridge.onViewport(value=>{received=value;});
  const viewport={width:1920,height:1080,characterX:-1200,characterY:-800,characterWidth:4200,characterHeight:5600,clipped:true};
  listeners.get('pet:viewport')({sender:'hidden'},viewport);assert.equal(received,viewport);
  listeners.get('pet:viewport')({sender:'hidden'},{...viewport,sequence:42});
  assert.deepEqual(invocations.at(-1),['pet:viewport-received',42]);
  stopViewport();assert.equal(listeners.has('pet:viewport'),false);
  assert.equal(bridge.dragMove, undefined, 'Drag uses native cursor sampling, not renderer delta queues');
  bridge.dragStart();bridge.dragEnd();
  assert.deepEqual(invocations.slice(-2), [['pet:drag-start'],['pet:drag-end']]);
  bridge.onPointer(() => { throw Error('callback failed'); });
  assert.throws(() => listeners.get('pet:pointer')({}, {sequence:7,sampledAt:100}), /callback failed/);
  assert.deepEqual(invocations.at(-1), ['pet:pointer-received',7], 'ACK is sent even if a subscriber fails');
  const stopDrag=bridge.onDragState(active=>{received=active;});
  listeners.get('pet:drag-state')({sender:'hidden'},true);assert.equal(received,true);
  stopDrag();assert.equal(listeners.has('pet:drag-state'),false);
  const stopTyped = bridge.onTypedKey((...args) => { received = args; });
  listeners.get('pet:typed-key')({sender:'hidden'}, 'A'); assert.deepEqual(received, ['A']);
  stopTyped(); assert.equal(listeners.has('pet:typed-key'),false);
  const region={width:420,height:560,rects:[{x:20,y:30,width:40,height:50}]};
  bridge.setHitRegion(region);assert.deepEqual(invocations.at(-1),['pet:set-hit-region',region]);
  bridge.interact('head-pat'); assert.deepEqual(invocations.at(-1), ['pet:interact','head-pat']);
  const beforeInvalid = invocations.length;
  bridge.interact({text:'arbitrary content'}); bridge.interact('not-an-interaction');
  assert.equal(invocations.length, beforeInvalid, 'Interaction bridge accepts only three named actions');
});

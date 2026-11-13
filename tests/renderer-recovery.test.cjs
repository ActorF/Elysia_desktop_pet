'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRendererRecovery } = require('../electron/renderer-recovery.cjs');

function fixture(t) {
  const webContents = new EventEmitter(); webContents.isDestroyed = () => false;
  const window = { webContents, isDestroyed: () => false, loadURL: async () => webContents.emit('did-finish-load') };
  const recovery = createRendererRecovery(window, 'file:///test/renderer/index.html');
  t.after(() => recovery.dispose());
  return { window, webContents, recovery };
}
test('a crashed pet reloads only on explicit recovery and concurrent requests share that reload', async t => {
  const f = fixture(t); let complete, loads = 0;
  f.window.loadURL = url => { loads++; assert.equal(url, 'file:///test/renderer/index.html'); return new Promise(resolve => { complete = resolve; }); };
  f.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.recovery.isFailed(), true); assert.equal(loads, 0);
  const first = f.recovery.recover(); assert.equal(f.recovery.recover(), first);
  await Promise.resolve(); assert.equal(loads, 1);
  f.webContents.emit('did-finish-load'); complete();
  assert.equal(await first, true); assert.equal(f.recovery.isFailed(), false);
  assert.equal(await f.recovery.recover(), true); assert.equal(loads, 1);
});
test('failed or crashing reload remains recoverable without an automatic restart loop', async t => {
  const f = fixture(t); let loads = 0;
  f.webContents.emit('render-process-gone');
  f.window.loadURL = async () => { loads++; throw new Error('load failed'); };
  await assert.rejects(f.recovery.recover(), /load failed/);
  assert.equal(loads, 1); assert.equal(f.recovery.isFailed(), true);
  f.window.loadURL = async () => { loads++; f.webContents.emit('did-finish-load'); f.webContents.emit('render-process-gone'); };
  assert.equal(await f.recovery.recover(), false); assert.equal(loads, 2);
  f.window.loadURL = async () => { loads++; f.webContents.emit('did-finish-load'); };
  assert.equal(await f.recovery.recover(), true); assert.equal(loads, 3);
});
test('closing the pet during recovery never revives it or retains listeners', async t => {
  const f = fixture(t); let complete;
  f.webContents.emit('render-process-gone');
  f.window.loadURL = () => new Promise(resolve => { complete = resolve; });
  const pending = f.recovery.recover(); await Promise.resolve();
  f.recovery.dispose(); complete();
  assert.equal(await pending, false); assert.equal(await f.recovery.recover(), false);
  assert.equal(f.webContents.listenerCount('render-process-gone'), 0);
  assert.equal(f.webContents.listenerCount('did-finish-load'), 0);
});

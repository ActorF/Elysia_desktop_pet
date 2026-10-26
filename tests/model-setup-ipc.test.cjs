'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerModelSetupIpc } = require('../electron/model-setup-ipc.cjs');

test('model installation and cancellation are available only to the settings main frame', async () => {
  const frame = { url: 'file:///settings.html' }, webContents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false }, handlers = new Map(), calls = [];
  const setup = Object.fromEntries(['getState', 'inspect', 'installChatModel', 'cancel'].map(method => [method, () => { calls.push(method); return method; }]));
  const voiceSetup = { ...setup, install: () => { calls.push('voiceInstall'); return 'voiceInstall'; } };
  registerModelSetupIpc({ ipcMain: { handle: (channel, action) => handlers.set(channel, action) },
    settingsWindow: { url: frame.url, getWindow: () => window }, setup, voiceSetup });
  for (const action of handlers.values()) {
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: webContents, senderFrame: { url: frame.url } }]) assert.equal(await action(event), null);
  }
  assert.deepEqual(calls, []);
  assert.equal(await handlers.get('settings:model-setup-install')({ sender: webContents, senderFrame: frame }, 'https://untrusted.example/evil.exe'), 'installChatModel');
  assert.equal(await handlers.get('settings:voice-setup-install')({ sender: webContents, senderFrame: frame }, 'untrusted/archive.zip'), 'voiceInstall');
  assert.deepEqual(calls, ['installChatModel', 'voiceInstall']);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFirstRunSetup } = require('../electron/first-run-setup.cjs');

test('new installation prepares both models; restart resumes only unfinished work and respects cancellation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-first-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], services = { chat: { installChatModel: () => calls.push('chat') }, voice: { install: () => calls.push('voice') } };
  let setup = createFirstRunSetup({ directory, firstRun: true });
  setup.start(services); assert.deepEqual(calls, ['chat', 'voice']);
  setup.update('chat', { phase: 'ready' }); setup.update('voice', { phase: 'error' });
  setup = createFirstRunSetup({ directory, firstRun: false });
  calls.length = 0; setup.start(services); assert.deepEqual(calls, ['voice']);
  setup.update('voice', { phase: 'cancelled' });
  // Even without any saved conversation, cancellation survives later startup.
  setup = createFirstRunSetup({ directory, firstRun: true });
  calls.length = 0; setup.start(services); assert.deepEqual(calls, []); assert.equal(setup.needsSetup(), false);
});

test('smoke and custom remote profiles never initiate downloads or create setup state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-existing-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const services = { chat: { installChatModel: () => assert.fail('unexpected installation') }, voice: { install: () => assert.fail('unexpected installation') } };
  createFirstRunSetup({ directory, firstRun: false }).start({ ...services, chatBaseUrl: 'https://example.test' });
  createFirstRunSetup({ directory, firstRun: true, enabled: false }).start(services);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('existing Ollama-era profile migrates once; later launches start the installed backend only', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'automatic-setup.json');
  fs.writeFileSync(marker, JSON.stringify({ chat: false, voice: false }));
  const calls = [], services = { chat: { installChatModel: () => calls.push('install'), ensureInstalledServer: () => calls.push('start') }, voice: { install: () => calls.push('voice') }, chatBaseUrl: 'http://127.0.0.1:18434' };
  let setup = createFirstRunSetup({ directory, firstRun: false });
  assert.equal(setup.start(services), true); assert.deepEqual(calls, ['install']);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { chat: true, voice: false, chatBackend: 'llama.cpp-v1' });
  setup.update('chat', { phase: 'ready' });
  setup = createFirstRunSetup({ directory, firstRun: false }); calls.length = 0;
  assert.equal(setup.start(services), false); assert.deepEqual(calls, ['start']);
});

test('cancelled migration remains cancelled and never redownloads on next launch', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-cancel-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], services = { chat: { installChatModel: () => calls.push('install'), ensureInstalledServer: () => calls.push('start') }, voice: { install: () => calls.push('voice') } };
  let setup = createFirstRunSetup({ directory, firstRun: false });
  setup.start(services); setup.update('chat', { phase: 'cancelled' }); calls.length = 0;
  setup = createFirstRunSetup({ directory, firstRun: true });
  assert.equal(setup.start(services), false); assert.deepEqual(calls, ['start']);
});

test('custom endpoints never start a local server, even with pending migration', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-remote-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'automatic-setup.json'), JSON.stringify({ chat: true, voice: false, chatBackend: 'llama.cpp-v1' }));
  const chat = { installChatModel: () => assert.fail('remote installation'), ensureInstalledServer: () => assert.fail('remote startup') };
  for (const chatBaseUrl of ['https://example.test', 'http://127.0.0.1:11434', 'http://127.0.0.1:18434/proxy', 'http://user@localhost:18434']) {
    assert.equal(createFirstRunSetup({ directory, firstRun: false }).start({ chat, voice: {}, chatBaseUrl }), false);
  }
});

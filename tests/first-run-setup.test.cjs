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

test('smoke and existing profiles never initiate downloads or create setup state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-existing-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const services = { chat: { installChatModel: () => assert.fail('unexpected installation') }, voice: { install: () => assert.fail('unexpected installation') } };
  createFirstRunSetup({ directory, firstRun: false }).start(services);
  createFirstRunSetup({ directory, firstRun: true, enabled: false }).start(services);
  assert.deepEqual(fs.readdirSync(directory), []);
});

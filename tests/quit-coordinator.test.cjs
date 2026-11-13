'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuitCoordinator } = require('../electron/quit-coordinator.cjs');

test('quit stops work once and waits for the owned worker even when requested repeatedly', async () => {
  const events = [];
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const coordinator = createQuitCoordinator({
    prepare: () => events.push('stop'), drain: () => { events.push('drain'); return released; },
    finish: () => {
      events.push('quit');
      coordinator.beforeQuit({ preventDefault: () => assert.fail('final Electron quit must be allowed') });
    },
  });
  const event = { preventDefault: () => events.push('prevent') };
  const first = coordinator.beforeQuit(event);
  assert.deepEqual(events, ['prevent', 'stop']);
  assert.equal(coordinator.beforeQuit(event), first);
  await Promise.resolve();
  assert.deepEqual(events, ['prevent', 'stop', 'prevent', 'drain']);
  release(); await first;
  assert.deepEqual(events, ['prevent', 'stop', 'prevent', 'drain', 'quit']);
});

test('preparation and bounded drain failures are reported without trapping app shutdown', async () => {
  const events = [], first = new Error('preparation'), second = new Error('drain');
  const coordinator = createQuitCoordinator({
    prepare: () => { events.push('stop'); throw first; },
    drain: () => { events.push('drain'); return Promise.reject(second); },
    onError: error => { events.push(error.message); throw new Error('log failure'); },
    finish: () => events.push('quit'),
  });
  await coordinator.beforeQuit({ preventDefault() {} });
  assert.deepEqual(events, ['stop', 'preparation', 'drain', 'drain', 'quit']);
});

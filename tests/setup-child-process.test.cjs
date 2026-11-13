'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSetupProcessTracker } = require('../electron/setup-child-process.cjs');
const timeoutError = () => Object.assign(new Error('timeout'), { diagnosticKind: 'extraction-timeout' });

test('a kill that throws or never exits settles within a bound and retains ownership until late exit', async t => {
  for (const throws of [false, true]) await t.test(String(throws), async () => {
    const tracker = createSetupProcessTracker({ stopTimeoutMs: 5 }), child = new EventEmitter(); child.pid = 123;
    child.kill = () => { if (throws) throw new Error('kill refused'); return false; };
    await assert.rejects(tracker.wait(child, { timeoutMs: 5, timeoutError }), error => error.setupProcessPending && error.preserveStage && error.diagnosticKind === 'extraction-timeout');
    assert.equal(tracker.pending(), true);
    child.emit('error', new Error('late kill failure'));
    assert.equal(tracker.pending(), true);
    child.emit('exit', 1); assert.equal(tracker.pending(), false);
  });
});

test('unconfirmed cancellation remains cancellation and cannot imply that staging may be removed', async () => {
  const tracker = createSetupProcessTracker({ stopTimeoutMs: 5 }), child = new EventEmitter(), controller = new AbortController();
  child.pid = 123; child.kill = () => true;
  const pending = tracker.wait(child, { signal: controller.signal, timeoutMs: 1000, timeoutError }); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && error.preserveStage === true);
  assert.equal(tracker.pending(), true); child.emit('close', null); assert.equal(tracker.pending(), false);
});

test('a confirmed stop permits cleanup and an exit without pipe closure is also bounded', async () => {
  const tracker = createSetupProcessTracker({ stopTimeoutMs: 5 }), child = new EventEmitter();
  child.pid = 123; child.kill = () => { child.emit('exit', 1); return true; };
  await assert.rejects(tracker.wait(child, { timeoutMs: 5, timeoutError }), error => !error.preserveStage);
  assert.equal(tracker.pending(), false);
  const drained = new EventEmitter(); drained.pid = 456; drained.kill = () => assert.fail('exited process should not be killed');
  const pending = tracker.wait(drained, { timeoutMs: 1000, timeoutError, completionEvent: 'close' }); drained.emit('exit', 0);
  await assert.rejects(pending, error => !error.preserveStage); assert.equal(tracker.pending(), false);
});

test('launch failure and successful exit leave no quarantined child', async () => {
  const tracker = createSetupProcessTracker(), failed = new EventEmitter();
  failed.kill = () => assert.fail('no process was launched');
  const pending = tracker.wait(failed, { timeoutMs: 1000, timeoutError }); failed.emit('error', Object.assign(new Error('launch'), { code: 'ENOENT' }));
  await assert.rejects(pending, { code: 'ENOENT' }); assert.equal(tracker.pending(), false);
  const success = new EventEmitter(); success.pid = 123; success.kill = () => assert.fail('successful process must not be killed');
  const result = tracker.wait(success, { timeoutMs: 1000, timeoutError }); success.emit('exit', 0);
  assert.equal(await result, 0); assert.equal(tracker.pending(), false);
});

test('an output failure arriving after process exit but before pipe close cannot become a successful result', async () => {
  const tracker = createSetupProcessTracker({ stopTimeoutMs: 20 }), child = new EventEmitter();
  child.pid = 123; child.kill = () => assert.fail('an already exited process must not be killed');
  const pending = tracker.wait(child, { timeoutMs: 1000, timeoutError, completionEvent: 'close' });
  child.emit('exit', 0);
  assert.equal(tracker.owns(child), false, 'the process is confirmed dead even while output is draining');
  tracker.stopChild(child, Object.assign(new Error('excessive output'), { diagnosticKind: 'extraction-output' }));
  child.emit('close', 0);
  await assert.rejects(pending, error => error.diagnosticKind === 'extraction-output' && !error.preserveStage);
  assert.equal(tracker.pending(), false);
});

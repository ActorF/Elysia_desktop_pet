'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTopmostController, REASSERT_INTERVAL_MS } = require('../electron/window-layer.cjs');

class FakeWindow extends EventEmitter {
  constructor({ visible = true, minimized = false } = {}) {
    super(); this.visible = visible; this.minimized = minimized; this.destroyed = false;
    this.calls = []; this.topmost = false;
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  setAlwaysOnTop(...args) { this.calls.push(['topmost', ...args]); this.topmost = args[0]; }
  moveTop() { this.calls.push(['raise']); }
  focus() { assert.fail('Topmost maintenance must not take keyboard focus'); }
  show() { assert.fail('Topmost maintenance must not show a hidden window'); }
  restore() { assert.fail('Topmost maintenance must not restore a minimized window'); }
}
function fixture(windowOptions = {}, options = {}) {
  const window = new FakeWindow(windowOptions), timers = new Set(), scheduled = [];
  if (options.createTaskbarOrderer) window.getNativeWindowHandle = () => Buffer.alloc(8);
  const controller = createTopmostController(window, { ...options,
    setInterval(fn, ms) { const timer = { fn, ms, unreferenced: false, unref() { this.unreferenced = true; } }; timers.add(timer); scheduled.push(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  });
  return { window, controller, timers, scheduled, tick() { for (const t of [...timers]) t.fn(); } };
}

test('reasserts the supported Windows level without activation and only one unreferenced timer', () => {
  const f = fixture();
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver'], ['raise']]);
  assert.equal(f.timers.size, 1);
  assert.equal(f.scheduled[0].ms, REASSERT_INTERVAL_MS);
  assert.equal(f.scheduled[0].unreferenced, true);
  f.window.calls.length = 0;
  // Another topmost app can cover the pet without changing isAlwaysOnTop().
  f.window.topmost = true; f.tick();
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver'], ['raise']]);
  assert.equal(f.scheduled.length, 1);
  for (const event of ['show', 'restore', 'blur', 'leave-full-screen']) f.window.emit(event);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('a hidden or minimized pet is never shown by moveTop or polled', () => {
  const f = fixture({ visible: false });
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver']]); assert.equal(f.timers.size, 0);
  assert.equal(f.window.topmost, true); f.window.calls.length = 0;
  f.window.emit('blur'); assert.deepEqual(f.window.calls, []);
  f.window.visible = true; f.window.emit('show');
  assert.equal(f.timers.size, 1);
  const stale = f.scheduled[0].fn;
  f.window.visible = false; f.window.emit('hide');
  assert.equal(f.timers.size, 0); f.window.calls.length = 0; stale();
  assert.deepEqual(f.window.calls, []);
  f.window.visible = true; f.window.minimized = true; f.window.emit('show');
  assert.equal(f.timers.size, 0); assert.deepEqual(f.window.calls, []);
  f.window.minimized = false; f.window.emit('restore'); assert.equal(f.timers.size, 1);
  f.window.minimized = true; f.window.emit('minimize'); assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('hidden preference toggles update native topmost without showing or starting a timer', () => {
  const f = fixture({ visible: false }, { enabled: false });
  f.window.calls.length = 0;
  f.controller.setEnabled(true);
  assert.equal(f.window.topmost, true); assert.equal(f.window.visible, false);
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver']]);
  assert.equal(f.timers.size, 0); assert.equal(f.scheduled.length, 0);
  f.controller.setEnabled(false);
  assert.equal(f.window.topmost, false); assert.equal(f.window.visible, false);
  assert.equal(f.timers.size, 0); assert.equal(f.scheduled.length, 0);
  f.controller.dispose();
});

test('disabling topmost wins over stale timer callbacks and lifecycle events', () => {
  const f = fixture(), stale = f.scheduled[0].fn;
  f.window.calls.length = 0; f.controller.setEnabled(false);
  assert.equal(f.controller.enabled, false); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.window.calls, [['topmost', false]]);
  for (const event of ['show', 'restore', 'blur']) f.window.emit(event);
  stale(); f.controller.refresh(); f.controller.setEnabled(false);
  assert.deepEqual(f.window.calls, [['topmost', false]]);
  f.controller.setEnabled(true); f.controller.setEnabled(true);
  assert.equal(f.timers.size, 1); assert.equal(f.scheduled.length, 2);
  f.controller.dispose();
});

test('initially disabled controller remains disabled even on show and restore', () => {
  const f = fixture({}, { enabled: false });
  assert.deepEqual(f.window.calls, [['topmost', false]]);
  f.window.emit('show'); f.window.emit('restore'); f.window.emit('blur');
  assert.equal(f.timers.size, 0); assert.deepEqual(f.window.calls, [['topmost', false]]);
  f.controller.dispose();
});

test('duplicate factories and repeated disposal cannot leak listeners or timers', () => {
  const f = fixture(), count = f.window.eventNames().map(e => [e, f.window.listenerCount(e)]);
  assert.equal(createTopmostController(f.window, { enabled: false }), f.controller);
  assert.deepEqual(f.window.eventNames().map(e => [e, f.window.listenerCount(e)]), count);
  assert.equal(f.timers.size, 1);
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.controller.disposed, true); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.window.eventNames(), []);
  f.window.calls.length = 0;
  f.scheduled[0].fn(); f.controller.refresh(); f.controller.setEnabled(true);
  assert.deepEqual(f.window.calls, []);
});

test('destroying the native window releases maintenance without native calls after close', () => {
  const f = fixture(), stale = f.scheduled[0].fn;
  f.window.destroyed = true; f.window.calls.length = 0; f.window.emit('closed');
  assert.equal(f.timers.size, 0); assert.equal(f.controller.disposed, true);
  stale(); f.controller.dispose(); assert.deepEqual(f.window.calls, []);
  assert.deepEqual(f.window.eventNames(), []);
});

test('native destruction during a maintenance call is caught and cleaned up', () => {
  const f = fixture(); f.window.calls.length = 0;
  f.window.setAlwaysOnTop = () => { f.window.destroyed = true; throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => f.tick());
  assert.equal(f.controller.disposed, true); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.window.calls, []); assert.deepEqual(f.window.eventNames(), []);
});

test('native failures are reported without creating a busy retry loop', () => {
  const errors = [], f = fixture({}, { intervalMs: 1, onError: error => errors.push(error.message) });
  assert.equal(f.scheduled[0].ms, 500);
  f.window.moveTop = () => { throw new Error('Native reorder failed'); };
  assert.equal(f.controller.refresh(), false);
  assert.deepEqual(errors, ['Native reorder failed']); assert.equal(f.timers.size, 1); assert.equal(f.scheduled.length, 1);
  f.controller.dispose();
});

test('taskbar-front mode stays topmost without raising above the taskbar on a timer or focus event', () => {
  const f = fixture({}, { taskbarInFront: true });
  assert.equal(f.controller.taskbarInFront, true);
  assert.deepEqual(f.window.calls, [['topmost', true, 'floating']]);
  f.window.calls.length = 0;
  f.tick();
  for (const event of ['focus', 'blur', 'show', 'restore', 'leave-full-screen']) f.window.emit(event);
  assert.equal(f.window.calls.length, 6);
  assert.ok(f.window.calls.every(call => JSON.stringify(call) === JSON.stringify(['topmost', true, 'floating'])));
  assert.equal(f.window.topmost, true);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('switching taskbar order applies immediately and stale ticks use the latest preference', () => {
  const f = fixture(), tick = f.scheduled[0].fn;
  f.window.calls.length = 0;
  f.controller.setTaskbarInFront(true);
  assert.deepEqual(f.window.calls, [['topmost', true, 'floating']]);
  f.window.calls.length = 0;
  tick();
  assert.deepEqual(f.window.calls, [['topmost', true, 'floating']]);
  f.window.calls.length = 0;
  f.controller.setTaskbarInFront(false);
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver'], ['raise']]);
  f.window.calls.length = 0;
  f.controller.setTaskbarInFront(false);
  assert.deepEqual(f.window.calls, []);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test('taskbar preference survives disabled and hidden states without showing or enabling the pet', () => {
  const f = fixture({ visible: false }, { enabled: false });
  f.window.calls.length = 0;
  f.controller.setTaskbarInFront(true);
  assert.deepEqual(f.window.calls, []);
  assert.equal(f.controller.enabled, false);
  f.controller.setEnabled(true);
  assert.deepEqual(f.window.calls, [['topmost', true, 'floating']]);
  assert.equal(f.window.visible, false);
  assert.equal(f.timers.size, 0);
  f.controller.setEnabled(false);
  f.window.calls.length = 0;
  f.controller.setEnabled(true);
  assert.deepEqual(f.window.calls, [['topmost', true, 'floating']]);
  f.controller.dispose();
  f.window.calls.length = 0;
  f.controller.setTaskbarInFront(false);
  f.controller.setEnabled(true);
  f.controller.refresh();
  assert.deepEqual(f.window.calls, []);
});

function nativeFixture(windowOptions = {}, options = {}) {
  const backend = { ready: false, starts: 0, stops: 0, disposals: 0,
    start() { this.starts++; },
    stop() { this.stops++; this.ready = false; },
    dispose() { this.disposals++; this.ready = false; },
    get running() { return this.ready; },
  };
  let callbacks;
  const f = fixture(windowOptions, { taskbarInFront: true, platform: 'win32', ...options,
    createTaskbarOrderer(window, settings) { callbacks = settings; return backend; },
  });
  return { ...f, backend, stopped() { callbacks.onStopped(); } };
}

test('ready native ordering is not undone by Electron floating reassertions', () => {
  const f = nativeFixture();
  assert.equal(f.backend.starts, 1);
  assert.deepEqual(f.window.calls, [['topmost', true, 'floating']]);
  f.backend.ready = true; f.window.calls.length = 0;
  f.tick();
  for (const event of ['focus', 'blur', 'show', 'restore']) f.window.emit(event);
  assert.deepEqual(f.window.calls, [], 'Floating only handles the primary taskbar and must not override the helper');
  assert.equal(f.window.topmost, true);
  f.controller.setTaskbarInFront(false);
  assert.equal(f.backend.ready, false);
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver'], ['raise']]);
  f.controller.dispose();
});

test('late native helper exit reapplies the latest enabled policy without resurrecting a disposed window', () => {
  const f = nativeFixture(); f.backend.ready = true;
  f.controller.setTaskbarInFront(false); f.window.calls.length = 0;
  f.stopped();
  assert.deepEqual(f.window.calls, [['topmost', true, 'screen-saver'], ['raise']]);
  f.controller.setTaskbarInFront(true); f.backend.ready = true;
  f.controller.setEnabled(false); f.window.calls.length = 0;
  f.stopped();
  assert.deepEqual(f.window.calls, [['topmost', false]]);
  assert.equal(f.timers.size, 0); assert.equal(f.backend.ready, false);
  f.controller.dispose(); f.window.calls.length = 0;
  f.stopped();
  assert.deepEqual(f.window.calls, []); assert.equal(f.backend.disposals, 1);
});

test('late helper exit restores companions after the latest pet policy, including disabled topmost', () => {
  for (const enabled of [false, true]) {
    const companion = { topmost: true, taskbarInFront: true }, restored = [];
    const f = nativeFixture({}, { onLayerRestored() {
      restored.push(f.window.calls.slice());
      companion.topmost = f.controller.enabled;
      companion.taskbarInFront = f.controller.taskbarInFront;
    } });
    f.backend.ready = true;
    if (enabled) f.controller.setTaskbarInFront(false);
    else f.controller.setEnabled(false);
    assert.equal(restored.length, 0, 'Stopping is not yet an acknowledgement of native exit');
    // The cancelled helper completes an old batch after the settings UI has
    // already applied its new settings to the subtitle window.
    companion.topmost = true; companion.taskbarInFront = true;
    f.window.calls.length = 0;
    f.stopped();
    assert.deepEqual(restored, [enabled
      ? [['topmost', true, 'screen-saver'], ['raise']]
      : [['topmost', false]]]);
    assert.deepEqual(companion, { topmost: enabled, taskbarInFront: !enabled });
    assert.equal(f.window.topmost, enabled);
    assert.equal(f.timers.size, enabled ? 1 : 0);
    f.controller.dispose(); f.stopped();
    assert.equal(restored.length, 1, 'A late exit cannot restore companions after disposal');
  }
});

test('companion restoration errors are reported without reviving disabled maintenance', () => {
  const errors = [];
  let restored = 0;
  const f = nativeFixture({}, {
    onLayerRestored() { restored++; throw new Error('Subtitle window closed during restoration'); },
    onError: error => errors.push(error.message),
  });
  f.backend.ready = true; f.controller.setEnabled(false);
  assert.doesNotThrow(() => f.stopped());
  assert.deepEqual(errors, ['Subtitle window closed during restoration']);
  assert.equal(restored, 1); assert.equal(f.window.topmost, false);
  assert.equal(f.controller.enabled, false); assert.equal(f.timers.size, 0);
  f.window.emit('restore'); f.tick();
  assert.equal(f.window.topmost, false); assert.equal(f.timers.size, 0);
  f.controller.dispose(); f.stopped();
  assert.equal(restored, 1); assert.equal(f.backend.disposals, 1);
});

test('helper exit never restores companions for a destroyed pet, including destruction during restoration', () => {
  for (const duringRestore of [false, true]) {
    let restored = 0;
    const f = nativeFixture({}, { onLayerRestored() { restored++; } });
    f.backend.ready = true;
    if (duringRestore) {
      f.window.setAlwaysOnTop = () => {
        f.window.destroyed = true;
        throw new Error('Native window destroyed during restoration');
      };
    } else {
      f.window.destroyed = true;
      f.window.emit('closed');
    }
    assert.doesNotThrow(() => f.stopped());
    assert.equal(restored, 0); assert.equal(f.controller.disposed, true);
    assert.equal(f.timers.size, 0); assert.equal(f.backend.disposals, 1);
  }
});

test('hidden and minimized windows stop the helper and restart ordering only on restore', () => {
  const f = nativeFixture({ visible: false });
  assert.equal(f.backend.starts, 0);
  f.window.visible = true; f.window.emit('show'); f.backend.ready = true;
  assert.equal(f.backend.starts, 1);
  f.window.minimized = true; f.window.emit('minimize');
  assert.equal(f.backend.ready, false); assert.equal(f.timers.size, 0);
  f.window.calls.length = 0; f.stopped();
  assert.ok(f.window.calls.every(call => call[0] === 'topmost'));
  assert.equal(f.backend.starts, 1);
  f.window.minimized = false; f.window.emit('restore');
  assert.equal(f.backend.starts, 2);
  f.window.visible = false; f.window.emit('hide');
  f.window.calls.length = 0; f.stopped();
  assert.ok(f.window.calls.every(call => call[0] === 'topmost'));
  assert.equal(f.backend.starts, 2); assert.equal(f.window.visible, false);
  f.controller.dispose();
});

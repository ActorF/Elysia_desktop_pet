'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path'), fs = require('node:fs'), vm = require('node:vm');
const { createCursorTrail, trailDisplays, displayForPoint, breaksTrail, TRAIL_LIFETIME_MS, MAX_PENDING_POINTS } = require('../electron/cursor-trail.cjs');
const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 };
const secondary = { id: 2, bounds: { x: -2200, y: -200, width: 1600, height: 1000 }, scaleFactor: 1.5 };

function fixture({ deferred = false, smoke = false, monitors = [primary, secondary], factory = createCursorTrail } = {}) {
  const windows = [], screen = new EventEmitter(); let now = 10000, displays = monitors;
  screen.getAllDisplays = () => displays;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false; this.sent = []; this.sentAt = []; this.calls = [];
      this.webContents = new EventEmitter(); this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.send = (...args) => { this.sent.push(args); this.sentAt.push(now); };
      this.webContents.setWindowOpenHandler = callback => { this.windowOpen = callback; };
      this.loading = deferred ? new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }) : Promise.resolve();
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    setMenu(value) { this.menu = value; }
    setIgnoreMouseEvents(...args) { this.ignore = args; }
    setAlwaysOnTop(...args) { this.top = args; }
    loadURL(url) { this.url = url; return this.loading; }
    showInactive() { this.visible = true; this.calls.push('showInactive'); }
    hide() { this.visible = false; this.calls.push('hide'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const controller = factory({ BrowserWindow: Window, screen, root: path.resolve(__dirname, '..'), isSmokeTest: smoke, now: () => now });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { controller, windows, screen, flush,
    sample: (x, y) => controller.sample({ x, y, sampledAt: now }),
    advance: (milliseconds, timers) => { now += milliseconds; timers?.tick(milliseconds); },
    displays: (next, event = 'display-metrics-changed') => { displays = next; screen.emit(event); },
  };
}
const packets = window => window.sent.filter(([channel]) => channel === 'cursor-trail:sample').map(([, value]) => value);
const samples = window => packets(window).flatMap(packet => packet.points);

test('display routing uses DIPs and breaks time gaps, clock rollback and monitor seams, never fast movement distance', () => {
  const displays = trailDisplays([primary, secondary, { bounds: { x: 0, y: 0, width: NaN, height: 10 } }]);
  assert.equal(displays.length, 2); assert.equal(displayForPoint({ x: -1000, y: -100 }, displays).id, '2');
  assert.equal(displayForPoint({ x: -300, y: 300 }, displays), null);
  assert.equal(displayForPoint({ x: 1920, y: 0 }, displays), null);
  const previous = { x: 100, y: 100, at: 1000, displayId: '1' };
  for (const distance of [30, 400, 700, 1000]) assert.equal(breaksTrail(previous, { ...previous, x: previous.x + distance, at: 1016 }), false);
  assert.equal(breaksTrail(previous, { ...previous, x: 1000, at: 1180 }), false);
  for (const next of [{ ...previous, at: 1181 }, { ...previous, at: 900 }, { ...previous, displayId: '2' }]) assert.equal(breaksTrail(previous, next), true);
});

test('first movement creates only its monitor window with transparent, click-through, sandboxed nonactivating behavior', async () => {
  const f = fixture();
  try {
    assert.equal(f.controller.getState().enabled, true);
    assert.equal(f.controller.getState().style, 'pink');
    assert.equal(f.controller.getState().duration, .6);
    f.sample(100, 100); f.sample(100, 100); assert.equal(f.windows.length, 0, 'A still cursor creates no surface');
    f.sample(120, 110); await f.flush(); const window = f.windows[0];
    assert.equal(f.windows.length, 1); assert.equal(window.options.width, 1920); assert.equal(window.options.height, 1080);
    assert.equal(window.options.focusable, false); assert.equal(window.options.skipTaskbar, true); assert.equal(window.options.transparent, true);
    assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.webPreferences.contextIsolation, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.deepEqual(window.ignore, [true]); assert.deepEqual(window.calls, ['showInactive']);
    assert.deepEqual(window.windowOpen({ url: 'https://example.com' }), { action: 'deny' });
    assert.deepEqual(samples(window).map(point => [point.x, point.y, point.break]), [[100, 100, true], [120, 110, false]]);
    assert.equal(window.sent[0][0], 'cursor-trail:style'); assert.deepEqual(window.sent[0][1], { style: 'pink', generation: 1, duration: .6 });
    assert.equal(f.controller.getWindows()[0], window); assert.deepEqual(f.controller.getState().pending, []);
    let prevented = 0; for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.emit(name, { preventDefault() { prevented++; } });
    assert.equal(prevented, 3);
  } finally { f.controller.dispose(); }
});

test('250Hz input batches its full recent path at most once per 16ms without dropping fast segments', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.sample(110, 100); await f.flush(); const window = f.windows[0];
    for (let index = 1; index <= 40; index++) { f.advance(4, t.mock.timers); f.sample(110 + index, 100); }
    f.advance(16, t.mock.timers);
    assert.ok(packets(window).length <= 12, `Expected <=12 packets, got ${packets(window).length}`);
    assert.equal(samples(window).length, 42, 'Every sample, including the initial origin, survives batching');
    const sentTimes = window.sent.flatMap(([channel], index) => channel === 'cursor-trail:sample' ? [window.sentAt[index]] : []);
    assert.ok(sentTimes.slice(1).every((at, index) => at - sentTimes[index] >= 16));
    assert.ok(packets(window).some(packet => packet.points.length > 1));
    assert.equal(samples(window).at(-1).x, 150);
    f.advance(4, t.mock.timers); f.sample(900, 100); f.advance(4, t.mock.timers); f.sample(901, 100); f.advance(16, t.mock.timers);
    assert.equal(samples(window).at(-1).x, 901); assert.equal(samples(window).at(-1).break, false);
    assert.equal(samples(window).find(point => point.x === 900).break, false);
  } finally { f.controller.dispose(); }
});

test('stationary sampling does not keep effects alive and idle clears/hides at 600ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.sample(120, 100); await f.flush(); const window = f.windows[0];
    f.advance(500, t.mock.timers); f.sample(120, 100); assert.equal(window.isVisible(), true);
    f.advance(TRAIL_LIFETIME_MS - 500, t.mock.timers); assert.equal(window.isVisible(), false);
    assert.equal(window.sent.at(-1)[0], 'cursor-trail:clear'); assert.deepEqual(f.controller.getState().pending, []);
    f.sample(125, 100);
    assert.deepEqual(packets(window).at(-1).points.map(point => [point.x, point.break]), [[120, true], [125, false]], 'The fresh stationary baseline seeds a new segment');
  } finally { f.controller.dispose(); }
});

test('crossing monitors creates independent small surfaces and never connects across their gap', async () => {
  const f = fixture();
  try {
    f.sample(-2000, 100); f.sample(-1980, 110); await f.flush(); const left = f.windows[0];
    assert.deepEqual({ x: left.options.x, y: left.options.y, width: left.options.width }, { x: -2200, y: -200, width: 1600 });
    assert.equal(samples(left).at(-1).x, 220); assert.equal(samples(left).at(-1).y, 310, 'No second DPI multiplication');
    f.sample(-300, 110); assert.equal(f.windows.length, 1);
    f.sample(10, 100); f.sample(30, 100); await f.flush(); const right = f.windows[1];
    assert.equal(right.options.x, 0); assert.equal(samples(right)[0].break, true); assert.equal(right.options.width, 1920);
  } finally { f.controller.dispose(); }
});

test('disable, blocked and dispose invalidate loading windows and pending throttle callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['disable', 'block', 'dispose']) {
    const f = fixture({ deferred: true });
    f.sample(100, 100); f.sample(120, 100); const window = f.windows[0];
    if (action === 'disable') f.controller.setEnabled(false);
    if (action === 'block') f.controller.setBlocked(true);
    if (action === 'dispose') f.controller.dispose();
    window.resolve(); await f.flush(); f.advance(1000, t.mock.timers);
    assert.equal(samples(window).length, 0); assert.equal(window.isVisible(), false); assert.deepEqual(f.controller.getState().pending, []);
    assert.equal(f.sample(200, 100), false); f.controller.dispose();
  }
  const f = fixture();
  f.sample(100, 100); f.sample(120, 100); await f.flush(); const window = f.windows[0];
  f.advance(4, t.mock.timers); f.sample(130, 100); const count = samples(window).length;
  f.controller.setEnabled(false); f.advance(1000, t.mock.timers);
  assert.equal(samples(window).length, count); assert.equal(window.isVisible(), false);
  f.controller.setEnabled(true); assert.equal(window.isVisible(), false);
  f.sample(200, 100); f.sample(220, 100);
  assert.deepEqual(packets(window).at(-1).points.map(point => [point.x, point.break]), [[200, true], [220, false]]);
  f.controller.dispose();
});

test('display geometry changes retire obsolete surfaces, and their late load callbacks cannot recreate them', async () => {
  const f = fixture({ deferred: true });
  try {
    f.sample(-2000, 100); f.sample(-1980, 110); const removed = f.windows[0];
    f.displays([primary], 'display-removed'); assert.equal(removed.isDestroyed(), true); assert.equal(f.controller.getWindows().length, 0);
    removed.resolve(); await f.flush(); assert.equal(samples(removed).length, 0);
    f.sample(100, 100); f.sample(120, 100); const changed = f.windows[1];
    f.displays([{ ...primary, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    assert.equal(changed.isDestroyed(), true); changed.resolve(); await f.flush();
    f.sample(100, 100); f.sample(120, 100); const latest = f.windows[2]; latest.resolve(); await f.flush();
    assert.equal(latest.options.width, 1280); assert.equal(packets(latest).length, 1);
  } finally { f.controller.dispose(); }
  assert.equal(f.screen.listenerCount('display-removed'), 0);
});

test('unchanged display notifications preserve a complete first stroke while its window is loading', async () => {
  const f = fixture({ deferred: true });
  try {
    f.sample(100, 100); f.advance(16); f.sample(500, 100); f.advance(16); f.sample(1500, 100);
    const window = f.windows[0], generation = f.controller.getState().generation;
    // Order, work-area-only metadata, and invalid displays do not change the
    // normalized id/bounds/scaleFactor configuration used to paint the overlay.
    const unchanged = [secondary, { ...primary, workArea: { x: 0, y: 0, width: 1920, height: 1000 } }, { id: 3, bounds: { x: 0, y: 0, width: NaN, height: 100 } }];
    f.displays(unchanged); f.displays([primary, secondary]);
    assert.equal(f.controller.getState().generation, generation);
    assert.equal(window.isDestroyed(), false); assert.equal(window.calls.includes('hide'), false);
    assert.deepEqual(f.controller.getState().pending, ['1']);
    window.resolve(); await f.flush();
    assert.deepEqual(samples(window).map(point => [point.x, point.break]), [[100, true], [500, false], [1500, false]]);
    assert.equal(packets(window).length, 1); assert.equal(packets(window)[0].generation, generation);
    assert.equal(window.isVisible(), true);
    const sent = window.sent.length;
    f.displays(unchanged);
    assert.equal(window.sent.length, sent, 'An unchanged notification cannot clear an already visible stroke either');
    assert.equal(window.isVisible(), true);
  } finally { f.controller.dispose(); }
});

test('smoke rendering stays hidden and failed window loads can recover without leaked surfaces', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true, smoke: true });
  try {
    f.sample(100, 100); f.sample(120, 100); const failed = f.windows[0]; failed.reject(new Error('load failed')); await f.flush();
    assert.equal(failed.isDestroyed(), true); assert.equal(f.controller.getWindows().length, 0);
    f.sample(150, 100); assert.equal(f.windows.length, 1);
    f.advance(2001, t.mock.timers); f.sample(170, 100); const recovered = f.windows[1]; recovered.resolve(); await f.flush();
    assert.equal(samples(recovered).length, 1); assert.equal(recovered.isVisible(), false);
  } finally { f.controller.dispose(); }
});

test('cursor trail preload exposes only four read-only subscriptions and strips IPC metadata', () => {
  const listeners = new Map(); let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'cursor-trail-preload.cjs'), 'utf8'), { require(name) {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(key, value) { assert.equal(key, 'elysiaCursorTrail'); bridge = value; } },
      ipcRenderer: { on: (channel, callback) => listeners.set(channel, callback), removeListener: (channel, callback) => { if (listeners.get(channel) === callback) listeners.delete(channel); } } };
  } });
  assert.deepEqual(Object.keys(bridge).sort(), ['onClear', 'onDuration', 'onSample', 'onStyle']); assert.equal(Object.isFrozen(bridge), true);
  let received; const stop = bridge.onSample(value => { received = value; });
  listeners.get('cursor-trail:sample')({ private: true }, { x: 10, y: 20 }); assert.deepEqual(received, { x: 10, y: 20 });
  stop(); assert.equal(listeners.size, 0);
  const stopStyle = bridge.onStyle(value => { received = value; });
  listeners.get('cursor-trail:style')({ private: true }, { style: 'stardust', generation: 4 }); assert.deepEqual(received, { style: 'stardust', generation: 4 });
  stopStyle(); assert.equal(listeners.size, 0); assert.doesNotThrow(() => bridge.onStyle(null)());
  const stopDuration = bridge.onDuration(value => { received = value; });
  listeners.get('cursor-trail:duration')({ private: true }, { duration: 2, generation: 5 }); assert.deepEqual(received, { duration: 2, generation: 5 });
  stopDuration(); assert.equal(listeners.size, 0); assert.doesNotThrow(() => bridge.onDuration(null)());
});

test('400–1000 DIP movements every 16ms remain connected on the same monitor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.advance(16, t.mock.timers); f.sample(500, 100); await f.flush();
    f.advance(16, t.mock.timers); f.sample(1500, 100);
    f.advance(16, t.mock.timers); f.sample(600, 100);
    const points = samples(f.windows[0]);
    assert.deepEqual(points.map(point => point.x), [100, 500, 1500, 600]);
    assert.deepEqual(points.map(point => point.break), [true, false, false, false]);
    assert.ok(points.slice(1).every((point, index) => point.sequence > points[index].sequence));
  } finally { f.controller.dispose(); }
});

test('a complete fast stroke before the first window finishes loading preserves its origin and intermediate points', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.sample(100, 100);
    for (const x of [700, 1700, 500]) { f.advance(16, t.mock.timers); f.sample(x, 100); }
    const window = f.windows[0]; assert.equal(packets(window).length, 0);
    f.advance(80, t.mock.timers); window.resolve(); await f.flush();
    assert.equal(packets(window).length, 1);
    assert.deepEqual(samples(window).map(point => [point.x, point.age, point.break]), [[100, 128, true], [700, 112, false], [1700, 96, false], [500, 80, false]]);
    assert.equal(window.sent[0][0], 'cursor-trail:style'); assert.equal(window.sent[1][0], 'cursor-trail:sample');
  } finally { f.controller.dispose(); }
});

test('loading buffers stay bounded and downsampling preserves the recent path origin and newest endpoint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.sample(100, 100);
    for (let index = 1; index <= 256; index++) { f.advance(2, t.mock.timers); f.sample(100 + index, 100); }
    const window = f.windows[0]; window.resolve(); await f.flush(); const points = samples(window);
    assert.equal(packets(window).length, 1); assert.ok(points.length <= MAX_PENDING_POINTS); assert.ok(points.length > 2);
    assert.equal(points[0].x, 100); assert.equal(points.at(-1).x, 356);
    assert.equal(points[0].break, true); assert.ok(points.slice(1).every(point => !point.break));
    assert.ok(points.slice(1).every((point, index) => point.sequence > points[index].sequence));
    assert.ok(points.every(point => point.age >= 0 && point.age < TRAIL_LIFETIME_MS));
  } finally { f.controller.dispose(); }
});

test('loading buffers prune expired points, and a window loaded after the whole stroke expires stays hidden', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.sample(100, 100);
    for (let index = 1; index <= 200; index++) { f.advance(4, t.mock.timers); f.sample(100 + index, 100); }
    const window = f.windows[0]; f.advance(200, t.mock.timers); window.resolve(); await f.flush();
    const points = samples(window);
    assert.ok(points.length > 1 && points.length <= MAX_PENDING_POINTS);
    assert.ok(points.every(point => point.age >= 0 && point.age < TRAIL_LIFETIME_MS));
    assert.ok(points[0].x > 200); assert.equal(points[0].break, true); assert.equal(points.at(-1).x, 300);
  } finally { f.controller.dispose(); }
  const expired = fixture({ deferred: true });
  try {
    expired.sample(100, 100); expired.sample(700, 100); const window = expired.windows[0];
    expired.advance(TRAIL_LIFETIME_MS, t.mock.timers); window.resolve(); await expired.flush();
    assert.equal(packets(window).length, 0); assert.equal(window.isVisible(), false);
    assert.deepEqual(expired.controller.getState().pending, []);
  } finally { expired.controller.dispose(); }
});

test('stationary ticks let the surface fade while retaining a fresh origin for one later fast movement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.sample(120, 100); await f.flush(); const window = f.windows[0];
    for (let index = 0; index < 50; index++) { f.advance(16, t.mock.timers); f.sample(120, 100); }
    assert.equal(window.isVisible(), false); assert.equal(packets(window).length, 1);
    f.advance(16, t.mock.timers); f.sample(520, 100);
    assert.equal(window.isVisible(), true);
    assert.deepEqual(packets(window).at(-1).points.map(point => [point.x, point.age, point.break]), [[120, 16, true], [520, 0, false]]);
    assert.equal(window.calls.filter(call => call === 'showInactive').length, 2);
  } finally { f.controller.dispose(); }
});

test('a real sampling gap breaks the line and clock rollback invalidates old buffered samples', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.sample(500, 100); await f.flush();
    f.advance(181, t.mock.timers); f.sample(1500, 100);
    assert.deepEqual(packets(f.windows[0]).at(-1).points.map(point => [point.x, point.break]), [[1500, true]]);
  } finally { f.controller.dispose(); }
  const rollback = fixture({ deferred: true });
  try {
    rollback.sample(100, 100); rollback.advance(16, t.mock.timers); rollback.sample(500, 100);
    const generation = rollback.controller.getState().generation;
    rollback.advance(-100); rollback.sample(700, 100);
    assert.ok(rollback.controller.getState().generation > generation);
    rollback.advance(16, t.mock.timers); rollback.sample(1100, 100);
    const window = rollback.windows[0]; window.resolve(); await rollback.flush();
    assert.deepEqual(samples(window).map(point => [point.x, point.break]), [[700, true], [1100, false]]);
    assert.ok(samples(window).every(point => point.age >= 0));
  } finally { rollback.controller.dispose(); }
});

test('crossing away and back while both windows load keeps a break at each monitor seam', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.sample(100, 100); f.advance(4, t.mock.timers); f.sample(500, 100);
    f.advance(4, t.mock.timers); f.sample(-1800, 100);
    f.advance(4, t.mock.timers); f.sample(-800, 100);
    f.advance(4, t.mock.timers); f.sample(700, 100);
    for (const window of f.windows) window.resolve(); await f.flush();
    assert.deepEqual(samples(f.windows[0]).map(point => [point.x, point.break]), [[100, true], [500, false], [700, true]]);
    assert.deepEqual(samples(f.windows[1]).map(point => [point.x, point.break]), [[400, true], [1400, false]]);
  } finally { f.controller.dispose(); }
});

test('returning to the same monitor after an invalid point or desktop gap cannot join its previous stroke', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const invalidX of [NaN, -300]) {
    const f = fixture();
    try {
      f.sample(100, 100); f.sample(500, 100); await f.flush(); const window = f.windows[0];
      f.advance(4, t.mock.timers); assert.equal(f.sample(invalidX, 100), false);
      f.advance(4, t.mock.timers); assert.equal(f.sample(700, 100), false);
      f.advance(4, t.mock.timers); f.sample(1000, 100); f.advance(4, t.mock.timers);
      assert.deepEqual(packets(window).at(-1).points.map(point => [point.x, point.break]), [[700, true], [1000, false]]);
    } finally { f.controller.dispose(); }
  }
});

test('style changes clear pending strokes, publish the next generation, and reject unknown styles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.sample(120, 100); await f.flush(); const window = f.windows[0];
    f.advance(4, t.mock.timers); f.sample(130, 100);
    const oldGeneration = f.controller.getState().generation;
    f.controller.setStyle('ribbon');
    assert.equal(f.controller.getState().style, 'ribbon'); assert.ok(f.controller.getState().generation > oldGeneration);
    assert.deepEqual(f.controller.getState().pending, []); assert.equal(window.isVisible(), false);
    const styleIndex = window.sent.findLastIndex(([channel]) => channel === 'cursor-trail:style');
    assert.deepEqual(window.sent[styleIndex][1], { style: 'ribbon', generation: f.controller.getState().generation, duration: .6 });
    f.sample(200, 100); f.advance(4, t.mock.timers); f.sample(1200, 100); f.advance(32, t.mock.timers);
    assert.deepEqual(packets(window).at(-1).points.map(point => [point.x, point.break]), [[200, true], [1200, false]]);
    assert.equal(packets(window).at(-1).style, 'ribbon'); assert.equal(samples(window).some(point => point.x === 130), false);
    const generation = f.controller.getState().generation;
    f.controller.setStyle('ribbon'); f.controller.setStyle('unknown'); f.controller.setStyle(null);
    assert.equal(f.controller.getState().generation, generation); assert.equal(f.controller.getState().style, 'ribbon');
    f.controller.setStyle('stardust'); assert.equal(f.controller.getState().style, 'stardust');
  } finally { f.controller.dispose(); }
});

test('multiple style changes during loading can only publish the latest style and latest stroke', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.sample(100, 100); f.sample(120, 100); const window = f.windows[0];
    f.controller.setStyle('ribbon'); f.sample(300, 100); f.advance(16, t.mock.timers); f.sample(700, 100);
    f.controller.setStyle('stardust'); f.sample(1000, 100); f.advance(16, t.mock.timers); f.sample(1600, 100);
    window.resolve(); await f.flush();
    const styleMessages = window.sent.filter(([channel]) => channel === 'cursor-trail:style');
    assert.equal(styleMessages.length, 1); assert.deepEqual(styleMessages[0][1], { style: 'stardust', generation: f.controller.getState().generation, duration: .6 });
    assert.equal(packets(window).length, 1); assert.equal(packets(window)[0].style, 'stardust');
    assert.deepEqual(samples(window).map(point => [point.x, point.break]), [[1000, true], [1600, false]]);
    assert.ok(window.sent.indexOf(styleMessages[0]) < window.sent.findIndex(([channel]) => channel === 'cursor-trail:sample'));
  } finally { f.controller.dispose(); }
});

test('cancelled throttle and idle callbacks cannot revive or erase a newer generation', async () => {
  for (const action of ['disable', 'block', 'style', 'duration', 'dispose']) {
    const timers = [], controllerModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'cursor-trail.cjs'), 'utf8'), {
      require, module: controllerModule,
      setTimeout(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
      clearTimeout() {},
    });
    const f = fixture({ factory: controllerModule.exports.createCursorTrail });
    try {
      f.sample(100, 100); f.sample(120, 100); await f.flush(); const window = f.windows[0];
      f.advance(4); f.sample(130, 100); const obsolete = [...timers], oldCount = packets(window).length;
      if (action === 'disable') f.controller.setEnabled(false);
      if (action === 'block') f.controller.setBlocked(true);
      if (action === 'style') f.controller.setStyle('ribbon');
      if (action === 'duration') f.controller.setDuration(2);
      if (action === 'dispose') f.controller.dispose();
      for (const timer of obsolete) timer.callback();
      assert.equal(packets(window).length, oldCount); assert.equal(window.isVisible(), false);
      if (action === 'dispose') { assert.equal(window.isDestroyed(), true); continue; }
      f.controller.setEnabled(true); f.controller.setBlocked(false);
      f.sample(200, 100); f.sample(220, 100); assert.equal(window.isVisible(), true);
      f.advance(4); f.sample(250, 100); const currentFlush = timers.at(-1), count = packets(window).length;
      for (const timer of obsolete) timer.callback();
      assert.equal(packets(window).length, count); assert.equal(window.isVisible(), true);
      f.advance(16); currentFlush.callback(); assert.equal(samples(window).at(-1).x, 250);
    } finally { f.controller.dispose(); }
  }
});

test('duration uses seconds, clamps finite values, and stays independent of the enable switch and style', () => {
  const f = fixture();
  try {
    assert.equal(f.controller.getState().duration, .6);
    f.controller.setEnabled(false); f.controller.setStyle('ribbon');
    f.controller.setDuration(10);
    assert.equal(f.controller.getState().duration, 5); assert.equal(f.controller.getState().enabled, false);
    assert.equal(f.controller.getState().style, 'ribbon');
    f.controller.setDuration(-1); assert.equal(f.controller.getState().duration, .1);
    const generation = f.controller.getState().generation;
    for (const value of [NaN, Infinity, -Infinity, '2', null, .1]) f.controller.setDuration(value);
    assert.equal(f.controller.getState().duration, .1); assert.equal(f.controller.getState().generation, generation);
    f.controller.setDuration(1.25); f.controller.setEnabled(true);
    assert.equal(f.controller.getState().duration, 1.25); assert.equal(f.controller.getState().enabled, true);
  } finally { f.controller.dispose(); }
});

test('changing duration clears visible and pending old strokes immediately and applies the new idle deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    f.sample(100, 100); f.sample(120, 100); await f.flush(); const window = f.windows[0];
    f.advance(4, t.mock.timers); f.sample(130, 100);
    const before = f.controller.getState().generation, oldPackets = packets(window).length;
    f.controller.setDuration(2);
    assert.equal(window.isVisible(), false); assert.deepEqual(f.controller.getState().pending, []);
    assert.ok(f.controller.getState().generation > before);
    assert.deepEqual(window.sent.at(-1), ['cursor-trail:duration', { duration: 2, generation: f.controller.getState().generation }]);
    f.advance(700, t.mock.timers); assert.equal(packets(window).length, oldPackets);
    f.sample(200, 100); f.sample(700, 100);
    assert.equal(packets(window).at(-1).duration, 2); assert.equal(window.isVisible(), true);
    assert.deepEqual(packets(window).at(-1).points.map(point => point.x), [200, 700]);
    f.advance(1999, t.mock.timers); assert.equal(window.isVisible(), true);
    f.advance(1, t.mock.timers); assert.equal(window.isVisible(), false);
    assert.equal(samples(window).some(point => point.x === 130), false);
  } finally { f.controller.dispose(); }
});

test('duration updates during loading publish only the latest duration and never revive the old pending stroke', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.sample(100, 100); f.sample(500, 100); const window = f.windows[0];
    f.controller.setDuration(5); f.sample(600, 100); f.sample(1000, 100);
    f.controller.setDuration(.1); f.sample(1100, 100); f.advance(16, t.mock.timers); f.sample(1500, 100);
    window.resolve(); await f.flush();
    assert.deepEqual(window.sent.find(([channel]) => channel === 'cursor-trail:style')[1], { style: 'pink', duration: .1, generation: f.controller.getState().generation });
    assert.equal(packets(window).at(-1).duration, .1);
    assert.deepEqual(samples(window).map(point => [point.x, point.break]), [[1100, true], [1500, false]]);
    f.advance(99, t.mock.timers); assert.equal(window.isVisible(), true);
    f.advance(1, t.mock.timers); assert.equal(window.isVisible(), false);
  } finally { f.controller.dispose(); }
});

test('five-second loading history remains bounded and preserves endpoints without creating long temporal holes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.controller.setDuration(5); f.sample(100, 100);
    for (let index = 1; index <= 1200; index++) { f.advance(4, t.mock.timers); f.sample(100 + index, 100); }
    const window = f.windows[0]; window.resolve(); await f.flush(); const points = samples(window);
    assert.equal(points.length, MAX_PENDING_POINTS); assert.equal(packets(window).length, 1);
    assert.equal(points[0].x, 100); assert.equal(points.at(-1).x, 1300);
    assert.equal(points[0].age, 4800); assert.equal(points.at(-1).age, 0);
    assert.ok(points.every(point => point.age < 5000 && point.x >= 0 && point.x < primary.bounds.width));
    assert.ok(points.slice(1).every((point, index) => !point.break && point.sequence > points[index].sequence));
    assert.ok(points.slice(1).every((point, index) => points[index].age - point.age <= 180), 'Compaction must not manufacture renderer time-gap breaks');
    assert.equal(packets(window)[0].duration, 5);
  } finally { f.controller.dispose(); }
});

test('the configured pending lifetime expires short trails without revealing a late-loading window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ deferred: true });
  try {
    f.controller.setDuration(.1); f.sample(100, 100); f.sample(500, 100);
    const window = f.windows[0]; f.advance(100, t.mock.timers); window.resolve(); await f.flush();
    assert.equal(packets(window).length, 0); assert.equal(window.isVisible(), false);
    assert.deepEqual(f.controller.getState().pending, []);
  } finally { f.controller.dispose(); }
});

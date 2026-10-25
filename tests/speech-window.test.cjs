'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs'), vm = require('node:vm');
const { createSpeechWindow, speechBounds } = require('../electron/speech-window.cjs');
const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

test('speech moves to the opposite side of the pet and stays within the monitor work area', () => {
  const right = speechBounds({ x: 1500, y: 600, width: 420, height: 560 }, displays);
  assert.equal(right.side, 'left'); assert.ok(right.x + right.width < 1508);
  const left = speechBounds({ x: 0, y: 600, width: 420, height: 560 }, displays);
  assert.equal(left.side, 'right'); assert.ok(left.x >= 400);
  for (const pet of [ { x: -300, y: -500, width: 420, height: 560 }, { x: 1800, y: 900, width: 420, height: 560 }, { x: -1000, y: -1000, width: 6000, height: 8000 }, { x: 1900, y: 1030, width: 4.2, height: 5.6 } ]) {
    const result = speechBounds(pet, displays);
    assert.ok(result.x >= 0 && result.y >= 0);
    assert.ok(result.x + result.width <= 1920 && result.y + result.height <= 1040);
    assert.ok(result.tailY >= 36 && result.tailY <= result.height - 36);
  }
});

test('speech follows negative-origin monitors without applying physical DPI a second time', () => {
  const screens = [{ bounds: { x: -1536, y: -100, width: 1536, height: 864 }, workArea: { x: -1536, y: -100, width: 1536, height: 824 }, scaleFactor: 1.25 }, ...displays];
  const result = speechBounds({ x: -440, y: 100, width: 420, height: 560 }, screens);
  assert.equal(result.side, 'left'); assert.equal(result.width, 300);
  assert.ok(result.x >= -1536 && result.x + result.width <= 0);
  const tiny = speechBounds({ x: 0, y: 0, width: 420, height: 560 }, [{ workArea: { x: 10, y: 20, width: 300, height: 150 } }], { width: 500, height: 200 });
  assert.deepEqual({ x: tiny.x, y: tiny.y, width: tiny.width, height: tiny.height }, { x: 10, y: 20, width: 300, height: 150 });
});

function fixture({ deferred = false, smoke = false, finishCallback = () => {} } = {}) {
  const windows = [], ipcMain = new EventEmitter(), started = [], finished = [];
  let release;
  const loading = deferred ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false; this.calls = []; this.sent = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.send = (...args) => this.sent.push(args);
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setMenu() {}
    setBounds(bounds) { this.bounds = bounds; }
    setAlwaysOnTop(...args) { this.top = args; }
    loadURL(url) { this.webContents.mainFrame.url = url; return loading; }
    hide() { this.visible = false; this.calls.push('hide'); }
    showInactive() { this.visible = true; this.calls.push('showInactive'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  let bounds = { x: 1500, y: 600, width: 420, height: 560 }, monitors = displays;
  const preferences = { alwaysOnTop: true };
  const controller = createSpeechWindow({ BrowserWindow: Window, screen: { getAllDisplays: () => monitors }, ipcMain, root: path.resolve(__dirname, '..'), getCharacterBounds: () => bounds, getPreferences: () => preferences, isSmokeTest: smoke, onStarted: value => started.push(value), onFinished: value => { finished.push(value); finishCallback(value); } });
  const report = (value, event = null) => { const window = windows.at(-1); ipcMain.emit('speech:event', event ?? { sender: window.webContents, senderFrame: window.webContents.mainFrame }, value); };
  const layout = (token, width = 320, height = 108, revision = 1, ready = true, event = null) => {
    const window = windows.at(-1);
    ipcMain.emit('speech:layout', event ?? { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { token, width, height, revision });
    if (ready) report({ token, type: 'prepared', revision });
  };
  return { windows, ipcMain, controller, report, layout, started, finished, release, preferences, move: next => { bounds = next; }, monitors: next => { monitors = next; } };
}
const line = id => ({ id, text: '早上好呀♪ 今天第一个见到的人，是不是我？', audioUrl: `file:///audio/${id}.wav`, groupName: '早上好' });

test('speech uses a safe nonactivating window; only trusted current-token playback commits and completes', async () => {
  const f = fixture();
  try {
    const result = await f.controller.play(line('01-1'), { token: 'one', kind: 'auto' });
    assert.equal(result.ok, true); const window = f.windows[0];
    assert.equal(window.isVisible(), false, 'The previous bubble size must stay hidden until layout is ready');
    f.report({ token: 'one', type: 'started' }); assert.equal(f.started.length, 0);
    f.layout('one');
    assert.equal(window.options.focusable, false); assert.deepEqual(window.calls, ['showInactive']);
    assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true); assert.equal(window.options.webPreferences.autoplayPolicy, 'no-user-gesture-required');
    assert.deepEqual(window.openHandler({ url: 'https://example.com' }), { action: 'deny' });
    assert.equal(f.controller.getState().playing, false);
    f.report({ token: 'one', type: 'started' }, { sender: {}, senderFrame: window.webContents.mainFrame });
    f.report({ token: 'one', type: 'started' }, { sender: window.webContents, senderFrame: { url: f.controller.url } });
    f.report({ token: 'stale', type: 'started' }); assert.equal(f.started.length, 0);
    f.report({ token: 'one', type: 'started' }); f.report({ token: 'one', type: 'started' });
    assert.deepEqual(f.started, [{ token: 'one', lineId: '01-1', kind: 'auto' }]); assert.equal(f.controller.getState().playing, true);
    f.report({ token: 'one', type: 'ended' });
    assert.deepEqual(f.finished, [{ token: 'one', lineId: '01-1', kind: 'auto', status: 'ended' }]);
    assert.equal(f.controller.getState().playing, false); assert.equal(f.controller.getState().visible, true);
    f.controller.stop(); assert.equal(f.controller.getState().visible, false);
  } finally { f.controller.dispose(); }
  assert.equal(f.ipcMain.listenerCount('speech:event'), 0);
  assert.equal(f.ipcMain.listenerCount('speech:layout'), 0);
});

test('rapid replacement during first load only starts the newest recording and stale completion cannot hide it', async () => {
  const f = fixture({ deferred: true });
  try {
    const first = f.controller.play(line('01-1'), { token: 'one' });
    const second = f.controller.play(line('01-2'), { token: 'two' });
    f.release();
    assert.equal((await first).ok, false); assert.equal((await second).ok, true);
    assert.equal(f.windows.length, 1);
    assert.equal(f.windows[0].sent.filter(([name]) => name === 'speech:play').length, 1);
    assert.equal(f.finished[0].status, 'replaced');
    f.layout('two');
    f.report({ token: 'one', type: 'ended' }); assert.equal(f.controller.getState().token, 'two'); assert.equal(f.controller.getState().visible, true);
    f.report({ token: 'two', type: 'started' });
    f.report({ token: 'two', type: 'skip' });
    assert.equal(f.finished.at(-1).status, 'skipped'); assert.equal(f.controller.getState().visible, false);
  } finally { f.controller.dispose(); }
});

test('farewell skip completes immediately, playback errors are reported, and placement follows movement and topmost preferences', async () => {
  const f = fixture();
  try {
    await f.controller.play(line('12-1'), { token: 'bye', kind: 'farewell' });
    f.layout('bye');
    f.report({ token: 'bye', type: 'skip' });
    assert.equal(f.finished.at(-1).kind, 'farewell'); assert.equal(f.finished.at(-1).status, 'skipped');
    await f.controller.play(line('01-1'), { token: 'bad' });
    f.layout('bad');
    f.report({ token: 'bad', type: 'error', error: '录音缺失' });
    assert.equal(f.controller.getState().error, '录音缺失'); assert.equal(f.finished.at(-1).status, 'error');
    f.move({ x: 50, y: 50, width: 420, height: 560 }); f.preferences.alwaysOnTop = false;
    assert.equal(f.controller.reposition().side, 'right'); assert.equal(f.windows[0].top[0], false);
    assert.equal((await f.controller.play({ ...line('01-1'), audioUrl: 'https://example.com/audio.wav' })).ok, false);
  } finally { f.controller.dispose(); }
});

test('smoke playback stays hidden and disposal cancels a pending load without reviving it', async () => {
  const f = fixture({ deferred: true, smoke: true });
  const pending = f.controller.play(line('01-1'));
  f.controller.dispose(); f.release();
  assert.equal((await pending).ok, false); assert.equal(f.controller.getWindow(), null);
  assert.equal(f.windows[0].calls.includes('showInactive'), false);
  assert.equal((await f.controller.play(line('01-2'))).ok, false);
});

test('volume updates are clamped, reject invalid input, and survive a pending first window load', async () => {
  const f = fixture({ deferred: true });
  try {
    assert.equal(f.controller.setVolume(.5), false);
    const playing = f.controller.play(line('01-1'), { token: 'volume', volume: .8 });
    assert.equal(f.controller.setVolume(.25), true);
    f.release(); await playing;
    f.layout('volume');
    const window = f.windows[0];
    assert.equal(window.sent.find(([name]) => name === 'speech:play')[1].volume, .25);
    for (const [input, output] of [[.6, .6], [4, 1], [-2, 0]]) {
      assert.equal(f.controller.setVolume(input), true);
      assert.deepEqual(window.sent.at(-1), ['speech:volume', { token: 'volume', volume: output }]);
    }
    const before = window.sent.length;
    for (const invalid of [NaN, Infinity, -.0 / .0, null, undefined, '.3', {}]) assert.equal(f.controller.setVolume(invalid), false);
    assert.equal(window.sent.length, before);
    f.report({ token: 'volume', type: 'ended' });
    assert.equal(f.controller.setVolume(.5), false);
    f.report({ token: 'stale', type: 'skip' }); assert.equal(window.isVisible(), true);
    f.controller.stop(); assert.equal(window.isVisible(), false, 'Stop also dismisses lingering subtitles after playback ends');
  } finally { f.controller.dispose(); }
});

test('measured bubble sizes are token-isolated, bounded, and renegotiated on a smaller display', async () => {
  const f = fixture();
  try {
    await f.controller.play(line('01-1'), { token: 'sized' }); const window = f.windows[0];
    const initial = { ...window.bounds };
    f.layout('stale', 410, 80); assert.deepEqual(window.bounds, initial); assert.equal(window.isVisible(), false);
    f.layout('sized', 410, 80, 1, true, { sender: {}, senderFrame: window.webContents.mainFrame });
    assert.deepEqual(window.bounds, initial); assert.equal(window.isVisible(), false);
    f.layout('sized', NaN, 80); assert.deepEqual(window.bounds, initial);
    f.layout('sized', 290, 80, 1, false);
    assert.equal(window.bounds.width, 290); assert.equal(window.bounds.height, 80); assert.equal(window.isVisible(), false);
    f.report({ token: 'sized', type: 'prepared', revision: 1 }); assert.equal(window.isVisible(), true);
    f.report({ token: 'sized', type: 'started' }); assert.equal(f.started.length, 1);
    f.layout('sized', 99999, 99999); assert.equal(window.bounds.width, 430); assert.equal(window.bounds.height, 180);
    f.monitors([{ bounds: { x: 0, y: 0, width: 300, height: 200 }, workArea: { x: 0, y: 0, width: 300, height: 180 } }]);
    f.controller.reposition();
    const measure = window.sent.findLast(([name]) => name === 'speech:measure')[1];
    assert.equal(measure.maxWidth, 300); assert.equal(measure.revision, 2);
    f.layout('sized', 280, 108, 1, false); assert.equal(window.bounds.width, 300, 'Old monitor measurement cannot overwrite the new revision');
    f.layout('sized', 280, 108, 2); assert.equal(window.bounds.width, 280); assert.equal(window.bounds.height, 108);
    f.report({ token: 'sized', type: 'started' }); assert.equal(f.started.length, 1, 'Remeasurement must never replay a line or double-commit');
  } finally { f.controller.dispose(); }
});

test('text-only bubbles start their lifetime after prepared and finish immediately without audio subtitle hold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const result = await f.controller.showText({ id: 'pet-head', text: '嗯……这样就很好。' }, { token: 'head' });
    assert.deepEqual(result, { ok: true, token: 'head' });
    const window = f.windows[0], payload = window.sent.find(([name]) => name === 'speech:play')[1];
    assert.equal(payload.textOnly, true); assert.equal(payload.line.audioUrl, undefined); assert.equal(payload.kind, 'interaction');
    assert.equal(window.isVisible(), false); assert.equal(f.controller.setVolume(.5), false);
    t.mock.timers.tick(4000); assert.equal(f.finished.length, 0, 'Layout preparation is not part of the display lifetime');
    f.layout('head', 250, 80, 1, false);
    t.mock.timers.tick(1000); assert.equal(f.started.length, 0);
    f.report({ token: 'head', type: 'prepared', revision: 1 });
    assert.deepEqual(f.started, [{ token: 'head', lineId: 'pet-head', kind: 'interaction' }]);
    assert.equal(window.isVisible(), true); assert.equal(f.controller.getState().playing, true);
    t.mock.timers.tick(3000);
    f.report({ token: 'head', type: 'prepared', revision: 1 });
    f.report({ token: 'head', type: 'started' }); f.report({ token: 'head', type: 'ended' });
    assert.equal(f.started.length, 1); assert.equal(f.finished.length, 0, 'Text-only completion belongs to the host timer');
    t.mock.timers.tick(200);
    assert.deepEqual(f.finished, [{ token: 'head', lineId: 'pet-head', kind: 'interaction', status: 'ended' }]);
    assert.equal(window.isVisible(), false); assert.equal(f.controller.getState().token, null);
    t.mock.timers.tick(30000); assert.equal(f.finished.length, 1);
  } finally { f.controller.dispose(); }
});

test('text duration, replacement, stop and dispose cannot end a newer audio or text request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.controller.showText({ id: 'poke', text: '再戳我可要生气啦。' }, { token: 'poke', kind: 'poke', duration: 1000 });
    f.layout('poke'); t.mock.timers.tick(900);
    await f.controller.play(line('01-1'), { token: 'audio' }); f.layout('audio');
    f.report({ token: 'audio', type: 'started' });
    t.mock.timers.tick(500);
    f.report({ token: 'poke', type: 'prepared', revision: 1 }); f.report({ token: 'poke', type: 'ended' });
    assert.equal(f.controller.getState().token, 'audio'); assert.equal(f.controller.getState().visible, true);
    assert.equal(f.finished[0].status, 'replaced');
    await f.controller.showText({ id: 'head', text: '好啦，再陪我一会儿吧。' }, { token: 'head', duration: 500 });
    f.layout('head'); t.mock.timers.tick(499); assert.equal(f.controller.getState().token, 'head');
    t.mock.timers.tick(1); assert.equal(f.controller.getState().token, null); assert.equal(f.finished.at(-1).status, 'ended');
    await f.controller.showText({ id: 'stop', text: '你好呀。' }, { token: 'stop', duration: 500 }); f.layout('stop');
    f.controller.stop(); const count = f.finished.length; t.mock.timers.tick(30000);
    assert.equal(f.finished.length, count); assert.equal(f.controller.getState().visible, false);
    await f.controller.showText({ id: 'dispose', text: '下次见。' }, { token: 'dispose' }); f.layout('dispose');
    f.controller.dispose(); const disposedCount = f.finished.length; t.mock.timers.tick(30000);
    assert.equal(f.finished.length, disposedCount); assert.equal(f.controller.getWindow(), null);
    assert.equal((await f.controller.showText({ id: 'late', text: '你好。' })).ok, false);
  } finally { f.controller.dispose(); }
});

test('text-only pending first-load replacement accepts only the newest layout', async () => {
  const f = fixture({ deferred: true });
  try {
    const first = f.controller.showText({ id: 'old', text: '你好。' }, { token: 'old' });
    const second = f.controller.showText({ id: 'new', text: '再陪我一会儿吧。' }, { token: 'new' });
    f.release(); assert.equal((await first).ok, false); assert.equal((await second).ok, true);
    f.layout('old'); assert.equal(f.started.length, 0); assert.equal(f.controller.getState().visible, false);
    f.layout('new'); assert.equal(f.started.length, 1); assert.equal(f.started[0].token, 'new');
    f.controller.stop(); f.layout('new'); assert.equal(f.started.length, 1); assert.equal(f.controller.getState().visible, false);
  } finally { f.controller.dispose(); }
});

test('renderer prepares text-only layout without constructing Audio and retains ordinary audio playback', async () => {
  const callbacks = {}, layouts = [], reports = [], audio = [];
  const elements = {
    '#speech': { dataset: {}, style: {} }, '#tail': { style: {} },
    '#line': { style: {}, textContent: '', getBoundingClientRect() {
      const font = parseFloat(this.style.fontSize) || 16, natural = this.textContent.length * font;
      const width = this.style.width === 'max-content' ? natural : parseFloat(this.style.width) || 300;
      return { width, height: Math.max(1, Math.ceil(natural / width)) * font * 1.75 };
    } },
  };
  const bridge = { layout: value => layouts.push(value), report: value => reports.push(value) };
  for (const name of ['Play', 'Stop', 'Volume', 'Placement', 'Error', 'Measure', 'LayoutReady']) bridge[`on${name}`] = callback => { callbacks[name] = callback; };
  class FakeAudio {
    constructor(url) { this.url = url; this.plays = 0; this.pauses = 0; audio.push(this); }
    addEventListener() {} removeAttribute() {} load() {}
    pause() { this.pauses++; } play() { this.plays++; return Promise.resolve(); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'speech.mjs'), 'utf8'), {
    window: { elysiaSpeech: bridge, addEventListener() {} },
    document: { querySelector: selector => elements[selector], fonts: { ready: Promise.resolve() }, documentElement: { dataset: {} } },
    Audio: FakeAudio, requestAnimationFrame: callback => queueMicrotask(callback),
  });
  await callbacks.Play({ token: 'text', textOnly: true, line: { id: 'head', text: '嗯，这样也不错。' }, revision: 1, maxWidth: 430, maxHeight: 180 });
  assert.equal(audio.length, 0); assert.equal(layouts.length, 1);
  await callbacks.LayoutReady({ token: 'text', revision: 1, width: 260, height: 80, side: 'right', tailY: 40 });
  assert.equal(reports.at(-1).type, 'prepared'); assert.equal(audio.length, 0);
  callbacks.Volume({ token: 'text', volume: .5 }); callbacks.Stop({ token: 'text' });
  await callbacks.Play({ token: 'audio', line: line('01-1'), volume: .8, revision: 1, maxWidth: 430, maxHeight: 180 });
  assert.equal(audio.length, 1); assert.equal(audio[0].url, 'file:///audio/01-1.wav'); assert.equal(audio[0].plays, 0);
  await callbacks.LayoutReady({ token: 'text', revision: 1 }); assert.equal(audio[0].plays, 0);
  await callbacks.LayoutReady({ token: 'audio', revision: 1, width: 320, height: 108, side: 'left', tailY: 54 });
  assert.equal(audio[0].plays, 1);
  callbacks.Volume({ token: 'audio', volume: .3 }); assert.equal(audio[0].volume, .3);
  callbacks.Stop({ token: 'audio' }); assert.equal(audio[0].pauses, 1);
});

test('actual audio start during monitor reflow is committed once instead of lost behind layoutReady', async () => {
  const f = fixture();
  try {
    await f.controller.play(line('01-1'), { token: 'moving' }); f.layout('moving');
    f.monitors([{ bounds: { x: 0, y: 0, width: 300, height: 200 }, workArea: { x: 0, y: 0, width: 300, height: 180 } }]);
    f.controller.reposition();
    f.report({ token: 'moving', type: 'started' });
    assert.equal(f.started.length, 1, 'Audio already started while its bubble is being remeasured');
    assert.equal(f.controller.getState().playing, true);
    f.layout('moving', 280, 108, 2); f.report({ token: 'moving', type: 'started' });
    assert.equal(f.started.length, 1);
  } finally { f.controller.dispose(); }
});

test('a late process-gone callback from a closed speech window cannot finish its replacement', async () => {
  const f = fixture();
  try {
    await f.controller.play(line('01-1'), { token: 'old-window' }); const old = f.windows[0]; old.destroy();
    await f.controller.play(line('01-2'), { token: 'new-window' }); f.layout('new-window');
    f.report({ token: 'new-window', type: 'started' }); const count = f.finished.length;
    old.webContents.emit('render-process-gone');
    assert.equal(f.controller.getState().token, 'new-window'); assert.equal(f.finished.length, count);
    assert.equal(f.controller.getState().playing, true);
  } finally { f.controller.dispose(); }
});

test('a crash completion callback can request the next line without reusing the crashed window', async () => {
  let replacement;
  const f = fixture({ finishCallback: event => {
    if (event.token === 'crashing' && event.status === 'error') replacement = f.controller.play(line('01-2'), { token: 'replacement' });
  } });
  try {
    await f.controller.play(line('01-1'), { token: 'crashing' }); const old = f.windows[0];
    old.webContents.emit('render-process-gone'); assert.equal((await replacement).ok, true);
    assert.equal(f.windows.length, 2); assert.equal(old.isDestroyed(), true); assert.equal(f.windows[1].isDestroyed(), false);
    f.layout('replacement'); f.report({ token: 'replacement', type: 'started' });
    assert.equal(f.controller.getState().token, 'replacement'); assert.equal(f.controller.getState().playing, true);
  } finally { f.controller.dispose(); }
});

test('audio completion is reported before its 1200ms subtitle hold and a next line cancels that hold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  try {
    await f.controller.play(line('01-1'), { token: 'first' }); f.layout('first'); f.report({ token: 'first', type: 'started' });
    f.report({ token: 'first', type: 'ended' });
    assert.equal(f.finished.length, 1); assert.equal(f.finished[0].status, 'ended');
    assert.equal(f.controller.getState().token, null); assert.equal(f.controller.getState().visible, true);
    t.mock.timers.tick(1199); assert.equal(f.controller.getState().visible, true);
    t.mock.timers.tick(1); assert.equal(f.controller.getState().visible, false);
    await f.controller.play(line('01-2'), { token: 'second' }); f.layout('second'); f.report({ token: 'second', type: 'started' });
    f.report({ token: 'second', type: 'ended' }); t.mock.timers.tick(600);
    await f.controller.play(line('01-3'), { token: 'third' }); f.layout('third'); f.report({ token: 'third', type: 'started' });
    t.mock.timers.tick(1000); f.report({ token: 'second', type: 'ended' });
    assert.equal(f.controller.getState().token, 'third'); assert.equal(f.controller.getState().visible, true);
    assert.equal(f.finished.length, 2);
  } finally { f.controller.dispose(); }
});

function rendererRaceFixture({ waitForFonts = false } = {}) {
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const fonts = deferred(), callbacks = {}, windowEvents = {}, layouts = [], reports = [], audio = [], frames = [];
  const elements = {
    '#speech': { dataset: {}, style: {} }, '#tail': { style: {} },
    '#line': { style: {}, textContent: '', getBoundingClientRect() {
      const font = parseFloat(this.style.fontSize) || 16, natural = this.textContent.length * font;
      const width = this.style.width === 'max-content' ? natural : parseFloat(this.style.width) || 300;
      return { width, height: Math.max(1, Math.ceil(natural / width)) * font * 1.75 };
    } },
  };
  const bridge = { layout: value => layouts.push(value), report: value => reports.push(value) };
  for (const name of ['Play', 'Stop', 'Volume', 'Placement', 'Error', 'Measure', 'LayoutReady']) bridge[`on${name}`] = callback => { callbacks[name] = callback; };
  class DeferredAudio {
    constructor(url) { this.src = url; this.paused = true; this.plays = 0; this.loads = 0; this.listeners = new Map(); this.pending = []; audio.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    emit(name) { const callback = this.listeners.get(name); this.listeners.delete(name); callback?.(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.loads++; this.paused = true; }
    pause() { this.paused = true; }
    play() { this.plays++; this.paused = false; const pending = deferred(); this.pending.push(pending); return pending.promise; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'speech.mjs'), 'utf8'), {
    window: { elysiaSpeech: bridge, addEventListener: (name, callback) => { windowEvents[name] = callback; } },
    document: { querySelector: selector => elements[selector], fonts: { ready: fonts.promise }, documentElement: { dataset: {} } },
    Audio: DeferredAudio, requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
  });
  if (!waitForFonts) fonts.resolve();
  return { callbacks, windowEvents, layouts, reports, audio, elements, fonts,
    play: token => callbacks.Play({ token, line: line('01-1'), volume: .8, revision: 1, maxWidth: 430, maxHeight: 180 }),
    ready: token => callbacks.LayoutReady({ token, revision: 1, width: 320, height: 108, side: 'left', tailY: 54 }),
    async frame() { for (const callback of frames.splice(0)) callback(); await Promise.resolve(); },
    audible: () => audio.filter(value => !value.paused && value.src).length,
  };
}

test('renderer stop during font loading or animation-frame preparation never calls stale Audio.play', async () => {
  const f = rendererRaceFixture({ waitForFonts: true });
  const oldLoad = f.play('old'); f.callbacks.Stop({ token: 'old' });
  const nextLoad = f.play('next'); f.fonts.resolve(); await Promise.all([oldLoad, nextLoad]);
  assert.deepEqual(f.layouts.map(value => value.token), ['next']);
  assert.equal(f.audio[0].src, ''); assert.equal(f.audio[0].paused, true);
  const ready = f.ready('next'); f.callbacks.Stop({ token: 'next' }); await f.frame(); await ready;
  assert.equal(f.audio[1].plays, 0); assert.equal(f.audible(), 0); assert.equal(f.reports.length, 0);
});

test('renderer replacement clears the old media source before the next play and ignores its late promise/events', async () => {
  const f = rendererRaceFixture(); await f.play('old');
  const oldReady = f.ready('old'); await f.frame(); assert.equal(f.audible(), 1);
  const old = f.audio[0]; await f.play('new');
  assert.equal(old.paused, true); assert.equal(old.src, ''); assert.equal(old.loads, 1); assert.equal(f.audible(), 0);
  const nextReady = f.ready('new'); await f.frame(); assert.equal(f.audible(), 1);
  const next = f.audio[1]; old.pending[0].resolve(); await oldReady;
  for (const event of ['playing', 'ended', 'error']) old.emit(event);
  f.callbacks.Stop({ token: 'old' }); f.callbacks.Error({ token: 'old' }); f.callbacks.Volume({ token: 'old', volume: 0 });
  assert.equal(f.audible(), 1); assert.equal(next.volume, .8); assert.equal(next.plays, 1);
  assert.equal(f.reports.some(value => value.token === 'old' && value.type !== 'prepared'), false);
  next.emit('playing'); assert.equal(f.reports.at(-1).token, 'new'); assert.equal(f.reports.at(-1).type, 'started');
  f.callbacks.Stop({ token: 'new' }); next.pending[0].reject(new Error('late play interruption')); await nextReady;
  assert.equal(f.audible(), 0); assert.equal(f.reports.some(value => value.type === 'error'), false);
});

test('pagehide fully clears a pending audio and its late callbacks cannot restart or report it', async () => {
  const f = rendererRaceFixture(); await f.play('closing'); const ready = f.ready('closing'); await f.frame();
  const audio = f.audio[0]; f.windowEvents.pagehide();
  assert.equal(audio.src, ''); assert.equal(audio.paused, true); assert.equal(f.audible(), 0);
  audio.pending[0].resolve(); await ready;
  for (const event of ['playing', 'ended', 'error']) audio.emit(event);
  assert.equal(f.reports.filter(value => value.type !== 'prepared').length, 0);
  assert.equal(f.elements['#speech'].dataset.layout, 'pending');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createVoiceEngine } = require('../electron/voice-engine.cjs');
const interaction = require('../electron/interaction-replies.cjs');
const { createQuickChatController } = require('../electron/quick-chat-controller.cjs');

// Both controllers are real. Native windows, persistence, model inference and
// audio are replaced, so these lifecycle tests never touch a user's profile.
function fixture(t, { readAloud = true } = {}) {
  const environment = { now: Date.now(), locked: false, suspended: false, fullscreen: false, monitorReady: true, idleSeconds: 0 };
  const captions = [], spoken = [], timers = new Map();
  let speechHooks, environmentHooks, active = null, nextTimer = 0, quitCount = 0, audioBusy = false, elapsed = 0;
  const finish = (record = active, status = 'ended') => {
    if (!record) return;
    if (record === active) active = null;
    speechHooks.onFinished({ token: record.token, lineId: record.line.id, kind: record.kind, status });
  };
  const captionWindow = {
    showText(line, options) {
      active = { line, ...options }; captions.push(active);
      speechHooks.onStarted({ token: active.token, lineId: line.id, kind: options.kind });
      return Promise.resolve({ ok: true });
    },
    stop: (reason = 'stopped') => finish(active, reason),
    dispose() { this.stop(); }, setVolume() {}, reposition() {}, getWindow: () => null,
  };
  const entry = path.resolve(__dirname, '../electron/voice-controller.cjs'), module = { exports: {} };
  const assetSet = { available: false, error: null, lines: new Map(), catalog: [], allowedUrls: new Set() };
  const timer = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(entry), console, Date,
    setTimeout: timer, setInterval: timer, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:perf_hooks') return require(name);
      if (name === 'node:util') return require(name);
      if (name === 'node:fs') return { readFileSync() { throw Object.assign(new Error('synthetic empty profile'), { code: 'ENOENT' }); }, mkdirSync() {}, writeFileSync() {}, renameSync() {} };
      if (name === './voice-engine.cjs') return { createVoiceEngine };
      if (name === './interaction-replies.cjs') return interaction;
      if (name === './voice-assets.cjs') return { loadVoiceAssets: () => assetSet, loadInteractionAssets: () => assetSet };
      if (name === './speech-window.cjs') return { createSpeechWindow: options => { speechHooks = options; return captionWindow; } };
      if (name === './voice-environment.cjs') return { createVoiceEnvironment: options => {
        environmentHooks = options; return { sample: () => ({ ...environment }), dispose() {} };
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: entry });
  let speech;
  const voices = module.exports.createVoiceController({ root: path.resolve(__dirname, '..'), userData: path.resolve('synthetic-quick-voice'),
    getCharacterBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), getPreferences: () => ({}), isSmokeTest: true,
    publish() { if (audioBusy && (environment.locked || environment.suspended)) speech.stop(); }, quit: () => { quitCount++; }, clock: () => elapsed });
  speech = {
    start(text, reference) {
      if (!readAloud || environment.locked || environment.suspended) return false;
      spoken.push({ text, reference }); audioBusy = true; voices.setExternalSpeechBusy(true); return true;
    },
    stop() { audioBusy = false; voices.setExternalSpeechBusy(false); }, warmup() {},
  };
  const conversation = { id: 'conversation', messages: [] };
  const state = { busy: false, error: null, storageError: null, settings: { readAloud }, activeConversationId: conversation.id, conversations: [conversation] };
  let messageId = 0;
  const chat = {
    getState: () => state,
    send(text) {
      conversation.messages.push({ id: `u${++messageId}`, role: 'user', content: text, status: 'complete' },
        { id: `a${++messageId}`, role: 'assistant', content: '', status: 'streaming' });
      state.busy = true; return state;
    },
    cancel() { state.busy = false; },
  };
  const quick = createQuickChatController({ chat, voices, speech, window: { publish() {}, hide() {}, open: async () => ({}) } });
  async function complete(lines) {
    const first = conversation.messages.at(-1);
    first.content = lines[0]; first.status = 'complete';
    for (const content of lines.slice(1)) conversation.messages.push({ id: `a${++messageId}`, role: 'assistant', content, status: 'complete' });
    state.busy = false;
    assert.equal(quick.completed({ conversationId: conversation.id, messageId: first.id, text: lines.join('\n') }), true);
    await flush();
  }
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  t.after(() => { quick.dispose(); speech.stop(); voices.dispose(); });
  return { quick, voices, captions, spoken, environment, complete, finish, flush, speech,
    get audioBusy() { return audioBusy; }, get quitCount() { return quitCount; },
    advance(milliseconds) { elapsed += milliseconds; environment.now += milliseconds; },
    block(reason) { environment[reason] = true; environmentHooks.onBlocked(reason); } };
}

test('shared TTS ownership preserves each caption until it ends, then advances exactly once', async t => {
  const f = fixture(t); await f.quick.send('聊一会儿吧'); await f.complete(['第一句。', '第二句！', '第三句。']);
  assert.equal(f.audioBusy, true); assert.equal(f.spoken.length, 1);
  assert.deepEqual(f.captions.map(item => item.line.text), ['第一句。']);
  const first = f.captions[0]; f.finish(first); await f.flush();
  assert.deepEqual(f.captions.map(item => item.line.text), ['第一句。', '第二句！']);
  f.finish(first); await f.flush(); assert.equal(f.captions.length, 2, 'late completion cannot advance a newer token');
  f.finish(f.captions[1], 'skipped'); await f.flush();
  assert.deepEqual(f.captions.map(item => item.line.text), ['第一句。', '第二句！', '第三句。']);
  f.finish(); await f.flush(); assert.equal(f.voices.getState().playback.status, 'idle');
  assert.equal(f.spoken.length, 1); assert.equal(f.voices.getState().externalSpeechBusy, true);
});

test('captions remain available when automatic read-aloud is off', async t => {
  const f = fixture(t, { readAloud: false }); await f.quick.send('你好'); await f.complete(['你好呀。', '今天想聊什么？']);
  assert.equal(f.audioBusy, false); assert.equal(f.spoken.length, 0);
  assert.equal(f.captions.length, 1); f.finish(); await f.flush(); assert.equal(f.captions.length, 2);
});

test('lock or suspend stops caption and audio, and unlocking never resurrects queued sentences', async t => {
  for (const reason of ['locked', 'suspended']) await t.test(reason, async t => {
    const f = fixture(t); await f.quick.send('睡前聊两句'); await f.complete(['第一句。', '不该重新出现。']);
    f.block(reason); await f.flush();
    assert.equal(f.audioBusy, false); assert.equal(f.voices.getState().playback.status, 'idle');
    f.environment[reason] = false; f.finish(f.captions[0]); await f.flush();
    assert.equal(f.captions.length, 1);
  });
});

test('cancel and a new quick question cannot revive sentences from a replaced answer', async t => {
  const f = fixture(t); await f.quick.send('旧问题'); await f.complete(['旧的第一句。', '旧的第二句。']);
  const old = f.captions[0]; f.quick.cancel(); await f.flush();
  assert.equal(f.audioBusy, false); assert.equal(f.captions.length, 1);
  await f.quick.send('新问题'); await f.complete(['新的回答。']);
  f.finish(old); await f.flush(); assert.deepEqual(f.captions.map(item => item.line.text), ['旧的第一句。', '新的回答。']);
  assert.equal(f.voices.getState().playback.text, '新的回答。');
});

test('normal quick-controller disposal settles the visible caption before voice disposal', async t => {
  const f = fixture(t); await f.quick.send('准备退出'); await f.complete(['第一句。', '不再出现。']);
  f.quick.dispose(); f.speech.stop(); f.voices.dispose(); await f.flush();
  f.finish(f.captions[0]); await f.flush();
  assert.equal(f.captions.length, 1); assert.equal(f.audioBusy, false);
});

test('voice disposal itself settles an outstanding chat caption promise', async t => {
  const f = fixture(t); let outcome = null;
  f.voices.showChatText('关闭中的气泡。', 'outstanding', 4200).then(value => { outcome = value; });
  f.voices.dispose(); await f.flush();
  assert.equal(outcome, 'stopped', 'disposing must settle the waiter even without a separate quick-controller interrupt');
});

// Verify lazy speech ownership and segment backpressure without Python, model files, or audio devices.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createChatSpeech, wavDuration, getChatSpeechBlockReason } = require('../electron/chat-speech.cjs');

function wav(seconds = .02) {
  const rate = 16000, dataSize = Math.round(seconds * rate) * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}
const audio = () => ({ type: 'audio', mime: 'audio/wav', base64: wav().toString('base64') });
function fixture(t, overrides = {}) {
  const gates = { enabled: true, open: true, allowed: true }, children = [], paths = [], played = [], stopped = [], claimed = [], changed = [], spawns = [];
  let spawnError = false, filesAvailable = true;
  const options = {
    root: path.resolve('fake-pet-root'), projectRoot: path.resolve('fake-elysia-project'),
    isEnabled: () => gates.enabled, isWindowOpen: () => gates.open, canSpeak: () => gates.allowed, volume: () => .42,
    exists: filename => { paths.push(filename); return filesAvailable; },
    sendAudio: packet => played.push(packet), stopAudio: packet => stopped.push(packet),
    claimAudio: busy => claimed.push(busy), onChange: snapshot => changed.push(snapshot),
    spawnImpl: (...args) => {
      spawns.push(args); if (spawnError) throw new Error('private runtime path');
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = value => { child.encoding = value; };
      child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.writes = [];
      child.stdin.write = text => { child.writes.push(JSON.parse(text)); return true; };
      child.killCount = 0; child.kill = () => { child.killCount++; return true; };
      child.packet = packet => child.stdout.emit('data', JSON.stringify(packet) + '\n');
      children.push(child); return child;
    },
    ...overrides,
  };
  const controller = createChatSpeech(options);
  t.after(() => controller.dispose());
  return { controller, gates, children, paths, played, stopped, claimed, changed, spawns,
    set spawnError(value) { spawnError = value; }, set filesAvailable(value) { filesAvailable = value; } };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'controller should settle promptly');
}

test('default-off, closed-window and denied-speech paths never even probe model files or spawn a worker', t => {
  const defaultOff = fixture(t, { isEnabled: undefined });
  assert.deepEqual(defaultOff.controller.getState(), { status: 'idle', error: null, messageId: null, emotion: null, cached: false });
  assert.equal(defaultOff.controller.start('回答'), false);
  defaultOff.controller.stop();
  assert.equal(defaultOff.paths.length, 0); assert.equal(defaultOff.spawns.length, 0);
  for (const gate of ['enabled', 'open', 'allowed']) {
    const f = fixture(t); f.gates[gate] = false;
    assert.equal(f.controller.start('回答'), false);
    assert.equal(f.paths.length, 0); assert.equal(f.spawns.length, 0); assert.deepEqual(f.claimed, []);
  }
});

test('an enabled idle controller never starts anything until a new valid reply is supplied', t => {
  const f = fixture(t);
  for (const text of [null, undefined, {}, '', '  ', 'x'.repeat(16001)]) assert.equal(f.controller.start(text), false);
  f.controller.getState(); f.controller.stop();
  assert.equal(f.paths.length, 0); assert.equal(f.spawns.length, 0);
  assert.equal(f.controller.start('可以读出的回答'), true);
  assert.equal(f.spawns.length, 1); assert.equal(f.paths.length, 3); assert.equal(f.controller.isActive(), true);
  const [python, args, options] = f.spawns[0];
  assert.equal(path.basename(python), 'python.exe'); assert.equal(args[0], '-u'); assert.equal(args[2], '--project-root');
  assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.env.PYTHONPATH, undefined); assert.equal(options.env.PYTHONHOME, undefined);
  assert.equal(options.env.PYTHONUTF8, '1'); assert.equal(f.children[0].encoding, 'utf8');
  assert.deepEqual(f.children[0].writes, [{ type: 'speak', text: '可以读出的回答' }]);
  assert.deepEqual(f.claimed, [true]);
});

test('valid WAV segments wait for matching ended acknowledgements before asking the worker for the next segment', t => {
  const f = fixture(t); f.controller.start('第一句。第二句。'); const child = f.children[0];
  child.packet({ type: 'starting' }); child.packet({ type: 'synthesizing' });
  const line = JSON.stringify(audio()) + '\n'; child.stdout.emit('data', line.slice(0, 23)); child.stdout.emit('data', line.slice(23));
  assert.equal(f.played.length, 1); assert.equal(f.controller.getState().status, 'playing');
  const first = f.played[0]; assert.equal(first.mime, 'audio/wav'); assert.equal(first.volume, .42); assert.equal(typeof first.token, 'string');
  assert.equal(child.writes.length, 1, 'No next request before playback completes');
  for (const report of [null, {}, { token: 'forged', type: 'ended' }, { token: first.token, type: 'other' }]) assert.equal(f.controller.report(report), false);
  assert.equal(f.controller.report({ token: first.token, type: 'started' }), true);
  assert.equal(child.writes.length, 1);
  assert.equal(f.controller.report({ token: first.token, type: 'ended' }), true);
  assert.deepEqual(child.writes.at(-1), { type: 'next' }); assert.equal(f.controller.getState().status, 'synthesizing');
  assert.equal(f.controller.report({ token: first.token, type: 'ended' }), false, 'Duplicate ended cannot advance twice');
  child.packet(audio()); const second = f.played[1]; assert.notEqual(second.token, first.token);
  assert.equal(f.controller.report({ token: first.token, type: 'error' }), false, 'Old segment cannot stop new playback');
  assert.equal(f.controller.report({ token: second.token, type: 'ended' }), true);
  assert.equal(child.writes.filter(item => item.type === 'next').length, 2);
  child.packet({ type: 'done' }); child.emit('close', 0);
  assert.equal(f.controller.isActive(), false); assert.deepEqual(f.controller.getState(), { status: 'idle', error: null, messageId: null, emotion: null, cached: false });
  assert.equal(child.killCount, 0, 'A clean exited worker is not killed again'); assert.deepEqual(f.claimed, [true, false]);
});

test('stop terminates only its child, stops renderer audio, releases ownership, and ignores late packets and tokens', t => {
  const f = fixture(t); f.controller.start('旧回答'); const old = f.children[0]; old.packet(audio()); const token = f.played[0].token;
  f.controller.stop();
  assert.equal(old.killCount, 1); assert.deepEqual(f.stopped.at(-1), { token }); assert.deepEqual(f.claimed, [true, false]);
  old.packet(audio()); old.packet({ type: 'done' }); old.emit('error', new Error('late')); old.emit('close', 1);
  assert.equal(f.played.length, 1); assert.equal(f.controller.report({ token, type: 'ended' }), false);
  assert.deepEqual(f.controller.getState(), { status: 'idle', error: null, messageId: null, emotion: null, cached: false });
  f.controller.start('新回答'); const current = f.children[1]; current.packet(audio());
  old.packet(audio()); old.emit('close', 0); assert.equal(current.killCount, 0); assert.equal(f.controller.isActive(), true);
  assert.equal(f.controller.report({ token, type: 'error' }), false);
  assert.equal(f.played.length, 2); assert.equal(old.killCount, 1);
  f.controller.stop(); assert.equal(current.killCount, 1); assert.equal(old.killCount, 1);
  f.controller.stop(); assert.equal(current.killCount, 1, 'Stopping twice is idempotent');
});

test('a replacement reply stops its predecessor before spawning and cannot overlap two audio segments', t => {
  const f = fixture(t); f.controller.start('第一条回答'); const first = f.children[0]; first.packet(audio());
  f.controller.start('第二条回答'); const second = f.children[1];
  assert.equal(first.killCount, 1); assert.deepEqual(f.claimed, [true, false, true]);
  second.packet(audio()); const sent = f.played.length;
  second.packet(audio());
  assert.equal(f.played.length, sent, 'The second unacknowledged segment must not reach the audio element');
  assert.equal(second.killCount, 1); assert.equal(f.controller.isActive(), false); assert.equal(f.controller.getState().status, 'error');
});

test('late audio rechecks the enabled, window and speech-permission gates before playback', t => {
  for (const gate of ['enabled', 'open', 'allowed']) {
    const f = fixture(t); f.controller.start('等待合成'); const child = f.children[0]; f.gates[gate] = false;
    child.packet(audio());
    assert.equal(f.played.length, 0); assert.equal(child.killCount, 1); assert.equal(f.controller.isActive(), false);
    assert.deepEqual(f.claimed, [true, false]);
  }
});

test('invalid WAV, protocol errors and audio playback failure terminate the job but leave future replies usable', t => {
  const invalidPackets = [
    { type: 'audio', mime: 'audio/wav', base64: Buffer.from('not a wav').toString('base64') },
    { type: 'audio', mime: 'audio/mp3', base64: wav().toString('base64') },
    { type: 'audio', mime: 'audio/wav', base64: '$$invalid$$' },
    { type: 'unknown' },
  ];
  for (const packet of invalidPackets) {
    const f = fixture(t); f.controller.start('失败'); const child = f.children[0]; child.packet(packet);
    assert.equal(f.played.length, 0); assert.equal(f.controller.getState().status, 'error'); assert.equal(child.killCount, 1);
    assert.equal(f.controller.start('重试'), true); assert.equal(f.controller.getState().status, 'starting');
    const retry = f.children[1]; retry.packet(audio()); assert.equal(f.played.length, 1);
    assert.equal(f.controller.report({ token: f.played[0].token, type: 'error' }), true);
    assert.equal(retry.killCount, 1); assert.match(f.controller.getState().error, /无法播放/);
  }
});

test('worker spawn, runtime, stdin and unexpected-exit failures release ownership and are recoverable', t => {
  const absent = fixture(t); absent.filesAvailable = false;
  assert.equal(absent.controller.start('回答'), false); assert.equal(absent.spawns.length, 0); assert.equal(absent.controller.getState().status, 'error');
  absent.filesAvailable = true; assert.equal(absent.controller.start('重试'), true);
  const thrown = fixture(t); thrown.spawnError = true;
  assert.equal(thrown.controller.start('回答'), false); assert.equal(thrown.controller.getState().status, 'error'); assert.deepEqual(thrown.claimed, [true, false]);
  thrown.spawnError = false; assert.equal(thrown.controller.start('重试'), true);
  for (const failure of ['process', 'stdin', 'close-zero', 'close-error', 'runtime']) {
    const f = fixture(t); f.controller.start('失败'); const child = f.children[0];
    if (failure === 'process') child.emit('error', new Error('PRIVATE diagnostic'));
    if (failure === 'stdin') child.stdin.emit('error', new Error('PRIVATE diagnostic'));
    if (failure === 'close-zero') child.emit('close', 0);
    if (failure === 'close-error') child.emit('close', 1);
    if (failure === 'runtime') child.packet({ type: 'error', code: 'runtime_unavailable', detail: 'PRIVATE diagnostic' });
    assert.equal(f.controller.isActive(), false); assert.equal(f.controller.getState().status, 'error');
    assert.doesNotMatch(f.controller.getState().error, /PRIVATE/); assert.deepEqual(f.claimed, [true, false]);
    assert.equal(f.controller.start('重试'), true); assert.equal(f.controller.getState().status, 'starting');
  }
});

test('worker timeout stops this child and a later reply can start cleanly', async t => {
  const f = fixture(t, { timeoutMs: 15 }); f.controller.start('没有返回音频'); const old = f.children[0];
  await waitFor(() => f.controller.getState().status === 'error');
  assert.match(f.controller.getState().error, /超时/); assert.equal(old.killCount, 1); assert.equal(f.controller.isActive(), false);
  old.packet(audio()); assert.equal(f.played.length, 0);
  assert.equal(f.controller.start('重试'), true); assert.equal(f.children.length, 2); f.controller.stop();
});

test('dispose stops owned playback and prevents all subsequent starts and file probes', t => {
  const f = fixture(t); f.controller.start('回答'); const child = f.children[0]; child.packet(audio());
  f.controller.dispose(); const before = { paths: f.paths.length, spawns: f.spawns.length, played: f.played.length };
  assert.equal(child.killCount, 1); assert.equal(f.controller.isActive(), false);
  assert.equal(f.controller.start('不能再启动'), false); child.packet(audio());
  assert.deepEqual({ paths: f.paths.length, spawns: f.spawns.length, played: f.played.length }, before);
});

test('WAV duration rejects truncated chunks, empty data and unreasonably long playback', () => {
  assert.equal(wavDuration(wav()), .02);
  for (const bytes of [Buffer.alloc(44), wav().subarray(0, 45), wav(0), wav(181)]) assert.throws(() => wavDuration(bytes));
});

function finish(f, child, emotion = 'neutral') {
  child.packet({ ...audio(), emotion });
  f.controller.report({ token: f.played.at(-1).token, type: 'ended' });
  child.packet({ type: 'done' });
}

test('warmup is gated, silent, reused by later requests, and stop preserves the idle worker', t => {
  const f = fixture(t); f.gates.enabled = false;
  assert.equal(f.controller.warmup(), false); assert.equal(f.paths.length, 0);
  f.gates.enabled = true;
  assert.equal(f.controller.warmup(), true); const child = f.children[0];
  assert.deepEqual(child.writes, [{ type: 'warmup' }]); assert.deepEqual(f.claimed, []);
  assert.equal(f.controller.getState().status, 'warming');
  f.controller.stop(); assert.equal(child.killCount, 0);
  child.packet({ type: 'ready', emotion: 'neutral' });
  assert.equal(f.controller.getState().status, 'ready'); assert.equal(f.controller.isActive(), false);
  f.controller.warmup(); assert.equal(child.writes.length, 1);
  assert.equal(f.controller.start('第一条回答', { messageId: 'reply-1' }), true);
  assert.equal(f.children.length, 1); finish(f, child);
  assert.equal(f.controller.getState().status, 'ready'); assert.equal(child.killCount, 0);
  f.controller.stop(); f.controller.start('第二条回答');
  assert.equal(f.children.length, 1); assert.equal(child.writes.filter(packet => packet.type === 'speak').length, 2);
});

test('manual speech bypasses only auto-read preference and reports the selected message and emotion', t => {
  const f = fixture(t); f.gates.enabled = false;
  assert.equal(f.controller.start('自动回答'), false);
  assert.equal(f.controller.speak('手动回答', { messageId: 'reply-7' }), true);
  f.children[0].packet({ ...audio(), emotion: 'caring' });
  assert.equal(f.controller.getState().messageId, 'reply-7'); assert.equal(f.controller.getState().emotion, 'caring');
  assert.equal(f.played[0].messageId, 'reply-7'); assert.equal(f.played[0].emotion, 'caring');
  f.controller.release();
  for (const gate of ['open', 'allowed']) {
    f.gates[gate] = false; const before = f.children.length;
    assert.equal(f.controller.speak('受限回答'), false); assert.equal(f.children.length, before);
    f.gates[gate] = true;
  }
});

function voiceSnapshot() {
  return { settings: { dnd: false, volume: .8 },
    environment: { monitorReady: true, locked: false, suspended: false, fullscreen: false } };
}

test('manual refusal explains the current cause without file probes or stale worker errors', t => {
  const voice = voiceSnapshot();
  const f = fixture(t, { getBlockReason: manual => getChatSpeechBlockReason(voice, { manual }) });
  f.controller.speak('先前的请求');
  f.children[0].packet({ type: 'error', code: 'runtime_unavailable' });
  const before = { probes: f.paths.length, workers: f.children.length };
  const cases = [
    [voice.settings, 'dnd', true, /勿扰已开启/],
    [voice.settings, 'volume', 0, /音量为 0/],
    [voice.environment, 'locked', true, /锁屏/],
    [voice.environment, 'suspended', true, /休眠/],
    [voice.environment, 'monitorReady', false, /屏幕状态检测尚未就绪/],
  ];
  for (const [object, field, value, message] of cases) {
    const previous = object[field]; object[field] = value;
    assert.equal(f.controller.speak('重试同一条回复'), false);
    assert.match(f.controller.getState().error, message);
    assert.deepEqual({ probes: f.paths.length, workers: f.children.length }, before);
    object[field] = previous;
  }
  for (const [text, message] of [['  ', /没有需要朗读/], ['x'.repeat(16001), /过长/]]) {
    assert.equal(f.controller.speak(text), false); assert.match(f.controller.getState().error, message);
  }
  f.gates.open = false;
  assert.equal(f.controller.speak('关闭的聊天'), false); assert.match(f.controller.getState().error, /打开聊天窗口/);
  f.gates.open = true;
  assert.equal(f.controller.speak('状态恢复后可以重试'), true);
  assert.equal(f.controller.getState().error, null);
});

test('explicit reading survives a stale BUSY sample on first click and later foreground switches', t => {
  const voice = voiceSnapshot(); voice.environment.fullscreen = true;
  let controller;
  const f = fixture(t, {
    isEnabled: () => false,
    getBlockReason: manual => getChatSpeechBlockReason(voice, { manual }),
    // Match the synchronous main-process publication when audio ownership changes.
    claimAudio: () => controller.refreshPermission(),
  });
  controller = f.controller;
  assert.equal(controller.speak('刚从其他程序切回聊天后点击朗读'), true);
  const child = f.children[0];
  voice.environment.fullscreen = false; controller.refreshPermission();
  voice.environment.fullscreen = true; controller.refreshPermission();
  assert.equal(child.killCount, 0, 'Passive notification suppression must not cancel explicit synthesis');
  child.packet(audio());
  assert.equal(f.played.length, 1, 'The late playback gate must retain the manual request intent');
  controller.report({ token: f.played[0].token, type: 'ended' });
  child.packet(audio());
  assert.equal(f.played.length, 2);
  voice.settings.dnd = true; controller.refreshPermission(); controller.refreshPermission();
  assert.equal(child.killCount, 1, 'DND still stops explicit playback exactly once');
  assert.equal(controller.isActive(), false);
  const played = f.played.length; child.packet(audio());
  assert.equal(f.played.length, played);
});

test('automatic warmup and reading retain BUSY protection while manual playback retains hard blocks', t => {
  const voice = voiceSnapshot(); voice.environment.fullscreen = true;
  const f = fixture(t, { getBlockReason: manual => getChatSpeechBlockReason(voice, { manual }) });
  assert.equal(f.controller.warmup(), false); assert.equal(f.controller.start('自动回复'), false);
  assert.equal(f.paths.length, 0); assert.equal(f.controller.getState().error, null);
  voice.environment.fullscreen = false;
  assert.equal(f.controller.start('可以自动朗读'), true); const auto = f.children[0];
  voice.environment.fullscreen = true; f.controller.refreshPermission();
  assert.equal(auto.killCount, 1); auto.packet(audio()); assert.equal(f.played.length, 0);

  for (const [object, field, value] of [
    [voice.settings, 'dnd', true], [voice.settings, 'volume', 0],
    [voice.environment, 'locked', true], [voice.environment, 'suspended', true],
    [voice.environment, 'monitorReady', false],
  ]) {
    assert.equal(f.controller.speak('手动开始后状态改变'), true);
    const child = f.children.at(-1), previous = object[field]; object[field] = value;
    f.controller.refreshPermission();
    assert.equal(child.killCount, 1); assert.equal(f.controller.isActive(), false);
    object[field] = previous;
  }
  assert.match(getChatSpeechBlockReason(undefined, { manual: true }), /语音状态尚未就绪/);
  voice.environment.monitorReady = false;
  assert.match(getChatSpeechBlockReason(voice, { manual: true }), /屏幕状态检测/,
    'An unready monitor must not be reported as fullscreen even though its sample sets fullscreen too');
});

test('a hard block published while claiming audio cannot revive the cancelled manual job', t => {
  const voice = voiceSnapshot(), claims = [];
  let controller;
  const f = fixture(t, {
    getBlockReason: manual => getChatSpeechBlockReason(voice, { manual }),
    claimAudio: claimed => {
      claims.push(claimed);
      if (claimed) voice.settings.dnd = true;
      controller.refreshPermission();
    },
  });
  controller = f.controller;
  assert.equal(controller.speak('请求与勿扰状态同时改变'), false);
  assert.match(controller.getState().error, /勿扰已开启/);
  assert.deepEqual(claims, [true, false]);
  assert.equal(f.children.length, 0); assert.equal(f.paths.length, 0);
  assert.equal(controller.isActive(), false);
});

test('complete replies replay from bounded cache without inference and keep per-segment acknowledgement', async t => {
  const f = fixture(t); f.controller.start('可重复回答'); const child = f.children[0];
  child.packet({ ...audio(), emotion: 'happy' }); f.controller.report({ token: f.played.at(-1).token, type: 'ended' });
  child.packet({ ...audio(), emotion: 'happy' }); f.controller.report({ token: f.played.at(-1).token, type: 'ended' });
  child.packet({ type: 'done' }); f.controller.release(); f.gates.enabled = false;
  const writes = child.writes.length;
  assert.equal(f.controller.speak('可重复回答', { messageId: 'same-text-new-message' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 1); assert.equal(child.writes.length, writes);
  assert.equal(f.played.length, 3); assert.equal(f.controller.getState().cached, true);
  assert.equal(f.controller.getState().messageId, 'same-text-new-message');
  const token = f.played.at(-1).token;
  f.controller.report({ token, type: 'ended' }); assert.equal(f.played.length, 4);
  assert.equal(f.controller.report({ token, type: 'ended' }), false);
  f.controller.report({ token: f.played.at(-1).token, type: 'ended' });
  assert.equal(f.controller.isActive(), false); assert.equal(f.controller.getState().status, 'idle');
  f.controller.clearCache(); assert.equal(f.controller.speak('可重复回答'), true); assert.equal(f.children.length, 2);
});

test('cache limits evict older replies and never cache cancelled or oversized audio', t => {
  const f = fixture(t, { maxCacheEntries: 1 });
  f.controller.start('旧回答'); const child = f.children[0]; finish(f, child);
  f.controller.start('新回答'); finish(f, child);
  f.controller.start('旧回答'); assert.equal(child.writes.filter(packet => packet.type === 'speak').length, 3);
  child.packet(audio()); f.controller.stop(); f.controller.start('旧回答');
  assert.equal(f.children.length, 2);
  const small = fixture(t, { maxCacheBytes: 1 });
  small.controller.start('过大回答'); finish(small, small.children[0]); small.controller.start('过大回答');
  assert.equal(small.children[0].writes.filter(packet => packet.type === 'speak').length, 2);
});

test('release is reentrant and idempotent even if voice publication calls release again', t => {
  let controller; const claims = [];
  const f = fixture(t, { claimAudio: value => { claims.push(value); if (!value) controller.release(); } });
  controller = f.controller;
  controller.release(); assert.deepEqual(claims, []); assert.equal(f.changed.length, 0);
  controller.start('会停止的回答'); f.children[0].packet(audio());
  controller.release(); controller.release();
  assert.deepEqual(claims, [true, false]); assert.equal(f.children[0].killCount, 1); assert.equal(f.stopped.length, 1);
  assert.equal(controller.getState().status, 'idle');
});

test('idle workers release promptly and changed project roots cannot reuse old runtimes or audio', async t => {
  let project = path.resolve('first-project');
  const f = fixture(t, { idleTimeoutMs: 15, getProjectRoot: () => project });
  f.controller.warmup(); f.children[0].packet({ type: 'ready' });
  await waitFor(() => f.children[0].killCount === 1);
  assert.equal(f.controller.getState().status, 'idle');
  f.controller.start('同样文字'); finish(f, f.children[1]);
  project = path.resolve('second-project'); f.controller.start('同样文字');
  assert.equal(f.children.length, 3); assert.equal(f.children[1].killCount, 1);
  assert.equal(f.spawns.at(-1)[2].cwd, project);
});

test('embedded Python is preferred but an existing source project can keep its venv', t => {
  const f = fixture(t); f.controller.start('安装的环境');
  assert.equal(path.basename(path.dirname(f.spawns[0][0])), 'python');
  const legacy = fixture(t, { exists: filename => !filename.endsWith(path.join('python', 'python.exe')) });
  legacy.controller.start('原来的环境');
  assert.ok(legacy.spawns[0][0].endsWith(path.join('.venv', 'Scripts', 'python.exe')));
});

test('unsolicited done cannot fabricate a complete cached answer', t => {
  const f = fixture(t); f.controller.start('没有音频'); f.children[0].packet({ type: 'done' });
  assert.equal(f.controller.getState().status, 'error'); assert.equal(f.children[0].killCount, 1);
  f.controller.start('没有音频'); assert.equal(f.children.length, 2);
});

test('Python helpers keep comfort and negation out of happy and bound the first audio segment', t => {
  const { spawnSync } = require('node:child_process');
  const script = [
    'import importlib.util,sys',
    'sys.dont_write_bytecode=True',
    "spec=importlib.util.spec_from_file_location('pettts',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "available={'neutral','happy','sad','caring','serious','moved'}",
    "assert m._select_emotion('不是开心，我很难过。',available)=='sad'",
    "assert m._select_emotion('你很难过，我会陪着你，慢慢来。',available)=='caring'",
    "assert m._select_emotion('恭喜你，真为你高兴！',available)=='happy'",
    "assert m._select_emotion('好消息，但也有让我难过的事情。',available)=='neutral'",
    "assert m._select_emotion('真开心！',{'neutral','sad'})=='neutral'",
    "assert m._select_emotion('你好！！！',available)=='neutral'",
    "assert m._select_emotion('我并不是很开心。',available)!='happy'",
    "assert m._select_emotion('请立即远离危险，安全第一。',available)=='serious'",
    "assert m._segments(chr(96)*3+'python\\nprint(1)\\n'+chr(96)*3)==[]",
    "parts=m._segments('你好'*170); assert 0<len(parts[0])<=70 and all(len(p)<=150 for p in parts)",
    "import io; from dataclasses import dataclass; from types import SimpleNamespace",
    "@dataclass\nclass Selection:\n speed_factor: float = 1.0",
    "owners=[]; lifecycle=[]",
    "class Runtime:\n def __init__(self,c): pass\n def acquire_lease(self,selection):\n  assert not owners, 'Source runtime admits exactly one owner'; owners.append(self); lifecycle.append('acquire'); return SimpleNamespace(close=lambda:lifecycle.append('close'))\n def shutdown(self):\n  owners.remove(self); lifecycle.append('shutdown')",
    "session=object.__new__(m._SpeechSession); session.output=io.StringIO(); session.pool={}; session.capacity=1; session.runtime_factory=Runtime; session.config=None; session.wait_cleanup=lambda seconds:not owners; session.catalog=SimpleNamespace(resolve_selection=lambda profile,emotion:Selection()); session.profile_id='test'; session.speed=1.0",
    "first=session.lease('neutral'); assert session.lease('neutral') is first; assert lifecycle==['acquire']",
    "session.lease('sad'); assert lifecycle==['acquire','close','shutdown','acquire']; assert len(owners)==1",
    "session.close(); assert not owners and not session.pool",
  ].join('\n');
  const result = spawnSync('python', ['-B', '-c', script, path.resolve(__dirname, '../electron/chat-tts-worker.py')], { encoding: 'utf8', windowsHide: true });
  if (result.error?.code === 'ENOENT') { t.skip('Python is optional for the desktop unit test suite'); return; }
  assert.equal(result.status, 0, result.stderr);
});

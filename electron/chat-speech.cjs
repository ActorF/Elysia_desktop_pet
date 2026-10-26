/** A lazy local TTS worker, bounded replay cache, and one acknowledged audio segment at a time. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const EMOTIONS = new Set(['neutral', 'happy', 'sad', 'caring', 'moved', 'playful', 'affectionate', 'teasing', 'serious', 'surprised']);

function getChatSpeechBlockReason(voice, { manual = false } = {}) {
  if (!voice?.settings || !voice.environment) return '语音状态尚未就绪，请稍后重试。';
  const { settings, environment } = voice;
  if (environment.locked) return '锁屏期间暂停朗读，请解锁后重试。';
  if (environment.suspended) return '休眠期间暂停朗读，请唤醒电脑后重试。';
  if (settings.dnd) return '勿扰已开启，请在“设置 → 语音”关闭勿扰后重试。';
  if (!(settings.volume > 0)) return '语音音量为 0，请在“设置 → 语音”调高音量后重试。';
  if (environment.monitorReady === false) return '屏幕状态检测尚未就绪，请稍后重试；若持续出现，请重新启动桌宠。';
  // An explicit playback request is not an unsolicited notification. The cached
  // screen sample may still describe the window that was focused before the click.
  if (!manual && environment.fullscreen) return '系统当前处于全屏、忙碌或演示状态，暂停自动朗读。';
  return null;
}

function wavDuration(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('audio');
  let rate = 0, data = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), tag = bytes.toString('ascii', offset, offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error('audio');
    if (tag === 'fmt ' && size >= 16) rate = bytes.readUInt32LE(offset + 16);
    if (tag === 'data') data += size;
    offset += 8 + size + (size % 2);
  }
  if (!rate || !data || data / rate > 180) throw new Error('audio');
  return data / rate;
}

function createChatSpeech({ root, projectRoot = 'D:\\Elysia_AI', getProjectRoot = () => projectRoot,
  isEnabled = () => false, isWindowOpen = () => false, canSpeak = () => true, volume = () => .8,
  getBlockReason = () => canSpeak() ? null : '当前语音状态不允许朗读，请稍后重试。',
  sendAudio = () => {}, stopAudio = () => {}, onChange = () => {}, claimAudio = () => {},
  spawnImpl = spawn, exists = fs.existsSync, timeoutMs = 600000, idleTimeoutMs = 45000,
  maxCacheEntries = 8, maxCacheBytes = 24 * 1024 * 1024 }) {
  let active = null, worker = null, disposed = false, idleTimer = null, claimed = false, cacheBytes = 0;
  let state = { status: 'idle', error: null, messageId: null, emotion: null, cached: false };
  const cache = new Map();
  const getState = () => ({ ...state });
  function status(value, extra = {}) {
    const next = { ...state, status: value, error: null, ...extra };
    if (Object.keys(next).every(key => next[key] === state[key])) return;
    state = next; if (!disposed) onChange(getState());
  }
  function claim(value) { if (claimed !== value) { claimed = value; claimAudio(value); } }
  function blockReason(manual) {
    if (disposed) return '朗读已关闭，请重新打开聊天窗口。';
    if (!manual && !isEnabled()) return '自动朗读已关闭。';
    if (!isWindowOpen()) return '请先打开聊天窗口再朗读。';
    return getBlockReason(manual);
  }
  const permitted = manual => !blockReason(manual);
  function currentProject() {
    const value = getProjectRoot();
    return typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;
  }
  function killWorker() {
    clearTimeout(idleTimer); idleTimer = null;
    const owner = worker; worker = null;
    if (!owner) return;
    clearTimeout(owner.deadline);
    // The bridge's non-inherited Kill-On-Close Job owns only its own model process tree.
    if (!owner.exited) { try { owner.child.kill(); } catch {} }
  }
  function discardActive() {
    const job = active; active = null;
    if (job) { clearTimeout(job.deadline); clearTimeout(job.audioTimer); stopAudio({ token: job.audioToken }); }
    claim(false);
  }
  function release() {
    killWorker(); discardActive();
    status('idle', { messageId: null, emotion: null, cached: false }); return getState();
  }
  function fail(error) {
    const messageId = active?.messageId ?? state.messageId;
    killWorker(); discardActive(); status('error', { error, messageId, cached: false });
  }
  function scheduleIdle() {
    clearTimeout(idleTimer); idleTimer = null;
    if (worker && !worker.warming && !active) {
      idleTimer = setTimeout(() => { if (!active) { killWorker(); status('idle', { messageId: null }); } }, idleTimeoutMs);
      idleTimer.unref?.();
    }
  }
  function stop(options = {}) {
    if (options.release) return release();
    // In-flight inference requires process cancellation; an idle model stays reusable.
    if (active?.source === 'worker') killWorker();
    discardActive(); status(worker?.warming ? 'warming' : worker ? 'ready' : 'idle', { messageId: null, emotion: null, cached: false });
    scheduleIdle(); return getState();
  }
  function refreshPermission() {
    // A completed manual request keeps its worker warm until the idle timeout.
    // Releasing audio ownership publishes voice state after active is cleared.
    const manual = active ? active.manual : worker?.manual === true;
    if ((active || worker) && !permitted(manual)) release();
    return getState();
  }
  function write(owner, packet) {
    if (owner !== worker || owner.exited) return false;
    try { owner.child.stdin.write(JSON.stringify(packet) + '\n'); return true; }
    catch { fail('本地朗读连接中断，文字回答已保留。'); return false; }
  }
  function cacheReply(job) {
    if (!job.cacheable || !job.clips.length || maxCacheEntries < 1 || job.bytes > maxCacheBytes) return;
    const previous = cache.get(job.key); if (previous) { cacheBytes -= previous.bytes; cache.delete(job.key); }
    cache.set(job.key, { clips: job.clips, bytes: job.bytes }); cacheBytes += job.bytes;
    while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
  }
  function finishReply(job) {
    if (active !== job) return;
    clearTimeout(job.deadline); clearTimeout(job.audioTimer);
    if (job.source === 'worker') cacheReply(job);
    active = null; claim(false);
    status(worker ? 'ready' : 'idle', { messageId: null, cached: false }); scheduleIdle();
  }
  function playClip(job, packet) {
    if (active !== job) return;
    if (!permitted(job.manual)) { release(); return; }
    if (job.audioToken || packet.mime !== 'audio/wav' || typeof packet.base64 !== 'string'
      || packet.base64.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.base64)) throw new Error('protocol');
    const duration = wavDuration(Buffer.from(packet.base64, 'base64'));
    const emotion = EMOTIONS.has(packet.emotion) ? packet.emotion : 'neutral';
    if (job.source === 'worker' && job.cacheable) {
      job.bytes += packet.base64.length * 2;
      if (job.bytes <= maxCacheBytes) job.clips.push({ mime: 'audio/wav', base64: packet.base64, emotion });
      else { job.clips = []; job.cacheable = false; }
    }
    job.audioToken = randomUUID();
    job.audioTimer = setTimeout(() => fail('朗读播放未完成，已停止本次语音。'), (duration + 15) * 1000);
    status('playing', { messageId: job.messageId, emotion, cached: job.source === 'cache' });
    sendAudio({ token: job.audioToken, base64: packet.base64, mime: 'audio/wav', volume: volume(), messageId: job.messageId, emotion });
  }
  function receive(owner, line) {
    if (!line.trim() || owner !== worker) return;
    const packet = JSON.parse(line);
    if (packet.type === 'starting') {
      status(active ? 'starting' : 'warming', { emotion: EMOTIONS.has(packet.emotion) ? packet.emotion : null }); return;
    }
    if (packet.type === 'ready') {
      owner.warming = false; clearTimeout(owner.deadline);
      if (!active) { status('ready', { emotion: EMOTIONS.has(packet.emotion) ? packet.emotion : 'neutral' }); scheduleIdle(); }
      return;
    }
    if (packet.type === 'error') {
      const messages = {
        assets_unavailable: '本地语音模型或参考音频不可用，请检查所选语音项目的配置。',
        runtime_unavailable: '本地语音环境暂不可用，请检查所选语音项目的运行环境。',
        no_speech: '这条回答没有需要朗读的文字。',
      };
      fail(messages[packet.code] || '本次朗读未能完成，文字回答已保留。'); return;
    }
    const job = active;
    if (!job || job.source !== 'worker') throw new Error('protocol');
    if (packet.type === 'synthesizing') { status('synthesizing', { emotion: EMOTIONS.has(packet.emotion) ? packet.emotion : 'neutral' }); return; }
    if (packet.type === 'done') {
      if (job.audioToken || !job.receivedAudio) throw new Error('protocol');
      owner.warming = false; clearTimeout(owner.deadline); finishReply(job); return;
    }
    if (packet.type !== 'audio') throw new Error('protocol');
    owner.warming = false; clearTimeout(owner.deadline); job.receivedAudio = true; playClip(job, packet);
  }
  function ensureWorker(project) {
    clearTimeout(idleTimer); idleTimer = null;
    if (worker?.project !== project) killWorker();
    if (worker) return worker;
    const embedded = path.join(project, 'python', 'python.exe');
    const python = exists(embedded) ? embedded : path.join(project, '.venv', 'Scripts', 'python.exe');
    const script = path.join(root.replace(/app\.asar$/i, 'app.asar.unpacked'), 'electron', 'chat-tts-worker.py');
    if (!exists(python) || !exists(script)) { fail('朗读暂不可用，请在设置中检查语音项目路径及其 Python 环境。'); return null; }
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    delete env.PYTHONPATH; delete env.PYTHONHOME;
    let child;
    try { child = spawnImpl(python, ['-u', script, '--project-root', project, '--parent-pid', String(process.pid)], { cwd: project, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { fail('无法启动本地朗读，请检查所选语音项目的环境。'); return null; }
    const owner = { child, project, buffer: '', exited: false, warming: true, manual: false, deadline: null };
    worker = owner;
    owner.deadline = setTimeout(() => { if (worker === owner) fail('本次朗读等待超时，文字回答已保留。'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (owner !== worker) return;
      owner.buffer += chunk;
      if (owner.buffer.length > 17 * 1024 * 1024) { fail('朗读返回的音频过大，已停止本次语音。'); return; }
      try {
        let newline;
        while ((newline = owner.buffer.indexOf('\n')) !== -1 && owner === worker) {
          const line = owner.buffer.slice(0, newline); owner.buffer = owner.buffer.slice(newline + 1); receive(owner, line);
        }
      } catch { fail('朗读返回了无效音频，文字回答已保留。'); }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { if (owner === worker) fail('本地朗读连接中断，文字回答已保留。'); });
    child.on('error', () => { if (owner === worker) fail('无法启动本地朗读，请检查所选语音项目的环境。'); });
    child.on('close', code => {
      owner.exited = true;
      if (owner !== worker) return;
      if (!active && !owner.warming && code === 0) { killWorker(); status('idle', { emotion: null }); }
      else fail('本地朗读意外结束，文字回答已保留。');
    });
    return owner;
  }
  function warmup() {
    if (!permitted(false) || active) return false;
    const project = currentProject();
    if (!project) { fail('请在设置中选择有效的语音项目路径。'); return false; }
    if (worker?.project === project) { worker.manual = false; scheduleIdle(); return true; }
    const owner = ensureWorker(project); if (!owner) return false;
    status('warming', { messageId: null, cached: false }); return write(owner, { type: 'warmup' });
  }
  function start(text, options = {}) {
    const manual = options.manual === true;
    if (disposed) return false;
    const blocked = blockReason(manual);
    if (blocked) { if (manual) fail(blocked); return false; }
    if (typeof text !== 'string' || !text.trim()) {
      if (manual) fail('这条回答没有需要朗读的文字。');
      return false;
    }
    if (text.length > 16000) {
      if (manual) fail('这条回答过长，暂时无法朗读。');
      return false;
    }
    const project = currentProject();
    if (!project) { fail('请在设置中选择有效的语音项目路径。'); return false; }
    stop(); clearTimeout(idleTimer); idleTimer = null;
    const key = project.toLowerCase() + '\n' + text, cached = cache.get(key);
    const messageId = typeof options.messageId === 'string' && options.messageId.length <= 100 ? options.messageId : null;
    const job = { source: cached ? 'cache' : 'worker', key, manual, messageId, clips: [], bytes: 0,
      cacheable: true, receivedAudio: false, audioToken: null, audioTimer: null, deadline: null, cachedClips: cached?.clips, index: 0 };
    active = job; claim(true);
    // Claiming audio publishes the latest voice state synchronously. A newly
    // applied DND/lock may release this job before a worker has been created.
    if (active !== job) {
      if (manual) fail(blockReason(manual) || '朗读已停止，请重试。');
      return false;
    }
    status('starting', { messageId, emotion: null, cached: Boolean(cached) });
    job.deadline = setTimeout(() => { if (active === job) fail('本次朗读等待超时，文字回答已保留。'); }, timeoutMs);
    if (cached) {
      cache.delete(key); cache.set(key, cached);
      queueMicrotask(() => { if (active === job) { try { playClip(job, cached.clips[0]); } catch { fail('朗读缓存无效，请重新生成语音。'); } } });
      return true;
    }
    const owner = ensureWorker(project); if (!owner) return false;
    owner.manual = manual;
    return write(owner, { type: 'speak', text });
  }
  function report(event) {
    const job = active;
    if (!job || !event || typeof event !== 'object' || !job.audioToken || event.token !== job.audioToken) return false;
    if (event.type === 'error') { fail('无法播放朗读音频，文字回答已保留。'); return true; }
    if (event.type === 'started') return true;
    if (event.type !== 'ended') return false;
    clearTimeout(job.audioTimer); job.audioTimer = null; job.audioToken = null;
    if (job.source === 'cache') {
      job.index++;
      if (job.index < job.cachedClips.length) playClip(job, job.cachedClips[job.index]);
      else finishReply(job);
    } else { status('synthesizing'); if (worker) write(worker, { type: 'next' }); }
    return true;
  }
  function clearCache() { release(); cache.clear(); cacheBytes = 0; }
  function dispose() { clearCache(); disposed = true; }
  return { getState, start, speak: (text, options = {}) => start(text, { ...options, manual: true }), warmup,
    stop, release, refreshPermission, clearCache, report, dispose, isActive: () => active !== null || worker?.warming === true };
}
module.exports = { createChatSpeech, wavDuration, getChatSpeechBlockReason };

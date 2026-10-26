/** Real, silent llama.cpp + TTS coexistence and restart check. Never downloads or opens a window. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createModelSetup, SETUP_BASE_URL } = require('../electron/model-setup.cjs');
const { createChatService } = require('../electron/chat-service.cjs');
const { createChatSpeech, getChatSpeechBlockReason, wavDuration } = require('../electron/chat-speech.cjs');

const root = path.resolve(__dirname, '..');
const userData = process.env.ELYSIA_CHAT_USER_DATA;
assert.ok(userData && path.isAbsolute(userData), 'Set ELYSIA_CHAT_USER_DATA to the profile containing prepared chat-runtime and chat-models.');
assert.equal(process.platform, 'win32', 'This native check requires Windows.');
const voiceProject = process.env.ELYSIA_VOICE_PROJECT_ROOT || path.join(userData, 'voice-runtime');
const directory = path.join(root, 'artifacts', 'chat-runtime-check', String(Date.now()));
fs.mkdirSync(directory, { recursive: true });
const reportPath = path.join(directory, 'report.json');
const started = Date.now(), children = [], owned = new Map(), events = [], requests = [], clips = [];
const report = { passed: false, playedAudio: false, syntheticConversation: true, downloaded: false,
  userHistoryUnchanged: false, timings: {}, replies: [], clips, requests, processes: [], cleanup: [], events };
let stage = 'prepare', setup = null, chat = null, speech = null, interrupted = false;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function note(value) {
  const event = { stage, elapsedMs: Date.now() - started, ...value }; events.push(event);
  fs.appendFileSync(path.join(directory, 'progress.jsonl'), JSON.stringify(event) + '\n');
  console.log(JSON.stringify(event));
}
function profileDigest() {
  const file = path.join(userData, 'chat-state.json');
  return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}
const initialProfileDigest = profileDigest();
function inventory() {
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize | ConvertTo-Json -Compress'],
  { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(output); return Array.isArray(result) ? result : [result];
}
function collectOwned(records = inventory()) {
  // Retain creation times so cleanup never confuses a reused PID with our child.
  const ids = new Set(children.filter(item => !item.exited).map(item => item.pid));
  for (const item of records) if (owned.get(item.ProcessId)?.created === item.CreationDate) ids.add(item.ProcessId);
  let size;
  do {
    size = ids.size;
    for (const item of records) if (ids.has(item.ParentProcessId)) ids.add(item.ProcessId);
  } while (ids.size !== size);
  const found = records.filter(item => ids.has(item.ProcessId));
  for (const item of found) owned.set(item.ProcessId, {
    pid: item.ProcessId, parentPid: item.ParentProcessId, name: item.Name,
    created: item.CreationDate, workingSetBytes: Number(item.WorkingSetSize),
  });
  return found;
}
function trackedSpawn(kind) {
  return (executable, args, options) => {
    const child = spawn(executable, args, options);
    const record = { kind, pid: child.pid, executable, args, windowsHide: options.windowsHide === true, exited: false, exitCode: null };
    if (options.env?.ELYSIA_CHAT_SERVER) {
      record.managedServer = { executable: options.env.ELYSIA_CHAT_SERVER, args: options.env.ELYSIA_CHAT_ARGS };
    }
    children.push(record);
    Object.defineProperty(record, 'child', { value: child });
    child.once('exit', code => { record.exited = true; record.exitCode = code; });
    child.once('error', () => { record.exited = true; });
    return child;
  };
}
async function localFetch(url, options) {
  const target = new URL(url);
  assert.equal(target.origin, SETUP_BASE_URL, 'This check must not contact a remote download host or another local model service.');
  assert.ok(['/health', '/v1/models', '/v1/chat/completions'].includes(target.pathname), 'Unexpected model route');
  requests.push({ stage, method: options?.method || 'GET', path: target.pathname });
  return fetch(url, options);
}
async function until(label, predicate, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let nextSample = 0;
  while (!predicate()) {
    if (interrupted) throw new Error('Verification interrupted');
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    if (Date.now() >= nextSample) { collectOwned(); nextSample = Date.now() + 1000; }
    await delay(100);
  }
  collectOwned();
}
function createSetup(name) {
  return createModelSetup({ userData, fetchImpl: localFetch, spawnImpl: trackedSpawn(name),
    onChange: state => note({ setupPhase: state.phase, busy: state.busy, error: state.error }) });
}
async function startInstalled(name) {
  stage = name; const mark = Date.now(); setup = createSetup(name);
  assert.equal(setup.ensureInstalledServer().ok, true);
  await until(name, () => !setup.getState().busy);
  const state = setup.getState();
  assert.equal(state.phase, 'ready', state.error || state.message);
  assert.equal(state.serverReady, true); assert.equal(state.runtimeReady, true); assert.equal(state.modelReady, true);
  report.timings[name] = Date.now() - mark;
  note({ ready: true, durationMs: report.timings[name] });
}
async function cleanup(name) {
  collectOwned();
  speech?.dispose(); speech = null; chat?.dispose(); chat = null; setup?.dispose(); setup = null;
  const deadline = Date.now() + 15000;
  let remaining = [];
  do {
    const live = inventory();
    remaining = live.filter(item => owned.get(item.ProcessId)?.created === item.CreationDate);
    if (!remaining.length) break;
    await delay(150);
  } while (Date.now() < deadline);
  const forcedPids = remaining.map(item => item.ProcessId);
  // An unexpected orphan fails the check, but terminate only its verified owned
  // process identity so a failed verification cannot leave a large model loaded.
  for (const item of remaining) { try { process.kill(item.ProcessId); } catch {} }
  if (remaining.length) {
    await delay(1000);
    remaining = inventory().filter(item => owned.get(item.ProcessId)?.created === item.CreationDate);
  }
  report.cleanup.push({ name, forcedPids, remainingPids: remaining.map(item => item.ProcessId) });
  assert.deepEqual(remaining, [], 'Owned native processes must exit after disposal');
  assert.deepEqual(forcedPids, [], 'Production disposal must clean up its children without test-harness intervention');
}
function waveProperties(bytes) {
  const properties = { bytes: bytes.length, durationSeconds: wavDuration(bytes) };
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ' && length >= 16) {
      Object.assign(properties, { format: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12), bitsPerSample: bytes.readUInt16LE(offset + 22) });
      break;
    }
    offset += 8 + length + length % 2;
  }
  return properties;
}
async function main() {
  await startInstalled('first-start');
  stage = 'chat'; const chatStart = Date.now();
  chat = createChatService({ directory: path.join(directory, 'synthetic-history'), fetchImpl: localFetch });
  const configured = chat.setSettings({ username: '测试旅人' }); assert.equal(configured.storageError, null);
  assert.equal(chat.send('请用一句简短中文和我打招呼，提到今天一起吃草莓蛋糕。不要描述动作。').busy, true);
  await until('Chinese reply', () => !chat.getState().busy);
  const chatState = chat.getState(); assert.equal(chatState.error, null); assert.equal(chatState.storageError, null);
  const reply = chatState.conversations.find(item => item.id === chatState.activeConversationId).messages.at(-1);
  assert.equal(reply.status, 'complete'); assert.match(reply.content, /[\u3400-\u9fff]/); assert.doesNotMatch(reply.content, /<think>/i);
  report.replies.push({ request: 'synthetic greeting and strawberry cake', text: reply.content });
  report.timings.chatMs = Date.now() - chatStart; note({ replyComplete: true, durationMs: report.timings.chatMs });

  stage = 'simultaneous-tts'; const speechStart = Date.now();
  const voice = { settings: { dnd: false, volume: .8 },
    environment: { locked: false, suspended: false, monitorReady: true, fullscreen: true } };
  speech = createChatSpeech({ root, projectRoot: voiceProject, isEnabled: () => false, isWindowOpen: () => true,
    spawnImpl: trackedSpawn('tts'), getBlockReason: manual => getChatSpeechBlockReason(voice, { manual }),
    claimAudio: () => speech?.refreshPermission(),
    onChange: state => note({ speechStatus: state.status, error: state.error }),
    sendAudio: packet => {
      const bytes = Buffer.from(packet.base64, 'base64');
      const file = path.join(directory, `speech-${clips.length + 1}.wav`);
      fs.writeFileSync(file, bytes);
      clips.push({ file, ...waveProperties(bytes), elapsedMs: Date.now() - speechStart });
      setImmediate(() => speech?.report({ token: packet.token, type: 'ended' }));
    },
  });
  assert.equal(speech.speak('你好，今天也一起加油吧。', { messageId: 'synthetic-runtime-check' }), true, speech.getState().error);
  speech.refreshPermission();
  await until('Silent speech synthesis beside the loaded chat model', () => !speech.isActive(), 600000);
  assert.equal(speech.getState().error, null); assert.ok(clips.length > 0);
  assert.ok(clips.every(clip => clip.durationSeconds > 0 && clip.sampleRate > 0));
  report.timings.speechMs = Date.now() - speechStart;
  const health = await localFetch(`${SETUP_BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.ok, true); assert.equal((await health.json()).status, 'ok');
  report.workingSetAfterSpeechBytes = collectOwned().reduce((sum, item) => sum + Number(item.WorkingSetSize), 0);
  report.manualSpeechDuringBusyScreen = true;
  note({ speechComplete: true, durationMs: report.timings.speechMs, clipCount: clips.length });

  stage = 'first-dispose'; await cleanup(stage); note({ noOrphans: true });
  await startInstalled('restart-from-disk');
  stage = 'restart-dispose'; await cleanup(stage); note({ noOrphans: true });
  assert.equal(profileDigest(), initialProfileDigest, 'The real user chat-state.json must remain byte-for-byte unchanged');
  report.userHistoryUnchanged = true; report.passed = true;
}
main().catch(error => { report.error = error.message; process.exitCode = 1; note({ failed: true, error: error.message }); })
  .finally(async () => {
    if (speech || chat || setup) {
      try { await cleanup('failure-dispose'); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; report.passed = false; }
    }
    report.userHistoryUnchanged = profileDigest() === initialProfileDigest;
    report.processes = children.map(item => ({ ...item })); report.ownedProcesses = [...owned.values()];
    report.elapsedMs = Date.now() - started;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, playedAudio: false, report: reportPath }));
  });

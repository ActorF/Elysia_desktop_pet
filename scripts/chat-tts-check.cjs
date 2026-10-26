/** Optional silent real TTS check: latency, emotion references, model reuse and exact-process cleanup. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createChatSpeech, wavDuration } = require('../electron/chat-speech.cjs');
const root = path.resolve(__dirname, '..');
const projectRoot = process.env.ELYSIA_VOICE_PROJECT_ROOT || 'D:\\Elysia_AI';
const directory = path.join(root, 'artifacts', 'chat-tts-check', 'controller-' + Date.now());
const events = [], clips = [], timings = [], children = [];
let enabled = false, stage = 'disabled', stageStart = Date.now(), helper = null;
const started = Date.now();
fs.mkdirSync(directory, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(50);
  assert.ok(predicate(), 'TTS check timed out in ' + stage);
}
function snapshot() {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(output); return Array.isArray(result) ? result : [result];
}
function descendants(pid, records = snapshot()) {
  const ids = new Set([pid]);
  let previous;
  do { previous = ids.size; for (const item of records) if (ids.has(item.ParentProcessId)) ids.add(item.ProcessId); } while (ids.size !== previous);
  return records.filter(item => ids.has(item.ProcessId) && item.ProcessId !== pid);
}
async function gone(ids) {
  const deadline = Date.now() + 15000;
  let remaining;
  do {
    const live = new Set(snapshot().map(item => item.ProcessId));
    remaining = ids.filter(id => live.has(id));
    if (!remaining.length) return;
    await delay(150);
  } while (Date.now() < deadline);
  assert.deepEqual(remaining, [], 'Owned TTS processes must not outlive their owner');
}
const speech = createChatSpeech({ root, projectRoot, idleTimeoutMs: 45000,
  isEnabled: () => enabled, isWindowOpen: () => true,
  spawnImpl: (...args) => { const child = spawn(...args); children.push(child); return child; },
  onChange: state => {
    const event = { ...state, stage, elapsedMs: Date.now() - started }; events.push(event);
    fs.appendFileSync(path.join(directory, 'progress.jsonl'), JSON.stringify(event) + '\n');
  },
  sendAudio: packet => {
    const bytes = Buffer.from(packet.base64, 'base64');
    fs.writeFileSync(path.join(directory, 'segment-' + (clips.length + 1) + '.wav'), bytes);
    clips.push({ stage, bytes: bytes.length, duration: wavDuration(bytes), emotion: packet.emotion,
      cached: speech.getState().cached, firstAudioMs: Date.now() - stageStart, elapsedMs: Date.now() - started });
    setImmediate(() => speech.report({ token: packet.token, type: 'ended' }));
  },
});
async function reply(name, text, { manual = false, emotion = 'neutral', cached = false } = {}) {
  stage = name; stageStart = Date.now(); const before = clips.length;
  assert.equal(manual ? speech.speak(text, { messageId: name }) : speech.start(text, { messageId: name }), true);
  await until(() => !speech.isActive());
  assert.equal(speech.getState().error, null, speech.getState().error || 'TTS failed');
  assert.ok(clips.length > before); assert.equal(clips[before].emotion, emotion); assert.equal(clips[before].cached, cached);
  timings.push({ stage, elapsedMs: Date.now() - stageStart, firstAudioMs: clips[before].firstAudioMs });
}
async function parentKillCheck() {
  stage = 'parent-kill'; let ready = false, failed = false;
  const code = [
    "const {createChatSpeech}=require(process.argv[1]);",
    "const s=createChatSpeech({root:process.argv[2],projectRoot:process.argv[3],isEnabled:()=>true,isWindowOpen:()=>true,",
    "onChange:state=>{if(state.status==='ready')process.stdout.write('ready\\n');if(state.error){process.stdout.write('error\\n');process.exitCode=1;s.dispose();}}});",
    "s.warmup();setInterval(()=>{},1000);",
  ].join('');
  helper = spawn(process.execPath, ['-e', code, path.join(root, 'electron', 'chat-speech.cjs'), root, projectRoot],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  helper.stdout.on('data', chunk => { const text = chunk.toString(); if (text.includes('ready')) ready = true; if (text.includes('error')) failed = true; });
  helper.stderr.on('data', () => {});
  helper.on('error', () => { failed = true; });
  await until(() => ready || failed); assert.equal(failed, false, 'Parent-kill fixture must load the model first');
  const owned = descendants(helper.pid).map(item => item.ProcessId);
  assert.ok(owned.length >= 2, 'Bridge and model must be real processes');
  const helperId = helper.pid; helper.kill(); helper = null;
  await gone([...owned, helperId]);
  return { passed: true, ownedProcesses: owned.length };
}
async function main() {
  assert.equal(speech.start('关闭时不能启动语音。'), false); assert.equal(speech.warmup(), false);
  assert.deepEqual(events, []); assert.equal(children.length, 0);
  enabled = true; stage = 'warmup'; stageStart = Date.now();
  assert.equal(speech.warmup(), true);
  await until(() => !speech.isActive());
  assert.equal(speech.getState().status, 'ready', speech.getState().error || 'Warmup failed');
  timings.push({ stage, elapsedMs: Date.now() - stageStart });
  const neutralText = '窗边的阳光很好。';
  await reply('warm-first', neutralText);
  await reply('warm-second', '今天我们继续聊聊。');
  assert.equal(children.length, 1, 'Fresh replies share the warm bridge');
  await reply('cached-replay', neutralText, { cached: true });
  await reply('sad-reference', '这件事让我很难过。', { emotion: 'sad' });
  const emotionProcesses = descendants(children[0].pid);
  const memoryBytes = emotionProcesses.reduce((total, item) => total + Number(item.WorkingSetSize), 0);
  await reply('comfort-reference', '辛苦了，慢慢来。', { emotion: 'caring' });
  const afterEviction = descendants(children[0].pid);
  assert.equal(afterEviction.length, emotionProcesses.length, 'Emotion changes must replace the lease rather than grow the pool');
  enabled = false;
  const ownedBeforeRelease = [children[0].pid, ...afterEviction.map(item => item.ProcessId)];
  speech.release(); await gone(ownedBeforeRelease);
  const spawnCount = children.length;
  assert.equal(speech.start('普通文字不能重启模型。'), false); assert.equal(speech.warmup(), false);
  assert.equal(children.length, spawnCount);
  await reply('manual-off-cached', neutralText, { manual: true, cached: true });
  assert.equal(children.length, spawnCount, 'Manual cached replay needs no Python process');
  speech.clearCache();
  stage = 'cancel-inference'; stageStart = Date.now();
  assert.equal(speech.speak('这是一段测试文字。'.repeat(12), { messageId: stage }), true);
  await until(() => speech.getState().status === 'synthesizing' || speech.getState().status === 'error');
  assert.equal(speech.getState().error, null);
  const current = children.at(-1), cancelledIds = [current.pid, ...descendants(current.pid).map(item => item.ProcessId)];
  speech.release(); await gone(cancelledIds);
  const parentKill = await parentKillCheck();
  const report = { passed: true, playedAudio: false, projectRoot, timings, clips, events,
    warmBridgeProcesses: 1, modelPoolProcesses: emotionProcesses.length, modelPoolWorkingSetBytes: memoryBytes,
    releaseNoOrphans: true, cancellationNoOrphans: true, parentKill };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, playedAudio: false, elapsedMs: Date.now() - started, timings,
    modelPoolProcesses: emotionProcesses.length, modelPoolWorkingSetBytes: memoryBytes,
    releaseNoOrphans: true, cancellationNoOrphans: true, parentKill, report: path.join(directory, 'report.json') }));
}
main().catch(error => {
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ passed: false, stage, error: error.message, timings, clips, events }, null, 2));
  console.error(JSON.stringify({ passed: false, stage, error: error.message, report: path.join(directory, 'report.json') })); process.exitCode = 1;
}).finally(() => {
  speech.dispose(); if (helper) helper.kill();
});

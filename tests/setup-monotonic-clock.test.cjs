'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createModelSetup } = require('../electron/model-setup.cjs');
const { createVoiceSetup } = require('../electron/voice-setup.cjs');
const originalManifest = require('../electron/chat-bootstrap-manifest.json');
const fixtureRoot = path.resolve(__dirname, '../artifacts/deep-audit-round2/monotonic-clock');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (root, name, bytes) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
function directory(t) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
  t.after(() => { const relative = path.relative(fixtureRoot, root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function chatResources(root, includeModel = false) {
  const manifest = structuredClone(originalManifest), bytes = Buffer.from('small pinned model fixture');
  manifest.model.bytes = bytes.length; manifest.model.sha256 = hash(bytes);
  const runtime = path.join(root, 'chat-runtime');
  for (const file of manifest.runtime.required) write(runtime, file, 'inert runtime');
  for (const file of manifest.runtimeDependencies.files) {
    const data = Buffer.from(`inert ${file.file}`); file.bytes = data.length; file.sha256 = hash(data); write(runtime, file.file, data);
  }
  write(runtime, 'elysia-runtime.json', JSON.stringify(manifest.runtime));
  if (includeModel) {
    const models = path.join(root, 'chat-models'); write(models, manifest.model.file, bytes);
    write(models, 'elysia-model.json', JSON.stringify({ ...manifest.model, modifiedAt: fs.statSync(path.join(models, manifest.model.file)).mtimeMs }));
  }
  return { manifest, bytes };
}
async function waitUntil(predicate, limit = 1000) {
  const deadline = performance.now() + limit;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  return predicate();
}
function stalledDownload(bytes, setWallClockBack) {
  let sent = false, release;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (sent) return new Promise(resolve => { release = resolve; });
      sent = true; setWallClockBack();
      await new Promise(resolve => setTimeout(resolve, 180));
      controller.enqueue(bytes.subarray(0, 4));
    },
    cancel() { release?.(); },
  }));
}

test('system clock rollback cannot extend the local model startup deadline', async t => {
  const root = directory(t), { manifest } = chatResources(root, true);
  let online = false, wall = Date.now(); const originalNow = Date.now; Date.now = () => wall;
  const service = createModelSetup({ userData: root, manifest, platform: 'win32', arch: 'x64', startTimeoutMs: 25, pollIntervalMs: 1,
    fetchImpl: async () => { if (!online) throw new Error('offline fixture'); wall -= 86400000; return new Response(null, { status: 503 }); },
    spawnImpl: (file, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('exit', 1)); return true; };
      if (options.env.ELYSIA_CHAT_SERVER) online = true;
      else queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); });
      return child;
    } });
  try {
    service.ensureInstalledServer();
    assert.equal(await waitUntil(() => !service.getState().busy, 2000), true, 'a 25 ms startup deadline must remain bounded after wall-clock rollback');
    assert.equal(service.getState().diagnostic?.code, 'RUN-204');
  } finally { Date.now = originalNow; service.dispose(); await waitUntil(() => !service.getState().busy); }
});

for (const kind of ['chat', 'voice']) test(`${kind} download progress keeps notifying after system clock rollback`, async t => {
  const root = directory(t), originalNow = Date.now;
  let wall = Date.now(), notified = false, service; Date.now = () => wall;
  const onChange = state => { if (state.busy && state.completedBytes > 0 && state.progress > 0) notified = true; };
  try {
    if (kind === 'chat') {
      const { manifest, bytes } = chatResources(root);
      service = createModelSetup({ userData: root, manifest, platform: 'win32', arch: 'x64', onChange,
        spawnImpl: () => assert.fail('progress fixture must never launch a model'),
        fetchImpl: async () => stalledDownload(bytes, () => { wall -= 86400000; }) });
      service.installChatModel();
    } else {
      const resources = path.join(root, 'resources'), executable = Buffer.from('inert extractor'), bytes = Buffer.from('small fixture asset bytes');
      write(resources, 'tools/7za.exe', executable);
      const item = (fileName, url) => ({ fileName, url, bytes: bytes.length, sha256: hash(bytes) });
      service = createVoiceSetup({ userData: path.join(root, 'data'), resourcesPath: resources, env: {}, onChange,
        manifest: { version: 1, extractor: { relativePath: 'tools/7za.exe', sha256: hash(executable) },
          assets: item('clock-fixture.zip', 'https://github.com/ActorF/Elysia_desktop_pet/releases/download/test/clock-fixture.zip'),
          runtime: item('clock-fixture.7z', 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/test/clock-fixture.7z') },
        spawnImpl: () => assert.fail('progress fixture must never launch an extractor'),
        fetchImpl: async () => stalledDownload(bytes, () => { wall -= 86400000; }) });
      service.install();
    }
    assert.equal(await waitUntil(() => notified, 2000), true, 'downloaded bytes must reach the renderer after the 150 ms throttle interval');
    assert.equal(service.getState().busy, true);
  } finally {
    Date.now = originalNow; service?.cancel();
    if (service) await waitUntil(() => !service.getState().busy);
    service?.dispose();
  }
});

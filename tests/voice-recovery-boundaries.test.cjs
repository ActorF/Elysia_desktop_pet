'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createVoiceSetup } = require('../electron/voice-setup.cjs');
const { REQUIRED } = require('../electron/voice-installation.cjs');

function fixture(t, beforeRepair) {
  const parent = path.resolve(__dirname, '../artifacts/deep-audit-round2/voice-recovery');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), userData = path.join(root, 'profile');
  const runtime = path.join(userData, 'voice-runtime'), stageName = `voice-staging-${randomUUID()}`;
  const stage = path.join(userData, stageName), replacement = path.join(stage, 'project'), journal = path.join(userData, 'voice-repair-transaction.json');
  const manifest = { version: 1, assets: { fileName: 'assets.zip', bytes: 1, sha256: 'a'.repeat(64) },
    runtime: { fileName: 'runtime.7z', bytes: 1, sha256: 'b'.repeat(64) }, extractor: { relativePath: 'tools/7za.exe', sha256: 'c'.repeat(64) } };
  fs.mkdirSync(runtime, { recursive: true }); fs.writeFileSync(path.join(runtime, 'keep'), 'old resources still used by the worker');
  for (const relative of REQUIRED) { const file = path.join(replacement, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'verified replacement'); }
  fs.writeFileSync(path.join(replacement, 'voice-setup-complete.json'), JSON.stringify({ version: 1,
    assets: manifest.assets.sha256, runtime: manifest.runtime.sha256, required: REQUIRED }));
  const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; };
  fs.writeFileSync(journal, JSON.stringify({ version: 1, kind: 'voice', id: randomUUID(), stage: stageName,
    root: identity(userData), stageIdentity: identity(stage), previous: identity(runtime), replacement: identity(replacement) }));
  const service = createVoiceSetup({ userData, manifest, beforeRepair,
    fetchImpl: () => assert.fail('recovery must not download'), spawnImpl: () => assert.fail('recovery must not extract') });
  t.after(() => { service.dispose(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runtime, stage, replacement, journal, service };
}
async function waitUntil(predicate) {
  for (let index = 0; index < 1000 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(predicate(), true);
}

for (const entry of ['repair', 'install']) test(`${entry} recovery waits for confirmed voice-worker release before moving either directory`, async t => {
  let called = 0, release;
  const f = fixture(t, () => { called++; return new Promise(resolve => { release = resolve; }); });
  f.service[entry]();
  try {
    await waitUntil(() => called > 0 || !f.service.getState().busy);
    assert.equal(called, 1);
    assert.equal(f.service.getState().busy, true);
    assert.equal(fs.readFileSync(path.join(f.runtime, 'keep'), 'utf8'), 'old resources still used by the worker');
    assert.equal(fs.existsSync(f.replacement), true); assert.equal(fs.existsSync(f.journal), true);
  } finally { release?.(); }
  await waitUntil(() => !f.service.getState().busy);
  assert.equal(f.service.getState().ready, true, JSON.stringify(f.service.getState())); assert.equal(fs.existsSync(f.journal), false);
});

test('refused worker release leaves a recoverable journal and both original resource trees untouched', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('worker has not exited'), { diagnosticKind: 'storage-busy' }); });
  const originalJournal = fs.readFileSync(f.journal);
  f.service.repair(); await waitUntil(() => !f.service.getState().busy);
  assert.equal(f.service.getState().phase, 'error');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep'), 'utf8'), 'old resources still used by the worker');
  assert.deepEqual(fs.readFileSync(f.journal), originalJournal); assert.equal(fs.existsSync(f.replacement), true);
});

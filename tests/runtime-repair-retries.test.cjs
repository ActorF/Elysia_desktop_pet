'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRuntimeRepair } = require('../electron/voice-repair.cjs');

const fixtureRoot = path.resolve(__dirname, '../artifacts/deep-audit-round2/repair-retries');
function fixture(t, kind) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const userData = fs.mkdtempSync(path.join(fixtureRoot, `${kind}-`));
  const runtime = path.join(userData, `${kind}-runtime`);
  const stage = kind === 'voice' ? path.join(userData, `voice-staging-${randomUUID()}`, 'project')
    : fs.mkdtempSync(path.join(userData, 'chat-staging-'));
  fs.mkdirSync(runtime); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'old'), 'retained old files');
  fs.writeFileSync(path.join(stage, 'new'), 'verified replacement');
  const oldIno = fs.statSync(runtime, { bigint: true }).ino, newIno = fs.statSync(stage, { bigint: true }).ino;
  const journal = path.join(userData, `${kind}-repair-transaction.json`);
  const create = (renameSync, verifyInstallation = file => fs.existsSync(path.join(file, 'new'))) => createRuntimeRepair({
    kind, userData, verifyInstallation, fsImpl: { ...fs, renameSync,
      copyFileSync() { assert.fail('replacement must not copy files'); },
      cpSync() { assert.fail('replacement must not copy directories'); },
      rmSync() { assert.fail('replacement must not delete directories'); } },
  });
  t.after(() => {
    const relative = path.relative(fixtureRoot, userData);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return { userData, runtime, stage, journal, oldIno, newIno, create };
}
const windows = { skip: process.platform !== 'win32' };

for (const kind of ['voice', 'chat']) {
  test(`${kind} transaction retries brief refusal of both directory moves without copying`, windows, async t => {
    const f = fixture(t, kind), attempts = new Map();
    const result = await f.create((source, destination) => {
      const count = (attempts.get(source) || 0) + 1; attempts.set(source, count);
      if (count === 1) throw Object.assign(new Error('brief refusal'), { code: 'EPERM' });
      fs.renameSync(source, destination);
    }).commit(f.stage);
    assert.equal(result.committed, true); assert.equal(attempts.get(f.runtime), 2); assert.equal(attempts.get(f.stage), 2);
    assert.equal(fs.statSync(f.runtime, { bigint: true }).ino, f.newIno);
    assert.equal(fs.statSync(result.backupDirectory, { bigint: true }).ino, f.oldIno);
    assert.equal(fs.existsSync(f.journal), false);
  });

  test(`${kind} rollback also retries brief directory refusal and preserves original identities`, windows, async t => {
    const f = fixture(t, kind), attempts = new Map();
    await assert.rejects(f.create((source, destination) => {
      const key = `${source}\0${destination}`, count = (attempts.get(key) || 0) + 1; attempts.set(key, count);
      if (count === 1) throw Object.assign(new Error('brief refusal'), { code: 'EBUSY' });
      fs.renameSync(source, destination);
    }, file => file !== f.runtime && fs.existsSync(path.join(file, 'new'))).commit(f.stage), error => error.rolledBack === true);
    assert.equal(attempts.size, 4); assert.ok([...attempts.values()].every(count => count === 2));
    assert.equal(fs.statSync(f.runtime, { bigint: true }).ino, f.oldIno);
    assert.equal(fs.statSync(f.stage, { bigint: true }).ino, f.newIno);
    assert.equal(fs.existsSync(f.journal), false);
  });

  test(`${kind} permanent refusal has bounded attempts then restores the old runtime`, windows, async t => {
    const f = fixture(t, kind); let attempts = 0;
    await assert.rejects(f.create((source, destination) => {
      if (source === f.stage) { attempts++; throw Object.assign(new Error('refusal'), { code: 'EACCES' }); }
      fs.renameSync(source, destination);
    }).commit(f.stage), error => error.rolledBack === true && error.diagnosticKind === 'storage-permission');
    assert.equal(attempts, 5); assert.equal(fs.statSync(f.runtime, { bigint: true }).ino, f.oldIno);
    assert.equal(fs.statSync(f.stage, { bigint: true }).ino, f.newIno); assert.equal(fs.existsSync(f.journal), false);
  });

  test(`${kind} refuses a new destination created during the retry delay and retains its transaction`, windows, async t => {
    const f = fixture(t, kind); let attempts = 0;
    await assert.rejects(f.create((source, destination) => {
      if (source === f.stage) {
        attempts++;
        setTimeout(() => { fs.mkdirSync(f.runtime); fs.writeFileSync(path.join(f.runtime, 'unrelated'), 'keep this'); }, 1);
        throw Object.assign(new Error('brief refusal'), { code: 'EPERM' });
      }
      fs.renameSync(source, destination);
    }).commit(f.stage), error => error.preserveStage === true && error.runtimeRepairPending === true);
    assert.equal(attempts, 1); assert.equal(fs.readFileSync(path.join(f.runtime, 'unrelated'), 'utf8'), 'keep this');
    assert.equal(fs.statSync(f.stage, { bigint: true }).ino, f.newIno); assert.equal(fs.existsSync(f.journal), true);
    const tx = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
    const backup = path.join(f.userData, `${kind}-runtime.${kind === 'voice' ? 'backup' : 'unverified'}-${tx.id}`);
    assert.equal(fs.statSync(backup, { bigint: true }).ino, f.oldIno);
  });

  test(`${kind} does not retry unrelated filesystem failures`, async t => {
    const f = fixture(t, kind); let attempts = 0;
    await assert.rejects(f.create((source, destination) => {
      if (source === f.stage) { attempts++; throw Object.assign(new Error('IO failure'), { code: 'EIO' }); }
      fs.renameSync(source, destination);
    }).commit(f.stage), error => error.rolledBack === true && error.diagnosticKind === 'storage-io');
    assert.equal(attempts, 1); assert.equal(fs.statSync(f.runtime, { bigint: true }).ino, f.oldIno);
  });
}

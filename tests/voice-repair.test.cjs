'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createVoiceRepair, createRuntimeRepair } = require('../electron/voice-repair.cjs');

const temporaryRoot = path.resolve(__dirname, '../artifacts/error-classification/temp/voice-repair');
const modulePath = path.resolve(__dirname, '../electron/voice-repair.cjs');
const journalName = 'voice-repair-transaction.json';
function write(root, name, value = 'new complete resources') {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, name), value);
}
function fixture(t, { existing = true } = {}) {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  const userData = path.join(root, 'data'), runtime = path.join(userData, 'voice-runtime');
  const staging = path.join(userData, `voice-staging-${randomUUID()}`), project = path.join(staging, 'project');
  write(project, 'complete.fixture');
  if (existing) write(runtime, 'keep.fixture', 'old user resource');
  const verification = [], renames = [];
  const verify = file => { verification.push(file); return fs.existsSync(path.join(file, 'complete.fixture'))
    && fs.readFileSync(path.join(file, 'complete.fixture'), 'utf8') === 'new complete resources'; };
  const fsImpl = { ...fs, renameSync: (source, destination) => { renames.push([source, destination]); return fs.renameSync(source, destination); },
    cpSync: () => assert.fail('repair must never copy directories'), copyFileSync: () => assert.fail('repair must never copy files'),
    rmSync: () => assert.fail('repair must never remove directories'), rmdirSync: () => assert.fail('repair must never remove directories') };
  const service = overrides => createVoiceRepair({ userData, verifyInstallation: verify, fsImpl, ...overrides });
  t.after(() => {
    const relative = path.relative(temporaryRoot, path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup stays inside the dedicated D-drive fixture root');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, userData, runtime, staging, project, verify, verification, renames, fsImpl, service,
    journal: path.join(userData, journalName) };
}
function chatFixture(t, { existing = true } = {}) {
  const f = fixture(t), runtime = path.join(f.userData, 'chat-runtime'), project = fs.mkdtempSync(path.join(f.userData, 'chat-staging-'));
  if (existing) write(runtime, 'keep.fixture', 'old user resource');
  write(project, 'complete.fixture');
  return { ...f, runtime, project, staging: project, journal: path.join(f.userData, 'chat-repair-transaction.json'),
    service: overrides => createRuntimeRepair({ kind: 'chat', userData: f.userData, verifyInstallation: f.verify, fsImpl: f.fsImpl, ...overrides }) };
}
function crashAfterRename(f, step, kind = 'voice') {
  const script = `const fs = require('node:fs');
    const { createRuntimeRepair } = require(${JSON.stringify(modulePath)});
    const root = ${JSON.stringify(f.userData)}, runtime = ${JSON.stringify(f.runtime)}, project = ${JSON.stringify(f.project)};
    const repair = createRuntimeRepair({ kind: ${JSON.stringify(kind)}, userData: root,
      verifyInstallation: file => fs.existsSync(require('node:path').join(file, 'complete.fixture')),
      fsImpl: { ...fs,
        writeFileSync(file, contents, ...options) {
          if (${step === 'journal-write'}) { fs.writeFileSync(file, contents.slice(0, 9), ...options); process.exit(86); }
          return fs.writeFileSync(file, contents, ...options); },
        linkSync(source, destination) { fs.linkSync(source, destination); if (${step === 'journal'}) process.exit(86); },
        renameSync(source, destination) { fs.renameSync(source, destination);
          if (${step === 'backup' ? 'source === runtime' : step === 'journal' ? 'false' : 'source === project && destination === runtime'}) process.exit(86); } } });
    repair.commit(project).then(() => process.exit(0), () => process.exit(87));`;
  const result = spawnSync(process.execPath, ['-e', script], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 86, result.stderr || `unexpected child exit ${result.status}`);
  assert.equal(fs.existsSync(f.journal), step !== 'journal-write');
}

test('verified repair renames the old directory into a retained backup without copying or deleting resources', async t => {
  const f = fixture(t), oldIdentity = fs.statSync(f.runtime).ino, newIdentity = fs.statSync(f.project).ino;
  const result = await f.service().commit(f.project);
  assert.equal(result.committed, true); assert.equal(result.recovered, false);
  assert.match(path.basename(result.backupDirectory), /^voice-runtime\.backup-[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.statSync(result.backupDirectory).ino, oldIdentity);
  assert.equal(fs.statSync(f.runtime).ino, newIdentity);
  assert.equal(fs.existsSync(f.project), false); assert.equal(fs.existsSync(f.journal), false);
  assert.equal(f.verification[0], f.project); assert.equal(f.verification.at(-1), f.runtime);
  assert.equal(f.renames.filter(([source]) => source === f.runtime).length, 1);
  assert.equal(f.renames.filter(([source]) => source === f.project).length, 1);
});

test('a missing previous installation requires no backup and an empty recovery does not mutate anything', async t => {
  const f = fixture(t, { existing: false }), service = f.service();
  assert.deepEqual(await service.recover(), { recovered: false, committed: false });
  assert.deepEqual(f.renames, []); assert.deepEqual(f.verification, []);
  const result = await service.commit(f.project);
  assert.equal(result.backupDirectory, null); assert.equal(fs.existsSync(f.runtime), true);
});

test('an absent userData directory is not created by explicit recovery', async t => {
  const f = fixture(t), absent = path.join(f.root, 'absent');
  assert.deepEqual(await createVoiceRepair({ userData: absent, verifyInstallation: () => false }).recover(), { recovered: false, committed: false });
  assert.equal(fs.existsSync(absent), false);
});

test('incomplete staging is rejected before a journal or old directory move', async t => {
  const f = fixture(t);
  await assert.rejects(f.service({ verifyInstallation: () => false }).commit(f.project), error => error.voiceRepairCode === 'verification-failed');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(f.journal), false); assert.deepEqual(f.renames, []);
});

test('a replacement failure restores the old directory and retains the prepared replacement', async t => {
  const f = fixture(t), fsImpl = { ...f.fsImpl, renameSync(source, destination) {
    if (source === f.project && destination === f.runtime) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return f.fsImpl.renameSync(source, destination);
  } };
  await assert.rejects(f.service({ fsImpl }).commit(f.project), error => error.rolledBack === true && error.diagnosticKind === 'storage-permission');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.journal), false);
  assert.equal(fs.readdirSync(f.userData).some(name => name.startsWith('voice-runtime.backup-')), false);
});

test('failed post-move verification rolls both directories back without deleting either', async t => {
  const f = fixture(t);
  await assert.rejects(f.service({ verifyInstallation: file => file !== f.runtime && f.verify(file) }).commit(f.project),
    error => error.voiceRepairCode === 'verification-failed' && error.rolledBack);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(path.join(f.project, 'complete.fixture')), true); assert.equal(fs.existsSync(f.journal), false);
});

test('rollback failure preserves the journal and staging so a later explicit action can complete the same transaction', async t => {
  const f = fixture(t), fsImpl = { ...f.fsImpl, renameSync(source, destination) {
    if (destination === f.runtime) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return f.fsImpl.renameSync(source, destination);
  } };
  await assert.rejects(f.service({ fsImpl }).commit(f.project), error => error.voiceRepairPending === true && error.preserveStage === true);
  assert.equal(fs.existsSync(f.runtime), false); assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.journal), true);
  const recovered = await f.service().recover();
  assert.equal(recovered.recovered, true); assert.equal(recovered.committed, true);
  assert.equal(fs.readFileSync(path.join(recovered.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(f.journal), false);
});

for (const step of ['journal', 'backup', 'replacement']) {
  test(`process interruption after ${step} resumes the same prepared resources without a rebuild`, async t => {
    const f = fixture(t), newIdentity = fs.statSync(f.project).ino;
    crashAfterRename(f, step);
    const result = await f.service().recover();
    assert.equal(result.recovered, true); assert.equal(result.committed, true);
    assert.equal(fs.statSync(f.runtime).ino, newIdentity);
    assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
    assert.equal(fs.existsSync(f.journal), false);
    assert.deepEqual(await f.service().recover(), { recovered: false, committed: false });
  });
}

test('recovery revalidates prepared resources and restores the backup if they have become incomplete', async t => {
  const f = fixture(t); crashAfterRename(f, 'backup');
  fs.unlinkSync(path.join(f.project, 'complete.fixture'));
  await assert.rejects(f.service().recover(), error => error.voiceRepairCode === 'verification-failed' && error.rolledBack);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.journal), false);
});

test('an unrecognized runtime appearing during interruption is never overwritten or moved', async t => {
  const f = fixture(t); crashAfterRename(f, 'backup');
  write(f.runtime, 'unrelated.fixture', 'other directory');
  await assert.rejects(f.service().recover(), error => error.voiceRepairCode === 'changed-transaction-directories' && error.preserveStage);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'unrelated.fixture'), 'utf8'), 'other directory');
  assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.journal), true); assert.deepEqual(f.renames, []);
});

test('changed stage or backup identities cannot be used to complete a transaction', async t => {
  for (const target of ['stage', 'backup']) {
    const f = fixture(t); crashAfterRename(f, 'backup');
    const transaction = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
    const directory = target === 'stage' ? f.staging : path.join(f.userData, `voice-runtime.backup-${transaction.id}`);
    fs.renameSync(directory, `${directory}.saved`); fs.mkdirSync(directory);
    await assert.rejects(f.service().recover(), error => error.preserveStage === true);
    assert.equal(fs.existsSync(`${directory}.saved`), true); assert.equal(fs.existsSync(f.journal), true); assert.deepEqual(f.renames, []);
  }
});

test('only direct, UUID-named staging projects on the userData volume may be committed', async t => {
  const f = fixture(t);
  for (const candidate of [f.runtime, f.staging, f.userData, 'relative/project', path.join(f.root, 'outside/project'),
    path.join(f.userData, 'voice-staging-invalid/project'), path.join(f.staging, 'nested/project')]) {
    await assert.rejects(f.service().commit(candidate), error => error.voiceRepairCode === 'invalid-staging-path');
  }
  assert.deepEqual(f.renames, []); assert.equal(fs.existsSync(f.journal), false);
});

test('linked stage, project, runtime or userData directories are rejected without following them', async t => {
  for (const target of ['stage', 'project', 'runtime', 'userData']) {
    const f = fixture(t), original = target === 'stage' ? f.staging : target === 'project' ? f.project : target === 'runtime' ? f.runtime : f.userData;
    const saved = `${original}.saved`;
    fs.renameSync(original, saved); fs.symlinkSync(saved, original, 'junction');
    await assert.rejects(f.service().commit(f.project), error => error.voiceRepairCode === 'linked-directory');
    assert.deepEqual(f.renames, []); assert.equal(fs.existsSync(path.join(saved, target === 'runtime' ? 'keep.fixture' : target === 'project' ? 'complete.fixture' : '')), true);
  }
});

test('a preexisting backup name is preserved and prevents replacement', async t => {
  const f = fixture(t), id = randomUUID(), backup = path.join(f.userData, `voice-runtime.backup-${id}`);
  write(backup, 'unrelated.fixture', 'do not replace');
  await assert.rejects(f.service({ randomUUIDImpl: () => id }).commit(f.project), error => error.voiceRepairCode === 'changed-transaction-directories');
  assert.equal(fs.readFileSync(path.join(backup, 'unrelated.fixture'), 'utf8'), 'do not replace');
  assert.deepEqual(f.renames, []);
});

test('journal parsing is bounded and rejects extra fields, traversal, absolute paths and forged identities', async t => {
  const f = fixture(t); crashAfterRename(f, 'journal');
  const original = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
  const cases = ['{', 'x'.repeat(4097), { ...original, path: f.runtime }, { ...original, stage: '../outside' },
    { ...original, stage: f.staging }, { ...original, id: '../../escape' }, { ...original, version: 2 },
    { ...original, previous: { ...original.previous, ino: '-1' } }, { ...original, root: { ...original.root, dev: 'other-drive' } }];
  for (const value of cases) {
    fs.writeFileSync(f.journal, typeof value === 'string' ? value : JSON.stringify(value));
    await assert.rejects(f.service().recover(), error => error.voiceRepairCode === 'invalid-journal' && error.preserveStage);
    assert.deepEqual(f.renames, []); assert.equal(fs.existsSync(path.join(f.runtime, 'keep.fixture')), true);
  }
});

test('journal symlinks and pending transactions cannot be overwritten by another commit', async t => {
  const f = fixture(t); crashAfterRename(f, 'journal');
  await assert.rejects(f.service().commit(f.project), error => error.voiceRepairCode === 'recovery-required');
  const original = `${f.journal}.saved`;
  fs.renameSync(f.journal, original);
  // A directory junction is sufficient to prove the fixed journal path is never followed.
  fs.symlinkSync(f.staging, f.journal, 'junction');
  await assert.rejects(f.service().recover(), error => error.voiceRepairCode === 'invalid-journal');
  assert.equal(fs.existsSync(original), true); assert.deepEqual(f.renames, []);
});

test('a directory changed while verification was pending is preserved instead of committed', async t => {
  const f = fixture(t);
  let finish;
  const pending = f.service({ verifyInstallation: () => new Promise(resolve => { finish = resolve; }) }).commit(f.project);
  fs.renameSync(f.runtime, `${f.runtime}.saved`); write(f.runtime, 'other.fixture');
  finish(true);
  await assert.rejects(pending, error => error.voiceRepairCode === 'changed-transaction-directories');
  assert.equal(fs.existsSync(path.join(f.runtime, 'other.fixture')), true); assert.equal(fs.existsSync(f.journal), false);
  assert.deepEqual(f.renames, []);
});

test('concurrent explicit actions in one process cannot race the same userData transaction', async t => {
  const f = fixture(t); let finish;
  const first = f.service({ verifyInstallation: () => new Promise(resolve => { finish = resolve; }) }).commit(f.project);
  await assert.rejects(f.service().recover(), error => error.voiceRepairCode === 'repair-busy');
  finish(false); await assert.rejects(first, error => error.voiceRepairCode === 'verification-failed');
  assert.deepEqual(f.renames, []);
});

test('an interrupted journal write never publishes incomplete JSON or moves the current installation', async t => {
  const f = fixture(t); crashAfterRename(f, 'journal-write');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(f.project), true);
  assert.deepEqual(await f.service().recover(), { recovered: false, committed: false });
  assert.deepEqual(f.renames, []);
});

test('journal publication cannot replace another transaction created concurrently', async t => {
  const f = fixture(t), other = 'unrecognized concurrent transaction';
  await assert.rejects(f.service({ fsImpl: { ...f.fsImpl, linkSync(source, destination) {
    fs.writeFileSync(destination, other); return fs.linkSync(source, destination);
  } } }).commit(f.project), error => error.voiceRepairCode === 'journal-publish' && error.preserveStage);
  assert.equal(fs.readFileSync(f.journal, 'utf8'), other);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.deepEqual(f.renames, []);
});

test('a filesystem without hardlinks can publish its flushed journal with a Windows exclusive move', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const result = await f.service({ fsImpl: { ...f.fsImpl, linkSync() {
    throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
  } } }).commit(f.project);
  assert.equal(result.committed, true); assert.equal(fs.existsSync(f.journal), false); assert.equal(fs.existsSync(f.project), false);
  assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(path.join(f.runtime, 'complete.fixture')), true);
});

test('an unconfirmed native journal publication blocks recovery and retains both prepared and old resources', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); let finish, temporary;
  const pendingExit = new Promise(resolve => { finish = resolve; });
  const repair = f.service({ fsImpl: { ...f.fsImpl, linkSync() { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); } },
    moveFileNoReplaceImpl: async source => {
      temporary = source;
      throw Object.assign(new Error('unconfirmed'), { code: 'EBUSY', preserveStage: true, setupProcessPending: true, setupProcessExit: pendingExit });
    } });
  await assert.rejects(repair.commit(f.project), error => error.preserveStage && error.runtimeRepairPending && !error.setupProcessExit);
  await assert.rejects(f.service().recover(), error => error.runtimeRepairCode === 'journal-publish-pending');
  assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.runtime), true); assert.deepEqual(f.renames, []);
  // The helper completes after its bounded wait. The next explicit action
  // must recover this exact journal, never delete or rebuild its valid stage.
  fs.renameSync(temporary, f.journal); finish(); await pendingExit; await Promise.resolve();
  const recovered = await f.service().recover(); assert.equal(recovered.committed, true);
  assert.equal(fs.readFileSync(path.join(recovered.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
});

test('journal publication handles the Windows EISDIR link error without treating other EISDIR operations as unsupported', { skip: process.platform !== 'win32' }, async t => {
  for (const syscall of ['link', 'open']) await t.test(syscall, async t => {
    const f = chatFixture(t);
    const repair = f.service({ fsImpl: { ...f.fsImpl, linkSync() { throw Object.assign(new Error('invalid function'), { code: 'EISDIR', syscall }); } } });
    if (syscall === 'link') {
      const result = await repair.commit(f.project); assert.equal(result.committed, true);
      assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
    } else {
      await assert.rejects(repair.commit(f.project), error => error.runtimeRepairCode === 'journal-publish');
      assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.journal), false); assert.deepEqual(f.renames, []);
    }
  });
});

test('chat uses only its fixed runtime, direct mkdtemp stage, backup and journal names', async t => {
  const f = chatFixture(t), oldIdentity = fs.statSync(f.runtime).ino, newIdentity = fs.statSync(f.project).ino;
  const result = await f.service().commit(f.project);
  assert.equal(result.committed, true); assert.equal(result.stagingDirectory, f.project);
  assert.match(path.basename(result.backupDirectory), /^chat-runtime\.unverified-[0-9a-f-]{36}$/);
  assert.equal(fs.statSync(result.backupDirectory).ino, oldIdentity); assert.equal(fs.statSync(f.runtime).ino, newIdentity);
  assert.equal(fs.existsSync(f.journal), false); assert.equal(fs.existsSync(f.project), false);
  assert.equal(fs.readFileSync(path.join(f.userData, 'voice-runtime/keep.fixture'), 'utf8'), 'old user resource');
});

for (const step of ['journal', 'backup', 'replacement']) {
  test(`chat interruption after ${step} resumes without building or copying another runtime`, async t => {
    const f = chatFixture(t), newIdentity = fs.statSync(f.project).ino;
    crashAfterRename(f, step, 'chat');
    const result = await f.service().recover();
    assert.equal(result.recovered, true); assert.equal(result.committed, true);
    assert.equal(fs.statSync(f.runtime).ino, newIdentity);
    assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'keep.fixture'), 'utf8'), 'old user resource');
  });
}

test('chat rolls back rejected or interrupted commits into its original direct staging directory', async t => {
  const f = chatFixture(t);
  await assert.rejects(f.service({ verifyInstallation: file => file !== f.runtime && f.verify(file) }).commit(f.project),
    error => error.runtimeRepairCode === 'verification-failed' && error.diagnosticKind === 'runtime-invalid' && error.rolledBack);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'keep.fixture'), 'utf8'), 'old user resource');
  assert.equal(fs.existsSync(path.join(f.project, 'complete.fixture')), true); assert.equal(fs.existsSync(f.journal), false);
});

test('chat and voice transactions can prepare concurrently for the same userData without sharing their locks', async t => {
  const f = chatFixture(t), voiceProject = path.join(f.userData, fs.readdirSync(f.userData).find(name => name.startsWith('voice-staging-')), 'project');
  let finish;
  const pending = createVoiceRepair({ userData: f.userData, verifyInstallation: () => new Promise(resolve => { finish = resolve; }) }).commit(voiceProject);
  const chat = await f.service().commit(f.project); assert.equal(chat.committed, true);
  finish(false); await assert.rejects(pending, error => error.voiceRepairCode === 'verification-failed');
});

test('runtime layouts are a fixed allowlist and cannot redirect paths using caller supplied names', async t => {
  const f = chatFixture(t);
  for (const kind of [undefined, null, '', 'toString', '__proto__', '../voice', 'other']) {
    assert.throws(() => createRuntimeRepair({ kind, userData: f.userData, verifyInstallation: f.verify }), error => error.runtimeRepairCode === 'invalid-options');
  }
  for (const stage of [path.join(f.userData, 'chat-staging-invalid'), path.join(f.project, 'project'),
    path.join(f.userData, `voice-staging-${randomUUID()}/project`)]) {
    await assert.rejects(f.service().commit(stage), error => error.runtimeRepairCode === 'invalid-staging-path');
  }
  assert.deepEqual(f.renames, []);
});

test('chat directory and journal errors do not use voice-specific installation diagnoses', async t => {
  const f = chatFixture(t), saved = `${f.runtime}.saved`;
  fs.renameSync(f.runtime, saved); fs.symlinkSync(saved, f.runtime, 'junction');
  await assert.rejects(f.service().commit(f.project), error => error.runtimeRepairCode === 'linked-directory' && error.diagnosticKind === 'storage-path');
  fs.unlinkSync(f.runtime); fs.writeFileSync(f.runtime, 'not a directory');
  await assert.rejects(f.service().commit(f.project), error => error.runtimeRepairCode === 'invalid-directory' && error.diagnosticKind === 'storage-path');
  fs.unlinkSync(f.runtime); fs.renameSync(saved, f.runtime); fs.writeFileSync(f.journal, '{}');
  await assert.rejects(f.service().recover(), error => error.runtimeRepairCode === 'invalid-journal' && error.diagnosticKind === 'storage-busy');
});

for (const kind of ['voice', 'chat']) {
  test(`${kind} ordinary installation cannot replace a target created while staging was prepared`, async t => {
    const f = kind === 'voice' ? fixture(t, { existing: false }) : chatFixture(t, { existing: false });
    const service = f.service();
    write(f.runtime, 'external.fixture', 'newly appeared resources');
    const identity = fs.statSync(f.runtime).ino;
    await assert.rejects(service.commit(f.project, { allowReplace: false }), error => error.runtimeRepairCode === 'replacement-not-allowed');
    assert.equal(fs.statSync(f.runtime).ino, identity);
    assert.equal(fs.readFileSync(path.join(f.runtime, 'external.fixture'), 'utf8'), 'newly appeared resources');
    assert.equal(fs.existsSync(f.project), true); assert.equal(fs.existsSync(f.journal), false);
    assert.deepEqual(f.renames, []); assert.deepEqual(f.verification, []);
  });

  test(`${kind} allowReplace false still installs into an absent target and requires a strict boolean`, async t => {
    const f = kind === 'voice' ? fixture(t, { existing: false }) : chatFixture(t, { existing: false });
    for (const allowReplace of [null, 0, 1, '', 'false', [], {}]) {
      await assert.rejects(f.service().commit(f.project, { allowReplace }), error => error.runtimeRepairCode === 'invalid-options');
    }
    assert.deepEqual(f.renames, []);
    const result = await f.service().commit(f.project, { allowReplace: false });
    assert.equal(result.committed, true); assert.equal(result.backupDirectory, null);
  });
}

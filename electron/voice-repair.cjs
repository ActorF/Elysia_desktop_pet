/** Explicit, same-volume voice replacement. No copies, directory deletion or inspection-side recovery. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { classifySetupFailure } = require('./setup-diagnostics.cjs');
const { moveFileNoReplace, isUnsupportedHardLink } = require('./windows-file-move.cjs');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${UUID}$`, 'i');
const layouts = Object.freeze({
  voice: { target: 'voice-runtime', stage: new RegExp(`^voice-staging-${UUID}$`, 'i'), child: 'project', backup: 'voice-runtime.backup-', validation: 'validation-output' },
  chat: { target: 'chat-runtime', stage: /^chat-staging-[a-z0-9]{6}$/i, child: null, backup: 'chat-runtime.unverified-', validation: 'runtime-invalid' },
});
const locks = new Set();
const pendingPublications = new Map();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameIdentity = (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
const validIdentity = value => record(value) && Object.keys(value).sort().join(',') === 'dev,ino'
  && [value.dev, value.ino].every(item => typeof item === 'string' && /^(?:0|[1-9][0-9]{0,31})$/.test(item)) && value.ino !== '0';
function repairFailure(reason, kind = 'installation-conflict', cause) {
  const error = new Error('Local resource replacement could not be completed.', cause ? { cause } : undefined);
  error.voiceRepairCode = reason;
  error.runtimeRepairCode = reason;
  error.diagnosticKind = cause ? classifySetupFailure(cause, kind) : kind;
  if (cause?.preserveStage) {
    error.preserveStage = true;
    error.voiceRepairPending = true;
    error.runtimeRepairPending = true;
  }
  return error;
}

/**
 * Call recover() only from an explicit install/repair action, before creating another staging tree.
 * commit() accepts only userData/voice-staging-UUID/project and verifies it before moving anything.
 * A pending error has preserveStage=true: its journal and staging directory must survive cleanup.
 */
function createRuntimeRepair({ kind, userData, verifyInstallation, beforeChange = () => {}, fsImpl = fs, randomUUIDImpl = randomUUID, moveFileNoReplaceImpl = moveFileNoReplace }) {
  function failure(reason, diagnosticKind = 'installation-conflict', cause) {
    const chatKinds = { 'installation-conflict': 'storage-busy', 'installation-linked-directory': 'storage-path', 'installation-invalid-directory': 'storage-path' };
    return repairFailure(reason, kind === 'chat' ? chatKinds[diagnosticKind] || diagnosticKind : diagnosticKind, cause);
  }
  if (typeof kind !== 'string' || !Object.hasOwn(layouts, kind) || typeof userData !== 'string' || !path.isAbsolute(userData)
    || typeof verifyInstallation !== 'function' || typeof beforeChange !== 'function') {
    throw failure('invalid-options', 'storage-path');
  }
  const layout = layouts[kind], root = path.resolve(userData), runtime = path.join(root, layout.target);
  const journalPath = path.join(root, `${kind}-repair-transaction.json`);
  const key = `${process.platform === 'win32' ? root.toLowerCase() : root}:${kind}`;
  const pathEqual = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  function stat(file) {
    try { return fsImpl.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw failure('filesystem-read', 'storage-io', error); }
  }
  function identity(value) {
    const result = { dev: value.dev.toString(), ino: value.ino.toString() };
    if (!validIdentity(result)) throw failure('identity-unavailable');
    return result;
  }
  function directory(file) {
    const value = stat(file);
    if (!value) return null;
    if (value.isSymbolicLink()) throw failure('linked-directory', 'installation-linked-directory');
    if (!value.isDirectory()) throw failure('invalid-directory', 'installation-invalid-directory');
    return identity(value);
  }
  function checkRoot(required = true) {
    const current = directory(root);
    if (!current) { if (required) throw failure('missing-user-directory', 'storage-path'); return null; }
    // Reject junction/symlink ancestors as well as a linked userData directory itself.
    for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
      if (!directory(parent)) throw failure('missing-parent-directory', 'storage-path');
      if (path.dirname(parent) === parent) break;
    }
    return current;
  }
  function validJournal(value) {
    return record(value) && Object.keys(value).sort().join(',') === 'id,kind,previous,replacement,root,stage,stageIdentity,version'
      && value.version === 1 && value.kind === kind && typeof value.id === 'string' && uuidPattern.test(value.id)
      && typeof value.stage === 'string' && layout.stage.test(value.stage)
      && [value.root, value.stageIdentity, value.replacement].every(validIdentity)
      && (value.previous === null || validIdentity(value.previous))
      && value.root.dev === value.stageIdentity.dev && value.root.dev === value.replacement.dev
      && (layout.child || sameIdentity(value.stageIdentity, value.replacement))
      && (!value.previous || (value.previous.dev === value.root.dev && !sameIdentity(value.previous, value.replacement)));
  }
  function readJournal() {
    const value = stat(journalPath);
    if (!value) return null;
    if (!value.isFile() || value.isSymbolicLink() || value.size <= 0n || value.size > 4096n) throw failure('invalid-journal');
    let descriptor, parsed;
    try {
      descriptor = fsImpl.openSync(journalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fsImpl.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || !sameIdentity(identity(value), identity(opened)) || opened.size !== value.size) throw failure('changed-journal');
      const data = Buffer.alloc(4097), length = fsImpl.readSync(descriptor, data, 0, data.length, 0);
      if (length !== Number(value.size) || length > 4096) throw failure('invalid-journal');
      try { parsed = JSON.parse(data.subarray(0, length).toString('utf8')); }
      catch (error) { throw failure('invalid-journal', 'installation-conflict', error); }
    } finally { if (descriptor !== undefined) fsImpl.closeSync(descriptor); }
    if (!validJournal(parsed)) throw failure('invalid-journal');
    return parsed;
  }
  function paths(transaction) {
    const stagingDirectory = path.join(root, transaction.stage);
    return { stagingDirectory, project: layout.child ? path.join(stagingDirectory, layout.child) : stagingDirectory,
      backup: path.join(root, `${layout.backup}${transaction.id}`) };
  }
  function scan(transaction) {
    if (!sameIdentity(checkRoot(), transaction.root)) throw failure('changed-user-directory');
    const { stagingDirectory, project, backup } = paths(transaction);
    const stageIdentity = directory(stagingDirectory);
    if (stageIdentity && !sameIdentity(stageIdentity, transaction.stageIdentity)) throw failure('changed-staging-directory');
    const staged = stageIdentity ? layout.child ? directory(project) : stageIdentity : null;
    const installed = directory(runtime), saved = directory(backup);
    const newStaged = sameIdentity(staged, transaction.replacement), newInstalled = sameIdentity(installed, transaction.replacement);
    if (transaction.previous) {
      if (sameIdentity(installed, transaction.previous) && newStaged && !saved) return 'prepared';
      if (!installed && newStaged && sameIdentity(saved, transaction.previous)) return 'backed-up';
      if (newInstalled && !staged && sameIdentity(saved, transaction.previous)) return 'installed';
    } else {
      if (!installed && newStaged && !saved) return 'prepared';
      if (newInstalled && !staged && !saved) return 'installed';
    }
    throw failure('changed-transaction-directories');
  }
  async function writeJournal(transaction) {
    const temporary = path.join(root, `${kind}-repair-journal-${transaction.id}.tmp`);
    let descriptor;
    try {
      descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
      fsImpl.writeFileSync(descriptor, JSON.stringify(transaction), 'utf8');
      fsImpl.fsyncSync(descriptor);
    } finally { if (descriptor !== undefined) fsImpl.closeSync(descriptor); }
    // Creating a second link publishes the already flushed inode atomically and
    // fails if a different transaction appeared. Never rename over a journal.
    try { fsImpl.linkSync(temporary, journalPath); }
    catch (error) {
      if (process.platform !== 'win32' || !isUnsupportedHardLink(error)) throw failure('journal-publish', 'storage-io', error);
      try {
        await moveFileNoReplaceImpl(temporary, journalPath, { expected: fsImpl.lstatSync(temporary, { bigint: true }) });
        return;
      } catch (cause) {
        if (cause.setupProcessExit) {
          const pending = cause.setupProcessExit;
          pendingPublications.set(key, pending);
          void pending.then(() => { if (pendingPublications.get(key) === pending) pendingPublications.delete(key); }, () => {});
        }
        // Preserve a possibly publishing transaction. Its stage must not use
        // extraction's late-exit cleanup: a valid journal may appear at exit.
        throw failure('journal-publish', 'storage-io', cause);
      }
    }
    fsImpl.unlinkSync(temporary);
  }
  function checkJournal(transaction) {
    if (JSON.stringify(readJournal()) !== JSON.stringify(transaction)) throw failure('changed-journal');
  }
  function removeJournal(transaction) {
    checkJournal(transaction);
    fsImpl.unlinkSync(journalPath);
  }
  async function verified(file) {
    let result;
    try { result = await verifyInstallation(file); }
    catch (error) { throw failure('verification-failed', layout.validation, error); }
    if (!(result === true || (record(result) && result.ready === true))) throw failure('verification-failed', layout.validation);
  }
  async function moveDirectory(transaction, source, destination, before, after) {
    const waits = process.platform === 'win32' ? [25, 75, 150, 250] : [];
    for (let attempt = 0; ; attempt++) {
      checkJournal(transaction);
      if (scan(transaction) !== before) throw failure('changed-transaction-directories');
      try { fsImpl.renameSync(source, destination); }
      catch (error) {
        // Windows can briefly refuse a directory rename even after all of our
        // handles have closed. Retry only the same immutable transaction; an
        // intervening directory or journal change must never be overwritten.
        checkJournal(transaction);
        if (scan(transaction) !== before) throw failure('changed-transaction-directories');
        if (attempt >= waits.length || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(waits[attempt]);
        continue;
      }
      if (scan(transaction) !== after) throw failure('changed-transaction-directories');
      return;
    }
  }
  async function rollback(transaction) {
    checkJournal(transaction);
    const target = paths(transaction);
    let phase = scan(transaction);
    if (phase === 'installed') {
      if (layout.child && !sameIdentity(directory(target.stagingDirectory), transaction.stageIdentity)) throw failure('missing-rollback-directory');
      await moveDirectory(transaction, runtime, target.project, 'installed', transaction.previous ? 'backed-up' : 'prepared');
      phase = scan(transaction);
    }
    if (phase === 'backed-up') {
      await moveDirectory(transaction, target.backup, runtime, 'backed-up', 'prepared');
      phase = scan(transaction);
    }
    if (phase !== 'prepared') throw failure('rollback-conflict');
    removeJournal(transaction);
  }
  async function finish(transaction, recovered) {
    const target = paths(transaction);
    let mayRollback = false;
    try {
      checkJournal(transaction);
      let phase = scan(transaction);
      // Recovery can also replace/roll back resources already in use. Await
      // the owner's confirmed shutdown before any move, including rollback.
      if (transaction.previous || phase === 'installed') {
        try { await beforeChange(); }
        catch (cause) { throw failure('replacement-not-ready', 'storage-busy', cause); }
      }
      mayRollback = true;
      checkJournal(transaction); phase = scan(transaction);
      if (phase !== 'installed') {
        await verified(target.project);
        checkJournal(transaction);
        phase = scan(transaction);
        if (phase === 'prepared' && transaction.previous) {
          await moveDirectory(transaction, runtime, target.backup, 'prepared', 'backed-up');
          phase = scan(transaction);
        }
        if (phase !== 'backed-up' && !(phase === 'prepared' && !transaction.previous)) throw failure('commit-conflict');
        await moveDirectory(transaction, target.project, runtime, phase, 'installed');
      }
      if (scan(transaction) !== 'installed') throw failure('commit-conflict');
      await verified(runtime);
      checkJournal(transaction);
      if (scan(transaction) !== 'installed') throw failure('commit-conflict');
      removeJournal(transaction);
      return { recovered, committed: true, stagingDirectory: target.stagingDirectory,
        backupDirectory: transaction.previous ? target.backup : null };
    } catch (cause) {
      const error = cause.voiceRepairCode ? cause : failure('commit-failed', 'storage-io', cause);
      if (!mayRollback) {
        error.voiceRepairPending = true; error.runtimeRepairPending = true; error.preserveStage = true;
        throw error;
      }
      try { await rollback(transaction); error.rolledBack = true; }
      catch (rollbackError) {
        error.voiceRepairPending = true; error.runtimeRepairPending = true; error.preserveStage = true;
        Object.defineProperty(error, 'rollbackError', { value: rollbackError });
      }
      throw error;
    }
  }
  async function exclusive(operation) {
    if (locks.has(key)) throw failure('repair-busy', 'storage-busy');
    if (pendingPublications.has(key)) {
      const error = failure('journal-publish-pending', 'storage-busy');
      error.preserveStage = true; error.voiceRepairPending = true; error.runtimeRepairPending = true;
      throw error;
    }
    locks.add(key);
    try { return await operation(); }
    catch (cause) {
      const error = cause.voiceRepairCode ? cause : failure('filesystem-operation', 'storage-io', cause);
      // Even a malformed or partially written journal is preserved for diagnosis.
      try { if (stat(journalPath)) { error.voiceRepairPending = true; error.runtimeRepairPending = true; error.preserveStage = true; } }
      catch { error.voiceRepairPending = true; error.runtimeRepairPending = true; error.preserveStage = true; }
      throw error;
    } finally { locks.delete(key); }
  }
  function recover() {
    return exclusive(async () => {
      if (!checkRoot(false)) return { recovered: false, committed: false };
      const transaction = readJournal();
      return transaction ? finish(transaction, true) : { recovered: false, committed: false };
    });
  }
  function commit(stagedProject, options = {}) {
    return exclusive(async () => {
      if (!record(options) || Object.keys(options).some(name => name !== 'allowReplace')
        || (options.allowReplace !== undefined && typeof options.allowReplace !== 'boolean')) throw failure('invalid-options', 'storage-path');
      const allowReplace = options.allowReplace === undefined ? true : options.allowReplace;
      const rootIdentity = checkRoot();
      if (readJournal()) throw failure('recovery-required');
      if (typeof stagedProject !== 'string' || !path.isAbsolute(stagedProject)) throw failure('invalid-staging-path', 'storage-path');
      const absolute = path.resolve(stagedProject), relative = path.relative(root, absolute).split(path.sep);
      if (relative.length !== (layout.child ? 2 : 1) || !layout.stage.test(relative[0]) || (layout.child && relative[1] !== layout.child)
        || !pathEqual(path.normalize(stagedProject), absolute)) throw failure('invalid-staging-path', 'storage-path');
      const stageIdentity = directory(layout.child ? path.dirname(absolute) : absolute), replacement = directory(absolute), previous = directory(runtime);
      if (!allowReplace && previous) throw failure('replacement-not-allowed');
      const id = randomUUIDImpl();
      const transaction = { version: 1, kind, id, stage: relative[0], root: rootIdentity, stageIdentity, previous, replacement };
      if (!validJournal(transaction)) throw failure('invalid-transaction');
      scan(transaction);
      await verified(absolute);
      scan(transaction);
      await writeJournal(transaction);
      return finish(transaction, false);
    });
  }
  return { recover, commit };
}

const createVoiceRepair = options => createRuntimeRepair({ ...options, kind: 'voice' });
module.exports = { createVoiceRepair, createRuntimeRepair };

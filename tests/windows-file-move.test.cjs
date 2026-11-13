'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createWindowsFileMover, isUnsupportedHardLink } = require('../electron/windows-file-move.cjs');

test('unsupported hardlink detection handles Windows invalid-function without broadening permission or path errors', () => {
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) assert.equal(isUnsupportedHardLink({ code }), true);
  assert.equal(isUnsupportedHardLink({ code: 'EISDIR', syscall: 'link' }), true);
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'EEXIST', 'ENOENT', 'EXDEV', 'EIO']) {
    assert.equal(isUnsupportedHardLink({ code, syscall: 'link' }), false, code);
  }
  for (const syscall of [undefined, 'stat', 'open', 'rename', 'unlink']) {
    assert.equal(isUnsupportedHardLink({ code: 'EISDIR', syscall }), false, String(syscall));
  }
  for (const error of [undefined, null, {}, new Error('EISDIR: unsupported link')]) assert.equal(isUnsupportedHardLink(error), false);
});

function fixture(t) {
  const parent = path.resolve(__dirname, '../artifacts/file-move-tests/temp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, '资源 東京 Ω # [x] &.part'), destination = path.join(root, '发布 $value ; 文件.bin');
  fs.writeFileSync(source, 'small verified resource');
  return { root, source, destination, expected: fs.lstatSync(source, { bigint: true }),
    options: { env: { ...process.env, TEMP: parent, TMP: parent } } };
}

test('native publication renames the exact file with Unicode and metacharacters without copying', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), mover = createWindowsFileMover(f.options);
  await mover.move(f.source, f.destination, { expected: f.expected });
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'small verified resource');
  const published = fs.lstatSync(f.destination, { bigint: true });
  assert.equal(published.ino, f.expected.ino); assert.equal(published.size, f.expected.size);
  assert.equal(published.mtimeNs, f.expected.mtimeNs);
});

test('native publication never replaces an existing target and refuses a substituted source', { skip: process.platform !== 'win32' }, async t => {
  for (const mode of ['target', 'source']) await t.test(mode, async t => {
    const f = fixture(t), saved = path.join(f.root, 'original.part');
    const mover = createWindowsFileMover({ ...f.options, spawnImpl: (...args) => {
      if (mode === 'target') fs.writeFileSync(f.destination, 'existing user content');
      else { fs.renameSync(f.source, saved); fs.writeFileSync(f.source, Buffer.alloc(Number(f.expected.size), 0x58)); }
      return spawn(...args);
    } });
    await assert.rejects(mover.move(f.source, f.destination, { expected: f.expected }), { code: mode === 'target' ? 'EEXIST' : 'EBUSY' });
    assert.equal(fs.existsSync(f.source), true);
    if (mode === 'target') assert.equal(fs.readFileSync(f.destination, 'utf8'), 'existing user content');
    else { assert.equal(fs.existsSync(f.destination), false); assert.equal(fs.readFileSync(saved, 'utf8'), 'small verified resource'); }
  });
});

test('native publication supports long namespaced paths and an explicit same-volume DLL move', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), directory = path.join(f.root, 'long-path-'.repeat(8), '长路径'.repeat(28), 'tail'.repeat(20));
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'runtime.dll.part'), destination = path.join(directory, 'runtime.dll');
  fs.writeFileSync(source, 'tiny long-path DLL');
  const mover = createWindowsFileMover(f.options), expected = fs.lstatSync(source, { bigint: true });
  assert.ok(destination.length > 260);
  await mover.move(source, destination, { expected });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'tiny long-path DLL');
  const final = path.join(f.root, 'runtime.dll');
  await assert.rejects(mover.move(destination, final, { expected: fs.lstatSync(destination, { bigint: true }) }), { code: 'EXDEV' });
  await mover.move(destination, final, { expected: fs.lstatSync(destination, { bigint: true }), allowSameVolume: true });
  assert.equal(fs.readFileSync(final, 'utf8'), 'tiny long-path DLL');
});

test('native publication reports missing sources without creating a destination', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); fs.unlinkSync(f.source);
  await assert.rejects(createWindowsFileMover(f.options).move(f.source, f.destination, { expected: f.expected }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(f.destination), false);
});

test('helper arguments remain data and do not expose caller paths in PowerShell source', async t => {
  const f = fixture(t); let observed;
  const mover = createWindowsFileMover({ ...f.options, platform: 'win32', spawnImpl: (file, args, options) => {
    observed = { file, args, options };
    const child = new EventEmitter(); child.pid = 123; child.kill = () => assert.fail('successful helper should not be killed');
    queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  await mover.move(f.source, f.destination, { expected: f.expected });
  assert.equal(observed.options.shell, false); assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.args.at(-2), '-File'); assert.match(observed.args.at(-1), /windows-file-move\.ps1$/);
  assert.ok(observed.args.every(value => !value.includes(path.basename(f.source))));
  assert.equal(observed.options.env.ELYSIA_MOVE_SOURCE, path.toNamespacedPath(f.source));
  assert.equal(observed.options.env.ELYSIA_MOVE_INO, String(f.expected.ino));
  assert.equal(observed.options.env.ELYSIA_MOVE_PARENT_INO, String(fs.lstatSync(f.root, { bigint: true }).ino));
});

test('an unconfirmed helper termination reserves its target until late exit', async t => {
  const f = fixture(t); let child, spawns = 0;
  const mover = createWindowsFileMover({ ...f.options, platform: 'win32', timeoutMs: 5, stopTimeoutMs: 5,
    spawnImpl: () => {
      spawns++; child = new EventEmitter(); child.pid = 123; child.kill = () => false;
      if (spawns > 1) queueMicrotask(() => child.emit('exit', 5)); return child;
    } });
  await assert.rejects(mover.move(f.source, f.destination, { expected: f.expected }), error => error.code === 'EBUSY'
    && error.preserveStage === true && error.setupProcessPending === true && typeof error.setupProcessExit?.then === 'function');
  await assert.rejects(mover.move(f.source, f.destination, { expected: f.expected }), { code: 'EBUSY' });
  assert.equal(spawns, 1); assert.equal(fs.existsSync(f.source), true);
  child.emit('exit', 1); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(mover.move(f.source, f.destination, { expected: f.expected }), { code: 'EACCES' });
  assert.equal(spawns, 2);
});

test('invalid identities and cross-volume targets cannot launch a helper', async t => {
  const f = fixture(t), mover = createWindowsFileMover({ ...f.options, platform: 'win32', spawnImpl: () => assert.fail('invalid move must not spawn') });
  await assert.rejects(mover.move(f.source, f.destination), { code: 'EINVAL' });
  await assert.rejects(mover.move(f.source, f.destination, { expected: { ...f.expected, dev: f.expected.dev + 1n } }), { code: 'EXDEV' });
  await assert.rejects(mover.move(f.source, f.source, { expected: f.expected }), { code: 'EXDEV' });
});

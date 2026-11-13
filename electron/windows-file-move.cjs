'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSetupProcessTracker } = require('./setup-child-process.cjs');

const errorFor = (code, cause) => Object.assign(new Error('Verified resource publication failed.', cause ? { cause } : undefined), { code });
const nativeCode = code => ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY', 33: 'EBUSY',
  39: 'ENOSPC', 80: 'EEXIST', 87: 'EINVAL', 112: 'ENOSPC', 123: 'EINVAL', 183: 'EEXIST', 206: 'ENAMETOOLONG' })[code] || 'EIO';

function isUnsupportedHardLink(error) {
  // libuv's Windows fs__link forwards CreateHardLinkW errors. In libuv 1.52.1,
  // ERROR_INVALID_FUNCTION (1) becomes EISDIR, while ERROR_NOT_SUPPORTED (50)
  // becomes ENOTSUP. EISDIR is eligible only for this exact link syscall; the
  // native mover still requires a verified regular source and cannot overwrite.
  // https://github.com/libuv/libuv/blob/v1.52.1/src/win/error.c
  return ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)
    || (error?.code === 'EISDIR' && error.syscall === 'link');
}

/** Windows fallback for filesystems without hardlinks; never overwrite or copy. */
function createWindowsFileMover({ spawnImpl = spawn, env = process.env, platform = process.platform,
  timeoutMs = 15000, stopTimeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) throw new TypeError('A bounded timeout is required.');
  const processes = createSetupProcessTracker({ stopTimeoutMs });
  const active = new Map();
  async function move(source, destination, { signal, expected, allowSameVolume = false } = {}) {
    if (platform !== 'win32') throw errorFor('ENOTSUP');
    if (signal?.aborted) throw Object.assign(errorFor('ECANCELED'), { name: 'AbortError' });
    if (typeof source !== 'string' || typeof destination !== 'string' || !path.isAbsolute(source) || !path.isAbsolute(destination)
      || source.includes('\0') || destination.includes('\0')) throw errorFor('EINVAL');
    source = path.resolve(source); destination = path.resolve(destination);
    const sourceParent = path.dirname(source), parent = path.dirname(destination);
    if (typeof allowSameVolume !== 'boolean') throw errorFor('EINVAL');
    if ((!allowSameVolume && sourceParent.toLowerCase() !== parent.toLowerCase())
      || source.toLowerCase() === destination.toLowerCase()) throw errorFor('EXDEV');
    if (!expected || !['dev', 'ino', 'size', 'mtimeNs'].every(key => typeof expected[key] === 'bigint')
      || expected.dev < 0n || expected.ino < 0n || expected.size < 0n) throw errorFor('EINVAL');
    const key = destination.toLowerCase();
    if (active.has(key)) throw errorFor('EBUSY');
    const token = {}; active.set(key, token);
    const release = () => { if (active.get(key) === token) active.delete(key); };
    let child;
    try {
      const directory = await fs.promises.lstat(parent, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw errorFor('EINVAL');
      if (directory.dev !== expected.dev) throw errorFor('EXDEV');
      if (sourceParent !== parent) {
        const from = await fs.promises.lstat(sourceParent, { bigint: true });
        if (!from.isDirectory() || from.isSymbolicLink()) throw errorFor('EINVAL');
        if (from.dev !== directory.dev) throw errorFor('EXDEV');
      }
      if (signal?.aborted) throw Object.assign(errorFor('ECANCELED'), { name: 'AbortError' });
      const script = path.join(__dirname, 'windows-file-move.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      child = spawnImpl(path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, shell: false, stdio: 'ignore', env: { ...env,
          ELYSIA_MOVE_SOURCE: path.toNamespacedPath(source), ELYSIA_MOVE_DESTINATION: path.toNamespacedPath(destination),
          ELYSIA_MOVE_PARENT: path.toNamespacedPath(parent), ELYSIA_MOVE_NAME: path.basename(destination),
          ELYSIA_MOVE_DEV: String(expected.dev), ELYSIA_MOVE_INO: String(expected.ino),
          ELYSIA_MOVE_SIZE: String(expected.size), ELYSIA_MOVE_MTIME: String(expected.mtimeNs),
          ELYSIA_MOVE_PARENT_DEV: String(directory.dev), ELYSIA_MOVE_PARENT_INO: String(directory.ino) } });
      const code = await processes.wait(child, { signal, timeoutMs, timeoutError: () => errorFor('EBUSY') });
      if (code !== 0) throw errorFor(nativeCode(code));
    } catch (error) {
      if (error.setupProcessExit) void error.setupProcessExit.then(release);
      throw error;
    } finally {
      if (!child || !processes.owns(child)) release();
    }
  }
  return { move };
}

const moveFileNoReplace = createWindowsFileMover().move;
module.exports = { moveFileNoReplace, createWindowsFileMover, isUnsupportedHardLink };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const failure = code => Object.assign(new Error(code), { setupCode: code });
const checkAbort = signal => { if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
const ordinaryFile = file => { try { const value = fs.lstatSync(file); return value.isFile() && !value.isSymbolicLink(); } catch { return false; } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function validDependenciesManifest(value) {
  const asset = value?.archive;
  const required = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
    'MICROSOFT-VC-RUNTIME-LICENSE.txt', 'MICROSOFT-VC-RUNTIME-NOTICE.txt'];
  return asset && /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(asset.file)
    && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 1024 ** 3 && /^[a-f0-9]{64}$/.test(asset.sha256)
    && Array.isArray(value.files) && value.files.length === required.length
    && value.files.every(item => item && required.includes(item.file) && item.entry === `python/${item.file}`
      && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= 16 * 1024 ** 2 && /^[a-f0-9]{64}$/.test(item.sha256))
    && required.every(file => value.files.some(item => item.file === file));
}

// Only the pinned members are read. Paths arrive as data and no shell is used.
const DEPENDENCIES_EXTRACT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($env:ELYSIA_CHAT_DEPENDENCY_STAGE)
$items = ConvertFrom-Json -InputObject $env:ELYSIA_CHAT_DEPENDENCY_FILES
if (-not [IO.Directory]::Exists($root)) { throw 'stage' }
$zip = [IO.Compression.ZipFile]::OpenRead($env:ELYSIA_CHAT_DEPENDENCY_ARCHIVE)
try {
  foreach ($item in $items) {
    if ($item.file -cnotmatch '^[A-Za-z0-9_-]+\.(dll|txt)$' -or $item.entry -cne ('python/' + $item.file)) { throw 'path' }
    $entries = @($zip.Entries | Where-Object { [String]::Equals($_.FullName, $item.entry, [StringComparison]::Ordinal) })
    if ($entries.Count -ne 1 -or $entries[0].Length -ne $item.bytes) { throw 'entry' }
    $type = ($entries[0].ExternalAttributes -shr 16) -band 61440
    if (($type -ne 0 -and $type -ne 32768) -or (($entries[0].ExternalAttributes -band 1024) -ne 0)) { throw 'link' }
  }
  foreach ($item in $items) {
    $entry = @($zip.Entries | Where-Object { [String]::Equals($_.FullName, $item.entry, [StringComparison]::Ordinal) })[0]
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, [IO.Path]::Combine($root, $item.file), $false)
  }
} finally { $zip.Dispose() }
`;

function createRuntimeDependencies({ manifest, resourcesPath = process.resourcesPath, assetDirectory,
  env = process.env, spawnImpl = spawn, extractionTimeoutMs = 5 * 60 * 1000 } = {}) {
  const valid = validDependenciesManifest(manifest);
  function fileMatches(file, asset) {
    try { return ordinaryFile(file) && fs.statSync(file).size === asset.bytes && hash(fs.readFileSync(file)) === asset.sha256; }
    catch { return false; }
  }
  function ready(directory) {
    try {
      const stat = fs.lstatSync(directory);
      return valid && stat.isDirectory() && !stat.isSymbolicLink()
        && manifest.files.every(item => fileMatches(path.join(directory, item.file), item));
    } catch { return false; }
  }
  async function archiveMatches(file, signal) {
    if (!ordinaryFile(file) || fs.statSync(file).size !== manifest.archive.bytes) return false;
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) { checkAbort(signal); digest.update(chunk); }
    checkAbort(signal); return digest.digest('hex') === manifest.archive.sha256;
  }
  function extract(archive, stage, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      let child, reason = null, finished = false;
      const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DEPENDENCIES_EXTRACT_SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, shell: false, stdio: 'ignore', env: { ...env,
            ELYSIA_CHAT_DEPENDENCY_ARCHIVE: archive, ELYSIA_CHAT_DEPENDENCY_STAGE: stage,
            ELYSIA_CHAT_DEPENDENCY_FILES: JSON.stringify(manifest.files) } });
      } catch { reject(failure('dependencies')); return; }
      const finish = error => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => { reason = Object.assign(new Error('cancelled'), { name: 'AbortError' }); child.kill(); };
      const timer = setTimeout(() => { reason = failure('dependencies'); child.kill(); }, extractionTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => finish(reason || failure('dependencies')));
      child.once('exit', code => finish(reason || (code === 0 ? null : failure('dependencies'))));
      if (signal.aborted) abort();
    });
  }
  async function prepareInternal(directory, signal) {
    checkAbort(signal);
    if (!valid) throw failure('manifest');
    if (ready(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('dependencies');
    // Always use app-owned, digest-pinned resources, never a system DLL or an
    // unverified file from PATH/another installed application.
    const directories = [assetDirectory, resourcesPath, path.join(__dirname, '..', 'build-resources', 'voice-bootstrap')].filter(Boolean);
    let archive;
    for (const candidate of [...new Set(directories.map(folder => path.join(folder, manifest.archive.file)))]) {
      try { if (await archiveMatches(candidate, signal)) { archive = candidate; break; } }
      catch (error) { if (error.name === 'AbortError') throw error; }
    }
    if (!archive) throw failure('dependencies-source');
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(directory), 'chat-dependencies-staging-'));
    try {
      await extract(archive, stage, signal); checkAbort(signal);
      if (!manifest.files.every(item => fileMatches(path.join(stage, item.file), item))) throw failure('dependencies');
      for (const item of manifest.files) {
        checkAbort(signal);
        const target = path.join(directory, item.file);
        if (fileMatches(target, item)) continue;
        if (fs.existsSync(target)) {
          if (!ordinaryFile(target)) throw failure('dependencies');
          await fs.promises.rename(target, `${target}.unverified-${randomUUID()}`);
        }
        await fs.promises.rename(path.join(stage, item.file), target);
      }
      if (!ready(directory)) throw failure('dependencies');
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {}); }
  }
  async function prepare(directory, signal) {
    try { return await prepareInternal(directory, signal); }
    catch (error) {
      if (error.name === 'AbortError' || error.setupCode) throw error;
      throw failure('dependencies');
    }
  }
  return { ready, prepare };
}

module.exports = { createRuntimeDependencies, validDependenciesManifest, DEPENDENCIES_EXTRACT_SCRIPT };

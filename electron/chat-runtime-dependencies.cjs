'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { classifySetupFailure } = require('./setup-diagnostics.cjs');
const { createSetupProcessTracker } = require('./setup-child-process.cjs');
const { moveFileNoReplace, isUnsupportedHardLink } = require('./windows-file-move.cjs');

const failure = (code, diagnosticKind = 'dependencies-invalid', details = {}, cause) =>
  Object.assign(new Error(code, cause ? { cause } : undefined), { setupCode: code, diagnosticKind, ...details });
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
$ProgressPreference = 'SilentlyContinue'
try {
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
} catch {
  if ($_.Exception.Message -in @('path','link')) { exit 70 }
  if ($_.Exception.Message -in @('stage','entry')) { exit 71 }
  $failure = $_.Exception
  for ($depth=0; $null -ne $failure -and $depth -lt 6; $depth++) {
    $nativeCode = $failure.HResult -band 65535
    if ($nativeCode -in @(39,112)) { exit 72 }
    if ($nativeCode -eq 5 -or $failure -is [UnauthorizedAccessException]) { exit 73 }
    if ($nativeCode -in @(32,33)) { exit 74 }
    if ($nativeCode -in @(3,123,206)) { exit 75 }
    if ($failure -is [IO.InvalidDataException]) { exit 71 }
    $failure = $failure.InnerException
  }
  exit 79
}
`;
const extractionKind = code => ({ 70: 'archive-unsafe', 71: 'archive-layout', 72: 'storage-space',
  73: 'storage-permission', 74: 'storage-busy', 75: 'storage-path' })[code] || 'extraction-exit';

function createRuntimeDependencies({ manifest, resourcesPath = process.resourcesPath, assetDirectory,
  env = process.env, spawnImpl = spawn, extractionTimeoutMs = 5 * 60 * 1000, processStopTimeoutMs = 2000 } = {}) {
  const valid = validDependenciesManifest(manifest);
  const helperProcesses = createSetupProcessTracker({ stopTimeoutMs: processStopTimeoutMs });
  let pendingExit = null;
  const pending = () => helperProcesses.pending() || pendingExit !== null;
  function fileMatches(file, asset) {
    try { return ordinaryFile(file) && fs.statSync(file).size === asset.bytes && hash(fs.readFileSync(file)) === asset.sha256; }
    catch { return false; }
  }
  function ready(directory) {
    try { return inspect(directory).kind === null; } catch { return false; }
  }
  function inspect(directory) {
    if (!valid) return { kind: 'manifest-invalid' };
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return { kind: 'dependencies-missing', missingFiles: manifest.files.map(item => item.file), missingCount: manifest.files.length }; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'dependencies-invalid' };
    const missingFiles = [], invalidFiles = [];
    for (const asset of manifest.files) {
      const file = path.join(directory, asset.file);
      try {
        const current = fs.lstatSync(file);
        if (!current.isFile() || current.isSymbolicLink() || current.size !== asset.bytes || hash(fs.readFileSync(file)) !== asset.sha256) invalidFiles.push(asset.file);
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') missingFiles.push(asset.file); else throw error; }
    }
    return missingFiles.length ? { kind: 'dependencies-missing', missingFiles, missingCount: missingFiles.length }
      : invalidFiles.length ? { kind: 'dependencies-invalid' } : { kind: null };
  }
  async function archiveMatches(file, signal) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.archive.bytes) return false;
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) { checkAbort(signal); digest.update(chunk); }
    checkAbort(signal); return digest.digest('hex') === manifest.archive.sha256;
  }
  async function extract(archive, stage, signal) {
      checkAbort(signal);
      const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        const child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DEPENDENCIES_EXTRACT_SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, shell: false, stdio: 'ignore', env: { ...env,
            ELYSIA_CHAT_DEPENDENCY_ARCHIVE: archive, ELYSIA_CHAT_DEPENDENCY_STAGE: stage,
            ELYSIA_CHAT_DEPENDENCY_FILES: JSON.stringify(manifest.files) } });
        const code = await helperProcesses.wait(child, { signal, timeoutMs: extractionTimeoutMs,
          timeoutError: () => failure('dependencies', 'extraction-timeout') });
        if (code !== 0) throw failure('dependencies', extractionKind(code), { exitCode: code });
      } catch (error) {
        if (error.setupCode || error.name === 'AbortError') throw error;
        const wrapped = failure('dependencies', classifySetupFailure(error, 'extraction-launch'),
          { preserveStage: error.preserveStage === true, setupProcessPending: error.setupProcessPending === true }, error);
        if (error.setupProcessExit) Object.defineProperty(wrapped, 'setupProcessExit', { value: error.setupProcessExit });
        throw wrapped;
      }
  }
  async function prepareInternal(directory, signal) {
    checkAbort(signal);
    if (pending()) throw failure('dependencies', 'storage-busy', { preserveStage: true });
    if (!valid) throw failure('manifest', 'manifest-invalid');
    if (ready(directory)) return;
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('dependencies');
    const originalPath = fs.realpathSync(directory);
    const assertRuntimeDirectory = () => {
      let current;
      try { current = fs.lstatSync(directory, { bigint: true }); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw failure('dependencies', 'storage-busy'); throw error; }
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino
        || fs.realpathSync(directory) !== originalPath) throw failure('dependencies', 'storage-busy');
    };
    // Always use app-owned, digest-pinned resources, never a system DLL or an
    // unverified file from PATH/another installed application.
    const directories = [assetDirectory, resourcesPath, path.join(__dirname, '..', 'build-resources', 'voice-bootstrap')].filter(Boolean);
    let archive, invalidSource = false, sourceError = null;
    for (const candidate of [...new Set(directories.map(folder => path.join(folder, manifest.archive.file)))]) {
      try {
        if (await archiveMatches(candidate, signal)) { archive = candidate; break; }
        if (fs.existsSync(candidate)) invalidSource = true;
      }
      catch (error) { if (error.name === 'AbortError') throw error; sourceError = error; }
    }
    if (!archive) throw failure('dependencies-source', sourceError ? classifySetupFailure(sourceError, 'unknown')
      : invalidSource ? 'dependencies-source-integrity' : 'dependencies-source-missing', {}, sourceError);
    assertRuntimeDirectory();
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(directory), 'chat-dependencies-staging-'));
    const stageIdentity = fs.lstatSync(stage, { bigint: true });
    const assertStage = () => {
      const current = fs.lstatSync(stage, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stageIdentity.dev || current.ino !== stageIdentity.ino) {
        throw failure('dependencies', 'storage-busy', { preserveStage: true });
      }
    };
    const removeOwnedStage = async () => {
      const current = await fs.promises.lstat(stage, { bigint: true });
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === stageIdentity.dev && current.ino === stageIdentity.ino) {
        await fs.promises.rm(stage, { recursive: true, force: true });
      }
    };
    let preserveStage = false;
    try {
      assertRuntimeDirectory(); assertStage();
      await extract(archive, stage, signal); checkAbort(signal);
      assertRuntimeDirectory(); assertStage();
      if (!manifest.files.every(item => fileMatches(path.join(stage, item.file), item))) throw failure('dependencies');
      for (const item of manifest.files) {
        checkAbort(signal); assertRuntimeDirectory(); assertStage();
        const target = path.join(directory, item.file);
        if (fileMatches(target, item)) continue;
        if (fs.existsSync(target)) {
          if (!ordinaryFile(target)) throw failure('dependencies');
          await fs.promises.rename(target, `${target}.unverified-${randomUUID()}`);
          assertRuntimeDirectory(); assertStage();
        }
        // Publish without overwriting a DLL created by another operation while
        // extraction was pending; linking does not duplicate resource bytes.
        const source = path.join(stage, item.file), expected = fs.lstatSync(source, { bigint: true });
        let moved = false;
        try { await fs.promises.link(source, target); }
        catch (error) {
          if (process.platform !== 'win32' || !isUnsupportedHardLink(error)) throw error;
          assertRuntimeDirectory(); assertStage();
          await moveFileNoReplace(source, target, { signal, expected, allowSameVolume: true });
          moved = true;
        }
        assertRuntimeDirectory(); assertStage();
        const published = fs.lstatSync(target, { bigint: true });
        if (!published.isFile() || published.isSymbolicLink() || published.dev !== expected.dev || published.ino !== expected.ino
          || published.size !== expected.size || published.mtimeNs !== expected.mtimeNs) throw failure('dependencies', 'storage-busy', { preserveStage: true });
        let remaining;
        try { remaining = fs.lstatSync(source, { bigint: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw Object.assign(error, { preserveStage: true }); }
        if (moved ? Boolean(remaining) : !remaining?.isFile() || remaining.isSymbolicLink() || remaining.dev !== expected.dev
          || remaining.ino !== expected.ino || remaining.size !== expected.size || remaining.mtimeNs !== expected.mtimeNs) {
          throw failure('dependencies', 'storage-busy', { preserveStage: true });
        }
        if (!moved) await fs.promises.unlink(source);
      }
      assertRuntimeDirectory();
      if (!ready(directory)) throw failure('dependencies');
    } catch (error) {
      preserveStage = error.preserveStage === true;
      if (error.setupProcessExit) {
        const confirmation = error.setupProcessExit; pendingExit = confirmation;
        void confirmation.then(() => { if (pendingExit === confirmation) pendingExit = null; return removeOwnedStage(); }).catch(() => {});
      }
      throw error;
    } finally { if (!preserveStage) await removeOwnedStage().catch(() => {}); }
  }
  async function prepare(directory, signal) {
    try { return await prepareInternal(directory, signal); }
    catch (error) {
      if (error.name === 'AbortError' || error.setupCode) throw error;
      const wrapped = failure('dependencies', classifySetupFailure(error, 'unknown'),
        { preserveStage: error.preserveStage === true, setupProcessPending: error.setupProcessPending === true }, error);
      if (error.setupProcessExit) Object.defineProperty(wrapped, 'setupProcessExit', { value: error.setupProcessExit });
      throw wrapped;
    }
  }
  return { ready, inspect, prepare, pending, dispose: helperProcesses.stop };
}

module.exports = { createRuntimeDependencies, validDependenciesManifest, DEPENDENCIES_EXTRACT_SCRIPT };

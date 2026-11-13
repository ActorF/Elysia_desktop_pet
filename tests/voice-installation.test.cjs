'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { REQUIRED, inspectVoiceInstallation } = require('../electron/voice-installation.cjs');

const sourceFile = path.resolve(__dirname, '../electron/voice-installation.cjs');
const source = fs.readFileSync(sourceFile, 'utf8');
const tempRoot = path.resolve(__dirname, '../artifacts/voice-setup-issue/temp');
const manifest = Object.freeze({ version: 1, assets: { sha256: 'a'.repeat(64) }, runtime: { sha256: 'b'.repeat(64) } });
const hashFilename = 'models/cache/GPT-SoVITS-v2-240821/runtime/Lib/site-packages/pandas/tests/io/data/legacy_pickle/1.2.4/empty_frame_v1_2_4-GH#42345.pkl';
function fixture(t) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'inspect-'));
  const project = path.join(directory, 'voice-runtime'), marker = path.join(project, 'voice-setup-complete.json');
  const markerValue = { version: 1, assets: manifest.assets.sha256, runtime: manifest.runtime.sha256, required: [...REQUIRED] };
  const write = (relative, data = 'small synthetic fixture') => {
    const file = path.join(project, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file;
  };
  const mark = (value = markerValue) => write('voice-setup-complete.json', typeof value === 'string' ? value : JSON.stringify(value));
  const install = () => { for (const relative of REQUIRED) write(relative); mark(); };
  const inspect = () => inspectVoiceInstallation(project, manifest);
  t.after(() => {
    const actual = fs.realpathSync(directory), parent = fs.realpathSync(tempRoot);
    assert.equal(path.dirname(actual), parent); assert.match(path.basename(actual), /^inspect-[A-Za-z0-9]+$/);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return { directory, project, marker, markerValue, write, mark, install, inspect };
}
function withFs(overrides) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'node:fs') return { ...fs, ...overrides };
    if (name === 'node:path') return path;
    throw new Error(`Unexpected import ${name}`);
  } }, { filename: sourceFile });
  return module.exports.inspectVoiceInstallation;
}
const denied = () => { throw Object.assign(new Error('Synthetic access denied'), { code: 'EACCES' }); };

test('absent and invalid-manifest inspections never create a directory', t => {
  const f = fixture(t);
  assert.equal(f.inspect().code, 'absent'); assert.equal(f.inspect().exists, false);
  assert.equal(inspectVoiceInstallation(f.project, null).code, 'invalid-manifest');
  assert.equal(inspectVoiceInstallation(f.project, { version: 1 }).code, 'invalid-manifest');
  assert.equal(fs.existsSync(f.project), false);
  assert.equal(inspectVoiceInstallation('relative/voice-runtime', manifest).code, 'invalid-directory');
});

test('complete installed resources remain recognized after normal caches and preference files appear', t => {
  const f = fixture(t); f.install();
  f.write('voice/__pycache__/profiles.cpython-314.pyc', 'cache'); f.write('workspace/settings/global.json', '{}'); f.write('diagnostics/session.log', 'log');
  const before = fs.readFileSync(f.marker, 'utf8');
  const status = f.inspect();
  assert.equal(status.code, 'ready'); assert.equal(status.ready, true); assert.equal(status.recognized, true); assert.equal(status.exists, true);
  assert.deepEqual(status.missingFiles, []); assert.equal(status.missingCount, 0);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.project, 'workspace/settings/global.json'), 'utf8'), '{}');
});

test('missing owned files are identified completely while only three paths appear in the message', t => {
  const f = fixture(t); f.install();
  for (const relative of REQUIRED.slice(0, 4)) fs.unlinkSync(path.join(f.project, relative));
  const status = f.inspect();
  assert.equal(status.code, 'missing-files'); assert.equal(status.recognized, true); assert.equal(status.ready, false);
  assert.equal(status.missingCount, 4); assert.deepEqual(status.missingFiles, REQUIRED.slice(0, 4));
  assert.match(status.message, /本地语音环境不完整/); assert.match(status.message, /共 4 个/);
  assert.doesNotMatch(status.message, /另一套|未识别/); assert.ok(!status.message.includes(REQUIRED[3]));
  assert.equal(fs.existsSync(f.marker), true); assert.equal(fs.existsSync(path.join(f.project, REQUIRED[4])), true);
});

test('an existing unmarked directory remains unrecognized and untouched', t => {
  const f = fixture(t); f.write('keep.txt', 'unrelated user-owned file');
  const status = f.inspect();
  assert.equal(status.code, 'missing-marker'); assert.equal(status.exists, true); assert.equal(status.recognized, false);
  assert.match(status.message, /缺少安装完成标记/); assert.doesNotMatch(status.message, /另一套/);
  assert.deepEqual(fs.readdirSync(f.project), ['keep.txt']); assert.equal(fs.readFileSync(path.join(f.project, 'keep.txt'), 'utf8'), 'unrelated user-owned file');
});

test('marker syntax, shape, size and mandatory paths are checked before any resource is trusted', t => {
  const f = fixture(t); f.install();
  const invalid = ['{broken', '', '[]', { ...f.markerValue, version: '1' }, { ...f.markerValue, assets: 'not-a-digest' },
    { ...f.markerValue, required: REQUIRED.slice(1) }, { ...f.markerValue, required: [...REQUIRED.slice(1), 'extra.txt'] },
    { ...f.markerValue, required: [...REQUIRED, '../outside'] }, { ...f.markerValue, required: [...REQUIRED, 'C:\\outside'] },
    { ...f.markerValue, required: [...REQUIRED, 'folder/NUL.txt'] }, { ...f.markerValue, required: [...REQUIRED, 'folder/file.'] },
    { ...f.markerValue, required: [...REQUIRED, 'folder//file'] }, { ...f.markerValue, required: [...REQUIRED, 7] },
    { ...f.markerValue, required: [...REQUIRED, ...Array.from({ length: 194 }, (_, i) => `extra-${i}`)] }];
  for (const value of invalid) { f.mark(value); const status = f.inspect(); assert.equal(status.code, 'invalid-marker'); assert.equal(status.recognized, false); }
  f.mark(' '.repeat(65537));
  const inspect = withFs({ readFileSync() { assert.fail('oversized marker must not be read'); } });
  assert.equal(inspect(f.project, manifest).code, 'invalid-marker');
});

test('different marker and resource versions remain distinct from missing files', t => {
  const f = fixture(t); f.install();
  f.mark({ ...f.markerValue, version: 2 }); const incompatible = f.inspect();
  assert.equal(incompatible.code, 'version-mismatch'); assert.equal(incompatible.recognized, false);
  assert.equal(incompatible.actualVersion, 2); assert.equal(incompatible.expectedVersion, manifest.version);
  f.mark({ ...f.markerValue, runtime: 'c'.repeat(64) }); assert.equal(f.inspect().code, 'resource-mismatch'); assert.equal(f.inspect().recognized, false);
  f.mark({ ...f.markerValue, assets: manifest.assets.sha256.toUpperCase(), runtime: manifest.runtime.sha256.toUpperCase() }); assert.equal(f.inspect().code, 'ready');
});

test('marker resource paths reject query-like, illegal and excessive names before filesystem inspection', t => {
  const f = fixture(t); f.install();
  const illegal = ['folder/file?token=secret', 'folder/*.bin', 'folder/<file',
    'folder/file>', 'folder/"file', 'folder/file|data', 'folder#tag/../secret', 'folder#tag/file:secret', 'a'.repeat(241)];
  const inspect = withFs({ lstatSync(file) {
    assert.ok(file === f.project || file === f.marker, 'invalid marker must not inspect its resource paths');
    return fs.lstatSync(file);
  } });
  for (const relative of illegal) {
    f.mark({ ...f.markerValue, required: [...REQUIRED, relative] });
    const before = fs.readFileSync(f.marker, 'utf8'), status = inspect(f.project, manifest);
    assert.equal(status.code, 'invalid-marker'); assert.equal(status.recognized, false);
    assert.equal(status.missingFiles.length, 0); assert.doesNotMatch(JSON.stringify(status), /secret|token=/);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), before);
  }
  const longest = 'a'.repeat(240);
  f.mark({ ...f.markerValue, required: [...REQUIRED, longest] });
  const inspectBoundary = withFs({ lstatSync(file) {
    if (file === path.join(f.project, longest)) throw Object.assign(new Error('synthetic absent file'), { code: 'ENOENT' });
    return fs.lstatSync(file);
  } });
  const boundary = inspectBoundary(f.project, manifest);
  assert.equal(boundary.code, 'missing-files'); assert.equal(boundary.missingFiles[0], longest);
});

test('a real runtime filename containing a hash sign is valid and remains identifiable if missing', t => {
  const f = fixture(t); f.install();
  f.write(hashFilename); f.mark({ ...f.markerValue, required: [...REQUIRED, hashFilename] });
  const original = fs.readFileSync(f.marker, 'utf8');
  assert.equal(f.inspect().code, 'ready');
  fs.unlinkSync(path.join(f.project, hashFilename));
  const missing = f.inspect(); assert.equal(missing.code, 'missing-files');
  assert.deepEqual(missing.missingFiles, [hashFilename]); assert.equal(fs.readFileSync(f.marker, 'utf8'), original);
});

test('the PowerShell diagnostic accepts the real hash-sign filename while rejecting unsafe paths', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); f.install(); f.write(hashFilename);
  const script = path.resolve(__dirname, '../scripts/diagnose-voice-setup.ps1');
  const run = (name, required) => {
    f.mark({ ...f.markerValue, required });
    const markerBefore = fs.readFileSync(f.marker, 'utf8'), output = path.join(f.directory, `${name}.json`);
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ProfilePath', f.directory, '-OutputPath', output], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(f.marker, 'utf8'), markerBefore);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  };
  const valid = run('valid-hash', [...REQUIRED, hashFilename]);
  assert.equal(valid.requiredListStatus, 'valid'); assert.equal(valid.invalidEntries, 0); assert.deepEqual(valid.fileProblems, []);
  const unsafe = run('unsafe', [...REQUIRED, 'folder#tag/../secret', 'file#tag:secret', 'file?token=secret']);
  assert.equal(unsafe.requiredListStatus, 'invalid-entries'); assert.equal(unsafe.invalidEntries, 3);
  assert.equal(unsafe.filesChecked, REQUIRED.length); assert.doesNotMatch(JSON.stringify(unsafe), /secret|token=/);
});

test('ordinary-directory and ordinary-file requirements reject substituted types', t => {
  const f = fixture(t); fs.writeFileSync(f.project, 'this is a file');
  assert.equal(f.inspect().code, 'invalid-directory'); fs.unlinkSync(f.project); f.install();
  fs.unlinkSync(f.marker); fs.mkdirSync(f.marker); assert.equal(f.inspect().code, 'invalid-marker'); fs.rmdirSync(f.marker); f.mark();
  fs.unlinkSync(path.join(f.project, 'config/settings.py')); fs.mkdirSync(path.join(f.project, 'config/settings.py'));
  assert.equal(f.inspect().code, 'invalid-directory'); assert.equal(f.inspect().recognized, true);
});

test('root and intermediate directory links are rejected without following their targets', t => {
  const f = fixture(t), target = path.join(f.directory, 'target'); fs.mkdirSync(target);
  fs.symlinkSync(target, f.project, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.inspect().code, 'linked-directory'); assert.equal(f.inspect().recognized, false);
  fs.unlinkSync(f.project); f.install();
  fs.unlinkSync(path.join(f.project, 'config/settings.py')); fs.rmdirSync(path.join(f.project, 'config'));
  fs.symlinkSync(target, path.join(f.project, 'config'), process.platform === 'win32' ? 'junction' : 'dir');
  const inspect = withFs({ lstatSync(file) {
    assert.notEqual(file, path.join(f.project, 'config/settings.py'), 'linked directory children must not be followed'); return fs.lstatSync(file);
  } });
  const status = inspect(f.project, manifest); assert.equal(status.code, 'linked-directory'); assert.equal(status.recognized, true);
});

test('marker and resource file links are rejected even if their targets look valid', t => {
  const f = fixture(t); f.install();
  const linkedStats = file => ({ ...fs.lstatSync(file), isSymbolicLink: () => true, isFile: () => true });
  const markerInspection = withFs({ lstatSync: file => file === f.marker ? linkedStats(file) : fs.lstatSync(file),
    readFileSync() { assert.fail('marker link must not be read'); } });
  assert.equal(markerInspection(f.project, manifest).code, 'invalid-marker');
  const linkedFile = path.join(f.project, 'python/python314.zip');
  const resourceInspection = withFs({ lstatSync: file => file === linkedFile ? linkedStats(file) : fs.lstatSync(file) });
  assert.equal(resourceInspection(f.project, manifest).code, 'linked-directory');
  assert.equal(resourceInspection(f.project, manifest).recognized, true);
});

test('access errors are reported as unreadable, never as missing or safe-to-replace', t => {
  const f = fixture(t); f.install();
  const root = withFs({ lstatSync: file => file === f.project ? denied() : fs.lstatSync(file) });
  assert.equal(root(f.project, manifest).code, 'unreadable-directory'); assert.equal(root(f.project, manifest).exists, true);
  const marker = withFs({ readFileSync: denied }); assert.equal(marker(f.project, manifest).code, 'unreadable-marker');
  const markerStat = withFs({ lstatSync: file => file === f.marker ? denied() : fs.lstatSync(file) }); assert.equal(markerStat(f.project, manifest).code, 'unreadable-marker');
  const file = path.join(f.project, 'python/python314.zip');
  const resource = withFs({ lstatSync: candidate => candidate === file ? denied() : fs.lstatSync(candidate) });
  const status = resource(f.project, manifest); assert.equal(status.code, 'unreadable-directory'); assert.equal(status.recognized, true); assert.equal(status.missingCount, 0);
});

test('inspection reads only the marker and never writes files or reads chat contents', t => {
  const f = fixture(t); f.install(); fs.writeFileSync(path.join(f.directory, 'chat-state.json'), '{"private":"fixture"}');
  const calls = [];
  const failWrite = () => assert.fail('inspection must not mutate the filesystem');
  const inspect = withFs({ writeFileSync: failWrite, appendFileSync: failWrite, mkdirSync: failWrite, rmSync: failWrite, renameSync: failWrite,
    openSync: failWrite, readFileSync(file, encoding) { calls.push(file); assert.equal(file, f.marker); return fs.readFileSync(file, encoding); } });
  assert.equal(inspect(f.project, manifest).code, 'ready'); assert.deepEqual(calls, [f.marker]);
  assert.equal(fs.readFileSync(path.join(f.directory, 'chat-state.json'), 'utf8'), '{"private":"fixture"}');
});

/** Prepare only the selected speech assets and a movable Python bridge; never copy a personal environment or chat database. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
async function main() {
const root = path.resolve(__dirname, '..');
const project = process.env.ELYSIA_VOICE_SOURCE || 'D:\\Elysia_AI';
const output = path.join(root, 'build-resources', 'voice-bootstrap');
fs.mkdirSync(output, { recursive: true });
const stagingRoot = path.join(root, 'artifacts', 'voice-bootstrap-build');
fs.mkdirSync(stagingRoot, { recursive: true });
const staging = fs.mkdtempSync(path.join(stagingRoot, 'staging-'));
const bundle = path.join(staging, 'bundle'); fs.mkdirSync(bundle);
const sevenZip = require.resolve('electron-winstaller/vendor/7z.exe');
const run = args => execFileSync(sevenZip, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copy(from, relative) {
  const target = path.resolve(bundle, relative);
  assert.ok(target.startsWith(bundle + path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(from, target);
}
function write(relative, content) {
  const target = path.join(bundle, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
}

// Reuse the already built, fixed CPython embedded distribution. Its private app
// source and unrelated site packages are excluded using an exact path list.
const installer = path.join(project, 'desktop', 'out', 'Elysia-Setup-0.1.0.exe');
run(['e', installer, '$PLUGINSDIR/app-64.7z', '-o' + staging, '-y']);
const payload = path.join(staging, 'app-64.7z');
const listing = run(['l', '-slt', payload]);
const packages = new Set(['requests', 'urllib3', 'certifi', 'idna', 'charset_normalizer', 'dotenv']);
const selected = listing.split(/\r?\n/).filter(line => line.startsWith('Path = ')).map(line => line.slice(7))
  .filter(name => {
    const normalized = name.replaceAll('\\', '/');
    if (!normalized.startsWith('resources/backend/python/')) return false;
    const relative = normalized.slice('resources/backend/python/'.length);
    if (!relative.includes('/')) return relative !== 'Lib';
    if (/^Lib\/site-packages\/ada92cb5d92a588d1b93__mypyc\.[^/]+\.pyd$/.test(relative)) return true;
    const match = /^Lib\/site-packages\/([^/]+)\//.exec(relative);
    return !!match && !relative.includes('/__pycache__/') && (packages.has(match[1])
      || /^(requests|urllib3|certifi|idna|charset_normalizer|python_dotenv)-[^/]+\.dist-info$/.test(match[1]));
  });
assert.ok(selected.some(file => file.endsWith('python.exe')));
assert.ok(selected.some(file => /requests[/\\]__init__\.py$/.test(file)));
const listFile = path.join(staging, 'python-files.txt'); fs.writeFileSync(listFile, selected.join('\n'));
const extracted = path.join(staging, 'python-source');
run(['x', payload, '-i@' + listFile, '-scsUTF-8', '-o' + extracted, '-y']);
fs.cpSync(path.join(extracted, 'resources', 'backend', 'python'), path.join(bundle, 'python'), { recursive: true });
write('python/python314._pth', 'python314.zip\n.\nLib/site-packages\n');

for (const name of ['managed_gpt_sovits.py', 'profiles.py', 'gpt_sovits.py', 'synthesis.py', '_windows_managed_process.py', '_windows_file_guard.py']) {
  copy(path.join(project, 'voice', name), 'voice/' + name);
}
for (const name of ['gpt_sovits_worker.py', 'gpt_sovits_protocol.py']) copy(path.join(project, 'scripts', name), 'scripts/' + name);
for (const name of ['voice', 'scripts', 'config']) write(`${name}/__init__.py`, '');
write('config/settings.py', `"""Movable speech-only settings. No personal .env or application data is loaded."""\nfrom pathlib import Path\nfrom types import SimpleNamespace\nROOT = Path(__file__).resolve().parent.parent\nSETTINGS = SimpleNamespace(\n    model_assets_root=ROOT / "models",\n    data_layout=SimpleNamespace(settings=ROOT / "workspace" / "settings"),\n    voice_profile_id="elysia-v2", voice_emotion="neutral", speech_rate_percent=100,\n    gpt_sovits_allow_local_evaluation=True, gpt_sovits_deterministic_seed=42,\n)\n`);
const catalogFile = path.join(project, 'workspace', 'settings', 'voice-profiles.json');
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const profile = catalog.profiles.find(item => item.profile_id === 'elysia-v2'); assert.ok(profile);
write('workspace/settings/voice-profiles.json', JSON.stringify({ schema_version: catalog.schema_version, default_profile_id: profile.profile_id, profiles: [profile] }, null, 2) + '\n');
const weights = path.join(project, 'models', 'weights', 'gpt-sovits');
for (const asset of [profile.gpt_weights, profile.sovits_weights, ...profile.references.map(reference => reference.audio)]) {
  const source = path.resolve(weights, asset.path);
  assert.ok(source.startsWith(weights + path.sep), 'Voice asset escapes the approved source directory');
  assert.equal(fs.statSync(source).size, asset.bytes); assert.equal(hash(source), asset.sha256);
  copy(source, 'models/weights/gpt-sovits/' + asset.path);
}
// These pronunciation assets were installed separately after the upstream
// runtime archive. Include the exact files bound by the managed worker.
for (const file of ['corpora/cmudict.zip', 'corpora/cmudict/cmudict',
  'taggers/averaged_perceptron_tagger.zip', 'taggers/averaged_perceptron_tagger/averaged_perceptron_tagger.pickle']) {
  const relative = 'models/cache/GPT-SoVITS-v2-240821/runtime/nltk_data/' + file;
  copy(path.join(project, relative), relative);
}
copy(path.join(project, 'LICENSE'), 'notices/Elysia-AI-LICENSE');
copy(path.join(project, 'MODEL_LICENSE.md'), 'notices/Elysia-AI-MODEL_LICENSE.md');
write('VOICE-BUNDLE-NOTICE.txt', 'Elysia AI speech bridge, selected Elysia v2 model weights and emotion references.\nModel, character, recording and runtime rights remain with their respective owners.\nPrepared locally for the requested automatic setup; no private chats, .env or application databases are included.\n');

// Prove that the embedded interpreter can import the entire adapter before
// packaging. This does not initialize or load a speech model.
const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }; delete env.PYTHONHOME; delete env.PYTHONPATH;
execFileSync(path.join(bundle, 'python', 'python.exe'), ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from config.settings import SETTINGS; from voice.managed_gpt_sovits import ManagedGptSovitsRuntime; from voice.profiles import JsonVoiceProfileCatalog; c=JsonVoiceProfileCatalog.load(SETTINGS.data_layout.settings / "voice-profiles.json", SETTINGS.model_assets_root / "weights" / "gpt-sovits", allow_local_evaluation=True); c.resolve_selection("elysia-v2", "happy"); print("speech bundle imports and assets verified")', bundle], { env, windowsHide: true, stdio: 'inherit' });
const archive = path.join(staging, 'Elysia-voice-assets-v1.zip');
execFileSync(sevenZip, ['a', '-tzip', '-mx=5', archive, '.'], { cwd: bundle, windowsHide: true, stdio: 'ignore' });
const destination = path.join(output, path.basename(archive)); fs.copyFileSync(archive, destination);
const extractor = await require('app-builder-lib/out/toolsets/7zip.js').getPath7za();
const toolDirectory = path.join(output, 'tools'); fs.mkdirSync(toolDirectory, { recursive: true });
fs.copyFileSync(extractor, path.join(toolDirectory, '7za.exe'));
for (const name of ['LICENSE.txt', 'COPYING']) fs.copyFileSync(path.join(path.dirname(extractor), '..', name), path.join(toolDirectory, name));
const manifest = {
  version: 1,
  assets: { fileName: path.basename(destination), bytes: fs.statSync(destination).size, sha256: hash(destination),
    url: null },
  runtime: { fileName: 'GPT-SoVITS-v2-240821.7z', bytes: 5744891255,
    sha256: '9d9ba79de6aca0cf28a3635ccb1dbbb08b6aef362c4352e32fad99bb49e3000a',
    url: 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/42b55dd0c41f0d23218f8f7c1e9e0636a0e386e8/GPT-SoVITS-v2-240821.7z' },
  extractor: { relativePath: 'tools/7za.exe', sha256: hash(extractor) },
};
fs.writeFileSync(path.join(root, 'electron', 'voice-bootstrap-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(destination + '.sha256', `${manifest.assets.sha256}  ${manifest.assets.fileName}\n`);
fs.writeFileSync(path.join(output, 'build-report.json'), JSON.stringify({ ...manifest, builtFromLocalSources: true }, null, 2));
const actualStaging = fs.realpathSync(staging), actualStagingRoot = fs.realpathSync(stagingRoot);
assert.equal(path.dirname(actualStaging), actualStagingRoot);
assert.match(path.basename(actualStaging), /^staging-[A-Za-z0-9]+$/);
fs.rmSync(actualStaging, { recursive: true, force: true });
console.log(JSON.stringify({ archive: destination, bytes: manifest.assets.bytes, sha256: manifest.assets.sha256, builtFromLocalSources: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

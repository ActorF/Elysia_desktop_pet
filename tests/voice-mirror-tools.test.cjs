'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { prepareVoiceMirror, renderReadme, containedPath } = require('../scripts/prepare-voice-mirror.cjs');
const { configureVoiceMirror, verifyMetadata, validateRepo } = require('../scripts/configure-voice-mirror.cjs');
const original = require('../electron/voice-bootstrap-manifest.json');
const REVISION = 'a'.repeat(40), REPO = 'test-owner/voice-runtime';

function fixture(t) {
  const parent = path.resolve(__dirname, '../artifacts/test-temp/voice-mirror-tools');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('small pinned voice archive fixture');
  const manifest = structuredClone(original);
  delete manifest.runtime.sources;
  Object.assign(manifest.runtime, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  fs.mkdirSync(path.join(root, 'electron'));
  const manifestPath = path.join(root, 'electron/voice-bootstrap-manifest.json');
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(manifestPath, raw);
  const calls = [], runtime = manifest.runtime;
  let cancelled = false;
  const metadata = { Success: true, Code: 200, Data: { Files: [{ Name: runtime.fileName, Path: runtime.fileName,
    Size: runtime.bytes, Sha256: runtime.sha256, Revision: REVISION }] } };
  const source = `https://www.modelscope.cn/models/${REPO}/resolve/${REVISION}/${runtime.fileName}`;
  const hash = runtime.sha256, cdn = `https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}?signed=example`;
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.headers['User-Agent']);
    if (url.includes('/api/v1/models/')) return new Response(JSON.stringify(metadata));
    assert.equal(options.headers.Range, 'bytes=0-0');
    if (url === source) return new Response(null, { status: 302, headers: { location: cdn } });
    assert.equal(url, cdn);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 1)); }, cancel() { cancelled = true; } }),
      { status: 206, headers: { 'content-range': `bytes 0-0/${runtime.bytes}`, 'content-length': '1' } });
  };
  return { root, bytes, manifest, manifestPath, runtime, raw, calls, metadata, source, cdn, fetch, cancelled: () => cancelled };
}

test('prepare defaults to a plan without downloads, cache creation, or manifest edits', async t => {
  const f = fixture(t);
  const result = await prepareVoiceMirror({ root: f.root, fetchImpl: () => { throw new Error('network forbidden'); } });
  assert.equal(result.action, 'dry-run');
  assert.equal(result.files.length, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'build-resources')), false);
  assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), f.raw);
});

test('explicit prepare writes only the verified original archive and provenance README', async t => {
  const f = fixture(t);
  const result = await prepareVoiceMirror({ root: f.root, download: true, fetchImpl: async url => {
    assert.equal(url, f.runtime.url); return new Response(f.bytes);
  } });
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'build-resources/voice-mirror')).sort(), [f.runtime.fileName, 'README.md'].sort());
  assert.deepEqual(fs.readFileSync(result.files[0]), f.bytes);
  assert.equal(fs.readFileSync(result.files[1], 'utf8'), renderReadme(f.runtime));
  assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), f.raw);
});

test('prepare rejects changed archive bytes and never produces an approved README', async t => {
  const f = fixture(t);
  await assert.rejects(prepareVoiceMirror({ root: f.root, download: true, fetchImpl: async () => new Response(Buffer.alloc(f.bytes.length)) }), error => error.setupCode === 'integrity');
  assert.equal(fs.existsSync(path.join(f.root, 'build-resources/voice-mirror/README.md')), false);
});

test('path and repository validation reject traversal before any requests', async t => {
  const f = fixture(t);
  assert.throws(() => containedPath(f.root, '../private-file'), /outside/);
  for (const repo of ['../private', 'owner/../name', 'owner/name?token=secret', 'https://example.com/repo']) assert.throws(() => validateRepo(repo));
  await assert.rejects(configureVoiceMirror({ root: f.root, repo: '../private', fetchImpl: () => { throw new Error('must not fetch'); } }));
});

test('configure dry run checks anonymous digest-specific Range and leaves manifest untouched', async t => {
  const f = fixture(t);
  const result = await configureVoiceMirror({ root: f.root, repo: REPO, fetchImpl: f.fetch });
  assert.equal(result.action, 'dry-run');
  assert.deepEqual(result.sources, [f.source, f.runtime.url]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.cancelled(), true);
  assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), f.raw);
});

test('configure apply updates only runtime.sources after all public checks succeed', async t => {
  const f = fixture(t);
  await configureVoiceMirror({ root: f.root, repo: REPO, apply: true, fetchImpl: f.fetch });
  const changed = JSON.parse(fs.readFileSync(f.manifestPath));
  assert.deepEqual(changed.runtime.sources, [f.source, f.runtime.url]);
  delete changed.runtime.sources;
  assert.deepEqual(changed, f.manifest);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'electron')), ['voice-bootstrap-manifest.json']);
});

test('mismatched metadata, duplicate entries, and mutable revisions cannot enable a mirror', async t => {
  const f = fixture(t);
  for (const change of [{ Size: f.runtime.bytes + 1 }, { Sha256: '0'.repeat(64) }, { Revision: 'master' }, { Revision: '' }]) {
    const metadata = structuredClone(f.metadata); Object.assign(metadata.Data.Files[0], change);
    assert.throws(() => verifyMetadata(metadata, f.runtime));
  }
  const duplicate = structuredClone(f.metadata); duplicate.Data.Files.push(duplicate.Data.Files[0]);
  assert.throws(() => verifyMetadata(duplicate, f.runtime));
  f.metadata.Data.Files[0].Sha256 = '0'.repeat(64);
  await assert.rejects(configureVoiceMirror({ root: f.root, repo: REPO, apply: true, fetchImpl: f.fetch }));
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), f.raw);
});

test('untrusted redirect is never followed and a full-file response cannot enable a mirror', async t => {
  for (const mode of ['redirect', 'full']) {
    const f = fixture(t), seen = [];
    let cancelled = false;
    await assert.rejects(configureVoiceMirror({ root: f.root, repo: REPO, apply: true, fetchImpl: async (url, options) => {
      seen.push(url);
      if (url.includes('/api/v1/models/')) return new Response(JSON.stringify(f.metadata));
      assert.equal(url, f.source);
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
    } }));
    assert.equal(seen.length, 2);
    if (mode === 'full') assert.equal(cancelled, true);
    assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), f.raw);
  }
});

test('concurrent manifest changes are retained instead of overwritten by configure', async t => {
  const f = fixture(t), replacement = f.raw.replace('"version": 1', '"version": 2');
  await assert.rejects(configureVoiceMirror({ root: f.root, repo: REPO, apply: true, fetchImpl: async (url, options) => {
    const response = await f.fetch(url, options);
    if (url === f.cdn) fs.writeFileSync(f.manifestPath, replacement);
    return response;
  } }), /changed during/);
  assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), replacement);
});

test('valid Range headers without an actual one-byte transfer cannot enable the mirror', async t => {
  for (const body of [Buffer.alloc(0), Buffer.from('too much')]) {
    const f = fixture(t);
    await assert.rejects(configureVoiceMirror({ root: f.root, repo: REPO, apply: true, fetchImpl: async url => {
      if (url.includes('/api/v1/models/')) return new Response(JSON.stringify(f.metadata));
      return new Response(body, { status: 206, headers: { 'content-range': `bytes 0-0/${f.runtime.bytes}`, 'content-length': '1' } });
    } }), /one-byte body/);
    assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), f.raw);
  }
});

test('Python publisher verifies the same README and sends only the two reviewed files', async t => {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') { t.skip('Python is unavailable on this test runner.'); return; }
  const f = fixture(t);
  await prepareVoiceMirror({ root: f.root, download: true, fetchImpl: async () => new Response(f.bytes) });
  const python = String.raw`
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('voice_publisher',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
plan=module.build_plan(Path(sys.argv[2]))
calls=[]
class FakeApi:
 def __init__(self,**kwargs):
  assert kwargs['token']=='fixture-token-not-real'
  assert kwargs['endpoint']=='https://modelscope.cn'
 def create_repo(self,*args,**kwargs): calls.append(['create',list(args),kwargs])
 def upload_file(self,*args): calls.append(['upload',list(args)])
module.publish_plan(plan,'test-owner/voice-runtime',api_factory=FakeApi)
assert len(calls)==3 and calls[1][1][-1]==module.FILE_NAME and calls[2][1][-1]=='README.md'
for name in ['MODELSCOPE_HOME','MODELSCOPE_CACHE','TEMP','TMP','TMPDIR','XDG_CACHE_HOME']:
 assert Path(os.environ[name]).is_relative_to(Path(sys.argv[2]))
assert os.environ['MODELSCOPE_ENDPOINT']=='https://modelscope.cn'
readme=plan['files'][1][0]
readme.write_text('unapproved local content',encoding='utf-8')
try: module.build_plan(Path(sys.argv[2]))
except ValueError: pass
else: raise AssertionError('Changed README should not be uploadable')
print(json.dumps({'files':[remote for local,remote in plan['files']],'calls':len(calls)}))
`;
  const output = execFileSync('python', ['-B', '-c', python, path.resolve(__dirname, '../scripts/publish-voice-mirror.py'), f.root], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MODELSCOPE_API_TOKEN: 'fixture-token-not-real', PYTHONDONTWRITEBYTECODE: '1', TEMP: f.root, TMP: f.root },
  });
  assert.equal(output.includes('fixture-token-not-real'), false);
  assert.deepEqual(JSON.parse(output), { files: [f.runtime.fileName, 'README.md'], calls: 3 });
});

test('publisher rejects accidentally supplied credential arguments without echoing them', t => {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') { t.skip('Python is unavailable on this test runner.'); return; }
  const result = spawnSync('python', ['-B', path.resolve(__dirname, '../scripts/publish-voice-mirror.py'),
    '--repo', REPO, '--token', 'fixture-secret-never-print'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes('fixture-secret-never-print'), false);
  assert.match(result.stderr, /Credentials belong in MODELSCOPE_API_TOKEN/);
});

test('empty token environment does not shadow the project-local saved login', async t => {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') { t.skip('Python is unavailable on this test runner.'); return; }
  const f = fixture(t);
  await prepareVoiceMirror({ root: f.root, download: true, fetchImpl: async () => new Response(f.bytes) });
  const python = String.raw`
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('voice_publisher',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
plan=module.build_plan(Path(sys.argv[2]))
assert os.environ['MODELSCOPE_API_TOKEN']==''
calls=[]
class SavedLoginApi:
 def __init__(self,**kwargs):
  assert kwargs['token'] is None
  assert kwargs['endpoint']=='https://modelscope.cn'
  # Mirrors SDK 0.6.1 config precedence without opening any credential file.
  effective=os.environ['MODELSCOPE_API_TOKEN'] if 'MODELSCOPE_API_TOKEN' in os.environ else 'fixture-saved-login'
  assert effective=='fixture-saved-login'
 def create_repo(self,*args,**kwargs): calls.append('create')
 def upload_file(self,*args): calls.append(args[-1])
module.publish_plan(plan,'test-owner/voice-runtime',api_factory=SavedLoginApi)
assert 'MODELSCOPE_API_TOKEN' not in os.environ
assert calls==['create',module.FILE_NAME,'README.md']
print(json.dumps({'savedLoginSelected':True,'uploads':len(calls)-1}))
`;
  const output = execFileSync('python', ['-B', '-c', python, path.resolve(__dirname, '../scripts/publish-voice-mirror.py'), f.root], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MODELSCOPE_API_TOKEN: '', PYTHONDONTWRITEBYTECODE: '1', TEMP: f.root, TMP: f.root },
  });
  assert.equal(output.includes('fixture-saved-login'), false);
  assert.deepEqual(JSON.parse(output), { savedLoginSelected: true, uploads: 2 });
});

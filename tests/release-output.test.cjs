'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveReleaseOutput } = require('../scripts/release-output.cjs');
const parent = path.resolve(__dirname, '../artifacts/release-1.4.6-review/output-fixtures');
const manifest = { version: '1.4.6', build: { directories: { output: 'release' } } };

function fixture(t) {
  fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, release: path.join(root, 'release'), output: path.join(root, 'release', 'build-v1.4.6'),
    resolve: (env = {}, options = {}) => resolveReleaseOutput({ root, manifest, env, ...options }) };
}

test('default release path stays compatible and resolution never creates or deletes build files', t => {
  const f = fixture(t);
  assert.equal(f.resolve(), f.release); assert.equal(fs.existsSync(f.release), false);
  fs.mkdirSync(f.release); fs.writeFileSync(path.join(f.release, 'old-portable.fixture'), 'keep');
  assert.equal(f.resolve({}, { requireFresh: true }), f.release);
  assert.equal(fs.readFileSync(path.join(f.release, 'old-portable.fixture'), 'utf8'), 'keep');
});

test('an explicit current-version output accepts only a missing or empty directory for building', t => {
  const f = fixture(t), env = { ELYSIA_RELEASE_OUTPUT: 'release/build-v1.4.6' };
  assert.equal(f.resolve(env, { requireFresh: true }), f.output); assert.equal(fs.existsSync(f.output), false);
  fs.mkdirSync(f.output, { recursive: true });
  assert.equal(f.resolve({ ELYSIA_RELEASE_OUTPUT: f.output }, { requireFresh: true }), f.output);
  fs.writeFileSync(path.join(f.output, 'prior-build.fixture'), 'preserve previous output');
  assert.throws(() => f.resolve(env, { requireFresh: true }), /not empty/);
  assert.equal(f.resolve(env), f.output, 'verification must be able to inspect the completed build');
  assert.equal(fs.readFileSync(path.join(f.output, 'prior-build.fixture'), 'utf8'), 'preserve previous output');
});

test('output overrides reject older versions, arbitrary directories, traversal and malformed paths', t => {
  const f = fixture(t);
  for (const value of ['', 'release', 'release/build-v1.4.5', 'release/win-unpacked', 'artifacts/build-v1.4.6',
    'release/other/../build-v1.4.6', './release/build-v1.4.6', '../release/build-v1.4.6', 'release/build-v1.4.6\0',
    path.join(parent, 'outside-release'), null, 123]) {
    assert.throws(() => f.resolve({ ELYSIA_RELEASE_OUTPUT: value }), /release output|Release output/);
  }
  assert.throws(() => f.resolve({}, { manifest: { ...manifest, build: { directories: { output: '../release' } } } }), /output path/);
  assert.throws(() => f.resolve({}, { manifest: { ...manifest, version: '1.4.6-preview' } }), /stable release/);
});

test('a file at the output location or an existing ancestor is never treated as a build directory', t => {
  const f = fixture(t); fs.mkdirSync(f.release); fs.writeFileSync(f.output, 'unrelated file');
  assert.throws(() => f.resolve({ ELYSIA_RELEASE_OUTPUT: f.output }), /ordinary directories/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'unrelated file');
});

for (const level of ['output', 'release', 'workspace']) test(`a ${level} directory link is rejected without modifying its destination`, t => {
  const f = fixture(t), target = path.join(f.root, 'retained-target'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.fixture'), 'untouched');
  if (level === 'output') {
    fs.mkdirSync(f.release); fs.symlinkSync(target, f.output, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.resolve({ ELYSIA_RELEASE_OUTPUT: f.output }), /without links/);
  } else if (level === 'release') {
    fs.symlinkSync(target, f.release, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.resolve(), /without links/);
  } else {
    const linked = path.join(f.root, 'linked-workspace'); fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveReleaseOutput({ root: linked, manifest, env: {} }), /without links/);
  }
  assert.equal(fs.readFileSync(path.join(target, 'keep.fixture'), 'utf8'), 'untouched');
});

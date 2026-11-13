'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createVoiceSetup } = require('../electron/voice-setup.cjs');

test('cancelling a large flat post-extraction scan stops before reading every remaining file', async t => {
  const parent = path.resolve(__dirname, '../artifacts/deep-audit-round2/voice-scan'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), userData = path.join(root, 'profile');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { version: 1, extractor: { relativePath: 'tools/7za.exe', sha256: sha('extractor') } };
  fs.mkdirSync(path.join(root, 'tools')); fs.writeFileSync(path.join(root, 'tools/7za.exe'), 'extractor');
  for (const [key, fileName] of [['assets', 'assets.zip'], ['runtime', 'runtime.7z']]) {
    const bytes = Buffer.from(key); fs.writeFileSync(path.join(root, fileName), bytes);
    manifest[key] = { fileName, bytes: bytes.length, sha256: sha(bytes) };
  }
  let scans = 0;
  const originalStat = fs.promises.lstat.bind(fs.promises);
  t.mock.method(fs.promises, 'lstat', async (file, ...options) => {
    if (/^entry\d+$/.test(path.basename(file))) { scans++; if (scans === 1) assert.equal(service.cancel().ok, true); }
    return originalStat(file, ...options);
  });
  const service = createVoiceSetup({ userData, manifest, resourcesPath: root, assetDirectory: root,
    fetchImpl: () => assert.fail('no downloads'), statfsImpl: async () => ({ bsize: 1, bavail: 1024 ** 3 }),
    spawnImpl: (file, args) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit('close', 1)); };
      queueMicrotask(() => {
        if (args[0] === 'l') child.stdout.write('----------\nPath = runtime\nSize = 64\nAttributes = D\n\n');
        if (args[0] === 'x') {
          const runtime = path.join(args.find(arg => arg.startsWith('-o')).slice(2), 'runtime'); fs.mkdirSync(runtime, { recursive: true });
          fs.writeFileSync(path.join(runtime, 'python.exe'), 'inert');
          for (let index = 0; index < 50; index++) fs.writeFileSync(path.join(runtime, `entry${index}`), 'small');
        }
        child.stdout.end(); child.emit('close', 0);
      });
      return child;
    } });
  t.after(() => { service.dispose(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  service.install();
  for (let index = 0; index < 1000 && service.getState().busy; index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.getState().phase, 'cancelled');
  assert.equal(scans, 1, 'no additional resource files should be inspected after cancellation');
  assert.equal(fs.existsSync(service.getProjectRoot()), false);
  assert.equal(fs.readdirSync(userData).some(name => name.startsWith('voice-staging-')), false);
});

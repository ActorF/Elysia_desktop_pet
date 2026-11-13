'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('speech bridge borrows verified existing drives and preserves guarded child startup without native mapping changes', t => {
  const result = spawnSync('python', ['-B', path.join(__dirname, 'chat_tts_drive_mapping_test.py')], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  if (result.error?.code === 'ENOENT') { t.skip('Python is optional outside the CI speech checks'); return; }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

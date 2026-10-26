/** Exercise the actual Windows helper policy without changing desktop focus or settings. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Windows BUSY does not silence our focused chat, while external fullscreen and explicit interruption states stay blocked', {
  skip: process.platform !== 'win32' ? 'The native helper uses Windows PowerShell and Win32 APIs' : false,
}, () => {
  const helper = fs.readFileSync(path.join(__dirname, '../electron/voice-environment.ps1'), 'utf8');
  const source = helper.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(source, 'Compile the production helper rather than a separate policy copy');
  const checks = [
    // Reproduction: ordinary focused Elysia chat, QUNS_BUSY from Windows.
    { state: 2, own: true, blocked: false },
    // Another application's BUSY/fullscreen must still pause speech.
    { state: 2, own: false, blocked: true },
    // Not present, exclusive Direct3D, presentation, and quiet time still win.
    ...[1, 3, 4, 6].flatMap(state => [true, false].map(own => ({ state, own, blocked: true }))),
    ...[5, 7].flatMap(state => [true, false].map(own => ({ state, own, blocked: false }))),
  ];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'", source[1], "'@",
    ...checks.map(({ state, own, blocked }) =>
      `if ([VoiceEnvironment]::BlocksNotification(${state}, $${own}) -ne $${blocked}) { throw 'Unexpected notification policy: state=${state}, own=${own}' }`),
    "[Console]::WriteLine('notification-policy-ok')",
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /notification-policy-ok/);
});

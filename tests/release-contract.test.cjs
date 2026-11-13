'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_RUNTIME_FILES, releaseSmokeModes, verifyReleaseContract, verifyQuickChatSmoke, verifyReleaseSmokeReport } = require('../scripts/release-contract.cjs');

const completeQuickChat = () => ({ quickChatSmoke: 'ok', noHistoryWindows: true, isolatedBridge: true, translucentComposer: true,
  bottomCenterThirdWidth: true, existingPetBubble: true, oneSentenceAtATime: true, hiddenAudioAcknowledged: true,
  escapedDraftRetained: true, sendsKeepInputOpen: true, shortcutToggles: true, shortcutSaved: true,
  captureRestoresOnBlur: true, stopVoiceClearsReply: true, noDownloads: true });

test('current release file rules include every quick chat and resource recovery module', () => {
  const root = path.resolve(__dirname, '..'), manifest = require('../package.json');
  const files = [...new Set(manifest.build.files.flatMap(pattern => fs.globSync(pattern, { cwd: root })))].map(file => file.replaceAll('\\', '/'));
  verifyReleaseContract(manifest, manifest, files);
  assert.ok(manifest.build.asarUnpack.includes('electron/windows-file-move.ps1'), 'Native file publication must run outside the ASAR archive');
});

test('formal package verification rejects missing features, stale versions and preview versions', () => {
  const manifest = { version: '1.4.5', main: 'electron/main.cjs' };
  verifyReleaseContract(manifest, manifest, REQUIRED_RUNTIME_FILES);
  for (const file of ['electron/voice-repair.cjs', 'electron/setup-diagnostics.cjs', 'electron/legacy-hotkey-listener.cjs',
    'electron/windows-file-move.ps1', 'electron/quick-chat-preload.cjs', 'renderer/quick-chat.html']) {
    assert.throws(() => verifyReleaseContract(manifest, manifest, REQUIRED_RUNTIME_FILES.filter(item => item !== file)), /Required release module is missing/);
  }
  assert.throws(() => verifyReleaseContract(manifest, { ...manifest, version: '1.4.4' }, REQUIRED_RUNTIME_FILES), /wrong release version/);
  assert.throws(() => verifyReleaseContract(manifest, { ...manifest, main: 'scripts/preview.cjs' }, REQUIRED_RUNTIME_FILES), /normal application entry point/);
  for (const version of ['1.4.5-preview', '1.4.5-beta.1', '1.4', 'v1.4.5', '01.4.5']) {
    assert.throws(() => verifyReleaseContract({ ...manifest, version }, { ...manifest, version }, REQUIRED_RUNTIME_FILES), /stable numeric version/);
  }
});

test('both full and chat-only package audits include the hidden quick-chat smoke check', () => {
  const full = releaseSmokeModes(), chat = releaseSmokeModes(true);
  assert.deepEqual(full.map(mode => mode.name), ['desktop', 'voice', 'interaction', 'chat', 'quick-chat']);
  assert.deepEqual(chat.map(mode => mode.name), ['chat', 'quick-chat']);
  assert.deepEqual(chat[1], { name: 'quick-chat', flag: '--quick-chat-smoke-test', key: 'quickChatSmoke' });
  assert.ok(full.every(mode => !mode.flag.includes('local-preview')));
});

test('installer audit rejects old reports and incomplete quick-chat behavior checks', () => {
  const report = { modes: ['chat', 'quick-chat', 'portable-relaunch'], directory: { 'quick-chat': { exitCode: 0, result: completeQuickChat() } },
    portable: { 'quick-chat': { exitCode: 0, result: null } } };
  verifyReleaseSmokeReport(report);
  assert.throws(() => verifyReleaseSmokeReport({ ...report, modes: ['chat', 'portable-relaunch'] }), /missing chat, quick chat/);
  assert.throws(() => verifyReleaseSmokeReport({ ...report, portable: {} }), /Portable quick chat check failed/);
  for (const field of ['sendsKeepInputOpen', 'noHistoryWindows', 'existingPetBubble', 'hiddenAudioAcknowledged', 'noDownloads']) {
    assert.throws(() => verifyQuickChatSmoke({ ...completeQuickChat(), [field]: false }), new RegExp(field));
  }
});

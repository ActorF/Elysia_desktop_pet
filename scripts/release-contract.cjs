/** Required release features shared by the portable and installer audits. */
'use strict';
const assert = require('node:assert/strict');

const REQUIRED_RUNTIME_FILES = Object.freeze([
  'electron/main.cjs', 'electron/model-setup.cjs', 'electron/voice-setup.cjs', 'electron/voice-repair.cjs',
  'electron/voice-installation.cjs', 'electron/setup-diagnostics.cjs', 'electron/resource-download.cjs',
  'electron/setup-child-process.cjs', 'electron/windows-file-move.cjs', 'electron/windows-file-move.ps1',
  'electron/resource-download-hosts.cjs',
  'electron/quit-coordinator.cjs', 'electron/renderer-recovery.cjs',
  'electron/legacy-hotkey-listener.cjs',
  'electron/quick-chat-window.cjs', 'electron/quick-chat-controller.cjs', 'electron/quick-chat-shortcut.cjs',
  'electron/quick-chat-ipc.cjs', 'electron/quick-chat-preload.cjs', 'electron/quick-chat-smoke.cjs',
  'renderer/quick-chat.html', 'renderer/quick-chat.css', 'renderer/quick-chat.mjs', 'renderer/quick-chat-settings.mjs',
]);
const MODES = Object.freeze([
  { name: 'desktop', flag: '--smoke-test', key: 'smoke' },
  { name: 'voice', flag: '--voice-smoke-test', key: 'voiceSmoke' },
  { name: 'interaction', flag: '--interaction-smoke-test', key: 'interactionSmoke' },
  { name: 'chat', flag: '--chat-smoke-test', key: 'chatSmoke' },
  { name: 'quick-chat', flag: '--quick-chat-smoke-test', key: 'quickChatSmoke' },
].map(Object.freeze));

function releaseSmokeModes(chatOnly = false) {
  return MODES.filter(mode => !chatOnly || ['chat', 'quick-chat'].includes(mode.name));
}
function verifyReleaseContract(manifest, packagedManifest, files) {
  assert.match(manifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'A formal release requires a stable numeric version');
  assert.equal(packagedManifest.version, manifest.version, 'Packaged application has the wrong release version');
  assert.equal(packagedManifest.main, 'electron/main.cjs', 'The package must start the normal application entry point');
  const actual = new Set(files);
  for (const file of REQUIRED_RUNTIME_FILES) assert.ok(actual.has(file), `Required release module is missing: ${file}`);
}
function verifyQuickChatSmoke(result) {
  assert.equal(result?.quickChatSmoke, 'ok', 'Packaged quick chat did not report success');
  for (const field of ['noHistoryWindows', 'isolatedBridge', 'translucentComposer', 'bottomCenterThirdWidth',
    'existingPetBubble', 'oneSentenceAtATime', 'hiddenAudioAcknowledged', 'escapedDraftRetained', 'sendsKeepInputOpen',
    'shortcutToggles', 'shortcutSaved', 'captureRestoresOnBlur', 'stopVoiceClearsReply', 'noDownloads']) {
    assert.equal(result[field], true, `Packaged quick chat check did not pass: ${field}`);
  }
}
function verifyReleaseSmokeReport(smoke) {
  assert.ok(['chat', 'quick-chat', 'portable-relaunch'].every(mode => smoke?.modes?.includes(mode)), 'Release report is missing chat, quick chat or portable relaunch checks');
  assert.equal(smoke.directory?.['quick-chat']?.exitCode, 0, 'Directory quick chat check failed');
  assert.equal(smoke.portable?.['quick-chat']?.exitCode, 0, 'Portable quick chat check failed');
  verifyQuickChatSmoke(smoke.directory['quick-chat'].result);
}

module.exports = { REQUIRED_RUNTIME_FILES, releaseSmokeModes, verifyReleaseContract, verifyQuickChatSmoke, verifyReleaseSmokeReport };

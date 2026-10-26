'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Remember unfinished automatic preparation without touching chat preferences. */
function createFirstRunSetup({ directory, firstRun, enabled = true }) {
  const file = path.join(directory, 'automatic-setup.json');
  let pending = { chat: false, voice: false };
  if (enabled) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      pending = { chat: saved.chat === true, voice: saved.voice === true };
    } catch { if (firstRun) pending = { chat: true, voice: true }; }
  }
  function save() {
    if (!enabled) return;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(pending)); fs.renameSync(file + '.tmp', file);
  }
  if (enabled && (pending.chat || pending.voice)) save();
  function update(kind, state) {
    if (!enabled || !['chat', 'voice'].includes(kind) || !pending[kind]) return;
    if (state.phase === 'ready' || state.phase === 'cancelled') { pending[kind] = false; save(); }
  }
  function start({ chat, voice }) {
    // Called before opening the setup window: its read-only inspection cannot
    // race with startup and accidentally suppress the initial installation.
    if (pending.chat) chat.installChatModel();
    if (pending.voice) voice.install();
  }
  return { update, start, needsSetup: () => pending.chat || pending.voice };
}
module.exports = { createFirstRunSetup };

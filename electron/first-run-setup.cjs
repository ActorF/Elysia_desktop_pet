'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CHAT_BACKEND = 'llama.cpp-v1';

function managedChatEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.port === '18434' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Remember unfinished automatic preparation without touching chat preferences. */
function createFirstRunSetup({ directory, firstRun, enabled = true }) {
  const file = path.join(directory, 'automatic-setup.json');
  let pending = { chat: false, voice: false, chatBackend: null };
  if (enabled) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      pending = { chat: saved.chat === true, voice: saved.voice === true, chatBackend: saved.chatBackend === CHAT_BACKEND ? CHAT_BACKEND : null };
    } catch { if (firstRun) pending = { chat: true, voice: true, chatBackend: null }; }
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
  function start({ chat, voice, chatBaseUrl = 'http://127.0.0.1:18434' }) {
    if (!enabled) return false;
    const localChat = managedChatEndpoint(chatBaseUrl);
    // One-time backend migration also applies to existing profiles whose old
    // Ollama setup was already completed. Cancellation remains durable.
    if (localChat && pending.chatBackend !== CHAT_BACKEND) {
      pending.chatBackend = CHAT_BACKEND; pending.chat = true; save();
    }
    // Called before opening the setup window: its read-only inspection cannot
    // race with startup and accidentally suppress the initial installation.
    const showSetup = (localChat && pending.chat) || pending.voice;
    if (localChat) {
      if (pending.chat) chat.installChatModel();
      else chat.ensureInstalledServer?.();
    }
    if (pending.voice) voice.install();
    return showSetup;
  }
  return { update, start, needsSetup: () => pending.chat || pending.voice };
}
module.exports = { createFirstRunSetup, managedChatEndpoint };

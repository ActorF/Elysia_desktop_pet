'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createVoiceEngine } = require('./voice-engine.cjs');
const { loadVoiceAssets, loadInteractionAssets } = require('./voice-assets.cjs');
const { createSpeechWindow } = require('./speech-window.cjs');
const { createVoiceEnvironment } = require('./voice-environment.cjs');
const { createInteractionReplies, INTERACTION_CATALOG } = require('./interaction-replies.cjs');

const DEFAULT_VOICE_SETTINGS = Object.freeze({ enabled: true, dnd: false, volume: .8, birthday: '' });
const INTERACTION_DEBOUNCE_MS = 300;
const SPEECH_GAP_MS = 1200;
const ANGRY_EXPIRY_MS = 6000;
function sanitizeVoiceSettings(patch, previous = DEFAULT_VOICE_SETTINGS) {
  const next = { ...DEFAULT_VOICE_SETTINGS, ...previous };
  if (!patch || typeof patch !== 'object') return next;
  for (const key of ['enabled', 'dnd']) if (typeof patch[key] === 'boolean') next[key] = patch[key];
  if (Number.isFinite(patch.volume)) next.volume = Math.min(1, Math.max(0, patch.volume));
  if (patch.birthday === '') next.birthday = '';
  else if (typeof patch.birthday === 'string' && /^\d{2}-\d{2}$/.test(patch.birthday)) {
    const [month, day] = patch.birthday.split('-').map(Number);
    const date = new Date(2000, month - 1, day);
    if (date.getMonth() === month - 1 && date.getDate() === day) next.birthday = patch.birthday;
  }
  return next;
}

function createVoiceController({ BrowserWindow, screen, ipcMain, powerMonitor, root, assetDirectory, interactionAssetDirectory, userData,
  getCharacterBounds, getPreferences, publish = () => {}, isSmokeTest = false, isPackaged = false, quit, testHooks }) {
  const assets = loadVoiceAssets(root, assetDirectory);
  const interactionAssets = loadInteractionAssets(root, interactionAssetDirectory);
  const file = path.join(userData, 'voice-state.json');
  let saved = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {}
  let settings = sanitizeVoiceSettings(saved.settings);
  const engine = createVoiceEngine({ saved: saved.history, now: Date.now() });
  const interactionReplies = createInteractionReplies();
  let timer = null, sequence = 0, pending = null, disposed = false, farewellPending = false, quitTimer = null;
  let quitRequested = false;
  let lastPlaybackEndedAt = 0, retryAt = 0, lastPersistedAt = 0;
  let environmentKey = '';
  let lastInteractionAt = -Infinity;
  let audioQuietUntil = 0, lastAudioKind = null, interactionTimer = null, queuedInteraction = null;
  let playback = { status: 'idle', lineId: null, kind: null, error: null };
  function persist() {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ settings, history: engine.exportState() }, null, 2));
      fs.renameSync(file + '.tmp', file); lastPersistedAt = Date.now();
    } catch (error) { console.error('Could not save voice history:', error.message); }
  }
  const speech = createSpeechWindow({ BrowserWindow, screen, ipcMain, root, getCharacterBounds, getPreferences, isSmokeTest, isPackaged,
    onStarted(event) {
      if (disposed || pending?.token !== event.token) return;
      pending.started = true;
      if (pending.candidate && (event.kind === 'automatic' || event.kind === 'farewell')) {
        engine.commit(pending.candidate, Date.now()); persist();
      }
      if (event.kind === 'interaction' && pending.interactionReply) interactionReplies.commit(pending.interactionReply);
      playback = { ...playback, status: 'playing', error: null }; notify();
    },
    onFinished(event) {
      if (disposed || pending?.token !== event.token) return;
      const previous = pending;
      if (!previous.textOnly) {
        lastPlaybackEndedAt = Date.now();
        lastAudioKind = previous.kind;
        audioQuietUntil = lastPlaybackEndedAt + SPEECH_GAP_MS;
      }
      playback = { ...playback, status: event.status === 'error' ? 'error' : 'idle', error: event.error ?? null };
      pending = null;
      if (event.status !== 'ended') clearInteractionQueue();
      if (event.status === 'error') retryAt = Date.now() + 30000;
      scheduleInteraction();
      notify();
      if (farewellPending && event.kind === 'farewell') finishQuit();
    },
  });
  const environment = createVoiceEnvironment({ powerMonitor, isSmokeTest, onBlocked(reason) {
    clearInteractionQueue();
    if (reason === 'fullscreen') {
      if (pending?.kind === 'automatic' || (pending?.kind === 'interaction' && !pending.textOnly)) speech.stop();
    } else { speech.stop(); tick(); }
    notify();
  } });
  function getState() {
    return { settings: { ...settings }, available: assets.available, error: assets.error,
      interactionAvailable: interactionAssets.available, interactionError: interactionAssets.error,
      queuedInteraction: queuedInteraction ? { kind: queuedInteraction.kind, expiresAt: queuedInteraction.expiresAt } : null,
      playback: { ...playback }, environment: environment.sample() };
  }
  function notify() { if (!disposed) publish(getState()); }
  async function play(lineId, kind, candidate = null) {
    if (disposed || quitRequested || (farewellPending && kind !== 'farewell')) return getState();
    const line = assets.lines.get(lineId) ?? (kind === 'manual' ? interactionAssets.lines.get(lineId) : null), sample = environment.sample();
    if (!line || sample.locked || sample.suspended) return getState();
    if (kind === 'automatic' && (pending || queuedInteraction || sample.now < audioQuietUntil)) return getState();
    clearInteractionQueue();
    const token = `voice-${++sequence}`;
    // Stop before replacing the pending token, so old completion cannot clear a newer line.
    speech.stop('replaced');
    pending = { token, kind, candidate, textOnly: false };
    playback = { lineId, text: line.text, kind, status: 'loading', error: null, reason: candidate?.reason ?? null };
    notify();
    try {
      const result = await speech.play(line, { token, kind, volume: settings.volume });
      if (!result?.ok && pending?.token === token) {
        pending = null; retryAt = Date.now() + 30000;
        playback = { ...playback, status: 'error', error: result?.error || '无法播放这句语音。' }; notify();
        if (farewellPending) finishQuit();
      }
    } catch (error) {
      if (pending?.token === token) {
        pending = null; retryAt = Date.now() + 30000;
        playback = { ...playback, status: 'error', error: error.message }; notify();
        if (farewellPending) finishQuit();
      }
    }
    return getState();
  }
  function clearInteractionQueue() {
    clearTimeout(interactionTimer); interactionTimer = null; queuedInteraction = null;
  }
  function canSpeakInteraction(sample) {
    return interactionAssets.available && !settings.dnd && settings.volume > 0
      && sample.monitorReady !== false && !sample.fullscreen && !sample.locked && !sample.suspended;
  }
  function scheduleInteraction() {
    clearTimeout(interactionTimer); interactionTimer = null;
    if (!queuedInteraction || pending || disposed || quitRequested || farewellPending) return;
    const request = queuedInteraction;
    const delay = Math.max(0, request.dueAt - Date.now(), audioQuietUntil - Date.now());
    interactionTimer = setTimeout(() => {
      if (queuedInteraction !== request || disposed) return;
      interactionTimer = null;
      const sample = environment.sample();
      if (sample.now < Math.max(request.dueAt, audioQuietUntil)) { scheduleInteraction(); return; }
      queuedInteraction = null;
      if (sample.now > request.expiresAt || pending || quitRequested || farewellPending
        || getPreferences().clickThrough || getPreferences().interactionsEnabled === false || !canSpeakInteraction(sample)) { notify(); return; }
      void presentInteraction(request.kind, true);
    }, delay);
    interactionTimer.unref?.();
  }
  function queueInteraction(kind, now) {
    // One slot only: an annoyed response may replace an unspoken gentle reply,
    // but repeated clicks never grow a playlist or extend its expiry.
    if (queuedInteraction?.kind === 'poke-annoyed') return false;
    queuedInteraction = { kind, dueAt: now + INTERACTION_DEBOUNCE_MS, expiresAt: now + ANGRY_EXPIRY_MS };
    scheduleInteraction(); notify(); return true;
  }
  async function interact(kind) {
    if (typeof kind !== 'string' || !interactionReplies.hasGroup(kind)
      || disposed || quitRequested || farewellPending || getPreferences().clickThrough || getPreferences().interactionsEnabled === false) return false;
    const sample = environment.sample();
    if (sample.locked || sample.suspended || (pending && pending.kind !== 'interaction')) return false;
    if (pending && !pending.textOnly) {
      if (kind === 'poke-annoyed' && pending.interactionType !== kind && canSpeakInteraction(sample)) {
        return queueInteraction(kind, sample.now);
      }
      return false;
    }
    if (canSpeakInteraction(sample)) {
      if (sample.now < audioQuietUntil && (kind !== 'poke-annoyed' || lastAudioKind !== 'interaction')) return false;
      // If a muted caption is still visible, let it stay until the new line is
      // ready; it must not hold the audio debounce slot open indefinitely.
      if (pending?.textOnly) speech.stop('replaced');
      return queueInteraction(kind, sample.now);
    }
    if (sample.now < audioQuietUntil) return false;
    clearInteractionQueue();
    const escalatesReaction = kind === 'poke-annoyed' && pending?.interactionType !== kind;
    if (!escalatesReaction && sample.now - lastInteractionAt < 250) return false;
    return presentInteraction(kind, false);
  }
  async function presentInteraction(kind, audible) {
    if (disposed || quitRequested || farewellPending || getPreferences().interactionsEnabled === false) return false;
    const reply = interactionReplies.reserve(kind), token = `interaction-${++sequence}`;
    lastInteractionAt = Date.now();
    speech.stop('replaced');
    pending = { token, kind: 'interaction', interactionType: kind, interactionReply: reply, textOnly: !audible };
    playback = { lineId: reply.id, kind: 'interaction', text: reply.text, textOnly: !audible, status: 'loading', error: null };
    notify();
    try {
      const result = audible
        ? await speech.play(interactionAssets.lines.get(reply.id), { token, kind: 'interaction', volume: settings.volume })
        : await speech.showText({ id: reply.id, text: reply.text }, { token, kind: 'interaction', duration: reply.duration });
      if (!result?.ok && pending?.token === token) {
        pending = null; clearInteractionQueue();
        if (audible) audioQuietUntil = Date.now() + SPEECH_GAP_MS;
        playback = { ...playback, status: 'error', error: result?.error || '互动回应暂时无法播放。' }; notify();
      }
      return result?.ok === true;
    } catch (error) {
      if (pending?.token === token) {
        pending = null; clearInteractionQueue();
        if (audible) audioQuietUntil = Date.now() + SPEECH_GAP_MS;
        playback = { ...playback, status: 'error', error: error.message }; notify();
      }
      return false;
    }
  }
  function tick() {
    if (disposed || quitRequested || farewellPending) return;
    const sample = environment.sample();
    const nextEnvironmentKey = JSON.stringify([sample.monitorReady, sample.locked, sample.suspended, sample.fullscreen]);
    if (nextEnvironmentKey !== environmentKey) { environmentKey = nextEnvironmentKey; notify(); }
    const candidate = engine.evaluate({ ...sample, ...settings, enabled: settings.enabled && settings.volume > 0,
      busy: !!pending || !!queuedInteraction || !assets.available || sample.now < retryAt || sample.now < audioQuietUntil });
    if (sample.now - lastPersistedAt >= 15000) persist();
    if (candidate && !isSmokeTest) void play(candidate.lineId, 'automatic', candidate);
  }
  function setSettings(patch) {
    settings = sanitizeVoiceSettings(patch, settings);
    speech.setVolume?.(settings.volume);
    if (settings.dnd || settings.volume === 0) clearInteractionQueue();
    if (((!settings.enabled || settings.dnd || settings.volume === 0) && pending?.kind === 'automatic')
      || ((settings.dnd || settings.volume === 0) && pending?.kind === 'interaction' && !pending.textOnly)) speech.stop();
    persist(); notify(); return getState();
  }
  function preferencesChanged() {
    if (disposed) return getState();
    if (getPreferences().interactionsEnabled === false) {
      clearInteractionQueue();
      lastInteractionAt = -Infinity;
      if (pending?.kind === 'interaction' || (!pending && playback.kind === 'interaction')) speech.stop();
    }
    notify(); return getState();
  }
  function finishQuit() {
    if (quitRequested) return; quitRequested = true;
    clearTimeout(quitTimer); quitTimer = null;
    quit();
  }
  function requestQuit() {
    if (disposed || quitRequested) return;
    clearInteractionQueue();
    if (farewellPending) { speech.stop('skipped'); finishQuit(); return; }
    const sample = environment.sample();
    const candidate = engine.farewell({ now: Date.now(), busy: !!pending, lastPlaybackEndedAt,
      enabled: assets.available && settings.enabled && settings.volume > 0 && !settings.dnd && !sample.locked && !sample.suspended && !sample.fullscreen });
    if (!candidate) { finishQuit(); return; }
    farewellPending = true;
    quitTimer = setTimeout(finishQuit, 30000);
    void play(candidate.lineId, 'farewell', candidate);
  }
  // Developer verification receives an explicitly injected main-process object.
  // These operations are absent from the production controller and renderer IPC.
  if (testHooks && typeof testHooks === 'object') Object.assign(testHooks, {
    getCatalog: () => ({ daily: assets.catalog, interaction: INTERACTION_CATALOG }),
    playVoice: id => assets.lines.has(id) || interactionAssets.lines.has(id) ? play(id, 'manual') : getState(),
    simulateVoice: groupId => {
      if (!/^(0[1-9]|1[0-2])$/.test(groupId)) return getState();
      const candidate = engine.simulate(groupId, { now: Date.now(), birthday: settings.birthday });
      return candidate ? play(candidate.lineId, 'simulation', candidate) : getState();
    },
  });
  return {
    getState, setSettings, requestQuit, interact, preferencesChanged,
    stopVoice: () => { clearInteractionQueue(); speech.stop(); notify(); return getState(); },
    start: () => { if (!timer && !isSmokeTest) timer = setInterval(tick, 1000); },
    reposition: () => speech.reposition(),
    allowsUrl: url => assets.allowedUrls.has(url) || interactionAssets.allowedUrls.has(url),
    getSpeechWindow: () => speech.getWindow(),
    getHistory: () => engine.exportState(),
    dispose: () => {
      if (disposed) return; persist(); disposed = true;
      clearInterval(timer); clearTimeout(quitTimer); clearInteractionQueue(); environment.dispose(); speech.dispose();
    },
  };
}
module.exports = { createVoiceController, sanitizeVoiceSettings, DEFAULT_VOICE_SETTINGS };

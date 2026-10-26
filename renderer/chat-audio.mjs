// Local synthesized WAV segments stay in memory and are released after playback or cancellation.
const bridge = window.elysiaChat;
let current = null;
function clear() {
  if (!current) return;
  const previous = current; current = null;
  previous.audio.pause(); previous.audio.removeAttribute('src'); previous.audio.load();
  URL.revokeObjectURL(previous.url);
}
function report(type, token) { bridge?.reportSpeech({ token, type }); }
const stopAudio = bridge?.onSpeechAudio?.(async packet => {
  clear();
  if (!packet || typeof packet.token !== 'string' || packet.mime !== 'audio/wav' || typeof packet.base64 !== 'string') return;
  try {
    const binary = atob(packet.base64), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = new Audio(url), item = { audio, url, token: packet.token }; current = item;
    audio.volume = Number.isFinite(packet.volume) ? Math.max(0, Math.min(1, packet.volume)) : .8;
    audio.addEventListener('ended', () => { if (current === item) { clear(); report('ended', item.token); } }, { once: true });
    audio.addEventListener('error', () => { if (current === item) { clear(); report('error', item.token); } }, { once: true });
    await audio.play(); if (current === item) report('started', item.token);
  } catch { if (current?.token === packet.token) clear(); report('error', packet.token); }
});
const stopStop = bridge?.onSpeechStop?.(packet => { if (!packet?.token || current?.token === packet.token) clear(); });
window.addEventListener('pagehide', () => { clear(); stopAudio?.(); stopStop?.(); }, { once: true });

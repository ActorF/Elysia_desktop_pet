const desktop = window.elysiaSpeech;
const bubble = document.querySelector('#speech'), text = document.querySelector('#line'), tail = document.querySelector('#tail');
const HORIZONTAL_INSET = 64, VERTICAL_INSET = 52;
let current = null;
function placement(value) {
  if (!value) return;
  bubble.dataset.side = value.side === 'right' ? 'right' : 'left';
  // The host position is relative to the native window; the card has 12px inset.
  if (Number.isFinite(value.tailY)) tail.style.top = `${Math.max(14, value.tailY - 22)}px`;
}
function clearAudio() {
  if (!current) return;
  const old = current; current = null;
  old.audio?.pause(); old.audio?.removeAttribute('src'); old.audio?.load();
  bubble.dataset.layout = 'pending';
}
function measure(request, value) {
  if (current !== request || value.revision < request.revision) return;
  request.revision = value.revision;
  bubble.dataset.layout = 'pending';
  const maxWidth = Math.max(1, value.maxWidth - HORIZONTAL_INSET);
  const maxHeight = Math.max(1, value.maxHeight - VERTICAL_INSET);
  let fontSize = 16;
  const heightAt = width => { text.style.width = `${width}px`; return text.getBoundingClientRect().height; };
  text.style.fontSize = `${fontSize}px`;
  // Font reduction is reserved for a genuinely narrow/short monitor. Ordinary
  // lines always keep 16px text and obtain enough width for their full contents.
  while (fontSize > 4 && (heightAt(maxWidth) > fontSize * 1.75 * 2 + .5 || heightAt(maxWidth) > maxHeight + .5)) {
    fontSize -= .5; text.style.fontSize = `${fontSize}px`;
  }
  const lineHeight = fontSize * 1.75;
  text.style.width = 'max-content';
  const naturalWidth = Math.ceil(text.getBoundingClientRect().width);
  let width = Math.min(naturalWidth, maxWidth);
  if (naturalWidth > maxWidth) {
    // Find the narrowest real browser layout with two complete lines. This
    // accounts for punctuation, musical symbols, fallback fonts and DPI.
    let low = Math.max(1, Math.floor(naturalWidth / 2)), high = Math.floor(maxWidth);
    low = Math.min(low, high);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (heightAt(middle) <= lineHeight * 2 + .5) high = middle;
      else low = middle + 1;
    }
    width = low;
  }
  // One spare DIP protects line breaks against native integer-size rounding.
  width = Math.min(maxWidth, Math.max(1, Math.ceil(width) + 1));
  const height = Math.ceil(heightAt(width));
  request.measured = { width: Math.ceil(width + HORIZONTAL_INSET), height: Math.ceil(height + VERTICAL_INSET), fontSize };
  desktop.layout({ token: request.token, revision: request.revision, width: request.measured.width, height: request.measured.height });
}
desktop?.onPlay(async value => {
  clearAudio(); placement(value); text.textContent = value.line.text;
  const audio = value.textOnly ? null : new Audio(value.line.audioUrl);
  if (audio) audio.volume = value.volume;
  const request = { token: value.token, audio, revision: value.revision, started: false };
  current = request;
  const report = (type, message) => {
    if (current !== request) return;
    desktop.report({ token: request.token, type, ...(message ? { error: message } : {}) });
  };
  audio?.addEventListener('playing', () => report('started'), { once: true });
  audio?.addEventListener('ended', () => report('ended'), { once: true });
  audio?.addEventListener('error', () => report('error', '这句录音暂时无法播放，请检查文件后重试。'), { once: true });
  await document.fonts.ready;
  measure(request, value);
});
desktop?.onMeasure(value => { if (current?.token === value?.token) measure(current, value); });
desktop?.onLayoutReady(async value => {
  const request = current;
  if (!request || request.token !== value?.token || request.revision !== value.revision || !request.measured) return;
  placement(value); text.style.width = '100%'; bubble.dataset.layout = 'ready';
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (current !== request || request.revision !== value.revision) return;
  desktop.report({ token: request.token, type: 'prepared', revision: request.revision });
  if (request.started) return;
  request.started = true;
  if (!request.audio) return;
  try { await request.audio.play(); }
  catch { if (current === request) desktop.report({ token: request.token, type: 'error', error: '语音未能播放。' }); }
});
desktop?.onStop(value => { if (value?.token == null || current?.token === value.token) clearAudio(); });
desktop?.onVolume(value => {
  if (current?.audio && current.token === value?.token && Number.isFinite(value.volume)) current.audio.volume = Math.max(0, Math.min(1, value.volume));
});
desktop?.onPlacement(placement);
desktop?.onError(value => { if (current?.token === value?.token) clearAudio(); });
window.addEventListener('pagehide', clearAudio);
document.documentElement.dataset.ready = 'true';

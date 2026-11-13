const desktop = window.elysiaQuickChat;
const input = document.querySelector('#quick-input');
const send = document.querySelector('#quick-send');
const stop = document.querySelector('#quick-stop');
const status = document.querySelector('#quick-status');
let snapshot = null, revision = 0, draftRevision = 0, pending = false, stopping = false, composing = false;
let localError = '';
const plainError = value => typeof value === 'string' ? value : '';

function render() {
  const busy = snapshot?.busy === true;
  const speaking = ['warming', 'starting', 'synthesizing', 'playing'].includes(snapshot?.voice?.status);
  send.hidden = busy;
  send.disabled = !snapshot || busy || pending || stopping || !!snapshot.storageError || !input.value.trim();
  stop.hidden = !busy && !speaking;
  stop.title = stop.ariaLabel = busy ? '停止回答，保留草稿' : '停止朗读，保留草稿';
  stop.disabled = stopping;
  input.setAttribute('aria-busy', String(pending));
  const error = localError || plainError(snapshot?.storageError) || plainError(snapshot?.error);
  const voice = snapshot?.voice;
  const voiceError = voice?.enabled ? plainError(voice.error) : '';
  const voiceMessage = !voice ? '' : !voice.enabled ? '回复朗读已关闭，可在设置 → 聊天开启。'
    : voiceError || plainError(voice.blocked) || ({ warming: '正在加载语音，首次使用可能需要等待…', starting: '正在准备朗读…', synthesizing: '正在生成语音…', playing: '爱莉希雅正在说话…' })[voice.status] || '';
  status.textContent = error || (stopping ? '正在停止…' : plainError(snapshot?.status) || (pending ? '正在发送…' : busy ? '她正在回复，你可以先写下一句。' : voiceMessage || (snapshot ? 'Enter 发送 · Shift + Enter 换行' : '正在准备…')));
  status.dataset.error = String(Boolean(error || (!busy && voiceError)));
  status.title = status.textContent;
}
function receive(value) {
  if (!value || typeof value.busy !== 'boolean') return;
  snapshot = value; revision++; render();
}
function focusInput() { input.focus({ preventScroll: true }); }
async function hide() {
  try { await desktop?.hide(); }
  catch { localError = '暂时没能收起输入框，请重试。'; render(); }
}
input.addEventListener('input', () => { draftRevision++; render(); });
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; });
input.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) document.querySelector('#quick-form').requestSubmit();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing || composing || event.keyCode === 229) return;
  event.preventDefault(); void hide();
});
document.querySelector('#quick-hide').addEventListener('click', () => void hide());
document.querySelector('#quick-form').addEventListener('submit', async event => {
  event.preventDefault();
  const draft = input.value, submittedRevision = draftRevision, text = draft.trim();
  if (!snapshot || snapshot.busy || snapshot.storageError || pending || stopping || composing || !text) return;
  pending = true; localError = ''; render();
  try {
    const before = revision, result = await desktop.send(text);
    const latest = before === revision;
    if (latest) receive(result);
    if (result?.accepted === true) {
      // Keep anything typed while the request was being accepted for the next turn.
      if (draftRevision === submittedRevision && input.value === draft) input.value = '';
    } else if (latest) {
      const problem = plainError(result?.storageError) || plainError(result?.error);
      // Host errors clear when the host recovers; do not make a duplicate local
      // error outlive that state or overwrite a newer window's broadcast.
      if (typeof result?.busy !== 'boolean' || !problem) localError = problem || '消息还没发出，草稿已保留，请重试。';
    }
  } catch { localError = '暂时没能发送，草稿已保留，请重试。'; }
  finally { pending = false; render(); }
});
stop.addEventListener('click', async () => {
  if ((!snapshot?.busy && !['warming', 'starting', 'synthesizing', 'playing'].includes(snapshot?.voice?.status)) || stopping) return;
  stopping = true; localError = ''; render();
  try {
    const before = revision, result = await desktop.cancel();
    if (before === revision) {
      receive(result);
      if (typeof result?.busy !== 'boolean') localError = plainError(result?.storageError) || plainError(result?.error);
    }
  } catch { localError = '暂时没能停止回答，请重试。'; }
  finally { stopping = false; render(); focusInput(); }
});

try {
  if (!['getState', 'send', 'cancel', 'hide', 'onState', 'onFocus'].every(key => typeof desktop?.[key] === 'function')) throw new Error('unavailable');
  const unsubscribeState = desktop.onState(receive), unsubscribeFocus = desktop.onFocus(focusInput);
  window.addEventListener('pagehide', () => { unsubscribeState?.(); unsubscribeFocus?.(); }, { once: true });
  const before = revision, value = await desktop.getState();
  if (before === revision) receive(value);
  if (!snapshot) throw new Error('unavailable');
  document.documentElement.dataset.quickChatReady = 'true';
  focusInput();
} catch { localError = '快捷输入暂不可用，请重新打开桌宠。'; render(); }

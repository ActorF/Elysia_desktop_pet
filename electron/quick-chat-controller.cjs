'use strict';
const { managedChatEndpoint } = require('./first-run-setup.cjs');

/** Start only an existing local model. No installation path is used here. */
async function ensureQuickChatReady(chat, setup, signal, timeoutMs = 150000) {
  if (!managedChatEndpoint(chat.getState().settings.baseUrl)) return;
  if (signal.aborted) throw new Error('已取消发送，草稿已保留。');
  const started = setup.ensureInstalledServer();
  if (started?.ok === false) throw new Error(started.error || '本地聊天服务暂时无法启动。');
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    const state = setup.getState();
    if (state.serverReady && !state.busy) return;
    if (!state.busy) throw new Error(state.error || '本地聊天资源尚未就绪，请在设置中查看。');
    if (Date.now() >= deadline) throw new Error('模型还在启动，请稍后再发送，草稿已保留。');
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 100);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  throw new Error('已取消发送，草稿已保留。');
}

function createQuickChatController({ chat, window, voices, speech, ensureReady = async () => {}, selectSpeechTarget = () => {},
  isSpeechTarget = () => true, getSpeechBlockReason = () => null }) {
  let disposed = false, preparing = null, owner = null, serial = 0, localError = null;
  const getState = () => {
    const state = chat.getState();
    const voice = isSpeechTarget() ? speech.getState?.() : null;
    return { busy: Boolean(preparing) || state.busy, error: localError || state.error, storageError: state.storageError,
      status: preparing ? '正在唤醒爱莉希雅…' : null,
      voice: { enabled: state.settings.readAloud === true, status: voice?.status ?? 'idle', error: voice?.error ?? null,
        blocked: state.settings.readAloud === true ? getSpeechBlockReason() : null } };
  };
  const publish = () => { if (!disposed) window.publish(getState()); };
  function interrupt() {
    serial++; owner = null;
    preparing?.abort(); preparing = null;
    voices.stopChatText();
    publish();
  }
  async function send(text) {
    const initial = chat.getState();
    const reject = error => { preparing = null; localError = error; publish(); return { ...getState(), accepted: false }; };
    if (disposed) return reject('快捷输入已关闭。');
    if (preparing || initial.busy) return { ...getState(), accepted: false, error: '请等她回复，或先停止当前回答。' };
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) return reject('请输入 1–8000 个字符的消息。');
    if (initial.storageError) return reject(initial.storageError);
    interrupt(); speech.stop(); selectSpeechTarget('quick');
    const request = new AbortController(); preparing = request; localError = null; publish();
    try {
      await ensureReady(request.signal);
      if (disposed || request.signal.aborted || preparing !== request) return { ...getState(), accepted: false, error: '已取消发送，草稿已保留。' };
      // Another chat window can send while the local model is starting.
      if (chat.getState().busy) return reject('请等她回复，或先停止当前回答。');
      const result = chat.send(text);
      if (!result.busy || result.error || result.storageError) return reject(result.storageError || result.error || '消息未发送，草稿已保留。');
      const conversation = result.conversations.find(item => item.id === result.activeConversationId);
      owner = { conversationId: result.activeConversationId, messageId: conversation.messages.at(-1).id, serial: ++serial };
      preparing = null;
      // The CPU voice runtime owns one emotion model at a time. Warming neutral
      // here can force a second full load when the actual reply needs caring,
      // happy, etc. Start the selected voice once the completed text is known.
      publish();
      return { ...getState(), accepted: true };
    } catch (error) {
      if (disposed || preparing !== request) return { ...getState(), accepted: false, error: '已取消发送，草稿已保留。' };
      return reject(error.message || '本地聊天暂时无法连接，草稿已保留。');
    } finally { if (preparing === request) { preparing = null; publish(); } }
  }
  function cancel() {
    interrupt(); speech.stop(); chat.cancel(); localError = null; publish(); return getState();
  }
  function changed() {
    if (disposed) return;
    const state = chat.getState();
    if (owner && !state.busy && state.error) {
      owner = null; localError = state.error;
    }
    publish();
  }
  function completed(reply) {
    if (disposed || !owner || reply.conversationId !== owner.conversationId || reply.messageId !== owner.messageId) return false;
    const request = owner; owner = null;
    const conversation = chat.getState().conversations.find(item => item.id === reply.conversationId);
    const index = conversation?.messages.findIndex(item => item.id === reply.messageId) ?? -1;
    const lines = [];
    for (const message of index < 0 ? [] : conversation.messages.slice(index)) {
      if (message.role !== 'assistant') break;
      if (message.status === 'complete' && message.content.trim()) lines.push(message);
    }
    if (!lines.length) return true;
    selectSpeechTarget('quick');
    speech.start(reply.text, { messageId: reply.messageId });
    void (async () => {
      for (const line of lines) {
        if (disposed || serial !== request.serial) break;
        const status = await voices.showChatText(line.content, line.id, Math.min(20000, Math.max(4200, [...line.content].length * 170)));
        if (!['ended', 'skipped'].includes(status)) break;
      }
    })().catch(() => {});
    return true;
  }
  function dispose() { if (disposed) return; disposed = true; interrupt(); }
  return { getState, send, cancel, changed, completed, interrupt, dispose };
}
module.exports = { createQuickChatController, ensureQuickChatReady };

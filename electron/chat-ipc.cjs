/** Authorizes each chat operation against the exact local main frame that owns it. */
'use strict';
const { isSettingsSender } = require('./settings-policy.cjs');

function registerChatIpc({ ipcMain, chat, chatWindow, settingsWindow, speech, clipboard, getState }) {
  const trustedChat = event => isSettingsSender(event, chatWindow.getWindow(), chatWindow.url);
  const trustedSettings = event => isSettingsSender(event, settingsWindow.getWindow(), settingsWindow.url);
  const handle = (channel, trusted, action) => ipcMain.handle(channel, (event, value) => trusted(event) ? action(value) : null);
  const snapshot = result => getState ? getState() : result;
  handle('chat:get-state', trustedChat, () => snapshot(chat.getState()));
  handle('chat:send', trustedChat, text => {
    speech?.stop();
    const result = chat.send(text);
    if (result.busy && !result.error) speech?.warmup?.();
    return snapshot(result);
  });
  handle('chat:cancel', trustedChat, () => { speech?.stop(); return snapshot(chat.cancel()); });
  handle('chat:new-conversation', trustedChat, () => { speech?.stop(); return snapshot(chat.newConversation()); });
  handle('chat:get-window-state', trustedChat, () => chatWindow.getWindowState());
  handle('chat:open-settings', trustedChat, async () => Boolean(await settingsWindow.open()));
  handle('chat:copy-message', trustedChat, reference => {
    const message = chat.getMessage(reference);
    if (!message?.content) return { ok: false, error: '没有找到可复制的消息。' };
    try { clipboard.writeText(message.content); return { ok: true }; }
    catch { return { ok: false, error: '暂时无法复制，请重试。' }; }
  });
  handle('chat:read-aloud', trustedChat, reference => {
    const state = chat.getState(), message = chat.getMessage(reference);
    const fail = error => ({ ...snapshot(state), ok: false, error });
    if (state.busy) return fail('请先等待回答完成，或停止当前回答。');
    if (state.activeConversationId !== reference?.conversationId || message?.role !== 'assistant'
      || message.status === 'streaming' || !message.content.trim()) return fail('没有找到可朗读的回复。');
    if (!speech?.speak(message.content, { messageId: message.id })) return fail(speech?.getState()?.error || '暂时无法朗读，请检查语音设置和勿扰状态。');
    return snapshot(state);
  });
  ipcMain.on('chat:window-control', (event, value) => { if (trustedChat(event)) chatWindow.windowControl(value); });
  ipcMain.on('chat:speech-report', (event, value) => { if (trustedChat(event)) speech?.report(value); });
  handle('settings:chat-get', trustedSettings, () => snapshot(chat.getState()));
  handle('settings:chat-settings', trustedSettings, patch => snapshot(chat.setSettings(patch)));
  handle('settings:chat-select', trustedSettings, id => { speech?.stop(); return snapshot(chat.selectConversation(id)); });
  for (const [channel, operation] of [['settings:chat-delete', id => chat.deleteConversation(id)], ['settings:chat-clear', () => chat.clearHistory()]]) {
    handle(channel, trustedSettings, value => {
      const result = operation(value);
      if (!result.error && !result.storageError) speech?.clearCache?.();
      return snapshot(result);
    });
  }
  handle('settings:chat-open', trustedSettings, async () => Boolean(await chatWindow.open()));
}
module.exports = { registerChatIpc };

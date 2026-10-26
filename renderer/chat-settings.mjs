const desktop = window.elysiaSettings;
const find = selector => document.querySelector(selector);
const fields = { username: find('#chat-username'), baseUrl: find('#chat-base-url'), model: find('#chat-model-name'), voiceProjectRoot: find('#chat-voice-project') };
const readAloud = find('#chat-read-aloud');
const dirty = new Set();
const conversationNodes = new Map(), historyMessageNodes = new Map();
function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
let snapshot = null, revision = 0, selectedId = null, pending = false, lastStorageError = null, readAloudPending = false, deletion = null;
function showError(error, history = false) {
  const node = find(history ? '#chat-history-error' : '#chat-settings-error');
  node.textContent = error?.message || '聊天操作暂未完成，请重试。'; node.hidden = false;
}
const date = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
};
const shortDate = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
};
function renderHistory() {
  const conversations = (snapshot?.conversations || []).filter(item => item.messages?.length).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!conversations.some(item => item.id === selectedId)) selectedId = conversations.find(item => item.id === snapshot?.activeConversationId)?.id || conversations[0]?.id || null;
  find('#chat-history-empty').hidden = conversations.length > 0;
  find('#chat-history-layout').hidden = conversations.length === 0;
  find('#chat-history-clear').disabled = !conversations.length || pending || !!snapshot?.busy || !!snapshot?.storageError;
  find('#chat-history-confirm-delete').disabled = pending || !!snapshot?.busy || !!snapshot?.storageError;
  find('#chat-history-confirm-cancel').disabled = pending;
  setText(find('#chat-history-count'), conversations.length ? `${conversations.length} 段对话` : '');
  const list = find('#chat-history-list'), ids = new Set(conversations.map(conversation => conversation.id));
  for (const [id, node] of conversationNodes) {
    if (!ids.has(id)) { node.button.remove(); conversationNodes.delete(id); }
  }
  for (const [index, conversation] of conversations.entries()) {
    let node = conversationNodes.get(conversation.id);
    if (!node) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chat-history-choice';
      button.dataset.conversationId = conversation.id;
      const title = document.createElement('span'); title.className = 'chat-history-choice-title';
      const meta = document.createElement('span'); meta.className = 'hint';
      button.append(title, meta); button.addEventListener('click', () => { selectedId = conversation.id; dismissDeletion(false); renderHistory(); });
      node = { button, title, meta }; conversationNodes.set(conversation.id, node);
    }
    node.button.setAttribute('aria-pressed', String(conversation.id === selectedId));
    setText(node.title, conversation.title || '新对话');
    setText(node.meta, `${shortDate(conversation.updatedAt)}\n${conversation.messages.length} 条消息`);
    if (list.children[index] !== node.button) list.insertBefore(node.button, list.children[index] || null);
  }
  const current = conversations.find(item => item.id === selectedId);
  find('#chat-history-detail').hidden = !current;
  if (!current) return;
  setText(find('#chat-history-title'), current.title || '新对话');
  setText(find('#chat-history-date'), date(current.createdAt));
  find('#chat-history-continue').disabled = pending || !!snapshot.busy || !!snapshot.storageError;
  find('#chat-history-delete').disabled = pending || !!snapshot.busy || !!snapshot.storageError;
  const detail = find('#chat-history-messages'), messageIds = new Set(current.messages.map(message => message.id));
  for (const [id, node] of historyMessageNodes) {
    if (!messageIds.has(id)) { node.article.remove(); historyMessageNodes.delete(id); }
  }
  for (const [index, message] of current.messages.entries()) {
    let node = historyMessageNodes.get(message.id);
    if (!node) {
      const article = document.createElement('article'); article.className = 'history-message';
      const meta = document.createElement('p'); meta.className = 'history-message-meta';
      const body = document.createElement('p'); body.className = 'history-message-body';
      const status = document.createElement('span'); status.className = 'hint';
      article.append(meta, body, status); node = { article, meta, body, status }; historyMessageNodes.set(message.id, node);
    }
    node.article.dataset.role = message.role;
    setText(node.meta, `${message.role === 'user' ? message.username || '你' : '爱莉希雅'} · ${date(message.createdAt)}`);
    setText(node.body, message.content || (message.status === 'streaming' ? '正在回答…' : '没有收到完整回答。'));
    const statuses = { streaming: '正在回答', error: '回答未完成', cancelled: '已停止' };
    setText(node.status, statuses[message.status] || ''); node.status.hidden = !statuses[message.status];
    // A stream in another conversation must not disturb selected history text.
    if (detail.children[index] !== node.article) detail.insertBefore(node.article, detail.children[index] || null);
  }
}
function dismissDeletion(restoreFocus = true) {
  const previous = deletion; deletion = null; find('#chat-history-confirm').hidden = true;
  if (restoreFocus && previous) find(previous.kind === 'all' ? '#chat-history-clear' : '#chat-history-delete').focus();
}
function requestDeletion(kind) {
  if (!snapshot || pending || snapshot.busy || snapshot.storageError) return;
  const conversation = snapshot.conversations.find(item => item.id === selectedId);
  if (kind === 'one' && !conversation) return;
  deletion = { kind, id: conversation?.id };
  const title = (conversation?.title || '新对话').slice(0, 24);
  setText(find('#chat-history-confirm-text'), kind === 'all' ? '清空全部聊天记录？此操作无法撤销。' : `删除“${title}”？此操作无法撤销。`);
  setText(find('#chat-history-confirm-delete'), kind === 'all' ? '清空' : '删除');
  find('#chat-history-confirm').hidden = false;
  find('#chat-history-confirm-cancel').focus();
}
function render() {
  // Saving settings also retries a failed disk write after the user frees space.
  const disabled = !snapshot || pending || snapshot.busy;
  for (const [key, input] of Object.entries(fields)) {
    input.disabled = disabled;
    if (snapshot && !dirty.has(key) && document.activeElement !== input) input.value = snapshot.settings[key] || '';
  }
  find('#chat-settings-save').disabled = disabled;
  readAloud.disabled = !snapshot || pending;
  if (snapshot && !readAloudPending) readAloud.checked = snapshot.settings.readAloud === true;
  find('#settings-open-chat').disabled = !snapshot;
  find('#chat-settings-status').textContent = snapshot?.busy ? '回答结束后可以修改设置' : pending ? '正在保存…' : snapshot?.storageError ? '保存失败，可重试' : dirty.size ? '有尚未保存的修改' : snapshot ? '已保存到本机' : '正在读取…';
  renderHistory();
}
function receive(value) {
  if (!value?.settings || !Array.isArray(value.conversations)) return;
  snapshot = value; revision++; render();
  if (value.storageError) { showError(new Error(value.storageError)); showError(new Error(value.storageError), true); }
  else if (lastStorageError) {
    for (const selector of ['#chat-settings-error', '#chat-history-error']) {
      const node = find(selector); if (node.textContent === lastStorageError) node.hidden = true;
    }
  }
  lastStorageError = value.storageError || null;
}
async function command(operation, history = false) {
  pending = true; render();
  find(history ? '#chat-history-error' : '#chat-settings-error').hidden = true;
  try {
    const before = revision, result = await operation();
    if (result === false || result?.ok === false) throw new Error(result?.error || '聊天操作暂未完成，请重试。');
    if (before === revision && result?.settings) receive(result);
    if (result?.error || result?.storageError) throw new Error(result.storageError || result.error);
    return result;
  } catch (error) { showError(error, history); return null; }
  finally { pending = false; render(); }
}
for (const [key, field] of Object.entries(fields)) field.addEventListener('input', () => { dirty.add(key); find('#chat-settings-status').textContent = '有尚未保存的修改'; });
readAloud.addEventListener('change', async () => {
  if (!snapshot || pending) return;
  const enabled = readAloud.checked;
  readAloudPending = true;
  await command(() => desktop.setChatSettings({ readAloud: enabled }));
  readAloudPending = false; render();
});
find('#chat-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!snapshot || snapshot.busy || pending) return;
  const patch = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()]));
  const result = await command(() => desktop.setChatSettings(patch));
  if (result) { dirty.clear(); for (const [key, input] of Object.entries(fields)) input.value = snapshot.settings[key] || ''; render(); }
});
find('#settings-open-chat').addEventListener('click', async () => {
  try { await desktop.openChat(); } catch (error) { showError(error); }
});
find('#chat-history-continue').addEventListener('click', async () => {
  if (!selectedId || snapshot?.busy || pending) return;
  const result = await command(() => desktop.selectChatConversation(selectedId), true);
  if (result) { try { await desktop.openChat(); } catch (error) { showError(error, true); } }
});
find('#chat-history-delete').addEventListener('click', () => requestDeletion('one'));
find('#chat-history-clear').addEventListener('click', () => requestDeletion('all'));
find('#chat-history-confirm-cancel').addEventListener('click', () => dismissDeletion());
find('#chat-history-confirm').addEventListener('keydown', event => { if (event.key === 'Escape' && !pending) { event.preventDefault(); dismissDeletion(); } });
find('#chat-history-confirm-delete').addEventListener('click', async () => {
  if (!deletion || pending || snapshot?.busy || snapshot?.storageError) return;
  const target = deletion;
  const result = await command(() => target.kind === 'all' ? desktop.clearChatHistory() : desktop.deleteChatConversation(target.id), true);
  if (result) {
    dismissDeletion(false);
    if (selectedId) find('#chat-history-delete').focus(); else find('[data-tab=history]').focus();
  }
});
try {
  if (!desktop?.getChatState || !desktop?.onChatState) throw new Error('聊天功能暂不可用，请重新打开新版桌宠。');
  const stop = desktop.onChatState(receive), before = revision;
  const result = await desktop.getChatState(); if (before === revision) receive(result);
  if (!snapshot) throw new Error('暂时无法读取聊天设置。');
  document.documentElement.dataset.chatSettingsReady = 'true';
  document.documentElement.dataset.chatReady = 'true';
  window.addEventListener('pagehide', () => stop?.(), { once: true });
} catch (error) { showError(error); showError(error, true); find('#chat-settings-status').textContent = '暂不可用'; }

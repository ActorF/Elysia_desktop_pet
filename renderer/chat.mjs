const desktop = window.elysiaChat;
const find = selector => document.querySelector(selector);
const transcript = find('#chat-transcript'), messages = find('#chat-messages'), input = find('#chat-input');
const errorNode = find('#chat-error'), storageErrorNode = find('#chat-storage-error'), speechErrorNode = find('#chat-speech-error');
let snapshot = null, revision = 0, pending = false, composing = false, submittedText = null;
let lastConversationId = null;
const messageNodes = new Map();
let messageActionPending = false;
function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
function makeMessageAction(action, label, paths) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'message-action'; button.dataset.messageAction = action;
  button.title = label; button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const data of paths) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', data); svg.append(path); }
  const tooltip = document.createElement('span'); tooltip.className = 'message-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = label;
  button.append(svg, tooltip);
  return { button, tooltip, label };
}
async function messageAction(node, action) {
  if (!snapshot || !node.message?.content?.trim() || node.actionPending) return;
  if (action === 'read-aloud' && (node.message.status === 'streaming' || snapshot.busy || messageActionPending)) return;
  const isCopy = action === 'copy', control = isCopy ? node.copy : node.read;
  const target = { conversationId: node.conversationId, messageId: node.message.id };
  node.actionPending = true;
  if (!isCopy) messageActionPending = true;
  renderMessages();
  try {
    const before = revision;
    const result = await (isCopy ? desktop.copyMessage(target) : desktop.readAloud(target));
    if (before === revision && result?.settings) receive(result);
    if (result === false || result?.ok === false || result?.error) throw new Error(result?.error || '操作暂未完成，请重试。');
    if (isCopy) {
      clearTimeout(node.copyTimer); setText(control.tooltip, '已复制'); control.button.title = '已复制';
      node.copyTimer = setTimeout(() => { setText(control.tooltip, control.label); control.button.title = control.label; }, 1500);
    }
  } catch (error) { fail(error); }
  finally { node.actionPending = false; if (!isCopy) messageActionPending = false; renderMessages(); }
}
const time = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
};
function fail(error) {
  errorNode.textContent = error?.message || '操作暂未完成，请重试。'; errorNode.hidden = false;
}
function restoreDraft() {
  if (submittedText && !input.value) input.value = submittedText;
  submittedText = null;
}
function controls() {
  const busy = snapshot?.busy === true;
  const speaking = ['starting', 'synthesizing', 'playing'].includes(snapshot?.speech?.status);
  input.disabled = !snapshot || !!snapshot.storageError;
  find('#chat-send').disabled = !snapshot || busy || pending || !!snapshot.storageError || !input.value.trim();
  find('#chat-send').hidden = busy;
  find('#chat-stop').hidden = !busy && !speaking;
  find('#chat-stop').disabled = pending;
  find('#chat-stop').textContent = busy ? '停止回答' : '停止朗读';
  find('#chat-stop').title = busy ? '停止回答' : '停止朗读';
  find('#chat-new').disabled = !snapshot || busy || pending || !!snapshot.storageError;
  find('#chat-status').textContent = busy ? '爱莉希雅正在回答…' : speaking ? snapshot.speech.status === 'playing' ? '正在朗读…' : '正在准备朗读…' : '';
  find('#chat-status').hidden = !busy && !speaking;
}
function renderMessages() {
  const conversation = snapshot.conversations?.find(item => item.id === snapshot.activeConversationId);
  const changed = lastConversationId !== snapshot.activeConversationId;
  const follow = changed || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  const previousScroll = transcript.scrollTop;
  lastConversationId = snapshot.activeConversationId;
  const entries = conversation?.messages || [];
  find('#chat-empty').hidden = entries.length > 0;
  const ids = new Set(entries.map(message => message.id));
  for (const [id, node] of messageNodes) {
    if (!ids.has(id)) { clearTimeout(node.copyTimer); node.article.remove(); messageNodes.delete(id); }
  }
  for (const [index, message] of entries.entries()) {
    let node = messageNodes.get(message.id);
    if (!node) {
      const article = document.createElement('article'); article.className = 'chat-message';
      const meta = document.createElement('div'); meta.className = 'chat-message-meta';
      const name = document.createElement('span'); name.className = 'chat-message-name';
      const stamp = document.createElement('time');
      const body = document.createElement('p'); body.className = 'chat-message-body';
      const note = document.createElement('span'); note.className = 'chat-message-note';
      const actions = document.createElement('div'); actions.className = 'message-actions';
      const copy = makeMessageAction('copy', message.role === 'user' ? '复制消息' : '复制回复', ['M9 8h11v13H9z', 'M15 8V3H4v13h5']);
      const read = message.role === 'assistant' ? makeMessageAction('read-aloud', '朗读回复', ['M4 9h4l5-4v14l-5-4H4z', 'M16 8c2 2 2 6 0 8', 'M19 5c4 4 4 10 0 14']) : null;
      actions.append(copy.button); if (read) actions.append(read.button);
      meta.append(name, stamp); article.append(meta, body, note, actions);
      node = { article, name, stamp, body, note, actions, copy, read, actionPending: false }; messageNodes.set(message.id, node);
      const created = node;
      copy.button.addEventListener('click', () => void messageAction(created, 'copy'));
      read?.button.addEventListener('click', () => void messageAction(created, 'read-aloud'));
    }
    node.message = message; node.conversationId = conversation.id; node.article.dataset.messageId = message.id;
    node.article.dataset.role = message.role;
    setText(node.name, message.role === 'user' ? message.username || '你' : '爱莉希雅');
    node.stamp.dateTime = message.createdAt || ''; setText(node.stamp, time(message.createdAt));
    setText(node.body, message.content || (message.status === 'streaming' ? '正在想怎么回应你…' : '这次没有收到完整回答。'));
    const labels = { streaming: '正在回答', cancelled: '已停止', error: '回答未完成' };
    setText(node.note, labels[message.status] || ''); node.note.hidden = !labels[message.status];
    node.copy.button.disabled = !message.content?.trim() || node.actionPending;
    if (node.read) node.read.button.disabled = !message.content?.trim() || message.status === 'streaming' || snapshot.busy || node.actionPending || messageActionPending;
    // Never detach unchanged messages: doing so destroys a user's copy selection.
    if (messages.children[index] !== node.article) messages.insertBefore(node.article, messages.children[index] || null);
  }
  if (follow) transcript.scrollTop = transcript.scrollHeight; else transcript.scrollTop = previousScroll;
}
function receive(value) {
  if (!value?.settings || !Array.isArray(value.conversations)) return;
  snapshot = value; revision++;
  errorNode.hidden = !value.error; errorNode.textContent = value.error || '';
  storageErrorNode.hidden = !value.storageError; storageErrorNode.textContent = value.storageError || '';
  speechErrorNode.hidden = !value.speech?.error; speechErrorNode.textContent = value.speech?.error || '';
  if (!value.busy && value.error) restoreDraft();
  else if (!value.busy && !pending) submittedText = null;
  renderMessages(); controls();
}
async function command(operation) {
  pending = true; controls(); errorNode.hidden = true;
  try {
    const before = revision, result = await operation();
    if (before === revision && result?.settings) receive(result);
    if (result === false || result?.ok === false) throw new Error(result?.error || '操作暂未完成，请重试。');
    if (result?.error) fail(new Error(result.error));
    return result;
  } catch (error) { fail(error); return null; }
  finally { pending = false; controls(); }
}
find('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !snapshot || snapshot.busy || pending || snapshot.storageError || composing) return;
  submittedText = input.value; input.value = ''; controls();
  const result = await command(() => desktop.send(text));
  if (!result || result.error || result.storageError) restoreDraft();
  else if (!snapshot.busy) submittedText = null;
  controls(); input.focus();
});
input.addEventListener('input', controls);
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault(); find('#chat-form').requestSubmit();
  }
});
find('#chat-stop').addEventListener('click', () => void command(() => desktop.cancel()));
find('#chat-new').addEventListener('click', () => void command(() => desktop.newConversation()));
find('#chat-settings').addEventListener('click', async () => {
  try { await desktop.openSettings(); } catch (error) { fail(error); }
});
for (const button of document.querySelectorAll('[data-window-control]')) button.addEventListener('click', () => desktop?.windowControl(button.dataset.windowControl));
function renderWindowState(value) {
  const button = find('[data-window-control=toggle-maximize]'), maximized = value?.maximized === true;
  button.dataset.maximized = String(maximized); button.title = maximized ? '还原' : '最大化'; button.setAttribute('aria-label', button.title);
}
try {
  if (!desktop) throw new Error('请从桌宠托盘的“打开聊天框”打开此窗口。');
  const stop = desktop.onState(receive), before = revision;
  const result = await desktop.getState(); if (revision === before) receive(result);
  if (!snapshot) throw new Error('暂时无法读取聊天，请关闭窗口后重新打开。');
  let windowRevision = 0;
  const stopWindow = desktop.onWindowState(value => { windowRevision++; renderWindowState(value); });
  const beforeWindow = windowRevision, windowState = await desktop.getWindowState();
  if (windowRevision === beforeWindow) renderWindowState(windowState);
  document.documentElement.dataset.chatReady = 'true'; input.focus();
  window.addEventListener('pagehide', () => { stop?.(); stopWindow?.(); for (const node of messageNodes.values()) clearTimeout(node.copyTimer); }, { once: true });
} catch (error) { fail(error); }

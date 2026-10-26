/** Exercise chat IPC authorization using distinct renderer identities and real handlers. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerChatIpc } = require('../electron/chat-ipc.cjs');

function fixture({ withSpeech = false, getState, chatState } = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [];
  function windowController(name) {
    const frame = { url: `file:///${name}.html` };
    const contents = { mainFrame: frame, isDestroyed: () => false };
    const window = { webContents: contents, isDestroyed: () => false };
    return {
      url: frame.url, window, event: { sender: contents, senderFrame: frame }, getWindow: () => window,
      open: async () => { calls.push([`${name}:open`]); return window; },
      getWindowState: () => { calls.push([`${name}:window-state`]); return { maximized: false }; },
      windowControl: value => calls.push([`${name}:window-control`, value]),
    };
  }
  const chatWindow = windowController('chat'), settingsWindow = windowController('settings');
  const chat = Object.fromEntries(['getState', 'send', 'cancel', 'newConversation', 'setSettings', 'selectConversation', 'deleteConversation', 'clearHistory']
    .map(method => [method, (...args) => { calls.push([method, ...args]); return { result: method }; }]));
  if (chatState) chat.getState = () => { calls.push(['getState']); return structuredClone(chatState); };
  chat.getMessage = reference => {
    calls.push(['getMessage', reference]);
    const message = chatState?.conversations.find(item => item.id === reference?.conversationId)?.messages.find(item => item.id === reference?.messageId);
    return message ? structuredClone(message) : null;
  };
  const clipboard = { text: '', fail: false, writeText(value) { if (this.fail) throw new Error('SECRET clipboard failure'); this.text = value; calls.push(['clipboard:write', value]); } };
  const speech = withSpeech ? {
    stop: () => calls.push(['speech:stop']), report: value => calls.push(['speech:report', value]), warmup: () => calls.push(['speech:warmup']),
    clearCache: () => calls.push(['speech:clear-cache']), start: (text, options) => { calls.push(['speech:start', text, options]); return true; },
    speak: (text, options) => { calls.push(['speech:speak', text, options]); return speech.accept !== false; }, getState: () => ({ error: speech.error || null }),
  } : undefined;
  registerChatIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) }, chat, chatWindow, settingsWindow, speech, clipboard, getState });
  return { handlers, listeners, calls, chatWindow, settingsWindow, chat, chatState, speech, clipboard };
}

test('chat operations and settings operations are limited to their own live main-frame document', async () => {
  const f = fixture();
  assert.equal(f.handlers.size, 14);
  for (const [channel, handle] of f.handlers) {
    const owner = channel.startsWith('settings:') ? f.settingsWindow : f.chatWindow;
    const other = owner === f.chatWindow ? f.settingsWindow : f.chatWindow;
    const untrusted = [
      other.event,
      { sender: {}, senderFrame: owner.event.senderFrame },
      { sender: owner.event.sender, senderFrame: { url: owner.url } },
      { sender: owner.event.sender, senderFrame: null },
    ];
    for (const event of untrusted) assert.equal(await handle(event, 'ignored'), null, `${channel} rejects a foreign sender`);
    const frame = owner.event.senderFrame;
    frame.url = `${owner.url}?untrusted=1`;
    assert.equal(await handle(owner.event, 'ignored'), null, `${channel} rejects a changed document URL`);
    frame.url = owner.url;
    owner.window.isDestroyed = () => true;
    assert.equal(await handle(owner.event, 'ignored'), null, `${channel} rejects a destroyed window`);
    owner.window.isDestroyed = () => false;
    owner.window.webContents.isDestroyed = () => true;
    assert.equal(await handle(owner.event, 'ignored'), null, `${channel} rejects destroyed contents`);
    owner.window.webContents.isDestroyed = () => false;
    const originalGetWindow = owner.getWindow;
    owner.getWindow = () => null;
    assert.equal(await handle(owner.event, 'ignored'), null, `${channel} rejects a closed window`);
    owner.getWindow = originalGetWindow;
  }
  assert.deepEqual(f.calls, [], 'Rejected senders never reach storage, inference or window operations');
});

test('authorized chat commands forward only their documented argument and return results', async () => {
  const f = fixture();
  const requests = [
    ['chat:get-state', 'ignored', ['getState']],
    ['chat:send', '你好，爱莉希雅', ['send', '你好，爱莉希雅']],
    ['chat:cancel', 'ignored', ['cancel']],
    ['chat:new-conversation', 'ignored', ['newConversation']],
    ['chat:get-window-state', 'ignored', ['chat:window-state']],
    ['chat:open-settings', 'ignored', ['settings:open']],
    ['settings:chat-get', 'ignored', ['getState']],
    ['settings:chat-settings', { username: '小星' }, ['setSettings', { username: '小星' }]],
    ['settings:chat-select', 'conversation-1', ['selectConversation', 'conversation-1']],
    ['settings:chat-delete', 'conversation-1', ['deleteConversation', 'conversation-1']],
    ['settings:chat-clear', 'ignored', ['clearHistory']],
    ['settings:chat-open', 'ignored', ['chat:open']],
  ];
  for (const [channel, argument, expected] of requests) {
    const owner = channel.startsWith('settings:') ? f.settingsWindow : f.chatWindow;
    const result = await f.handlers.get(channel)(owner.event, argument, { extra: 'never forwarded' });
    assert.deepEqual(f.calls.at(-1), expected);
    if (channel.endsWith('open') || channel === 'chat:open-settings') assert.equal(result, true);
    else if (channel === 'chat:get-window-state') assert.deepEqual(result, { maximized: false });
    else assert.deepEqual(result, { result: expected[0] });
  }
  assert.equal(f.calls.length, requests.length);
  assert.deepEqual([...f.listeners.keys()], ['chat:window-control', 'chat:speech-report']);
  f.listeners.get('chat:window-control')(f.settingsWindow.event, 'close');
  f.listeners.get('chat:window-control')({ ...f.chatWindow.event, senderFrame: { url: f.chatWindow.url } }, 'close');
  assert.equal(f.calls.length, requests.length, 'Only the chat main frame can control the chat window');
  f.listeners.get('chat:window-control')(f.chatWindow.event, 'close', 'quit');
  assert.deepEqual(f.calls.at(-1), ['chat:window-control', 'close']);
});

function storedChat() {
  return { settings: { readAloud: false }, busy: false, activeConversationId: 'current', conversations: [
    { id: 'current', messages: [
      { id: 'user-1', role: 'user', content: '用户的真实消息', status: 'complete' },
      { id: 'reply-1', role: 'assistant', content: '已经保存的回复\n第二行', status: 'complete' },
      { id: 'partial-1', role: 'assistant', content: '保存的部分回复', status: 'cancelled' },
      { id: 'stream-1', role: 'assistant', content: '未完成的流', status: 'streaming' },
      { id: 'empty-1', role: 'assistant', content: '  ', status: 'error' },
    ] },
    { id: 'other', messages: [{ id: 'other-reply', role: 'assistant', content: '其他会话', status: 'complete' }] },
  ] };
}

test('copy writes only the stored message selected by identifiers, never renderer-supplied text or invalid references', async () => {
  const f = fixture({ chatState: storedChat() }), copy = f.handlers.get('chat:copy-message');
  for (const messageId of ['user-1', 'reply-1', 'stream-1']) {
    const result = await copy(f.chatWindow.event, { conversationId: 'current', messageId, content: '伪造正文', text: '任意剪贴板内容' });
    assert.deepEqual(result, { ok: true });
    assert.equal(f.clipboard.text, f.chatState.conversations[0].messages.find(item => item.id === messageId).content);
  }
  const previous = f.clipboard.text;
  for (const reference of [null, {}, { content: '任意文本' }, { conversationId: 'current', messageId: 'missing' }, { conversationId: 'other', messageId: 'reply-1' }]) {
    assert.equal((await copy(f.chatWindow.event, reference)).ok, false); assert.equal(f.clipboard.text, previous);
  }
  f.clipboard.fail = true;
  const failed = await copy(f.chatWindow.event, { conversationId: 'current', messageId: 'reply-1' });
  assert.equal(failed.ok, false); assert.match(failed.error, /无法复制/); assert.doesNotMatch(failed.error, /SECRET/);
});

test('manual reading only accepts a finished assistant message in the active idle conversation and bypasses the automatic toggle through speak', async () => {
  const f = fixture({ withSpeech: true, chatState: storedChat() }), read = f.handlers.get('chat:read-aloud');
  for (const reference of [null, {}, { conversationId: 'current', messageId: 'user-1' },
    { conversationId: 'current', messageId: 'stream-1' }, { conversationId: 'current', messageId: 'empty-1' },
    { conversationId: 'other', messageId: 'other-reply' }, { conversationId: 'other', messageId: 'reply-1' }]) {
    assert.equal((await read(f.chatWindow.event, reference)).ok, false);
  }
  assert.equal(f.calls.some(([operation]) => operation === 'speech:speak' || operation === 'speech:start'), false);
  f.chatState.busy = true;
  const rejected = await read(f.chatWindow.event, { conversationId: 'current', messageId: 'reply-1' });
  assert.equal(rejected.ok, false); assert.match(rejected.error, /等待/);
  assert.equal(f.calls.some(([operation]) => operation === 'speech:speak'), false);
  f.chatState.busy = false;
  for (const messageId of ['reply-1', 'partial-1']) {
    const result = await read(f.chatWindow.event, { conversationId: 'current', messageId, content: '伪造的朗读文本' });
    assert.equal(result.settings.readAloud, false);
    const expected = f.chatState.conversations[0].messages.find(item => item.id === messageId);
    assert.deepEqual(f.calls.at(-1), ['speech:speak', expected.content, { messageId }]);
  }
  assert.equal(f.calls.some(([operation]) => operation === 'speech:start'), false, 'Explicit reading must not depend on the automatic-only start path');
  f.speech.accept = false; f.speech.error = '勿扰已开启。';
  const muted = await read(f.chatWindow.event, { conversationId: 'current', messageId: 'reply-1' });
  assert.equal(muted.ok, false); assert.equal(muted.error, '勿扰已开启。');
});

test('successful history removal clears generated audio caches, but rejected deletion preserves them', async () => {
  const f = fixture({ withSpeech: true });
  for (const [channel, operation] of [['settings:chat-delete', 'deleteConversation'], ['settings:chat-clear', 'clearHistory']]) {
    const invoke = f.handlers.get(channel);
    for (const failure of [{ error: 'busy', storageError: null }, { error: null, storageError: 'disk full' }]) {
      f.chat[operation] = () => failure;
      const before = f.calls.length;
      assert.equal(await invoke(f.settingsWindow.event, 'conversation-1'), failure);
      assert.equal(f.calls.length, before, 'A failed disk mutation must not discard usable cached audio');
    }
    f.chat[operation] = () => ({ conversations: [], activeConversationId: null, settings: { readAloud: true }, error: null, storageError: null });
    const result = await invoke(f.settingsWindow.event, 'conversation-1');
    assert.deepEqual(f.calls.at(-1), ['speech:clear-cache']); assert.equal(result.settings.readAloud, true);
  }
});

test('speech completion reports accept only the current chat main frame, never settings, stale frames or closed windows', () => {
  const f = fixture({ withSpeech: true }), receive = f.listeners.get('chat:speech-report');
  const packet = { token: 'audio-token', type: 'ended' };
  for (const event of [f.settingsWindow.event, { sender: {}, senderFrame: f.chatWindow.event.senderFrame },
    { ...f.chatWindow.event, senderFrame: { url: f.chatWindow.url } }, { ...f.chatWindow.event, senderFrame: null }]) receive(event, packet);
  const frame = f.chatWindow.event.senderFrame;
  frame.url = 'https://outside.example/'; receive(f.chatWindow.event, packet); frame.url = f.chatWindow.url;
  f.chatWindow.window.isDestroyed = () => true; receive(f.chatWindow.event, packet); f.chatWindow.window.isDestroyed = () => false;
  f.chatWindow.window.webContents.isDestroyed = () => true; receive(f.chatWindow.event, packet); f.chatWindow.window.webContents.isDestroyed = () => false;
  const getWindow = f.chatWindow.getWindow; f.chatWindow.getWindow = () => null; receive(f.chatWindow.event, packet); f.chatWindow.getWindow = getWindow;
  assert.deepEqual(f.calls, []);
  receive(f.chatWindow.event, packet, 'extra not forwarded');
  assert.deepEqual(f.calls, [['speech:report', packet]]);
});

test('authorized send, cancel, new and history-selection commands stop speech before changing the conversation', async () => {
  const f = fixture({ withSpeech: true });
  for (const [channel, argument, operation] of [
    ['chat:send', '新问题', ['send', '新问题']], ['chat:cancel', undefined, ['cancel']],
    ['chat:new-conversation', undefined, ['newConversation']], ['settings:chat-select', 'saved-id', ['selectConversation', 'saved-id']],
  ]) {
    const owner = channel.startsWith('settings:') ? f.settingsWindow : f.chatWindow;
    const other = owner === f.chatWindow ? f.settingsWindow : f.chatWindow;
    const before = f.calls.length;
    assert.equal(await f.handlers.get(channel)(other.event, argument), null);
    assert.equal(f.calls.length, before, 'Rejected command must not stop another window’s audio');
    await f.handlers.get(channel)(owner.event, argument);
    assert.deepEqual(f.calls.slice(before), [['speech:stop'], operation]);
  }
});

test('chat and settings receive the combined chat-and-speech snapshot when supplied by the host', async () => {
  const snapshot = { settings: { readAloud: true }, speech: { status: 'playing', error: null }, conversations: [] };
  const f = fixture({ withSpeech: true, getState: () => snapshot });
  for (const channel of ['chat:get-state', 'chat:send', 'chat:cancel', 'chat:new-conversation', 'settings:chat-get', 'settings:chat-settings', 'settings:chat-select']) {
    const owner = channel.startsWith('settings:') ? f.settingsWindow : f.chatWindow;
    assert.equal(await f.handlers.get(channel)(owner.event, {}), snapshot);
  }
});

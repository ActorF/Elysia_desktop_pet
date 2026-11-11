'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatService } = require('../electron/chat-service.cjs');
const { createQuickChatController, ensureQuickChatReady } = require('../electron/quick-chat-controller.cjs');
const { registerChatIpc } = require('../electron/chat-ipc.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'controlled request should settle promptly');
}
function response(text) {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-quick-controller-'));
  const requests = [], captions = [], completed = [], calls = [], publications = [];
  let quick, caption = null;
  const window = {
    hide: () => calls.push('hide'), open: async () => { calls.push('open'); return {}; },
    publish: state => publications.push(state),
  };
  const voices = {
    stopChatText() { calls.push('caption:stop'); caption?.resolve('stopped'); caption = null; },
    showChatText(text, id, duration) { caption = deferred(); captions.push({ text, id, duration, done: caption.resolve }); return caption.promise; },
  };
  const speech = {
    stop: () => calls.push('speech:stop'), warmup: () => calls.push('speech:warmup'),
    start: (text, reference) => calls.push(['speech:start', text, reference]),
    speak: () => { calls.push('speech:speak'); return true; }, clearCache: () => calls.push('speech:clear'),
  };
  const chat = createChatService({ directory,
    fetchImpl: (url, init) => { const request = deferred(); requests.push({ ...request, body: JSON.parse(init.body), signal: init.signal }); return request.promise; },
    onChange: () => quick?.changed(), onReplyCompleted: reply => completed.push({ reply, handled: quick?.completed(reply) }),
  });
  quick = createQuickChatController({ chat, window, voices, speech,
    selectSpeechTarget: target => calls.push(['target', target]), ...options });
  t.after(() => { quick.dispose(); chat.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function finish(text, request = requests.at(-1)) {
    request.resolve(response(text)); await until(() => !chat.getState().busy);
    assert.equal(chat.getState().error, null, 'the synthetic completion must be accepted by the real SSE parser');
  }
  const conversation = () => chat.getState().conversations.find(item => item.id === chat.getState().activeConversationId);
  return { quick, chat, window, voices, speech, requests, captions, completed, calls, publications, finish, conversation };
}

test('waiting for the model rejects duplicates, can be cancelled and never sends the retained draft later', async t => {
  const ready = deferred(); let signal;
  const f = fixture(t, { ensureReady: value => { signal = value; return ready.promise; } });
  const first = f.quick.send('尚未发送的草稿');
  assert.equal(f.quick.getState().busy, true); assert.match(f.quick.getState().status, /唤醒/);
  assert.equal((await f.quick.send('重复发送')).accepted, false);
  assert.equal(f.chat.getState().conversations.length, 0); assert.equal(f.requests.length, 0);
  f.quick.cancel(); assert.equal(signal.aborted, true); assert.equal(f.quick.getState().busy, false);
  ready.resolve(); assert.equal((await first).accepted, false);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.includes('hide'), false);
  assert.equal((await f.quick.send('保留后重新发送')).accepted, true);
  await until(() => f.requests.length === 1); await f.finish('收到啦。');
  assert.deepEqual(f.conversation().messages.filter(item => item.role === 'user').map(item => item.content), ['保留后重新发送']);
});

test('a busy existing chat is rejected without stopping its response or claiming speech', async t => {
  const f = fixture(t); f.chat.send('完整聊天窗口的问题');
  await until(() => f.requests.length === 1);
  const result = await f.quick.send('快捷窗口的新问题');
  assert.equal(result.accepted, false); assert.match(result.error, /回复|停止/);
  assert.equal(f.requests[0].signal.aborted, false); assert.deepEqual(f.calls, []);
  await f.finish('原来的回答。');
  assert.equal(f.completed[0].handled, false); assert.deepEqual(f.captions, []);
});

test('an external send during model startup wins, without adding the quick draft to history', async t => {
  const ready = deferred(), f = fixture(t, { ensureReady: () => ready.promise });
  const quickSend = f.quick.send('仍在准备的草稿');
  f.chat.send('另一个窗口已经发送'); ready.resolve();
  const result = await quickSend;
  assert.equal(result.accepted, false); assert.equal(f.calls.includes('hide'), false);
  await until(() => f.requests.length === 1); await f.finish('另一个窗口的回答。');
  assert.deepEqual(f.conversation().messages.filter(item => item.role === 'user').map(item => item.content), ['另一个窗口已经发送']);
  assert.equal(f.completed[0].handled, false); assert.deepEqual(f.captions, []);
});

test('a real multi-sentence reply shows sequential stored bubbles and speaks once', async t => {
  const f = fixture(t);
  assert.equal((await f.quick.send('今天过得怎么样？')).accepted, true);
  assert.equal(f.calls.includes('speech:warmup'), false, 'quick replies select their voice after text is known, avoiding a discarded neutral cold load');
  await until(() => f.requests.length === 1); await f.finish('见到你真好。\n今天也辛苦啦！\n一起歇一会儿吧。');
  const replies = f.conversation().messages.filter(item => item.role === 'assistant');
  assert.equal(replies.length, 3); assert.equal(f.captions.length, 1);
  assert.deepEqual(f.captions.map(({ text, id }) => ({ text, id })), [{ text: replies[0].content, id: replies[0].id }]);
  assert.deepEqual(f.calls.filter(item => Array.isArray(item) && item[0] === 'speech:start'),
    [['speech:start', replies.map(item => item.content).join('\n'), { messageId: replies[0].id }]]);
  assert.equal(f.quick.completed(f.completed[0].reply), false, 'a repeated completion cannot replay the same answer');
  f.captions[0].done('ended'); await until(() => f.captions.length === 2);
  f.captions[1].done('skipped'); await until(() => f.captions.length === 3);
  assert.deepEqual(f.captions.map(item => item.id), replies.map(item => item.id));
  assert.ok(f.captions.every(item => item.duration >= 4200 && item.duration <= 20000));
  assert.equal(f.calls.filter(item => item === 'hide').length, 0, 'sending and completing never hide the composer');
  assert.equal(f.calls.filter(item => item === 'open').length, 0, 'reply arrival does not change the user-selected visibility');
});

test('cancel stops inference and captions, and late responses cannot resurface in a new conversation', async t => {
  const f = fixture(t); await f.quick.send('旧问题'); await until(() => f.requests.length === 1);
  const old = f.requests[0]; f.quick.cancel(); assert.equal(old.signal.aborted, true);
  assert.equal(f.conversation().messages.at(-1).status, 'cancelled');
  f.chat.newConversation(); await f.quick.send('新的话题'); await until(() => f.requests.length === 2);
  old.resolve(response('这是过时的回答。')); await f.finish('从这里重新开始吧。');
  assert.deepEqual(f.captions.map(item => item.text), ['从这里重新开始吧。']);
  assert.deepEqual(f.requests[1].body.messages.slice(1), [{ role: 'user', content: '新的话题' }]);
  assert.equal(f.completed.length, 1);
});

test('a failure preserves composer visibility, while validation and startup errors retain an unsent draft', async t => {
  const failedReady = fixture(t, { ensureReady: async () => { throw new Error('本地模型尚未准备好。'); } });
  for (const text of ['', '   ', null, 'a'.repeat(8001)]) assert.equal((await failedReady.quick.send(text)).accepted, false);
  assert.equal((await failedReady.quick.send('保留这条消息')).accepted, false);
  assert.match(failedReady.quick.getState().error, /尚未准备好/); assert.equal(failedReady.quick.getState().busy, false);
  assert.equal(failedReady.requests.length, 0); assert.equal(failedReady.calls.includes('hide'), false);
  const f = fixture(t); await f.quick.send('请求会中断'); await until(() => f.requests.length === 1);
  f.requests[0].reject(new Error('fixture network failure')); await until(() => !f.chat.getState().busy);
  assert.equal(f.calls.filter(item => item === 'open').length, 0); assert.ok(f.quick.getState().error);
  assert.equal(f.completed.length, 0); assert.equal(f.captions.length, 0);
});

function registerExternalActions(f) {
  const handlers = new Map();
  function window(name) {
    const frame = { url: `file:///${name}.html` }, webContents = { mainFrame: frame, isDestroyed: () => false };
    return { url: frame.url, event: { sender: webContents, senderFrame: frame },
      getWindow: () => ({ webContents, isDestroyed: () => false }) };
  }
  const chatWindow = window('chat'), settingsWindow = window('settings');
  registerChatIpc({ ipcMain: { handle: (key, value) => handlers.set(key, value), on() {} },
    chat: f.chat, chatWindow, settingsWindow, speech: f.speech, onAction: () => f.quick.interrupt() });
  return { handlers, chatWindow, settingsWindow };
}

test('voice progress, disabled read-aloud and blocked playback are visible without exposing history', t => {
  let target = true, blocked = null;
  const f = fixture(t, { isSpeechTarget: () => target, getSpeechBlockReason: () => blocked });
  f.speech.getState = () => ({ status: 'warming', error: null, messageId: 'not-for-composer' });
  assert.equal(f.quick.getState().voice.enabled, false);
  f.chat.setSettings({ readAloud: true });
  assert.deepEqual(f.quick.getState().voice, { enabled: true, status: 'warming', error: null, blocked: null });
  blocked = '勿扰已开启。'; f.quick.changed();
  assert.equal(f.publications.at(-1).voice.blocked, '勿扰已开启。');
  blocked = null;
  f.speech.getState = () => ({ status: 'error', error: '本地语音暂时无法启动。' }); f.quick.changed();
  assert.equal(f.publications.at(-1).voice.error, '本地语音暂时无法启动。');
  target = false;
  assert.deepEqual(f.quick.getState().voice, { enabled: true, status: 'idle', error: null, blocked: null });
  assert.equal(Object.hasOwn(f.quick.getState(), 'conversations'), false);
});

test('authorized external chat changes stop queued bubbles; foreign renderers cannot interrupt them', async t => {
  for (const channel of ['chat:send', 'chat:cancel', 'chat:new-conversation', 'chat:read-aloud',
    'settings:chat-select', 'settings:chat-delete', 'settings:chat-clear']) {
    await t.test(channel, async t => {
      const f = fixture(t); await f.quick.send('原问题'); await until(() => f.requests.length === 1);
      await f.finish('第一句。\n第二句。');
      const ipc = registerExternalActions(f), owner = channel.startsWith('settings:') ? ipc.settingsWindow : ipc.chatWindow;
      const other = owner === ipc.settingsWindow ? ipc.chatWindow : ipc.settingsWindow;
      const conversationId = f.chat.getState().activeConversationId;
      const argument = channel === 'chat:send' ? '外部新消息' : channel === 'chat:read-aloud'
        ? { conversationId, messageId: f.conversation().messages[1].id } : conversationId;
      const stopCount = f.calls.filter(item => item === 'caption:stop').length;
      assert.equal(await ipc.handlers.get(channel)(other.event, argument), null);
      assert.equal(f.calls.filter(item => item === 'caption:stop').length, stopCount);
      await ipc.handlers.get(channel)(owner.event, argument);
      assert.equal(f.calls.filter(item => item === 'caption:stop').length, stopCount + 1);
      f.captions[0].done('ended'); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.captions.length, 1, 'the remaining old sentence must never appear');
      assert.equal(f.quick.completed(f.completed[0].reply), false);
    });
  }
});

test('external context changes and disposal cancel preparation without reviving hidden work', async t => {
  for (const dispose of [false, true]) {
    const ready = deferred(); let signal;
    const f = fixture(t, { ensureReady: value => { signal = value; return ready.promise; } });
    const sending = f.quick.send('还在等待');
    if (dispose) f.quick.dispose();
    else {
      const ipc = registerExternalActions(f);
      await ipc.handlers.get('chat:new-conversation')(ipc.chatWindow.event);
    }
    assert.equal(signal.aborted, true); ready.resolve(); assert.equal((await sending).accepted, false);
    assert.equal(f.requests.length, 0); assert.equal(f.calls.includes('hide'), false);
  }
});

test('readiness starts only installed managed servers, surfaces refusal and supports prompt abort', async () => {
  const signal = new AbortController(); let starts = 0;
  const chat = baseUrl => ({ getState: () => ({ settings: { baseUrl } }) });
  const managed = chat('http://127.0.0.1:18434');
  const setup = { ensureInstalledServer: () => { starts++; }, getState: () => ({ serverReady: true, busy: false }) };
  await ensureQuickChatReady(chat('https://provider.example/v1'), setup, signal.signal); assert.equal(starts, 0);
  await ensureQuickChatReady(managed, setup, signal.signal); assert.equal(starts, 1);
  await assert.rejects(ensureQuickChatReady(managed, { ...setup, ensureInstalledServer: () => ({ ok: false, error: '启动被拒绝' }) }, signal.signal), /启动被拒绝/);
  await assert.rejects(ensureQuickChatReady(managed, { ...setup, getState: () => ({ busy: false, error: '缺少本地资源' }) }, signal.signal), /缺少本地资源/);
  await assert.rejects(ensureQuickChatReady(managed, { ...setup, getState: () => ({ busy: true }) }, signal.signal, -1), /还在启动/);
  const waiting = ensureQuickChatReady(managed, { ...setup, getState: () => ({ busy: true }) }, signal.signal);
  signal.abort(); await assert.rejects(waiting, /取消/);
  const before = starts;
  await assert.rejects(ensureQuickChatReady(managed, setup, signal.signal), /取消/); assert.equal(starts, before);
});

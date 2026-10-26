// Exercise persistent host chat state against controlled SSE streams without a model or real profile.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatService, DEFAULT_CHAT_SETTINGS } = require('../electron/chat-service.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-chat-test-'));
  const services = [];
  const create = (extra = {}) => {
    const service = createChatService({ directory, ...options, ...extra }); services.push(service); return service;
  };
  t.after(() => { for (const service of services) service.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file: path.join(directory, 'chat-state.json'), create };
}
async function settled(service) {
  const deadline = Date.now() + 2000;
  while (service.getState().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.getState().busy, false, 'request should settle promptly');
  return service.getState();
}
function event(content, finishReason = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
}
function complete(content, extra = {}) {
  return new Response(event(content, extra.finish_reason || 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
const latest = service => service.getState().conversations.find(item => item.id === service.getState().activeConversationId);

test('recognized previous local defaults migrate on load and persist without losing history or speech preferences', async t => {
  for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11434/', 'http://[::1]:11434']) {
    const f = fixture(t), original = f.create({ fetchImpl: async () => complete('原有回复') });
    original.setSettings({ username: '保留名字', readAloud: true, voiceProjectRoot: 'D:\\MyVoice' });
    original.send('保留聊天'); await settled(original); original.dispose();
    const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    saved.settings.baseUrl = baseUrl;
    saved.settings.model = baseUrl.includes('[::1]') ? 'tobestyledintro/qwen3.8-9b-distill' : 'tobestyledintro/qwen3.8-9b-distill:latest';
    fs.writeFileSync(f.file, JSON.stringify(saved));
    const calls = [], migrated = f.create({ fetchImpl: async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return complete('迁移后的回复'); } });
    const after = migrated.getState();
    assert.equal(after.settings.baseUrl, DEFAULT_CHAT_SETTINGS.baseUrl); assert.equal(after.settings.model, DEFAULT_CHAT_SETTINGS.model);
    assert.equal(after.settings.username, '保留名字'); assert.equal(after.settings.readAloud, true); assert.equal(after.settings.voiceProjectRoot, 'D:\\MyVoice');
    assert.deepEqual(after.conversations, saved.conversations); assert.equal(after.activeConversationId, saved.activeConversationId);
    assert.equal(calls.length, 0, 'Migration itself cannot contact a service');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).settings, after.settings);
    migrated.send('迁移后的问题'); await settled(migrated);
    assert.deepEqual(calls.map(item => item.url), ['http://127.0.0.1:18434/v1/chat/completions']);
    assert.equal(calls[0].payload.model, 'elysia-chat');
  }
});

test('migration preserves custom servers and models and uses a single compatible endpoint without fallback', async t => {
  for (const settings of [
    { baseUrl: 'https://example.test/service/v1', model: 'custom:model' },
    { baseUrl: 'http://localhost:11434', model: 'my-custom-model' },
    { baseUrl: 'https://example.test', model: 'tobestyledintro/qwen3.8-9b-distill:latest' },
    { baseUrl: 'http://localhost:11434/proxy', model: 'tobestyledintro/qwen3.8-9b-distill:latest' },
  ]) {
    const f = fixture(t), original = f.create(); original.setSettings(settings); original.dispose();
    const before = fs.readFileSync(f.file), calls = [];
    const restarted = f.create({ fetchImpl: async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); throw new Error('offline'); } });
    assert.equal(restarted.getState().settings.baseUrl, settings.baseUrl); assert.equal(restarted.getState().settings.model, settings.model);
    assert.deepEqual(fs.readFileSync(f.file), before);
    restarted.send('检查连接'); await settled(restarted);
    assert.deepEqual(calls.map(item => item.url), [`${settings.baseUrl}${settings.baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`]);
    assert.equal(calls[0].payload.chat_template_kwargs, undefined);
    assert.equal(calls[0].payload.options, undefined); assert.match(restarted.getState().error, /无法连接到本地聊天服务/);
  }
});

test('SSE accepts CRLF, comments, split events, role-only deltas and usage while excluding reasoning from visible text', async t => {
  const f = fixture(t);
  const stream = ': keepalive\r\n\r\nevent: message\r\nid: 1\r\n'
    + 'data: {"choices": [\r\ndata: {"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}\r\n\r\n'
    + 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"内部推理"},"finish_reason":null}]}\r\n\r\n'
    + event('可见回答')
    + 'data: {"choices":[],"usage":{"total_tokens":10}}\n\n'
    + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(stream);
  const service = f.create({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
    controller.close();
  } })) });
  service.send('测试'); await settled(service);
  assert.equal(service.getState().error, null); assert.equal(latest(service).messages.at(-1).content, '可见回答');
  assert.equal(latest(service).messages.at(-1).status, 'complete');
});

test('malformed SSE events and incomplete event boundaries never fabricate a completed reply', async t => {
  for (const suffix of [
    'data: {"error":{"message":"SECRET server diagnostic"}}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":42}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n',
  ]) {
    const f = fixture(t), service = f.create({ fetchImpl: async () => new Response(event('保留部分') + suffix) });
    service.send('测试'); await settled(service);
    assert.match(service.getState().error, /格式异常|提前中断/); assert.doesNotMatch(service.getState().error, /SECRET/);
    assert.equal(latest(service).messages.at(-1).content, '保留部分'); assert.equal(latest(service).messages.at(-1).status, 'error');
  }
});

test('streaming joins split UTF-8/SSE, persists replies and sends role prompt plus bounded successful history', async t => {
  const calls = [], f = fixture(t);
  let round = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (++round > 1) return complete('记得呀。');
    const bytes = new TextEncoder().encode(event('你好，') + event('<img src=x onerror=alert(1)>', 'stop') + 'data: [DONE]\n\n');
    return new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
      controller.close();
    } }));
  };
  const service = f.create({ fetchImpl });
  assert.deepEqual(service.getState().settings, DEFAULT_CHAT_SETTINGS);
  service.setSettings({ username: '小星' });
  const snapshot = service.send('你好');
  assert.equal(snapshot.busy, true); assert.equal(snapshot.conversations[0].messages[1].status, 'streaming');
  snapshot.settings.username = '篡改'; snapshot.conversations[0].messages[0].content = '篡改';
  await settled(service);
  assert.equal(latest(service).messages[1].content, '你好，<img src=x onerror=alert(1)>');
  assert.equal(latest(service).messages[1].status, 'complete');
  assert.equal(calls[0].url, 'http://127.0.0.1:18434/v1/chat/completions');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].body.model, 'elysia-chat');
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[0].body.max_tokens, 1024); assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.think, undefined); assert.equal(calls[0].body.options, undefined);
  assert.match(calls[0].body.messages[0].content, /Elysia 运行时人格合同/);
  assert.match(calls[0].body.messages[0].content, /USER_PROFILE_JSON\n\{"user_name":"小星"\}/);
  assert.match(calls[0].body.messages[0].content, /应用可以按用户设置朗读完成的回答/);
  service.send('你记得我吗？'); await settled(service);
  assert.deepEqual(calls[1].body.messages.slice(1).map(item => [item.role, item.content]), [
    ['user', '你好'], ['assistant', '你好，<img src=x onerror=alert(1)>'], ['user', '你记得我吗？'],
  ]);
  const restarted = f.create({ fetchImpl });
  assert.equal(restarted.getState().settings.username, '小星');
  assert.equal(latest(restarted).messages.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).conversations, service.getState().conversations);
});

test('cancel preserves received text, rejects concurrent changes and excludes the cancelled pair from next context', async t => {
  const f = fixture(t), calls = [];
  let stream, fetchCount = 0, signal;
  const service = f.create({ fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body)); signal = options.signal;
    if (++fetchCount > 1) return complete('重新回答');
    return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(event('一半'))); } }));
  } });
  service.send('失败的问题');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(latest(service).messages[1].content, '一半');
  const originalId = service.getState().activeConversationId;
  assert.match(service.send('并发消息').error, /先等待/);
  assert.match(service.setSettings({ username: '另一个名字' }).error, /先等待/);
  assert.match(service.newConversation().error, /先等待/);
  assert.equal(service.getState().activeConversationId, originalId);
  service.cancel();
  assert.equal(signal.aborted, true); assert.equal(service.getState().busy, false);
  assert.equal(latest(service).messages[1].status, 'cancelled');
  assert.equal(latest(service).messages[1].content, '一半');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).conversations[0].messages[1].status, 'cancelled');
  service.send('新的问题'); await settled(service);
  assert.deepEqual(calls[1].messages.slice(1), [{ role: 'user', content: '新的问题' }]);
  assert.equal(fetchCount, 2);
  assert.ok(stream);
});

test('new conversations isolate context and selecting history preserves its original username', async t => {
  const calls = [], f = fixture(t);
  const service = f.create({ fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return complete('回答'); } });
  service.setSettings({ username: '旧名字' }); service.send('旧对话'); await settled(service);
  const oldId = service.getState().activeConversationId;
  service.setSettings({ username: '新名字' }); service.newConversation(); service.send('新对话'); await settled(service);
  assert.deepEqual(calls[1].messages.slice(1), [{ role: 'user', content: '新对话' }]);
  service.selectConversation(oldId);
  assert.equal(latest(service).messages[0].username, '旧名字');
  service.send('继续'); await settled(service);
  assert.match(calls[2].messages[0].content, /"user_name":"新名字"/);
  assert.equal(latest(service).messages.at(-2).username, '新名字');
  assert.equal(service.getState().conversations.length, 2);
  assert.match(service.selectConversation('missing').error, /没有找到/);
});

test('deleting conversations persists the selection and settings, including deletion of the last conversation across restart', async t => {
  const f = fixture(t), service = f.create({ fetchImpl: async () => complete('保留的回答') });
  service.setSettings({ username: '记录主人', model: 'custom:model', baseUrl: 'https://example.test/ollama', readAloud: true, voiceProjectRoot: 'D:\\SavedVoice' });
  const settings = service.getState().settings;
  service.send('第一段'); await settled(service); const firstId = service.getState().activeConversationId;
  service.newConversation(); service.send('第二段'); await settled(service); const secondId = service.getState().activeConversationId;
  const result = service.deleteConversation(secondId);
  assert.equal(result.error, null); assert.equal(result.activeConversationId, firstId);
  assert.deepEqual(result.conversations.map(item => item.id), [firstId]); assert.deepEqual(result.settings, settings);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(saved.conversations, result.conversations); assert.equal(saved.activeConversationId, firstId); assert.deepEqual(saved.settings, settings);
  const restarted = f.create(); assert.equal(restarted.getState().activeConversationId, firstId);
  const empty = restarted.deleteConversation(firstId);
  assert.equal(empty.activeConversationId, null); assert.deepEqual(empty.conversations, []); assert.deepEqual(empty.settings, settings);
  const reopened = f.create(); assert.equal(reopened.getState().activeConversationId, null);
  assert.deepEqual(reopened.getState().conversations, []); assert.deepEqual(reopened.getState().settings, settings);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).conversations, [], 'Deleted histories cannot reappear after restart');
});

test('clear history removes every persisted conversation without changing preferences or recreating an empty conversation', async t => {
  const f = fixture(t), service = f.create({ fetchImpl: async () => complete('回答') });
  service.setSettings({ username: '保留称呼', readAloud: true, model: 'another:model' });
  const settings = service.getState().settings;
  for (const text of ['第一段', '第二段']) { service.newConversation(); service.send(text); await settled(service); }
  const result = service.clearHistory();
  assert.equal(result.error, null); assert.deepEqual(result.conversations, []); assert.equal(result.activeConversationId, null);
  assert.deepEqual(result.settings, settings);
  const restarted = f.create(); assert.deepEqual(restarted.getState().conversations, []); assert.equal(restarted.getState().activeConversationId, null);
  assert.deepEqual(restarted.getState().settings, settings);
});

test('failed delete and clear writes roll back live history and leave the original disk bytes intact', async t => {
  const f = fixture(t), service = f.create({ fetchImpl: async () => complete('必须保留') });
  service.send('不能丢失'); await settled(service);
  const before = service.getState(), original = fs.readFileSync(f.file);
  fs.mkdirSync(f.file + '.tmp');
  for (const operation of [() => service.deleteConversation(before.activeConversationId), () => service.clearHistory()]) {
    const result = operation();
    assert.ok(result.error); assert.ok(result.storageError);
    assert.deepEqual(result.conversations, before.conversations); assert.equal(result.activeConversationId, before.activeConversationId);
    assert.deepEqual(result.settings, before.settings); assert.deepEqual(fs.readFileSync(f.file), original);
  }
  fs.rmdirSync(f.file + '.tmp');
  assert.equal(service.clearHistory().error, null);
  assert.deepEqual(f.create().getState().conversations, []);
});

test('delete and clear reject a running generation without mutating its history or detaching the streamed reply', async t => {
  const f = fixture(t); let stream;
  const service = f.create({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(new TextEncoder().encode(event('前半')));
  } })) });
  service.send('继续回答'); await new Promise(resolve => setTimeout(resolve, 15));
  const before = service.getState(), original = fs.readFileSync(f.file);
  for (const operation of [() => service.deleteConversation(before.activeConversationId), () => service.clearHistory()]) {
    const result = operation(); assert.match(result.error, /先等待/); assert.equal(result.busy, true);
    assert.deepEqual(result.conversations, before.conversations); assert.equal(result.activeConversationId, before.activeConversationId);
    assert.deepEqual(fs.readFileSync(f.file), original);
  }
  stream.enqueue(new TextEncoder().encode(event('后半', 'stop'))); stream.close(); await settled(service);
  assert.equal(latest(service).messages.at(-1).content, '前半后半'); assert.equal(latest(service).messages.at(-1).status, 'complete');
});

test('getMessage resolves only a stored message in its own conversation and returns an isolated clone', async t => {
  const f = fixture(t), service = f.create({ fetchImpl: async () => complete('真实回复') });
  service.send('真实消息'); await settled(service);
  const conversation = latest(service), message = conversation.messages.at(-1);
  const reference = { conversationId: conversation.id, messageId: message.id, content: '伪造正文' };
  const copy = service.getMessage(reference); assert.deepEqual(copy, message);
  copy.content = '篡改'; copy.status = 'streaming';
  assert.deepEqual(service.getMessage(reference), message); assert.deepEqual(f.create().getMessage(reference), message);
  for (const invalid of [null, [], {}, { conversationId: conversation.id }, { messageId: message.id },
    { conversationId: 'other', messageId: message.id }, { conversationId: conversation.id, messageId: 'missing' },
    { conversationId: 1, messageId: message.id }]) assert.equal(service.getMessage(invalid), null);
  service.deleteConversation(conversation.id); assert.equal(service.getMessage(reference), null);
});

test('settings and user messages validate at the host boundary without network requests', t => {
  let calls = 0; const f = fixture(t), service = f.create({ fetchImpl: async () => { calls++; return complete('reply'); } });
  for (const baseUrl of ['file:///C:/', 'http://user:secret@localhost', 'http://localhost?token=secret', 'http://localhost/#hash', 'not a url']) assert.ok(service.setSettings({ baseUrl }).error);
  for (const username of ['', ' '.repeat(3), 'x'.repeat(51), 'x\ny']) assert.ok(service.setSettings({ username }).error);
  for (const model of ['', 'x'.repeat(201), 'x\ny']) assert.ok(service.setSettings({ model }).error);
  for (const message of [null, {}, '', '  ', 'x'.repeat(8001)]) assert.ok(service.send(message).error);
  assert.equal(calls, 0); assert.equal(service.getState().conversations.length, 0);
  const saved = service.setSettings({ baseUrl: 'https://example.test/ollama/', username: '名字', model: 'custom:model', secret: 'ignored' });
  assert.equal(saved.settings.baseUrl, 'https://example.test/ollama'); assert.equal(saved.settings.secret, undefined);
});

test('corrupt history remains byte-for-byte untouched and blocks sends and settings overwrites', t => {
  const f = fixture(t), original = '{ this is not valid JSON';
  fs.writeFileSync(f.file, original);
  let calls = 0; const service = f.create({ fetchImpl: async () => { calls++; return complete('reply'); } });
  assert.match(service.getState().storageError, /原文件已保留/);
  assert.ok(service.send('hello').error); assert.ok(service.setSettings({ username: '新名字' }).storageError);
  service.newConversation();
  assert.equal(fs.readFileSync(f.file, 'utf8'), original); assert.equal(calls, 0);
});

test('failed persistence does not acknowledge or send a message and can recover after the disk issue is fixed', async t => {
  const f = fixture(t), blocker = path.join(f.directory, 'blocked'); fs.writeFileSync(blocker, 'file');
  let calls = 0; const service = f.create({ directory: blocker, fetchImpl: async () => { calls++; return complete('reply'); } });
  // Windows may report a missing child as ENOENT when its parent is a file.
  assert.ok(service.send('hello').error); assert.ok(service.getState().storageError); assert.equal(calls, 0);
  const good = f.create({ fetchImpl: async () => { calls++; return complete('reply'); } });
  fs.mkdirSync(f.file + '.tmp');
  const failed = good.send('hello'); assert.ok(failed.storageError); assert.equal(failed.conversations.length, 0); assert.equal(calls, 0);
  fs.rmdirSync(f.file + '.tmp');
  assert.equal(good.setSettings({ username: '恢复后' }).storageError, null);
  good.send('hello'); await settled(good); assert.equal(calls, 1);
});

test('restart marks interrupted streaming as cancelled without inventing a completed answer', t => {
  const f = fixture(t), service = f.create(); service.newConversation();
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  saved.conversations[0].messages = [{ id: 'message-a', role: 'assistant', content: '未完成', status: 'streaming', createdAt: new Date().toISOString() }];
  fs.writeFileSync(f.file, JSON.stringify(saved));
  const restarted = f.create(); assert.equal(latest(restarted).messages[0].status, 'cancelled'); assert.equal(restarted.getState().busy, false);
});

test('network errors, missing models, malformed/truncated streams and empty replies are explicit and preserve partial text', async t => {
  for (const [name, fetchImpl, expected, partial] of [
    ['offline', async () => { throw new Error('SECRET do not expose'); }, /无法连接/, ''],
    ['model missing', async () => new Response('SECRET', { status: 404 }), /找不到/, ''],
    ['bad stream', async () => new Response('not json\n'), /格式异常/, ''],
    ['interrupted', async () => new Response(event('部分')), /提前中断/, '部分'],
    ['empty', async () => complete(''), /没有返回回答/, ''],
    ['length', async () => complete('太长了', { finish_reason: 'length' }), /长度上限/, '太长了'],
  ]) await t.test(name, async sub => {
    const f = fixture(sub), service = f.create({ fetchImpl }); service.send('测试'); const state = await settled(service);
    assert.match(state.error, expected); assert.doesNotMatch(state.error, /SECRET/);
    assert.equal(latest(service).messages[1].status, 'error'); assert.equal(latest(service).messages[1].content, partial);
  });
});

test('timeout and dispose abort even an unresponsive fetch and no late result overwrites cancellation', async t => {
  const f = fixture(t); let resolveFetch, signal;
  const service = f.create({ requestTimeoutMs: 25, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); } });
  service.send('超时测试'); await settled(service);
  assert.match(service.getState().error, /超时/); assert.equal(signal.aborted, true);
  resolveFetch(complete('太晚的回答')); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(latest(service).messages[1].content, '');
  const pending = f.create({ fetchImpl: () => new Promise(() => {}) }); pending.send('关闭测试'); pending.dispose();
  assert.equal(pending.getState().busy, false); assert.equal(latest(pending).messages.at(-1).status, 'cancelled');
});

test('context retains recent whole successful pairs and never splits a pair to fit', async t => {
  const calls = [], f = fixture(t);
  const service = f.create({ fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return complete('答'.repeat(600)); } });
  for (const letter of ['甲', '乙', '丙']) { service.send(letter.repeat(600)); await settled(service); }
  service.send('最新'); await settled(service);
  const context = calls.at(-1).messages.slice(1);
  assert.deepEqual(context.map(message => message.role), ['user', 'assistant', 'user']);
  assert.equal(context[0].content, '丙'.repeat(600)); assert.equal(context[2].content, '最新');
});

test('read-aloud defaults off, migrates old settings, persists explicit booleans and rejects coercion', t => {
  const f = fixture(t), service = f.create();
  assert.equal(service.getState().settings.readAloud, false);
  service.newConversation();
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8')); delete saved.settings.readAloud;
  fs.writeFileSync(f.file, JSON.stringify(saved));
  const migrated = f.create();
  assert.equal(migrated.getState().settings.readAloud, false);
  for (const readAloud of ['true', 'false', 0, 1, null, undefined, {}, []]) {
    assert.match(migrated.setSettings({ readAloud }).error, /朗读开关/);
    assert.equal(migrated.getState().settings.readAloud, false);
  }
  assert.equal(migrated.setSettings({ readAloud: true }).error, null);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).settings.readAloud, true);
  const restarted = f.create(); assert.equal(restarted.getState().settings.readAloud, true);
  restarted.setSettings({ readAloud: false }); assert.equal(f.create().getState().settings.readAloud, false);
});

test('read-aloud can change during generation without changing request identity or detaching live reply references', async t => {
  const f = fixture(t); let stream;
  const service = f.create({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(new TextEncoder().encode(event('前半句')));
  } })) });
  service.send('一条慢回答'); await new Promise(resolve => setTimeout(resolve, 15));
  const original = latest(service), activeId = service.getState().activeConversationId;
  assert.equal(service.setSettings({ ...service.getState().settings, readAloud: true }).error, null);
  assert.equal(service.getState().busy, true); assert.equal(service.getState().settings.readAloud, true);
  for (const patch of [{ username: '不允许更名' }, { model: 'another:model' }, { baseUrl: 'http://example.test' }]) {
    assert.match(service.setSettings({ ...patch, readAloud: false }).error, /先等待/);
    assert.equal(service.getState().settings.readAloud, true, 'A rejected mixed patch must be atomic');
  }
  const normalizedNoChange = { ...service.getState().settings, baseUrl: 'http://127.0.0.1:18434/', readAloud: false };
  assert.equal(service.setSettings(normalizedNoChange).error, null);
  assert.equal(service.getState().settings.readAloud, false);
  stream.enqueue(new TextEncoder().encode(event('后半句', 'stop'))); stream.close();
  await settled(service);
  assert.equal(service.getState().activeConversationId, activeId);
  assert.equal(latest(service).messages.at(-1).id, original.messages.at(-1).id);
  assert.equal(latest(service).messages.at(-1).content, '前半句后半句');
  assert.equal(latest(service).messages.at(-1).status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).settings.readAloud, false);
});

test('failed read-aloud enable rolls back, while disabling stays effective and streaming survives a failed save', async t => {
  const f = fixture(t); let stream;
  const service = f.create({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(new TextEncoder().encode(event('开始')));
  } })) });
  service.send('回答中切换'); await new Promise(resolve => setTimeout(resolve, 15));
  fs.mkdirSync(f.file + '.tmp');
  assert.ok(service.setSettings({ readAloud: true }).storageError);
  assert.equal(service.getState().settings.readAloud, false);
  fs.rmdirSync(f.file + '.tmp');
  service.setSettings({ readAloud: true }); assert.equal(service.getState().settings.readAloud, true);
  fs.mkdirSync(f.file + '.tmp');
  const muted = service.setSettings({ readAloud: false });
  assert.ok(muted.storageError); assert.equal(muted.settings.readAloud, false); assert.equal(muted.busy, true);
  fs.rmdirSync(f.file + '.tmp');
  stream.enqueue(new TextEncoder().encode(event('结束', 'stop'))); stream.close();
  await settled(service);
  assert.equal(latest(service).messages.at(-1).content, '开始结束');
  assert.equal(latest(service).messages.at(-1).status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).settings.readAloud, false);
});

test('completion callback runs once after publication with final identifiers and text, never on history operations', async t => {
  const f = fixture(t), calls = [];
  let service, published = null;
  service = f.create({ fetchImpl: async () => complete('最终回答'), onChange: snapshot => { published = snapshot; }, onReplyCompleted: reply => {
    const state = service.getState();
    assert.equal(state.busy, false); assert.equal(state.error, null);
    assert.equal(published.busy, false); assert.equal(published.conversations.at(-1).messages.at(-1).status, 'complete');
    calls.push(reply);
  } });
  service.send('问题'); await settled(service);
  const conversation = latest(service), reply = conversation.messages.at(-1);
  assert.deepEqual(calls, [{ conversationId: conversation.id, messageId: reply.id, text: '最终回答' }]);
  service.setSettings({ readAloud: true }); service.newConversation(); service.selectConversation(conversation.id);
  f.create({ onReplyCompleted: reply => calls.push(reply) });
  assert.equal(calls.length, 1, 'Loading, selecting history or enabling read-aloud must not replay old answers');
});

test('callback failures remain separate from successful text, including rejected promises', async t => {
  for (const callback of [() => { throw new Error('speech failed'); }, async () => { throw new Error('async speech failed'); }]) {
    const f = fixture(t), service = f.create({ fetchImpl: async () => complete('文本正常'), onReplyCompleted: callback });
    service.send('问题'); await settled(service); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.getState().error, null); assert.equal(latest(service).messages.at(-1).status, 'complete');
    assert.equal(latest(service).messages.at(-1).content, '文本正常');
  }
});

test('completion callback excludes failed, empty, truncated, cancelled and timed-out responses', async t => {
  const calls = [];
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => complete(''), async () => complete('部分', { finish_reason: 'length' }), async () => new Response(event('中断'))]) {
    const f = fixture(t), service = f.create({ fetchImpl, onReplyCompleted: reply => calls.push(reply) });
    service.setSettings({ readAloud: true }); service.send('问题'); await settled(service);
  }
  const f = fixture(t), cancelled = f.create({ fetchImpl: async () => new Promise(() => {}), onReplyCompleted: reply => calls.push(reply) });
  cancelled.send('取消'); cancelled.cancel();
  const timedOut = f.create({ fetchImpl: async () => new Promise(() => {}), requestTimeoutMs: 10, onReplyCompleted: reply => calls.push(reply) });
  timedOut.send('超时'); await settled(timedOut);
  assert.deepEqual(calls, []);
});

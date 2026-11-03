/** Optional live llama.cpp check with synthetic messages and an isolated, locally ignored history. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createChatService, DEFAULT_CHAT_SETTINGS } = require('../electron/chat-service.cjs');
const directory = path.resolve(__dirname, '..', 'artifacts', 'chat-model-check', String(Date.now()));
const service = createChatService({ directory });
const replies = [];
async function turn(text) {
  const started = Date.now();
  const before = service.getState();
  const offset = before.conversations.find(item => item.id === before.activeConversationId)?.messages.length || 0;
  const state = service.send(text);
  assert.equal(state.busy, true, state.error ?? 'Request did not start');
  while (service.getState().busy) await new Promise(resolve => setTimeout(resolve, 100));
  const final = service.getState();
  assert.equal(final.error, null); assert.equal(final.storageError, null);
  const responses = final.conversations.find(item => item.id === final.activeConversationId).messages.slice(offset).filter(message => message.role === 'assistant');
  assert.ok(responses.length > 0);
  for (const response of responses) { assert.equal(response.status, 'complete'); assert.ok(response.content.trim()); }
  const result = { elapsedMs: Date.now() - started, response: responses.map(message => message.content).join('\n'), bubbles: responses.map(message => message.content) };
  replies.push(result); console.log(JSON.stringify(result));
}
async function main() {
  service.setSettings({ username: '测试旅人' });
  await turn('你好呀，我今天想吃草莓蛋糕。');
  await turn('我刚才说想吃什么？');
  assert.match(replies.at(-1).response, /草莓.*蛋糕/);
  const report = { passed: true, model: DEFAULT_CHAT_SETTINGS.model, localOnly: true, syntheticConversation: true, replies };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(directory, 'report.json') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => service.dispose());

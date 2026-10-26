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
  const state = service.send(text);
  assert.equal(state.busy, true, state.error ?? 'Request did not start');
  while (service.getState().busy) await new Promise(resolve => setTimeout(resolve, 100));
  const final = service.getState();
  assert.equal(final.error, null); assert.equal(final.storageError, null);
  const response = final.conversations.find(item => item.id === final.activeConversationId).messages.at(-1);
  assert.equal(response.status, 'complete'); assert.ok(response.content.trim());
  const result = { elapsedMs: Date.now() - started, response: response.content };
  replies.push(result); console.log(JSON.stringify(result));
}
async function main() {
  service.setSettings({ username: '测试旅人' });
  await turn('你好呀，我今天想吃草莓蛋糕。请用一两句话、50字以内回应我。');
  await turn('我刚才说想吃什么？请用一句话告诉我。');
  assert.match(replies.at(-1).response, /草莓.*蛋糕/);
  const report = { passed: true, model: DEFAULT_CHAT_SETTINGS.model, localOnly: true, syntheticConversation: true, replies };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(directory, 'report.json') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => service.dispose());

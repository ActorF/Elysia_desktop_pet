'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitReply } = require('../electron/chat-reply.cjs');

const examples = [
  ['你好。今天开心吗？一起出去吧！', ['你好。', '今天开心吗？', '一起出去吧！']],
  ['  第一行\r\n\r\n 第二行\n最后一行  ', ['第一行', '第二行', '最后一行']],
  ['她说：“当然呀！”然后笑了。', ['她说：“当然呀！”', '然后笑了。']],
  ['She said "Yes!" Then smiled. "Ready?"', ['She said "Yes!"', 'Then smiled.', '"Ready?"']],
  ["Don't worry! It's fine. Really?", ["Don't worry!", "It's fine.", 'Really?']],
  ['价格是3.14元，版本1.4.3。没有变化。', ['价格是3.14元，版本1.4.3。', '没有变化。']],
  ['Dr. Smith uses e.g. tea in the U.S. office. I agree!', ['Dr. Smith uses e.g. tea in the U.S. office.', 'I agree!']],
  ['看https://example.com/a?x=1.2&next=yes!here。收到！', ['看https://example.com/a?x=1.2&next=yes!here。', '收到！']],
  ['链接是https://example.com/?q=Dr.Smith&v=1.4.3。明白了吗？', ['链接是https://example.com/?q=Dr.Smith&v=1.4.3。', '明白了吗？']],
  ['What? See https://example.com/?q=3.14159. Ask Dr. Smith!', ['What?', 'See https://example.com/?q=3.14159.', 'Ask Dr. Smith!']],
  ['See https://example.com/a?x=1.2. Then email a.b@example.com.', ['See https://example.com/a?x=1.2.', 'Then email a.b@example.com.']],
  ['真的吗？！……“当然！”', ['真的吗？！……', '“当然！”']],
  ['好呀。♪\n明天再聊。', ['好呀。♪', '明天再聊。']],
  ['好呀。❤️👩‍💻\n明天见。🌸', ['好呀。❤️👩‍💻', '明天见。🌸']],
  ['第一句\n。\n第二句', ['第一句\n。', '第二句']],
  ['一。二。三。四。五。', ['一。', '二。', '三。', '四。', '五。']],
];

for (const [text, expected] of examples) test(`sentence boundaries preserve content: ${text}`, () => {
  assert.deepEqual(splitReply(text), expected);
  assert.equal(expected.join('').replace(/\s/gu, ''), text.replace(/\s/gu, ''));
  // Feed every UTF-16 prefix, including split emoji and CRLF. Once a following
  // bubble exists, earlier boundaries and their content may no longer change.
  let previous = [];
  for (let end = 1; end <= text.length; end++) {
    const current = splitReply(text.slice(0, end));
    assert.ok(current.length >= previous.length, `Bubble count regressed at ${end}`);
    assert.deepEqual(current.slice(0, Math.max(0, previous.length - 1)), previous.slice(0, -1));
    previous = current;
  }
});

test('long clauses remain intact and blank output creates no extra bubbles', () => {
  const clause = '只是陪你慢慢说话，'.repeat(80);
  assert.deepEqual(splitReply(clause), [clause]);
  assert.deepEqual(splitReply(' \n\r\n '), []);
  assert.deepEqual(splitReply('等待中……'), ['等待中……']);
  assert.deepEqual(splitReply('❤️'), ['❤️']);
});

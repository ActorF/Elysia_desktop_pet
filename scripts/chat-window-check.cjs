'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const { DEFAULT_SETTINGS } = require('../electron/host-policy.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts', 'chat-window-check');
const report = { passed: false, kind: 'browser UI with mock host; real IPC and model tested separately', checks: [], screenshots: [] };
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', { '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[path.extname(filename)] || 'application/octet-stream');
    response.end(await fs.readFile(filename));
  } catch { response.writeHead(404).end(); }
});
async function main() {
  await fs.mkdir(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [], check = name => report.checks.push(name);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 560, height: 730 } });
    await context.addInitScript(({ defaults }) => {
      const listeners = new Set(), windowListeners = new Set(), calls = [];
      const stamp = '2026-10-25T12:00:00.000Z';
      let id = 1, rejectNext = false, windowState = { maximized: false };
      let state = { settings: { username: '旅行者', baseUrl: 'http://127.0.0.1:18434', model: 'elysia-chat', readAloud: false, voiceProjectRoot: 'D:\\Elysia_AI' }, conversations: [], activeConversationId: null, busy: false, error: null, storageError: null };
      const copy = () => structuredClone(state);
      const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(copy()); return copy(); };
      const current = () => state.conversations.find(item => item.id === state.activeConversationId);
      const newConversation = () => {
        const entry = { id: `conversation-${id++}`, title: '新对话', createdAt: stamp, updatedAt: stamp, messages: [] };
        state.conversations.push(entry); state.activeConversationId = entry.id; return publish({ error: null });
      };
      const onState = callback => { listeners.add(callback); return () => listeners.delete(callback); };
      const windowControl = action => {
        calls.push(['windowControl', action]);
        if (action === 'toggle-maximize') { windowState.maximized = !windowState.maximized; for (const listener of windowListeners) listener(structuredClone(windowState)); }
      };
      const onWindowState = callback => { windowListeners.add(callback); return () => windowListeners.delete(callback); };
      const finish = (text, status = 'complete') => { const reply = current().messages.at(-1); reply.content = text; reply.status = status; return publish({ busy: false, error: status === 'error' ? '无法连接本地模型，请检查服务后重试。' : null }); };
      const send = async text => {
        calls.push(['send', text]);
        if (rejectNext) { rejectNext = false; return publish({ error: '无法保存消息，请重试。' }); }
        if (!current()) newConversation();
        const conversation = current(); conversation.title = text.slice(0, 40);
        conversation.messages.push({ id: `message-${id++}`, role: 'user', content: text, username: state.settings.username, createdAt: stamp, status: 'complete' }, { id: `message-${id++}`, role: 'assistant', content: '', createdAt: stamp, status: 'streaming' });
        return publish({ busy: true, error: null });
      };
      let clipboard = '';
      const locate = target => state.conversations.find(item => item.id === target.conversationId)?.messages.find(item => item.id === target.messageId);
      window.__chatQA = { calls, snapshot: copy, publish, finish, clipboard: () => clipboard, reject: () => { rejectNext = true; }, stream: text => { current().messages.at(-1).content = text; return publish({}); } };
      window.elysiaChat = {
        getState: async () => copy(), onState, send,
        cancel: async () => { calls.push(['cancel']); if (!state.busy) return publish({ speech: { status: 'idle', error: null } }); return finish(current().messages.at(-1).content, 'cancelled'); },
        newConversation: async () => { calls.push(['newConversation']); return newConversation(); },
        copyMessage: async target => { calls.push(['copyMessage', target]); if (rejectNext) { rejectNext = false; return { ok: false, error: '复制暂未完成，请重试。' }; } clipboard = locate(target).content; return { ok: true }; },
        readAloud: async target => { calls.push(['readAloud', target]); return publish({ speech: { status: 'playing', messageId: target.messageId, emotion: 'happy', cached: true, error: null } }); },
        openSettings: async () => { calls.push(['openSettings']); return true; }, windowControl,
        getWindowState: async () => structuredClone(windowState), onWindowState,
      };
      const petState = { settings: defaults, appearance: { expression: 'neutral', pose: 'idle', cat: false, glasses: false }, hotkeys: {} };
      window.elysiaSettings = {
        getState: async () => structuredClone(petState), onState: () => () => {},
        getWindowState: async () => structuredClone(windowState), onWindowState, windowControl,
        getVoiceState: async () => ({ settings: { enabled: true, dnd: false, volume: .8, birthday: '' }, playback: { status: 'idle' }, available: true, interactionAvailable: true, environment: { monitorReady: true } }), onVoiceState: () => () => {},
        getChatState: async () => copy(), onChatState: onState,
        setChatSettings: async patch => { calls.push(['setChatSettings', patch]); if (rejectNext) { rejectNext = false; return publish({ error: '请输入有效的用户名。' }); } return publish({ settings: { ...state.settings, ...patch }, error: null, storageError: null }); },
        selectChatConversation: async selected => { calls.push(['selectChatConversation', selected]); if (rejectNext) { rejectNext = false; return publish({ error: '无法切换对话，请重试。' }); } return publish({ activeConversationId: selected, error: null }); },
        deleteChatConversation: async selected => { calls.push(['deleteChatConversation', selected]); if (rejectNext) { rejectNext = false; return publish({ error: '删除未保存，请重试。' }); } const conversations = state.conversations.filter(item => item.id !== selected); return publish({ conversations, activeConversationId: state.activeConversationId === selected ? conversations.at(-1)?.id || null : state.activeConversationId, error: null }); },
        clearChatHistory: async () => { calls.push(['clearChatHistory']); if (rejectNext) { rejectNext = false; return publish({ error: '清空未保存，请重试。' }); } return publish({ conversations: [], activeConversationId: null, error: null }); },
        openChat: async () => { calls.push(['openChat']); return true; },
      };
      if (new URL(location.href).searchParams.has('modelSetup')) {
        const automatic = new URL(location.href).searchParams.get('modelSetup') === 'auto';
        if (!automatic) state.settings = { ...state.settings, baseUrl: 'https://example.test/ollama', model: 'custom-remote' };
        const setupListeners = new Set(), setupCalls = [];
        let setup = { phase: automatic ? 'pulling-model' : 'idle', busy: automatic, canCancel: automatic, runtimeReady: automatic, modelReady: false,
          model: 'elysia-chat', baseUrl: 'http://127.0.0.1:18434', expectedModelBytes: 5780090176,
          completedBytes: 0, totalBytes: 0, progress: null, error: null, message: null };
        const publishSetup = patch => { setup = { ...setup, ...patch }; for (const listener of setupListeners) listener(structuredClone(setup)); return structuredClone(setup); };
        window.__modelSetupQA = { calls: setupCalls, publish: publishSetup, snapshot: () => structuredClone(setup) };
        Object.assign(window.elysiaSettings, {
          getModelSetup: async () => structuredClone(setup),
          onModelSetup: listener => { setupListeners.add(listener); return () => setupListeners.delete(listener); },
          inspectModelSetup: async () => { setupCalls.push('inspect'); return publishSetup({ phase: 'needs-install', busy: false, error: null }); },
          installChatModel: async () => { setupCalls.push('install'); return { ok: true, state: publishSetup({ phase: 'downloading-installer', busy: true, canCancel: true, error: null, completedBytes: 0, totalBytes: 0 }) }; },
          cancelModelSetup: async () => { setupCalls.push('cancel'); return { ok: true, state: publishSetup({ phase: 'cancelled', busy: false, canCancel: false }) }; },
        });
        const voiceSetupListeners = new Set(), voiceSetupCalls = [];
        let voiceSetup = { phase: automatic ? 'downloading' : 'idle', busy: automatic, canCancel: automatic, ready: false,
          completedBytes: 0, totalBytes: 0, progress: null, error: null, message: null, expectedBytes: 6200000000 };
        const publishVoiceSetup = patch => { voiceSetup = { ...voiceSetup, ...patch }; for (const listener of voiceSetupListeners) listener(structuredClone(voiceSetup)); return structuredClone(voiceSetup); };
        window.__voiceSetupQA = { calls: voiceSetupCalls, publish: publishVoiceSetup, snapshot: () => structuredClone(voiceSetup) };
        Object.assign(window.elysiaSettings, {
          getVoiceSetup: async () => structuredClone(voiceSetup),
          onVoiceSetup: listener => { voiceSetupListeners.add(listener); return () => voiceSetupListeners.delete(listener); },
          inspectVoiceSetup: async () => { voiceSetupCalls.push('inspect'); return publishVoiceSetup({ phase: 'needs-install', busy: false, error: null }); },
          installVoiceSetup: async () => { voiceSetupCalls.push('install'); return { ok: true, state: publishVoiceSetup({ phase: 'downloading', busy: true, canCancel: true, error: null, ready: false, completedBytes: 0, totalBytes: 0 }) }; },
          cancelVoiceSetup: async () => { voiceSetupCalls.push('cancel'); return { ok: true, state: publishVoiceSetup({ phase: 'cancelled', busy: false, canCancel: false, ready: false }) }; },
        });
      }
    }, { defaults: DEFAULT_SETTINGS });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    const capture = async (target, name) => { const filename = path.join(output, `${name}.png`); await target.screenshot({ path: filename, animations: 'disabled' }); report.screenshots.push(filename); };
    const layout = async target => {
      const size = await target.evaluate(() => {
        const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, centerY: rect.top + rect.height / 2 } : null; };
        return { width: innerWidth, body: document.documentElement.scrollWidth, height: innerHeight,
          form: document.querySelector('#chat-form')?.getBoundingClientRect().bottom,
          gear: box('#chat-settings'), input: box('#chat-input'), send: box('#chat-send') };
      });
      assert.ok(size.body <= size.width, 'No horizontal overflow'); if (size.form) assert.ok(size.form <= size.height + 1, 'Composer stays visible');
      if (size.form) {
        assert.ok(size.gear.right <= size.input.left && size.input.right <= size.send.left, 'Composer places settings, input and send from left to right');
        assert.ok(Math.abs(size.gear.centerY - size.input.centerY) <= 1 && Math.abs(size.input.centerY - size.send.centerY) <= 1, 'Composer controls share one vertically centered row');
        for (const box of [size.gear, size.input, size.send]) assert.ok(box.left >= 0 && box.right <= size.width && box.top >= 0 && box.bottom <= size.height, 'Each composer control stays inside the window');
      }
    };
    await page.goto(`${base}/renderer/chat.html`); await page.waitForSelector('html[data-chat-ready=true]');
    assert.equal(await page.locator('#chat-empty').isVisible(), true); assert.equal(await page.locator('#chat-send').isDisabled(), true);
    assert.deepEqual(await page.locator('h1').allTextContents(), ['ELYSIA · 在这里陪你']);
    assert.equal(await page.locator('#chat-model, #chat-input-hint, .chat-eyebrow, #chat-empty > span').count(), 0);
    assert.equal(await page.locator('#chat-status').isHidden(), true);
    assert.doesNotMatch(await page.locator('body').innerText(), /和爱莉希雅聊天|qwen3\.8|Enter|聊天记录保存在本机/);
    assert.equal(await page.locator('.chat-sidebar > button').count(), 1);
    assert.equal(await page.locator('.chat-sidebar > #chat-new').count(), 1);
    assert.equal(await page.locator('#chat-form #chat-settings').count(), 1);
    const icons = await page.locator('#chat-new, #chat-settings').evaluateAll(nodes => nodes.map(node => ({ title: node.title, label: node.getAttribute('aria-label') })));
    assert.deepEqual(icons.map(({ title, label }) => [title, label]), [['新对话', '新对话'], ['设置与记录', '设置与记录']]);
    assert.equal(await page.locator('#chat-send svg').count(), 1); assert.equal((await page.locator('#chat-send').textContent()).trim(), '');
    assert.equal(await page.locator('#chat-send').getAttribute('aria-label'), '发送消息');
    await layout(page); await capture(page, 'chat-empty'); check('empty chat clearly introduces the editable composer');
    await page.locator('#chat-new').hover(); assert.equal(await page.locator('#chat-new-tooltip').isVisible(), true);
    await page.mouse.move(0, 0); await page.locator('#chat-new').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.locator('#chat-transcript').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#chat-settings').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#chat-settings-tooltip').isVisible(), true);
    await capture(page, 'chat-settings-tooltip');
    await page.keyboard.press('Tab'); assert.equal(await page.locator('#chat-input').evaluate(node => node === document.activeElement), true);
    await page.locator('#chat-input').fill('键盘测试'); await page.keyboard.press('Tab');
    assert.equal(await page.locator('#chat-send').evaluate(node => node === document.activeElement), true);
    await page.locator('#chat-input').fill('');
    check('new chat stays upper left; settings, input and arrow send share one row with logical keyboard order and tooltips');
    const input = page.locator('#chat-input');
    await input.fill('你好');
    await input.evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart')); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); });
    assert.equal(await page.evaluate(() => window.__chatQA.calls.filter(([method]) => method === 'send').length), 0);
    await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend')));
    await input.press('Shift+Enter'); assert.equal(await input.inputValue(), '你好\n');
    await input.press('Enter'); await page.waitForFunction(() => window.__chatQA.snapshot().busy);
    assert.equal(await input.inputValue(), ''); assert.equal(await page.locator('#chat-stop').isVisible(), true);
    await input.fill('还想和你说'); await input.press('Enter');
    assert.equal(await page.evaluate(() => window.__chatQA.calls.filter(([method]) => method === 'send').length), 1);
    check('IME Enter is preserved, Shift Enter inserts newline, and busy state prevents duplicate requests');
    await page.evaluate(() => window.__chatQA.stream('嗨，旅行者♪ 今天也很高兴见到你。'));
    assert.match(await page.locator('#chat-messages').innerText(), /今天也很高兴/);
    assert.equal(await page.locator('.chat-message[data-role=user] .message-action').count(), 1);
    assert.equal(await page.locator('.chat-message[data-role=assistant] .message-action').count(), 2);
    assert.equal(await page.locator('[data-message-action=read-aloud]').isDisabled(), true);
    await page.locator('.chat-message[data-role=assistant] [data-message-action=copy]').click();
    assert.equal(await page.evaluate(() => window.__chatQA.clipboard()), '嗨，旅行者♪ 今天也很高兴见到你。');
    assert.equal(await input.inputValue(), '还想和你说');
    await page.locator('#chat-stop').click();
    assert.match(await page.locator('#chat-messages').innerText(), /已停止/);
    assert.equal(await input.inputValue(), '还想和你说'); check('streamed text appears and cancellation keeps partial text plus a new draft');
    await page.locator('#chat-new').click(); assert.equal(await page.locator('#chat-empty').isVisible(), true);
    await input.fill('今天做了什么？'); await input.press('Enter');
    await page.evaluate(() => window.__chatQA.finish('嗯哼，正准备听听你的故事呢♪'));
    assert.equal(await page.locator('#chat-stop').isHidden(), true); await page.mouse.move(0, 0); await capture(page, 'chat-conversation');
    check('new conversations preserve previous history and completion restores the composer');
    const userCopy = page.locator('.chat-message[data-role=user] [data-message-action=copy]');
    const responseCopy = page.locator('.chat-message[data-role=assistant] [data-message-action=copy]');
    const responseRead = page.locator('[data-message-action=read-aloud]');
    for (const action of [userCopy, responseCopy, responseRead]) assert.equal(await action.locator('svg').count(), 1);
    await userCopy.hover(); assert.equal(await userCopy.locator('[role=tooltip]').isVisible(), true);
    assert.equal(await userCopy.getAttribute('aria-label'), '复制消息');
    await userCopy.click(); assert.equal(await page.evaluate(() => window.__chatQA.clipboard()), '今天做了什么？');
    const copied = await page.evaluate(() => window.__chatQA.calls.at(-1));
    assert.equal(copied[0], 'copyMessage'); assert.deepEqual(Object.keys(copied[1]).sort(), ['conversationId', 'messageId']);
    await responseCopy.click(); assert.equal(await page.evaluate(() => window.__chatQA.clipboard()), '嗯哼，正准备听听你的故事呢♪');
    await page.mouse.move(0, 0); await responseCopy.focus(); await page.keyboard.press('Tab');
    assert.equal(await responseRead.evaluate(node => node === document.activeElement), true);
    assert.equal(await responseRead.locator('[role=tooltip]').isVisible(), true);
    await capture(page, 'chat-message-actions');
    await responseRead.click(); assert.equal(await page.evaluate(() => window.__chatQA.calls.at(-1)[0]), 'readAloud');
    assert.equal(await page.evaluate(() => window.__chatQA.snapshot().settings.readAloud), false, 'Manual reading keeps automatic preference unchanged');
    assert.equal(await page.locator('#chat-stop').textContent(), '停止朗读'); await page.locator('#chat-stop').click();
    await page.evaluate(() => window.__chatQA.reject()); await responseCopy.click(); assert.equal(await page.locator('#chat-error').isVisible(), true);
    check('message icons copy exact user/assistant text, support hover and keyboard tooltips, and manually read without enabling automatic speech');
    await input.fill('再说一点吧'); await input.press('Enter');
    const selectedReply = await page.locator('.chat-message[data-role=assistant] .chat-message-body').first().evaluate(node => {
      window.__selectedReplyNode = node;
      const range = document.createRange(); range.selectNodeContents(node);
      getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString();
    });
    await page.evaluate(() => window.__chatQA.stream('当然好呀，'));
    await page.evaluate(() => window.__chatQA.stream('当然好呀，想听哪一段呢？'));
    assert.equal(await page.evaluate(() => getSelection().toString()), selectedReply);
    assert.equal(await page.evaluate(() => document.querySelector('.chat-message[data-role=assistant] .chat-message-body') === window.__selectedReplyNode), true);
    await page.evaluate(() => window.__chatQA.finish('当然好呀，想听哪一段呢？'));
    assert.equal(await page.evaluate(() => getSelection().toString()), selectedReply);
    check('stream chunks and completion preserve selected text in an earlier completed reply');
    await page.evaluate(() => window.__chatQA.publish({ speech: { status: 'starting', error: null } }));
    assert.equal(await page.locator('#chat-stop').textContent(), '停止朗读'); assert.equal(await page.locator('#chat-status').isVisible(), true);
    await page.evaluate(() => window.__chatQA.publish({ speech: { status: 'playing', error: null } }));
    assert.equal(await page.locator('#chat-status').textContent(), '正在朗读…');
    await page.locator('#chat-stop').click(); assert.equal(await page.locator('#chat-status').isHidden(), true);
    await page.evaluate(() => window.__chatQA.publish({ speech: { status: 'error', error: '朗读暂时不可用，请稍后重试。' } }));
    assert.equal(await page.locator('#chat-speech-error').isVisible(), true); assert.equal(await input.isEnabled(), true);
    await page.evaluate(() => window.__chatQA.publish({ speech: { status: 'idle', error: null } }));
    assert.equal(await page.locator('#chat-speech-error').isHidden(), true);
    for (const status of ['warming', 'ready']) {
      await page.evaluate(status => window.__chatQA.publish({ speech: { status, error: null } }), status);
      assert.equal(await page.locator('#chat-status').isHidden(), true); assert.equal(await page.locator('#chat-stop').isHidden(), true);
    }
    check('speech has a stop control while active and an error notice without blocking text chat');
    await input.fill('消息未发送时保留我'); await page.evaluate(() => window.__chatQA.reject()); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#chat-input').value === '消息未发送时保留我');
    assert.equal(await page.locator('#chat-error').isVisible(), true);
    await input.press('Enter'); await page.evaluate(() => window.__chatQA.finish('', 'error'));
    assert.equal(await input.inputValue(), '消息未发送时保留我'); check('both immediate send rejection and later connection failure restore the draft');
    await input.fill('<img src=x onerror="window.__injected=true">'); await input.press('Enter');
    await page.evaluate(() => window.__chatQA.finish('<script>window.__injected=true</script>\n收到啦 <b>朋友</b>'));
    assert.equal(await page.locator('#chat-messages img, #chat-messages script, #chat-messages b').count(), 0);
    assert.equal(await page.evaluate(() => window.__injected), undefined); check('user and model content remain literal text');
    await page.locator('#chat-settings').click(); await page.locator('[data-window-control=toggle-maximize]').click();
    assert.equal(await page.locator('[data-window-control=toggle-maximize]').getAttribute('aria-label'), '还原');
    await page.locator('[data-window-control=close]').click();
    assert.ok(await page.evaluate(() => window.__chatQA.calls.some(([method, value]) => method === 'windowControl' && value === 'close'))); check('window controls and settings use only their explicit bridge methods');
    await page.setViewportSize({ width: 420, height: 520 }); await layout(page); await capture(page, 'chat-compact');
    const stored = await page.evaluate(() => window.__chatQA.snapshot());
    const settings = await context.newPage(); settings.on('pageerror', error => errors.push(error.message)); await settings.setViewportSize({ width: 600, height: 741 });
    await settings.goto(`${base}/renderer/settings.html`); await settings.waitForSelector('html[data-chat-ready=true][data-ready=true]');
    assert.equal(await settings.locator('#model-setup-card').count(), 0, 'Older hosts without setup bridge do not show an unusable setup card');
    assert.equal(await settings.locator('#voice-setup-card').count(), 0);
    await settings.evaluate(value => window.__chatQA.publish(value), stored);
    await settings.locator('[data-tab=chat]').click();
    await settings.locator('#chat-username').fill('粉色妖精'); await settings.locator('#chat-settings-save').click();
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().settings.username), '粉色妖精');
    await settings.locator('.chat-connection').evaluate(node => { node.open = true; });
    assert.equal(await settings.locator('#chat-voice-project').inputValue(), 'D:\\Elysia_AI');
    await settings.locator('#chat-voice-project').fill('D:\\VoiceProject');
    await settings.locator('#chat-model-name').fill('qwen3.8:custom'); await settings.locator('#chat-settings-save').click();
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().settings.model), 'qwen3.8:custom');
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().settings.voiceProjectRoot), 'D:\\VoiceProject');
    await capture(settings, 'chat-settings'); check('username and model preferences save explicitly');
    await settings.locator('.chat-connection').evaluate(node => { node.open = false; });
    assert.equal(await settings.locator('#chat-read-aloud').isChecked(), false);
    await settings.locator('#chat-read-aloud').check();
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().settings.readAloud), true);
    assert.deepEqual(await settings.evaluate(() => window.__chatQA.calls.at(-1)), ['setChatSettings', { readAloud: true }]);
    await capture(settings, 'chat-settings-read-aloud');
    await settings.evaluate(() => window.__chatQA.reject()); await settings.locator('#chat-read-aloud').click();
    assert.equal(await settings.locator('#chat-read-aloud').isChecked(), true); assert.equal(await settings.locator('#chat-settings-error').isVisible(), true);
    await settings.evaluate(() => window.__chatQA.publish({ busy: true, error: null }));
    await settings.locator('#chat-read-aloud').uncheck();
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().settings.readAloud), false);
    assert.equal(await settings.locator('#chat-settings-save').isDisabled(), true);
    await settings.evaluate(() => window.__chatQA.publish({ busy: false }));
    check('read-aloud defaults off, saves independently, can switch off while generating, and restores state on rejection');
    await settings.locator('#chat-username').fill('不能保存'); await settings.evaluate(() => window.__chatQA.reject()); await settings.locator('#chat-settings-save').click();
    assert.equal(await settings.locator('#chat-settings-error').isVisible(), true); assert.equal(await settings.locator('#chat-username').inputValue(), '不能保存');
    check('rejected settings keep edits visible and show the host error');
    await settings.evaluate(() => window.__chatQA.publish({ storageError: '磁盘空间不足，修复后请重新保存设置。' }));
    assert.equal(await settings.locator('#chat-settings-save').isEnabled(), true);
    await settings.locator('#chat-settings-save').click();
    assert.equal(await settings.locator('#chat-settings-error').isHidden(), true);
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().storageError), null);
    check('storage errors allow a settings save retry and disappear after successful persistence');
    await settings.locator('[data-tab=history]').click();
    assert.equal(await settings.locator('.chat-history-choice').count(), stored.conversations.length);
    assert.match(await settings.locator('#chat-history-messages').innerText(), /旅行者/);
    assert.equal(await settings.locator('#chat-history-messages script, #chat-history-messages img').count(), 0);
    await settings.locator(`[data-conversation-id="${stored.conversations[0].id}"]`).click(); assert.match(await settings.locator('#chat-history-messages').innerText(), /你好/);
    const historyLayout = async () => {
      const boxes = await settings.evaluate(() => {
        const rect = id => { const value = document.querySelector(id).getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, width: value.width }; };
        return { list: rect('#chat-history-list'), detail: rect('#chat-history-detail') };
      });
      assert.ok(boxes.list.right <= boxes.detail.left && boxes.detail.width > boxes.list.width, 'History has a smaller left list and larger right detail');
      assert.ok(Math.abs(boxes.list.top - boxes.detail.top) <= 1, 'History panes start together');
    };
    await historyLayout();
    await capture(settings, 'chat-history');
    await settings.evaluate(() => window.elysiaChat.send('查看历史期间继续生成'));
    await settings.locator(`[data-conversation-id="${stored.conversations[0].id}"]`).focus();
    const historySelection = await settings.locator('.history-message-body').first().evaluate(node => {
      window.__historySelectedNode = node; window.__historyFocusedNode = document.activeElement;
      const range = document.createRange(); range.selectNodeContents(node);
      getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString();
    });
    await settings.evaluate(() => window.__chatQA.stream('另一段对话的回答正在生成。'));
    assert.equal(await settings.evaluate(() => getSelection().toString()), historySelection);
    assert.equal(await settings.evaluate(() => document.querySelector('.history-message-body') === window.__historySelectedNode), true);
    assert.equal(await settings.evaluate(() => document.activeElement === window.__historyFocusedNode), true);
    await settings.evaluate(() => window.__chatQA.finish('另一段对话的回答完成。'));
    assert.equal(await settings.evaluate(() => getSelection().toString()), historySelection);
    assert.equal(await settings.evaluate(() => document.activeElement === window.__historyFocusedNode), true);
    check('background streaming preserves selected history text and the focused conversation button');
    await settings.evaluate(() => window.__chatQA.reject()); await settings.locator('#chat-history-continue').click();
    assert.equal(await settings.evaluate(() => window.__chatQA.calls.filter(([method]) => method === 'openChat').length), 0);
    await settings.locator('#chat-history-continue').click();
    assert.equal(await settings.evaluate(() => window.__chatQA.calls.filter(([method]) => method === 'openChat').length), 1);
    check('history preserves recorded usernames, displays chosen conversation, and resumes only after a successful selection');
    await settings.evaluate(() => window.__chatQA.publish({ busy: true, error: null }));
    assert.equal(await settings.locator('#chat-history-continue').isDisabled(), true);
    assert.equal(await settings.locator('#chat-history-delete').isDisabled(), true); assert.equal(await settings.locator('#chat-history-clear').isDisabled(), true);
    await settings.locator('.chat-history-choice').first().click();
    await settings.locator('[data-tab=chat]').click(); assert.equal(await settings.locator('#chat-settings-save').isDisabled(), true);
    await settings.evaluate(() => window.__chatQA.publish({ busy: false, error: null }));
    await settings.setViewportSize({ width: 500, height: 500 });
    for (const tab of ['chat', 'history']) { await settings.locator(`[data-tab=${tab}]`).click(); await layout(settings); await capture(settings, `${tab}-settings-compact`); }
    await historyLayout();
    const tabs = await settings.locator('[role=tab]').evaluateAll(nodes => nodes.map(node => ({ width: node.clientWidth, scroll: node.scrollWidth })));
    for (const tab of tabs) assert.ok(tab.scroll <= tab.width, 'Each tab label fits at minimum width');
    check('history stays readable while generating; seven tabs and chat panels fit the minimum window');
    const initialHistoryCount = await settings.locator('.chat-history-choice').count();
    const deletions = () => settings.evaluate(() => window.__chatQA.calls.filter(([method]) => method === 'deleteChatConversation' || method === 'clearChatHistory'));
    await settings.locator('#chat-history-delete').click();
    assert.equal(await settings.locator('#chat-history-confirm').isVisible(), true); assert.equal((await deletions()).length, 0);
    await settings.locator('#chat-history-confirm-cancel').click();
    assert.equal(await settings.locator('#chat-history-confirm').isHidden(), true); assert.equal(await settings.locator('.chat-history-choice').count(), initialHistoryCount);
    await settings.locator('#chat-history-delete').click(); await settings.evaluate(() => window.__chatQA.reject()); await settings.locator('#chat-history-confirm-delete').click();
    assert.equal(await settings.locator('.chat-history-choice').count(), initialHistoryCount); assert.equal(await settings.locator('#chat-history-confirm').isVisible(), true);
    assert.equal(await settings.locator('#chat-history-error').isVisible(), true);
    await settings.locator('#chat-history-confirm-delete').click();
    assert.equal(await settings.locator('.chat-history-choice').count(), initialHistoryCount - 1); assert.equal(await settings.locator('#chat-history-confirm').isHidden(), true);
    assert.equal(await settings.locator('#chat-history-detail').isVisible(), true);
    await settings.locator('#chat-history-clear').click(); await settings.locator('#chat-history-confirm-cancel').press('Escape');
    assert.equal(await settings.locator('#chat-history-confirm').isHidden(), true);
    assert.equal((await deletions()).filter(([method]) => method === 'clearChatHistory').length, 0);
    await settings.locator('#chat-history-clear').click(); await capture(settings, 'chat-history-clear-confirm');
    await settings.locator('#chat-history-confirm-delete').click();
    assert.equal(await settings.locator('.chat-history-choice').count(), 0); assert.equal(await settings.locator('#chat-history-empty').isVisible(), true);
    assert.equal(await settings.locator('#chat-history-layout').isHidden(), true); assert.equal(await settings.locator('#chat-history-clear').isDisabled(), true);
    assert.equal(await settings.evaluate(() => window.__chatQA.snapshot().settings.model), 'qwen3.8:custom');
    check('delete and clear require explicit in-app confirmation, cancellation is inert, failed deletion keeps records, and clearing preserves preferences');
    const setup = await context.newPage(); setup.on('pageerror', error => errors.push(error.message)); await setup.setViewportSize({ width: 600, height: 741 });
    await setup.goto(`${base}/renderer/settings.html?modelSetup=manual`); await setup.waitForSelector('html[data-model-setup-ready=true][data-voice-setup-ready=true]');
    await setup.locator('[data-tab=chat]').click();
    assert.deepEqual(await setup.evaluate(() => window.__modelSetupQA.calls), ['inspect']);
    assert.match(await setup.locator('#model-setup-card').innerText(), /首次运行自动准备.*5\.8 GB/s);
    assert.doesNotMatch(await setup.locator('#model-setup-card').innerText(), /D:\\|AppData|python|\.exe/);
    await setup.locator('#model-setup-install').click();
    assert.equal(await setup.locator('#model-setup-install').isDisabled(), true); assert.equal(await setup.locator('#model-setup-cancel').isEnabled(), true);
    assert.deepEqual(await setup.evaluate(() => window.__modelSetupQA.calls), ['inspect', 'install']);
    await setup.evaluate(() => window.__modelSetupQA.publish({ phase: 'pulling-model', runtimeReady: true, completedBytes: 2890045088, totalBytes: 5780090176, progress: .5 }));
    assert.equal(await setup.locator('#model-setup-progress').getAttribute('value'), '50'); assert.match(await setup.locator('#model-setup-progress-text').innerText(), /2\.89 GB.*5\.78 GB.*50%/);
    await capture(setup, 'model-setup-progress');
    await setup.evaluate(() => window.__modelSetupQA.publish({ phase: 'installing', canCancel: false, completedBytes: 0, totalBytes: 0, progress: null }));
    assert.equal(await setup.locator('#model-setup-cancel').isDisabled(), true); assert.equal(await setup.locator('#model-setup-progress').getAttribute('value'), null);
    await setup.evaluate(() => window.__modelSetupQA.publish({ phase: 'pulling-model', canCancel: true }));
    await setup.locator('#model-setup-cancel').click(); assert.equal(await setup.locator('#model-setup-install').isEnabled(), true);
    assert.equal(await setup.locator('#model-setup-badge').innerText(), '已取消');
    await setup.evaluate(() => window.__modelSetupQA.publish({ phase: 'error', busy: false, error: '网络连接中断，请重试。' }));
    assert.equal(await setup.locator('#model-setup-error').isVisible(), true); await setup.locator('#model-setup-install').click();
    assert.equal(await setup.locator('#model-setup-error').isHidden(), true);
    await setup.evaluate(() => window.__modelSetupQA.publish({ phase: 'ready', busy: false, canCancel: false, modelReady: true, error: null }));
    assert.equal(await setup.evaluate(() => window.__chatQA.snapshot().settings.model), 'custom-remote');
    assert.equal(await setup.locator('#model-setup-use-local').isEnabled(), true);
    await setup.evaluate(() => window.__chatQA.reject()); await setup.locator('#model-setup-use-local').click();
    assert.equal(await setup.locator('#model-setup-error').isVisible(), true); assert.equal(await setup.evaluate(() => window.__chatQA.snapshot().settings.model), 'custom-remote');
    await setup.locator('#model-setup-use-local').click();
    assert.deepEqual(await setup.evaluate(() => window.__chatQA.calls.at(-1)), ['setChatSettings', { baseUrl: 'http://127.0.0.1:18434', model: 'elysia-chat' }]);
    assert.equal(await setup.locator('#model-setup-use-local').isDisabled(), true); assert.match(await setup.locator('#model-setup-status').innerText(), /当前聊天正在使用本地模型/);
    await setup.setViewportSize({ width: 500, height: 500 }); await layout(setup); await capture(setup, 'model-setup-ready-compact');
    const automaticSetup = await context.newPage(); automaticSetup.on('pageerror', error => errors.push(error.message));
    await automaticSetup.goto(`${base}/renderer/settings.html?modelSetup=auto`); await automaticSetup.waitForSelector('html[data-model-setup-ready=true][data-voice-setup-ready=true]');
    assert.deepEqual(await automaticSetup.evaluate(() => window.__modelSetupQA.calls), [], 'An existing host-owned automatic download is only observed');
    await automaticSetup.evaluate(() => window.__modelSetupQA.publish({ phase: 'ready', busy: false, modelReady: true, canCancel: false }));
    assert.equal(await automaticSetup.locator('#model-setup-use-local').isDisabled(), true, 'Default local configuration requires no extra user action when ready');
    check('setup observes automatic host preparation, inspects idle hosts without downloading, displays progress, cancels safely, retries errors, and switches custom models only explicitly');
    assert.deepEqual(await automaticSetup.evaluate(() => window.__voiceSetupQA.calls), [], 'Host-owned voice preparation is observed without a second installation');
    assert.equal(await automaticSetup.locator('#voice-setup-badge').innerText(), '正在下载', 'Chat readiness must not claim voice readiness');
    await setup.setViewportSize({ width: 600, height: 741 });
    assert.deepEqual(await setup.evaluate(() => window.__voiceSetupQA.calls), ['inspect']);
    await setup.locator('#voice-setup-install').click(); assert.equal(await setup.locator('#voice-setup-install').isDisabled(), true);
    await setup.evaluate(() => window.__voiceSetupQA.publish({ completedBytes: 1000000000, totalBytes: 2000000000, progress: .5 }));
    assert.equal(await setup.locator('#voice-setup-progress').getAttribute('value'), '50'); assert.match(await setup.locator('#voice-setup-progress-text').innerText(), /1\.00 GB.*2\.00 GB.*50%/);
    await setup.locator('#voice-setup-card').scrollIntoViewIfNeeded(); await capture(setup, 'voice-setup-progress');
    await setup.locator('#voice-setup-cancel').click(); assert.equal(await setup.locator('#voice-setup-badge').innerText(), '已取消');
    await setup.evaluate(() => window.__voiceSetupQA.publish({ phase: 'error', busy: false, error: '语音资源尚未发布或暂时无法下载，请稍后重试。文字聊天仍可使用。' }));
    assert.equal(await setup.locator('#voice-setup-error').isVisible(), true); assert.equal(await setup.locator('#voice-setup-badge').innerText(), '未完成');
    await setup.locator('#voice-setup-install').click(); assert.equal(await setup.locator('#voice-setup-error').isHidden(), true);
    await setup.evaluate(() => window.__voiceSetupQA.publish({ phase: 'validating', busy: true, completedBytes: 0, totalBytes: 0, progress: null }));
    assert.equal(await setup.locator('#voice-setup-progress').getAttribute('value'), null);
    await setup.evaluate(() => window.__voiceSetupQA.publish({ phase: 'ready', busy: false, ready: false, error: null }));
    assert.equal(await setup.locator('#voice-setup-badge').innerText(), '未完成', 'Incomplete verification cannot be presented as ready');
    await setup.evaluate(() => window.__voiceSetupQA.publish({ phase: 'ready', ready: true, canCancel: false, progress: 1 }));
    assert.equal(await setup.locator('#voice-setup-badge').innerText(), '已就绪'); assert.equal(await setup.locator('#voice-setup-install').isHidden(), true);
    assert.equal(await setup.evaluate(() => window.__chatQA.snapshot().settings.readAloud), false, 'Preparing voice resources does not silently enable automatic speech');
    await setup.setViewportSize({ width: 500, height: 500 }); await setup.locator('#voice-setup-card').scrollIntoViewIfNeeded(); await layout(setup); await capture(setup, 'voice-setup-ready-compact');
    check('voice setup independently observes automatic preparation, displays archive progress, cancels and retries, and requires verified readiness without changing automatic speech');
    assert.deepEqual(errors, []); report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });

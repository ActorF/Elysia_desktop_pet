'use strict';
// Real browser pages with deferred, isolated host replies; no user profile or model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const { DEFAULT_SETTINGS } = require('../electron/host-policy.cjs');
const root = path.resolve(__dirname, '..');
const output = process.env.ELYSIA_UI_OUTPUT ? path.resolve(process.env.ELYSIA_UI_OUTPUT) : path.join(root, 'artifacts', 'renderer-lifecycle-check');
const region = { locale: process.env.ELYSIA_UI_LOCALE || 'zh-CN', timezoneId: process.env.ELYSIA_UI_TIMEZONE || 'Asia/Shanghai' };
const report = { passed: false, ...region, checks: [], pageErrors: [] };
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep)) return response.writeHead(403).end();
    response.setHeader('Content-Type', { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css' }[path.extname(filename)] || 'application/octet-stream');
    response.end(await fs.readFile(filename));
  } catch { response.writeHead(404).end(); }
});

async function main() {
  await fs.mkdir(path.join(output, 'temp'), { recursive: true });
  process.env.TEMP = process.env.TMP = path.join(output, 'temp');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 650, height: 780 }, ...region });
  await context.addInitScript(({ defaults }) => {
    const groups = new Map(), deferred = new Map(), calls = [];
    const copy = value => structuredClone(value);
    const on = (name, fn) => { if (!groups.has(name)) groups.set(name, new Set()); groups.get(name).add(fn); return () => groups.get(name).delete(fn); };
    const emit = (name, value) => { for (const fn of groups.get(name) || []) fn(copy(value)); };
    let pet = { settings: defaults, appearance: { expression: null, pose: 'idle', cat: false, glasses: false }, hotkeys: {} };
    let chat = { settings: { username: '旅行者', baseUrl: 'http://127.0.0.1:18434', model: 'elysia-chat', readAloud: false, voiceProjectRoot: 'D:\\fixture-中文' }, conversations: [], activeConversationId: null, busy: false, error: null, storageError: null, speech: { status: 'idle', error: null } };
    let setup = { phase: 'ready', ready: true, busy: false, allowDownloads: true };
    let voice = { settings: { enabled: true, dnd: false, volume: .8, birthday: '' }, playback: { status: 'idle' }, available: true, interactionAvailable: true, error: null, storageError: null, environment: { monitorReady: true } };
    const publishChat = patch => { chat = { ...chat, ...patch }; emit('chat', chat); return copy(chat); };
    const invoke = (name, value, action) => {
      calls.push([name, copy(value)]);
      if (deferred.has(name)) {
        const owner = deferred.get(name); deferred.delete(name);
        return new Promise((resolve, reject) => { owner.settle = (failure, result) => failure ? reject(new Error(failure)) : resolve(result === undefined ? action() : result); });
      }
      return Promise.resolve(action());
    };
    const holds = new Map();
    window.__audit = { calls, emit, chat: () => copy(chat), pet: () => copy(pet), voice: () => copy(voice), publishChat,
      publishPet(patch) { pet = { ...pet, ...patch }; emit('pet', pet); return copy(pet); },
      hold(name, id = name) { const owner = {}; holds.set(id, owner); deferred.set(name, owner); },
      release(id, failure = null, result) { const owner = holds.get(id); if (!owner?.settle) throw new Error('Missing pending operation: ' + id); owner.settle(failure, result); holds.delete(id); },
      history(count = 1) { return publishChat({ conversations: Array.from({ length: count }, (_, i) => ({ id: 'c' + i, title: '私密记录' + i, createdAt: '2026-11-13T12:00:00Z', updatedAt: '2026-11-13T12:00:00Z', messages: [{ id: 'm' + i, role: 'user', content: '应清除的对话-' + i, createdAt: '2026-11-13T12:00:00Z', status: 'complete' }] })), activeConversationId: count ? 'c0' : null }); },
      publishVoice(patch) { voice = { ...voice, ...patch }; emit('voice', voice); return copy(voice); },
      listeners: () => Object.fromEntries([...groups].map(([key, values]) => [key, values.size])) };
    const windowMethods = { getWindowState: async () => ({ maximized: false }), onWindowState: fn => on('window', fn), windowControl() {} };
    window.elysiaSettings = {
      ...windowMethods, getState: async () => copy(pet), onState: fn => on('pet', fn),
      setSettings: patch => invoke('setSettings', patch, () => { pet.settings = { ...pet.settings, ...patch }; emit('pet', pet); return copy(pet); }),
      getChatState: async () => copy(chat), onChatState: fn => on('chat', fn),
      setChatSettings: patch => invoke('setChatSettings', patch, () => publishChat({ settings: { ...chat.settings, ...patch } })),
      clearChatHistory: async () => publishChat({ conversations: [], activeConversationId: null }),
      deleteChatConversation: async id => publishChat({ conversations: chat.conversations.filter(item => item.id !== id), activeConversationId: null }),
      openChat: async () => true,
      getVoiceState: async () => copy(voice), onVoiceState: fn => on('voice', fn),
      setVoiceSettings: patch => invoke('setVoiceSettings', patch, () => window.__audit.publishVoice({ settings: { ...voice.settings, ...patch }, storageError: null })),
      getModelSetup: async () => copy(setup), onModelSetup: fn => on('setup', fn), inspectModelSetup: async () => copy(setup), installChatModel: async () => ({ ok: true, state: copy(setup) }), cancelModelSetup: async () => ({ ok: true, state: copy(setup) }),
    };
    window.elysiaChat = { ...windowMethods, getState: async () => copy(chat), onState: fn => on('chat', fn),
      send: text => invoke('send', text, () => publishChat({ busy: true })), cancel: async () => publishChat({ busy: false, speech: { status: 'idle' } }),
      copyMessage: value => invoke('copyMessage', value, () => ({ ok: true })),
      newConversation: async () => publishChat({ conversations: [], activeConversationId: null }),
      openSettings: async () => true, onSpeechAudio: fn => on('audio', fn), onSpeechStop: fn => on('audio-stop', fn), reportSpeech: value => calls.push(['reportSpeech', value]) };
    window.elysiaSpeech = { layout: value => calls.push(['speech-layout', value]), report: value => calls.push(['speech-report', value]),
      ...Object.fromEntries(['Play', 'Measure', 'LayoutReady', 'Stop', 'Volume', 'Placement', 'Error'].map(name => ['on' + name, fn => on('speech-' + name, fn)])) };
    const urls = new Set(), audio = [];
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revokeURL(url); };
    class FakeAudio extends EventTarget {
      constructor(url) { super(); this.src = url; this.paused = true; audio.push(this); }
      pause() { this.paused = true; } removeAttribute() { this.src = ''; } load() {}
      async play() { this.paused = false; this.playCount = (this.playCount || 0) + 1; this.dispatchEvent(new Event('playing')); }
    }
    window.Audio = FakeAudio;
    window.__audioAudit = { audio, urls };
  }, { defaults: DEFAULT_SETTINGS });
  const base = `http://127.0.0.1:${server.address().port}`;
  const check = async (name, operation) => {
    const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
    try { await operation(page); report.checks.push({ name, passed: true }); }
    catch (error) { report.checks.push({ name, passed: false, error: error.message }); }
    finally { await page.close(); }
  };
  const settings = async page => { await page.goto(base + '/renderer/settings.html'); await page.waitForSelector('html[data-ready=true][data-chat-settings-ready=true][data-model-setup-ready=true]'); };
  const chat = async page => { await page.goto(base + '/renderer/chat.html'); await page.waitForSelector('html[data-chat-ready=true]'); };
  try {
    await check('Deleting the final history removes its text from the DOM', async page => {
      await settings(page); await page.locator('[data-tab=history]').click(); await page.evaluate(() => window.__audit.history());
      await page.locator('#chat-history-clear').click(); await page.locator('#chat-history-confirm-delete').click();
      assert.equal(await page.locator('#chat-history-messages').textContent(), '');
      assert.equal(await page.locator('.history-message').count(), 0);
    });
    await check('A later successful queued settings save clears the previous operation error', async page => {
      await settings(page); await page.locator('[data-tab=animation]').click(); await page.evaluate(() => window.__audit.hold('setSettings'));
      await page.locator('[name=eyeTracking]').uncheck();
      await page.locator('[name=eyeTracking]').check();
      await page.evaluate(() => window.__audit.release('setSettings', '模拟第一次写入失败'));
      await page.waitForFunction(() => window.__audit.calls.filter(([name]) => name === 'setSettings').length === 2);
      assert.equal(await page.locator('#error-message').isHidden(), true);
      assert.equal(await page.locator('#save-status').textContent(), '自动保存');
    });
    await check('Reset after a slider input wins over its unflushed animation-frame patch', async page => {
      await settings(page); await page.locator('[data-tab=animation]').click();
      await page.evaluate(() => {
        const slider = document.querySelector('[name=eyeWarpStrength]'); slider.value = '175'; slider.dispatchEvent(new Event('input', { bubbles: true }));
        const other = document.querySelector('[name=motionAmplitude]'); other.value = '120'; other.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#eye-range .range-reset').click();
      });
      await page.waitForFunction(() => window.__audit.calls.filter(([name]) => name === 'setSettings').length >= 1);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.__audit.pet().settings.eyeWarpStrength), 1);
      assert.equal(await page.evaluate(() => window.__audit.pet().settings.motionAmplitude), 1.2, 'Unrelated batched slider input is preserved');
    });
    await check('Host settings persistence errors survive unrelated successful commands until a saved broadcast', async page => {
      await settings(page); await page.locator('[data-tab=animation]').click();
      await page.evaluate(() => window.__audit.publishPet({ storageError: '模拟偏好保存失败' }));
      assert.equal(await page.locator('#settings-storage-error').isVisible(), true);
      assert.equal(await page.locator('#save-status').textContent(), '未能保存');
      await page.locator('[name=eyeTracking]').uncheck();
      await page.waitForFunction(() => window.__audit.calls.some(([name]) => name === 'setSettings'));
      assert.equal(await page.locator('#settings-storage-error').isVisible(), true);
      assert.equal(await page.locator('#save-status').textContent(), '未能保存');
      await page.evaluate(() => window.__audit.publishPet({ storageError: null }));
      assert.equal(await page.locator('#settings-storage-error').isHidden(), true);
      assert.equal(await page.locator('#save-status').textContent(), '自动保存');
    });
    await check('Host persistence recovery does not erase an unrelated local validation error', async page => {
      await settings(page); await page.locator('[data-tab=desktop]').click();
      await page.locator('#scale-percent').fill('0');
      await page.locator('#size-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await page.evaluate(() => window.__audit.publishPet({ storageError: '模拟偏好保存失败' }));
      assert.equal(await page.locator('#error-message').isVisible(), true);
      assert.equal(await page.locator('#settings-storage-error').isVisible(), true);
      await page.evaluate(() => window.__audit.publishPet({ storageError: null }));
      assert.equal(await page.locator('#settings-storage-error').isHidden(), true);
      assert.match(await page.locator('#error-message').textContent(), /至少 1%/);
    });
    await check('Late send failure cannot resurrect an intentionally cleared newer draft', async page => {
      await chat(page); await page.evaluate(() => window.__audit.hold('send'));
      await page.locator('#chat-input').fill('第一条'); await page.locator('#chat-input').press('Enter');
      await page.locator('#chat-input').fill('另外一条'); await page.locator('#chat-input').fill('');
      await page.evaluate(() => window.__audit.release('send', '模拟发送失败'));
      await page.waitForFunction(() => !document.querySelector('#chat-error').hidden);
      assert.equal(await page.locator('#chat-input').inputValue(), '');
    });
    await check('An untouched failed draft is still restored, including Unicode', async page => {
      await chat(page); await page.evaluate(() => window.__audit.hold('send'));
      await page.locator('#chat-input').fill('你好🌸 مرحبا'); await page.locator('#chat-input').press('Enter');
      await page.evaluate(() => window.__audit.release('send', '模拟发送失败'));
      await page.waitForFunction(() => !document.querySelector('#chat-error').hidden);
      assert.equal(await page.locator('#chat-input').inputValue(), '你好🌸 مرحبا');
    });
    await check('A local copy failure survives unrelated playback updates until the next operation', async page => {
      await chat(page); await page.evaluate(() => { window.__audit.history(); window.__audit.hold('copyMessage'); });
      await page.locator('[data-message-action=copy]').click();
      await page.evaluate(() => window.__audit.release('copyMessage', '模拟剪贴板写入失败'));
      await page.waitForFunction(() => !document.querySelector('#chat-error').hidden);
      await page.evaluate(() => window.__audit.publishChat({ speech: { status: 'playing', error: null } }));
      assert.equal(await page.locator('#chat-error').isVisible(), true);
      assert.match(await page.locator('#chat-error').textContent(), /剪贴板/);
      await page.locator('[data-message-action=copy]').click();
      assert.equal(await page.locator('#chat-error').isHidden(), true);
      await page.evaluate(() => window.__audit.publishChat({ error: '模拟连接失败' }));
      assert.equal(await page.locator('#chat-error').isVisible(), true);
      await page.evaluate(() => window.__audit.publishChat({ error: null }));
      assert.equal(await page.locator('#chat-error').isHidden(), true, 'Recovered host errors do not become sticky local errors');
    });
    await check('A stale use-local-model reply cannot overwrite a newer chat broadcast', async page => {
      await settings(page); await page.locator('[data-tab=chat]').click();
      await page.evaluate(() => { const settings = window.__audit.chat().settings; window.__audit.publishChat({ settings: { ...settings, baseUrl: 'https://old.example', model: 'old' } }); window.__audit.hold('setChatSettings'); });
      await page.locator('#model-setup-use-local').click();
      await page.evaluate(() => { const old = window.__audit.chat(); old.settings = { ...old.settings, baseUrl: 'http://127.0.0.1:18434', model: 'elysia-chat' }; window.__audit.publishChat({ settings: { ...old.settings, baseUrl: 'https://new.example', model: 'new' } }); window.__audit.release('setChatSettings', null, old); });
      await page.waitForFunction(() => !document.querySelector('#model-setup-inspect').disabled);
      assert.equal(await page.locator('#model-setup-use-local').textContent(), '使用本地模型');
      assert.equal(await page.locator('#model-setup-use-local').isDisabled(), false);
    });
    await check('Use-local-model still updates when no concurrent chat broadcast arrives', async page => {
      await settings(page); await page.locator('[data-tab=chat]').click();
      await page.evaluate(() => { window.__audit.publishChat({ settings: { ...window.__audit.chat().settings, baseUrl: 'https://old.example', model: 'old' } }); window.__audit.hold('setChatSettings'); });
      await page.locator('#model-setup-use-local').click();
      await page.evaluate(() => { const next = window.__audit.chat(); next.settings = { ...next.settings, baseUrl: 'http://127.0.0.1:18434', model: 'elysia-chat' }; window.__audit.release('setChatSettings', null, next); });
      await page.waitForFunction(() => document.querySelector('#model-setup-use-local').textContent === '当前已使用');
      assert.equal(await page.locator('#model-setup-use-local').isDisabled(), true);
    });
    await check('A warming speech model stays visible and can be stopped in normal chat', async page => {
      await chat(page); await page.evaluate(() => window.__audit.publishChat({ speech: { status: 'warming', error: null } }));
      assert.equal(await page.locator('#chat-stop').isVisible(), true);
      assert.match(await page.locator('#chat-status').textContent(), /正在.*语音|正在.*朗读/);
      await page.locator('#chat-stop').click();
      assert.equal(await page.locator('#chat-status').isHidden(), true);
    });
    await check('Voice persistence failure preserves the birthday draft and recovery clears its own notice', async page => {
      await settings(page); await page.locator('[data-tab=voice]').click();
      await page.locator('#voice-birthday-month').fill('2'); await page.locator('#voice-birthday-day').fill('29');
      await page.evaluate(() => window.__audit.hold('setVoiceSettings'));
      await page.locator('#voice-birthday-form').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => window.__audit.calls.some(([name]) => name === 'setVoiceSettings'));
      await page.evaluate(() => {
        const state = window.__audit.publishVoice({ settings: { ...window.__audit.voice().settings, birthday: '02-29' }, storageError: '磁盘无法保存语音设置' });
        window.__audit.release('setVoiceSettings', null, state);
      });
      assert.equal(await page.locator('#voice-storage-error').count(), 1);
      assert.equal(await page.locator('#voice-storage-error').isVisible(), true);
      assert.doesNotMatch(await page.locator('#voice-birthday-hint').textContent(), /已保存/);
      assert.equal(await page.locator('#voice-birthday-day').inputValue(), '29');
      await page.evaluate(() => window.__audit.publishVoice({ storageError: null }));
      assert.equal(await page.locator('#voice-storage-error').isHidden(), true);
      assert.match(await page.locator('#voice-birthday-hint').textContent(), /已保存/);
      await page.evaluate(() => window.__audit.publishVoice({ settings: { ...window.__audit.voice().settings, birthday: '05-20' } }));
      assert.equal(await page.locator('#voice-birthday-month').inputValue(), '5');
    });
    await check('Voice retry cannot overwrite a newer birthday draft or an unrelated input error', async page => {
      await settings(page); await page.locator('[data-tab=voice]').click();
      await page.locator('#voice-birthday-month').fill('4'); await page.locator('#voice-birthday-day').fill('31');
      await page.locator('#voice-birthday-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await page.evaluate(() => window.__audit.publishVoice({ settings: { ...window.__audit.voice().settings, birthday: '02-29' }, storageError: '磁盘无法保存语音设置' }));
      assert.equal(await page.locator('#voice-storage-error').count(), 1);
      assert.equal(await page.locator('#voice-storage-error').isVisible(), true);
      assert.match(await page.locator('#voice-error').textContent(), /有效的生日/);
      await page.evaluate(() => window.__audit.publishVoice({ storageError: null }));
      assert.equal(await page.locator('#voice-storage-error').isHidden(), true);
      assert.equal(await page.locator('#voice-birthday-month').inputValue(), '4');
      assert.equal(await page.locator('#voice-birthday-day').inputValue(), '31');
      assert.equal(await page.locator('#voice-error').isVisible(), true);
    });
    await check('Repeated chat audio playback and cancellation releases every Blob URL', async page => {
      await chat(page);
      const result = await page.evaluate(async () => {
        for (let i = 0; i < 150; i++) {
          window.__audit.emit('audio', { token: 't' + i, mime: 'audio/wav', base64: btoa('fixture') });
          await Promise.resolve();
          if (i % 2) window.__audit.emit('audio-stop', { token: 't' + i });
          else window.__audioAudit.audio.at(-1).dispatchEvent(new Event('ended'));
        }
        return { urls: window.__audioAudit.urls.size, active: window.__audioAudit.audio.filter(item => !item.paused || item.src).length };
      });
      assert.deepEqual(result, { urls: 0, active: 0 });
    });
    await check('Repeated history changes keep only current messages and empty history releases all nodes', async page => {
      await settings(page);
      const result = await page.evaluate(() => {
        let maximum = 0;
        for (let i = 0; i < 100; i++) {
          window.__audit.history(5);
          for (const button of document.querySelectorAll('.chat-history-choice')) { button.click(); maximum = Math.max(maximum, document.querySelectorAll('.history-message').length); }
          window.__audit.history(0);
        }
        return { maximum, messages: document.querySelectorAll('.history-message').length, conversations: document.querySelectorAll('.chat-history-choice').length };
      });
      assert.deepEqual(result, { maximum: 1, messages: 0, conversations: 0 });
    });
    await check('Speech layout revisions and old audio events cannot affect the replacement bubble', async page => {
      await page.goto(base + '/renderer/speech.html'); await page.waitForSelector('html[data-ready=true]');
      await page.evaluate(() => window.__audit.emit('speech-Play', { token: 'one', line: { text: '你好🌸 مرحبا，跨屏布局检查。', audioUrl: 'file:///fixture.wav' }, volume: .8, revision: 1, maxWidth: 430, maxHeight: 180 }));
      await page.waitForFunction(() => window.__audit.calls.some(([name]) => name === 'speech-layout'));
      await page.evaluate(() => {
        window.__audit.emit('speech-Measure', { token: 'one', revision: 2, maxWidth: 260, maxHeight: 170 });
        window.__audit.emit('speech-LayoutReady', { token: 'one', revision: 1 });
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await page.evaluate(() => window.__audioAudit.audio[0].playCount || 0), 0);
      await page.evaluate(() => window.__audit.emit('speech-LayoutReady', { token: 'one', revision: 2 }));
      await page.waitForFunction(() => window.__audioAudit.audio[0].playCount === 1);
      await page.evaluate(() => window.__audit.emit('speech-Play', { token: 'two', line: { text: '第二条短消息。', audioUrl: 'file:///fixture-2.wav' }, volume: .8, revision: 1, maxWidth: 430, maxHeight: 180 }));
      await page.waitForFunction(() => window.__audit.calls.some(([name, value]) => name === 'speech-layout' && value.token === 'two'));
      const before = await page.evaluate(() => window.__audit.calls.filter(([name]) => name === 'speech-report').length);
      await page.evaluate(() => { window.__audioAudit.audio[0].dispatchEvent(new Event('ended')); window.__audioAudit.audio[0].dispatchEvent(new Event('error')); window.__audit.emit('speech-Stop', { token: 'one' }); });
      assert.equal(await page.evaluate(() => window.__audit.calls.filter(([name]) => name === 'speech-report').length), before);
      assert.equal(await page.evaluate(() => window.__audioAudit.audio[1].src), 'file:///fixture-2.wav');
      await page.evaluate(() => window.__audit.emit('speech-LayoutReady', { token: 'two', revision: 1 }));
      await page.waitForFunction(() => window.__audioAudit.audio[1].playCount === 1);
      await page.evaluate(() => window.__audit.emit('speech-Stop', { token: 'two' }));
      assert.equal(await page.evaluate(() => window.__audioAudit.audio.every(item => item.paused && item.src === '')), true);
    });
    await check('Closing chat and settings pages unregisters every host subscription', async page => {
      for (const open of [chat, settings]) {
        await open(page); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        assert.equal(await page.evaluate(() => Object.values(window.__audit.listeners()).every(count => count === 0)), true);
      }
    });
    await check('A speech page cannot create or play new media after pagehide teardown', async page => {
      await page.goto(base + '/renderer/speech.html'); await page.waitForSelector('html[data-ready=true]');
      const result = await page.evaluate(async () => {
        window.dispatchEvent(new PageTransitionEvent('pagehide'));
        window.__audit.emit('speech-Play', { token: 'late', line: { text: '关闭后的迟到字幕', audioUrl: 'file:///fixture.wav' }, volume: .8, revision: 1, maxWidth: 430, maxHeight: 180 });
        await Promise.resolve();
        window.__audit.emit('speech-LayoutReady', { token: 'late', revision: 1 });
        await new Promise(resolve => requestAnimationFrame(resolve));
        return { listeners: Object.entries(window.__audit.listeners()).filter(([name]) => name.startsWith('speech-')).reduce((total, [, count]) => total + count, 0), audio: window.__audioAudit.audio.length,
          reports: window.__audit.calls.filter(([name]) => name.startsWith('speech-')).length };
      });
      assert.deepEqual(result, { listeners: 0, audio: 0, reports: 0 });
    });
    await check('IME Enter and keyCode 229 cannot submit a composition', async page => {
      await chat(page); await page.locator('#chat-input').fill('拼音输入');
      await page.locator('#chat-input').evaluate(input => { input.dispatchEvent(new CompositionEvent('compositionstart')); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); input.dispatchEvent(new CompositionEvent('compositionend')); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })); });
      assert.equal(await page.evaluate(() => window.__audit.calls.filter(([name]) => name === 'send').length), 0);
    });
  } finally {
    report.passed = report.checks.every(item => item.passed) && !report.pageErrors.length;
    await fs.writeFile(path.join(output, 'renderer-results.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });

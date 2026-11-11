import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'quick-chat-ui');
await fs.mkdir(path.join(output, 'temp'), { recursive: true });
process.env.TEMP = path.join(output, 'temp');
process.env.TMP = process.env.TEMP;
const report = { passed: false, checks: [], screenshots: [] }, errors = [];
const check = name => report.checks.push(name);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const fixture = url.pathname === '/renderer/quick-chat-settings-fixture.html';
    const file = path.resolve(root, fixture ? 'renderer/settings.html' : '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    let body = await fs.readFile(file);
    // Exercise the real settings markup/style and the independently scoped
    // quick-chat module without unrelated pet, model, or conversation fixtures.
    if (fixture) body = body.toString().replace(/<script\b[^>]*src="\.\/([^"]+)"[^>]*><\/script>/g, (tag, name) => name === 'quick-chat-settings.mjs' ? tag : '');
    response.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 640, height: 140 } });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.addInitScript(() => {
    let state = { busy: false, error: null, storageError: null, voice: { enabled: true, status: 'idle', error: null, blocked: null } }, mode = 'accept', finish;
    const listeners = new Set(), focusListeners = new Set(), calls = [];
    const copy = () => structuredClone(state);
    const publish = patch => { state = { ...state, ...patch }; for (const callback of listeners) callback(copy()); return copy(); };
    const subscribe = set => callback => { set.add(callback); return () => set.delete(callback); };
    window.__quickQA = { calls, publish, mode: value => { mode = value; }, focus: () => { for (const callback of focusListeners) callback(); },
      finish: result => { publish(result); finish(result); } };
    window.elysiaQuickChat = {
      getState: async () => copy(), onState: subscribe(listeners), onFocus: subscribe(focusListeners),
      hide: async () => { calls.push(['hide']); return true; },
      cancel: async () => { calls.push(['cancel']); const result = publish({ busy: false, error: null, status: null, voice: { ...state.voice, status: 'idle', error: null } }); if (mode === 'preparing') finish({ ...result, accepted: false, error: '已取消发送，草稿已保留。' }); return result; },
      send: async text => {
        calls.push(['send', text]);
        if (mode === 'defer') return new Promise(resolve => { finish = resolve; });
        if (mode === 'preparing') { publish({ busy: true, status: '正在唤醒爱莉希雅…' }); return new Promise(resolve => { finish = resolve; }); }
        if (mode === 'throw') throw new Error('transport detail must not appear');
        if (mode === 'reject') return { ...publish({ error: '暂时无法发送，请重试。' }), accepted: false };
        return { ...publish({ busy: true, error: null }), accepted: true };
      },
      onSpeechAudio: () => () => {}, onSpeechStop: () => () => {}, reportSpeech: () => {},
    };
  });
  const page = await context.newPage();
  await page.goto(`${origin}/renderer/quick-chat.html`);
  await page.waitForFunction(() => document.documentElement.dataset.quickChatReady === 'true');
  assert.equal(await page.locator('#quick-input').evaluate(node => node === document.activeElement), true);
  const input = page.locator('#quick-input');
  const sends = () => page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'send').length);
  await input.fill('今天的晚霞很好看。');
  await page.evaluate(() => {
    const node = document.querySelector('#quick-input');
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal(await sends(), 0);
  assert.equal(await page.evaluate(() => window.__quickQA.calls.length), 0);
  await page.evaluate(() => document.querySelector('#quick-input').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.keyboard.press('Shift+Enter');
  assert.match(await input.inputValue(), /\n/);
  assert.equal(await sends(), 0);
  check('IME confirmation and dismissal do not send or hide; Shift+Enter adds a line');
  await input.fill('今天的晚霞很好看。');
  await page.screenshot({ path: path.join(output, 'quick-chat-640.png'), omitBackground: true });
  report.screenshots.push('quick-chat-640.png');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#quick-input').value === '' && !document.querySelector('#quick-stop').hidden);
  assert.equal(await page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'hide').length), 0, 'Accepted send must not ask the host to hide the composer');
  await input.fill('先写下一句。');
  await page.keyboard.press('Enter');
  assert.equal(await sends(), 1);
  await page.locator('#quick-stop').click();
  await page.waitForFunction(() => document.querySelector('#quick-stop').hidden);
  assert.equal(await input.inputValue(), '先写下一句。');
  check('Accepted send clears only its draft; busy suppresses duplicate sends and exposes cancellation');
  for (const [voiceStatus, message] of [['warming', '正在加载语音'], ['starting', '正在准备朗读'], ['synthesizing', '正在生成语音'], ['playing', '爱莉希雅正在说话']]) {
    await page.evaluate(status => window.__quickQA.publish({ busy: false, voice: { enabled: true, status, error: null, blocked: null } }), voiceStatus);
    assert.match(await page.locator('#quick-status').textContent(), new RegExp(message));
    assert.equal(await page.locator('#quick-send').isVisible(), true);
    assert.equal(await page.locator('#quick-send').isEnabled(), true);
    assert.equal(await page.locator('#quick-stop').isVisible(), true);
    assert.equal(await page.locator('#quick-stop').getAttribute('aria-label'), '停止朗读，保留草稿');
    const before = await page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'cancel').length);
    await page.locator('#quick-stop').click();
    await page.waitForFunction(() => document.querySelector('#quick-stop').hidden);
    assert.equal(await page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'cancel').length), before + 1);
    assert.equal(await input.inputValue(), '先写下一句。');
  }
  check('Voice loading, preparation, synthesis and playback show distinct status and remain stoppable after text generation ends');
  for (const [voice, message, markedError] of [
    [{ enabled: false, status: 'idle', error: null, blocked: null }, '回复朗读已关闭', false],
    [{ enabled: true, status: 'idle', error: null, blocked: '勿扰已开启，请在设置 → 语音关闭。' }, '勿扰已开启', false],
    [{ enabled: true, status: 'error', error: '本地语音加载失败，文字回复已保留。', blocked: null }, '本地语音加载失败', true],
  ]) {
    await page.evaluate(voice => window.__quickQA.publish({ busy: false, voice }), voice);
    assert.match(await page.locator('#quick-status').textContent(), new RegExp(message));
    assert.equal(await page.locator('#quick-status').getAttribute('data-error'), String(markedError));
    assert.equal(await page.locator('#quick-send').isEnabled(), true);
    assert.equal(await page.locator('#quick-stop').isHidden(), true);
  }
  check('Disabled reading, DND blocking and speech errors explain silence without disabling text messages');
  await page.evaluate(() => window.__quickQA.publish({ voice: { enabled: true, status: 'playing', error: null, blocked: null } }));
  await page.setViewportSize({ width: 320, height: 140 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false);
  assert.ok((await input.boundingBox()).width >= 160);
  await page.screenshot({ path: path.join(output, 'quick-chat-speaking-320.png'), omitBackground: true });
  report.screenshots.push('quick-chat-speaking-320.png');
  await page.evaluate(() => window.__quickQA.publish({ voice: { enabled: true, status: 'idle', error: null, blocked: null } }));
  assert.equal(await page.locator('#quick-stop').isHidden(), true);
  assert.equal(await page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'hide').length), 0);
  await page.setViewportSize({ width: 640, height: 140 });
  check('Manual speech stop and natural completion keep the composer visible, including both actions in a compact layout');
  await page.evaluate(() => window.__quickQA.mode('reject'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#quick-status').textContent.includes('暂时无法发送'));
  assert.equal(await input.inputValue(), '先写下一句。');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__quickQA.focus());
  assert.equal(await input.inputValue(), '先写下一句。');
  assert.equal(await page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'hide').length), 1);
  check('Rejected send and Escape/refocus preserve the draft');
  await page.evaluate(() => { window.__quickQA.publish({ error: null }); window.__quickQA.mode('defer'); });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#quick-input').getAttribute('aria-busy') === 'true');
  await input.fill('等待确认时写下的新草稿。');
  await page.evaluate(() => window.__quickQA.finish({ accepted: true, busy: true, error: null, storageError: null }));
  await page.waitForFunction(() => document.querySelector('#quick-input').getAttribute('aria-busy') === 'false');
  assert.equal(await input.inputValue(), '等待确认时写下的新草稿。');
  assert.equal(await page.evaluate(() => window.__quickQA.calls.filter(call => call[0] === 'hide').length), 1, 'Only the earlier explicit Escape can hide, never accepted sends or voice events');
  check('Typing while send acceptance is pending survives the accepted result and state event');
  await page.evaluate(() => { window.__quickQA.publish({ busy: false }); window.__quickQA.mode('preparing'); });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#quick-status').textContent === '正在唤醒爱莉希雅…');
  assert.equal(await page.locator('#quick-stop').isEnabled(), true);
  await input.fill('等待启动时又写了一句。');
  await page.locator('#quick-stop').click();
  await page.waitForFunction(() => document.querySelector('#quick-input').getAttribute('aria-busy') === 'false');
  assert.equal(await input.inputValue(), '等待启动时又写了一句。');
  check('Cold-start status stays visible and cancellation during pending send retains the latest draft');
  await page.evaluate(() => { window.__quickQA.publish({ busy: false }); window.__quickQA.mode('throw'); });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#quick-status').textContent.includes('草稿已保留'));
  assert.doesNotMatch(await page.locator('#quick-status').textContent(), /transport detail/);
  await page.evaluate(() => window.__quickQA.publish({ storageError: '暂时无法保存聊天记录。' }));
  assert.equal(await page.locator('#quick-send').isDisabled(), true);
  assert.equal(await input.isEnabled(), true);
  check('Transport and storage failures leave typed content editable without exposing transport internals');
  await page.setViewportSize({ width: 320, height: 140 });
  await page.screenshot({ path: path.join(output, 'quick-chat-320.png'), omitBackground: true });
  report.screenshots.push('quick-chat-320.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false);
  check('Compact 320 × 140 layout fits without page overflow');

  const settingsContext = await browser.newContext({ viewport: { width: 720, height: 830 } });
  settingsContext.on('page', target => target.on('pageerror', error => errors.push(error.message)));
  await settingsContext.addInitScript(() => {
    let state = { enabled: true, accelerator: 'Control+Space', registered: true, error: null }, capturing = false, reject = false, hold = false, resolveStart;
    const listeners = new Set(), calls = [];
    const copy = () => structuredClone(state);
    const publish = patch => { state = { ...state, ...patch }; for (const callback of listeners) callback(copy()); return copy(); };
    window.__quickSettingsQA = { calls, snapshot: copy, reject: () => { reject = true; }, holdStart: () => { hold = true; }, releaseStart: () => { resolveStart(copy()); } };
    window.elysiaSettings = {
      getQuickChatSettings: async () => copy(),
      onQuickChatSettings: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      setQuickChatSettings: async patch => {
        calls.push(['save', patch]);
        if (reject) { reject = false; return publish({ error: '这个快捷键已被其他程序占用。' }); }
        return publish({ ...patch, registered: patch.enabled && !capturing, error: null });
      },
      setQuickChatCapture: async value => {
        calls.push(['capture', value]); capturing = value;
        const result = publish({ registered: state.enabled && !capturing, error: null });
        if (value && hold) { hold = false; return new Promise(resolve => { resolveStart = resolve; }); }
        return result;
      },
      openQuickChat: async () => { calls.push(['open']); return true; },
    };
  });
  const settings = await settingsContext.newPage();
  await settings.goto(`${origin}/renderer/quick-chat-settings-fixture.html`);
  await settings.waitForFunction(() => document.documentElement.dataset.quickChatSettingsReady === 'true');
  await settings.evaluate(() => { document.querySelector('#panel-appearance').hidden = true; document.querySelector('#panel-chat').hidden = false; });
  const record = settings.locator('#quick-chat-record'), shortcut = settings.locator('#quick-chat-key');
  assert.equal(await shortcut.textContent(), 'Ctrl + 空格');
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.calls.length), 0, 'Opening settings must preserve the saved custom shortcut');
  assert.equal(await record.textContent(), '更换快捷键');
  assert.match(await settings.locator('#quick-chat-help').textContent(), /更换快捷键.*新组合键.*保存快捷键/);
  assert.match(await settings.locator('.quick-chat-usage').textContent(), /发送后输入框保持显示.*Esc.*再次按快捷键收起/);
  assert.doesNotMatch(await settings.locator('#quick-chat-settings').textContent(), /录制/);
  await settings.locator('#quick-chat-settings').screenshot({ path: path.join(output, 'quick-chat-settings.png') });
  report.screenshots.push('quick-chat-settings.png');
  check('Settings preserve the saved custom shortcut and clearly explain editing, saving and manual collapse');
  await record.click();
  await settings.waitForFunction(() => document.querySelector('#quick-chat-record').getAttribute('aria-pressed') === 'true');
  assert.equal(await record.textContent(), '取消编辑');
  await settings.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true, bubbles: true })));
  assert.equal(await shortcut.textContent(), '按下组合键…');
  await settings.keyboard.press('Shift+K');
  assert.match(await settings.locator('#quick-chat-help').textContent(), /Ctrl、Alt 或 Win/);
  assert.equal(await record.getAttribute('aria-pressed'), 'true');
  await settings.keyboard.press('Control+Alt+K');
  await settings.waitForFunction(() => document.querySelector('#quick-chat-save').disabled === false);
  assert.equal(await shortcut.textContent(), 'Ctrl + Alt + K');
  assert.match(await settings.locator('#quick-chat-help').textContent(), /尚未保存.*保存快捷键/);
  assert.deepEqual(await settings.evaluate(() => window.__quickSettingsQA.calls.filter(call => call[0] === 'capture')), [['capture', true], ['capture', false]]);
  check('Shortcut editing suspends the binding, ignores IME composition, rejects bare/Shift typing and restores registration');
  await settings.evaluate(() => window.__quickSettingsQA.reject());
  await settings.locator('#quick-chat-save').click();
  await settings.waitForFunction(() => !document.querySelector('#quick-chat-settings-error').hidden);
  assert.equal(await shortcut.textContent(), 'Ctrl + Alt + K');
  assert.equal(await settings.locator('#quick-chat-save').isEnabled(), true);
  await settings.locator('#quick-chat-save').click();
  await settings.waitForFunction(() => document.querySelector('#quick-chat-settings-error').hidden && document.querySelector('#quick-chat-save').disabled);
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.snapshot().accelerator), 'Control+Alt+K');
  check('Conflicting shortcut errors retain the edited chord and can be retried');
  await record.click();
  await settings.keyboard.press('Control+Alt+J');
  await settings.waitForFunction(() => document.querySelector('#quick-chat-enabled').disabled === false);
  await settings.locator('#quick-chat-enabled').uncheck();
  await settings.waitForFunction(() => !document.querySelector('#quick-chat-enabled').disabled);
  assert.equal(await shortcut.textContent(), 'Ctrl + Alt + J');
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.snapshot().accelerator), 'Control+Alt+K');
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.snapshot().enabled), false);
  await settings.locator('#quick-chat-save').click();
  await settings.waitForFunction(() => document.querySelector('#quick-chat-save').disabled);
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.snapshot().accelerator), 'Control+Alt+J');
  check('Enable toggle saves independently without losing or silently saving the shortcut draft');
  await settings.locator('#quick-chat-reset').click();
  await settings.waitForFunction(() => document.querySelector('#quick-chat-key').textContent === 'Ctrl + Alt + E' && !document.querySelector('#quick-chat-record').disabled);
  await record.click();
  await settings.keyboard.press('Escape');
  await settings.waitForFunction(() => !document.querySelector('#quick-chat-record').disabled);
  assert.equal(await shortcut.textContent(), 'Ctrl + Alt + E');
  await record.click();
  await settings.evaluate(() => window.dispatchEvent(new Event('blur')));
  await settings.waitForFunction(() => document.querySelector('#quick-chat-record').getAttribute('aria-pressed') === 'false' && !document.querySelector('#quick-chat-record').disabled);
  await settings.evaluate(() => window.__quickSettingsQA.holdStart());
  await record.click();
  await settings.waitForFunction(() => document.querySelector('#quick-chat-record').disabled);
  await settings.evaluate(() => window.dispatchEvent(new Event('blur')));
  await settings.evaluate(() => window.__quickSettingsQA.releaseStart());
  await settings.waitForFunction(() => !document.querySelector('#quick-chat-record').disabled);
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.calls.at(-1)[1]), false);
  check('Reset, Escape, blur, and blur during pending suspension restore a usable shortcut');
  await settings.locator('#quick-chat-open').click();
  assert.equal(await settings.evaluate(() => window.__quickSettingsQA.calls.at(-1)[0]), 'open');
  await settings.setViewportSize({ width: 420, height: 830 });
  assert.equal(await settings.locator('#quick-chat-settings').evaluate(node => node.scrollWidth > node.clientWidth), false);
  await settings.locator('#quick-chat-settings').screenshot({ path: path.join(output, 'quick-chat-settings-narrow.png') });
  report.screenshots.push('quick-chat-settings-narrow.png');
  check('Shortcut values, edit action and help text remain separate without horizontal overflow in a narrow settings window');
  const legacy = await browser.newPage();
  legacy.on('pageerror', error => errors.push(error.message));
  await legacy.goto(`${origin}/renderer/quick-chat-settings-fixture.html`);
  assert.equal(await legacy.locator('#quick-chat-settings').isHidden(), true);
  check('Settings gracefully hide the optional section when the host lacks the new bridge');
  assert.deepEqual(errors, []);
  report.passed = true;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, errors }, null, 2));
}
console.log(JSON.stringify(report, null, 2));

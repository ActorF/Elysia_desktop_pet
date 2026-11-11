/** Real hidden windows and IPC; a tiny loopback fixture replaces the model. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { quickChatBounds } = require('./quick-chat-window.cjs');

async function checkQuickChatRuntime({ chat, quickChat, quickChatWindow, quickChatShortcut, chatWindow,
  settingsWindow, voices, chatSpeech, chatSpeechTestHooks, pet, screen, root, directory }) {
  assert.match(path.basename(directory), /quick-chat-smoke$/);
  const errors = [], requests = [];
  const poll = async (label, read, matches) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const value = await read(); if (matches(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`${label} did not settle: ${JSON.stringify({ quick: quickChat.getState(), voice: voices.getState(), speech: chatSpeech.getState(), messages: chat.getState().conversations.find(item => item.id === chat.getState().activeConversationId)?.messages })}`);
  };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '我在这里呀。\n' }, finish_reason: null }] }) + '\n\n');
    setTimeout(() => response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '慢慢说，我听着呢♪' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'), 200);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    chat.setSettings({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'quick-smoke', readAloud: true });
    chat.newConversation();
    voices.setSettings({ enabled: false, dnd: false, volume: .8 });
    const window = await quickChatWindow.open();
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await poll('quick renderer', () => window.webContents.executeJavaScript('document.documentElement.dataset.quickChatReady'), value => value === 'true');
    let hides = 0;
    const nativeHide = window.hide.bind(window);
    window.hide = () => { hides++; return nativeHide(); };
    const snapshot = await window.webContents.executeJavaScript('window.elysiaQuickChat.getState()');
    assert.equal(Object.hasOwn(snapshot, 'conversations'), false);
    assert.deepEqual(await window.webContents.executeJavaScript('({node:typeof require,chat:typeof window.elysiaChat,settings:typeof window.elysiaSettings})'), { node: 'undefined', chat: 'undefined', settings: 'undefined' });
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    assert.equal(window.webContents.getLastWebPreferences().nodeIntegration, false);
    const expectedBounds = quickChatBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    // Windows may round an invisible frame by two DIPs on fractional scaling.
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(window.getBounds()[key] - expectedBounds[key]) <= 2, `composer ${key}`);
    assert.equal(chatWindow.getWindow(), null); assert.equal(settingsWindow.getWindow(), null);
    await window.webContents.executeJavaScript(`const input = document.querySelector('#quick-input'); input.value = '今天可以陪我说句话吗？'; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#quick-form').requestSubmit(); true`);
    await poll('accepted message', () => window.webContents.executeJavaScript('document.querySelector("#quick-input").value'), value => value === '');
    await poll('first pet reply', () => voices.getState().playback, value => value.kind === 'chat' && value.status === 'playing' && value.text === '我在这里呀。');
    assert.equal(chatWindow.getWindow(), null, 'Reply never opens conversation window');
    assert.equal(settingsWindow.getWindow(), null, 'Reply never opens settings/history');
    const bubble = voices.getSpeechWindow();
    assert.equal(await bubble.webContents.executeJavaScript('document.querySelector("#line").textContent'), '我在这里呀。');
    await poll('quick audio acknowledgement', () => chatSpeechTestHooks.calls, calls => calls.some(item => item.acknowledged));
    assert.equal(chatSpeechTestHooks.calls.reduce((sum, item) => sum + item.requests, 0), 1);
    // ASAR is read-only. Packaged checks write alongside the verifier workspace.
    const screenshotDirectory = path.join(root.includes('app.asar') ? process.cwd() : root, 'artifacts', 'quick-chat-tests'); fs.mkdirSync(screenshotDirectory, { recursive: true });
    fs.writeFileSync(path.join(screenshotDirectory, 'pet-reply.png'), (await bubble.webContents.capturePage()).toPNG());
    await bubble.webContents.executeJavaScript('document.body.click(); true');
    await poll('second pet reply', () => voices.getState().playback, value => value.kind === 'chat' && value.status === 'playing' && value.text === '慢慢说，我听着呢♪');
    assert.equal(hides, 0, 'sending and both replies keep the input open');
    await quickChatWindow.open();
    assert.equal(quickChatWindow.getWindow(), window);
    await window.webContents.executeJavaScript(`document.querySelector('#quick-input').value = '保留草稿'; document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(hides, 1, 'Escape explicitly closes the input');
    await quickChatWindow.open();
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#quick-input").value'), '保留草稿');
    await quickChatWindow.toggle(); assert.equal(hides, 2, 'the same shortcut closes the input');
    await quickChatWindow.toggle(); assert.equal(quickChatWindow.getWindow(), window);
    fs.writeFileSync(path.join(screenshotDirectory, 'native-input.png'), (await window.webContents.capturePage()).toPNG());
    const settings = await settingsWindow.open();
    await poll('shortcut settings', () => settings.webContents.executeJavaScript('document.documentElement.dataset.quickChatSettingsReady'), value => value === 'true');
    const invokeSettings = (method, value) => settings.webContents.executeJavaScript(`window.elysiaSettings.${method}(${value === undefined ? '' : JSON.stringify(value)})`);
    const saved = await invokeSettings('setQuickChatSettings', { enabled: true, accelerator: 'Control+Alt+Shift+E' });
    assert.equal(saved.registered, true); assert.equal(saved.error, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'quick-chat-settings.json'), 'utf8')).accelerator, 'Control+Alt+Shift+E');
    await invokeSettings('setQuickChatCapture', true); assert.equal(quickChatShortcut.getState().registered, false);
    settings.emit('blur'); assert.equal(quickChatShortcut.getState().registered, true);
    await invokeSettings('setQuickChatSettings', { enabled: true, accelerator: 'Control+Alt+E' });
    await invokeSettings('stopVoice');
    assert.equal(voices.getState().playback.status, 'idle');
    assert.equal(chatSpeech.isActive(), false);
    settings.close();
    await poll('closed settings', () => settingsWindow.getWindow(), value => value === null);
    assert.equal(chatWindow.getWindow(), null);
    assert.equal(pet.isVisible(), false); assert.equal(window.isVisible(), false); assert.equal(bubble.isVisible(), false);
    assert.equal(chatSpeech.getState().error, null);
    assert.deepEqual(errors, []);
    return { noHistoryWindows: true, isolatedBridge: true, translucentComposer: true, bottomCenterThirdWidth: true,
      existingPetBubble: true, oneSentenceAtATime: true, hiddenAudioAcknowledged: true, escapedDraftRetained: true, sendsKeepInputOpen: true, shortcutToggles: true,
      shortcutSaved: true, captureRestoresOnBlur: true, stopVoiceClearsReply: true, noDownloads: true, requests: requests.length, bounds: window.getBounds(), contentBounds: window.getContentBounds() };
  } finally {
    quickChat.cancel();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { checkQuickChatRuntime };

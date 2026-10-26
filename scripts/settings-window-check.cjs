'use strict';

// Browser interaction/visual QA only. Native window isolation is covered by
// electron/settings-window-smoke.cjs using the real Electron IPC and filesystem.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const { DEFAULT_SETTINGS, sanitizeSettings } = require('../electron/host-policy.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'settings-window-check');
const report = { passed: false, kind: 'browser UI with mock host; native lifecycle tested separately', checks: [], screenshots: [] };
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const data = await fs.readFile(filename);
    response.setHeader('Content-Type', { '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' }[path.extname(filename)] || 'application/octet-stream');
    response.end(data);
  } catch { response.writeHead(404).end(); }
});

async function main() {
  await fs.mkdir(output, { recursive: true });
  const { createPetState, applyAction, EXPRESSIONS, POSES } = await import(pathToFileURL(path.join(root, 'renderer', 'state.mjs')).href);
  const pet = createPetState();
  let settings = { ...DEFAULT_SETTINGS }, rejectNext = false;
  let typing = {active:false,error:'需要允许输入监控。',permissionRequired:true};
  const calls = [], errors = [];
  const snapshot = () => ({ platform:process.platform, settings: { ...settings }, appearance: { expression: pet.expression, pose: pet.pose, cat: pet.cat, glasses: pet.glasses }, hotkeys: { typing, legacy: { active: true, error: null }, alternate: { active: false, failed: [] } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 600, height: 741 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__mockSettingsHost', async (method, value) => {
      calls.push({ method, value });
      if (rejectNext && method !== 'getState') { rejectNext = false; throw new Error('QA simulated save failure'); }
      if (method === 'typingPermission') typing = {active:true,error:null,permissionRequired:false};
      if (method === 'setSettings') settings = sanitizeSettings(value, settings);
      if (method === 'action') {
        applyAction(pet, value);
        settings = sanitizeSettings({ cat: pet.cat, glasses: pet.glasses }, settings);
      }
      if (method === 'resize') settings = sanitizeSettings({ scale: value }, settings);
      if (method === 'recover') settings = sanitizeSettings({ clickThrough: false, ...(value ? { scale: 1 } : {}) }, settings);
      return snapshot();
    });
    await page.addInitScript(() => {
      const listeners = new Set(), windowListeners = new Set(), windowControls = [], voiceListeners = new Set(), voiceCalls = [];
      let windowState = { maximized: false };
      let voiceState = { settings: { enabled: true, dnd: false, volume: .8, birthday: '' }, playback: { status: 'idle' },
        available: true, interactionAvailable: true, error: null, interactionError: null, queuedInteraction: null,
        environment: { monitorReady: true, locked: false, suspended: false, fullscreen: false } };
      const publishVoice = patch => {
        voiceState = { ...voiceState, ...patch };
        for (const callback of voiceListeners) callback(structuredClone(voiceState));
        return structuredClone(voiceState);
      };
      const publish = state => { for (const callback of listeners) callback(structuredClone(state)); };
      const publishWindowState = state => {
        windowState = { maximized: state.maximized === true };
        for (const callback of windowListeners) callback(structuredClone(windowState));
      };
      const invoke = async (method, value) => {
        const state = await window.__mockSettingsHost(method, value);
        if (method !== 'getState') publish(state);
        return method === 'action' ? true : state;
      };
      window.__settingsQA = { publish, windowControls, publishWindowState, publishVoice, voiceCalls, voiceSnapshot: () => structuredClone(voiceState) };
      window.elysiaSettings = Object.freeze({
        requestTypingPermission: () => invoke('typingPermission'),
        getState: () => invoke('getState'), setSettings: patch => invoke('setSettings', patch),
        action: action => invoke('action', action), resize: scale => invoke('resize', scale),
        recover: (resetScale = false) => invoke('recover', resetScale),
        // Native preload uses send; this stub records intent without closing the QA page.
        windowControl: action => {
          windowControls.push(action); void window.__mockSettingsHost('windowControl', action);
          if (action === 'toggle-maximize') publishWindowState({ maximized: !windowState.maximized });
        },
        getWindowState: async () => structuredClone(windowState),
        onWindowState: callback => { windowListeners.add(callback); return () => windowListeners.delete(callback); },
        onState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
        getVoiceState: async () => structuredClone(voiceState),
        setVoiceSettings: async patch => { voiceCalls.push(['settings', patch]); return publishVoice({ settings: { ...voiceState.settings, ...patch } }); },
        stopVoice: async () => { voiceCalls.push(['stop']); return publishVoice({ playback: { status: 'idle' }, queuedInteraction: null }); },
        onVoiceState: callback => { voiceListeners.add(callback); return () => voiceListeners.delete(callback); },
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/settings.html`);
    await page.waitForSelector('html[data-ready="true"][data-voice-ready="true"]');
    const settled = async () => { await page.waitForFunction(() => document.querySelector('#save-status').textContent === '自动保存'); };
    const check = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
    const tab = async name => { await page.locator(`[data-tab="${name}"]`).click(); assert.equal(await page.locator(`[data-tab="${name}"]`).getAttribute('aria-selected'), 'true'); };
    const selected = async (type, id) => assert.equal(await page.locator(`.choice[data-action="${type}"][data-id="${id}"]`).getAttribute('aria-pressed'), 'true');
    const choose = async (type, id) => { await page.locator(`.choice[data-action="${type}"][data-id="${id}"]`).click(); await settled(); await selected(type, id); };
    const toggle = async (key, value) => { await page.locator(`[name="${key}"]`).setChecked(value); await settled(); assert.equal(settings[key], value); };
    const number = async (key, value, expected) => {
      const input = page.locator(`[name="${key}Value"]`);
      await input.fill(String(value)); await input.press('Tab'); await settled();
      assert.equal(settings[key], expected ?? value);
    };
    const capture = async (name, scrollToTop = true) => {
      if (scrollToTop) await page.locator('main').evaluate(node => { node.scrollTop = 0; });
      const filename = path.join(output, `${name}.png`);
      await page.screenshot({ path: filename, animations: 'disabled' }); report.screenshots.push(filename);
    };
    const layout = async name => {
      const value = await page.evaluate(() => {
        const footer = document.querySelector('footer').getBoundingClientRect();
        const tabbar = document.querySelector('.tabs').getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth,
          footer: { top: footer.top, bottom: footer.bottom }, tabbar: { top: tabbar.top, bottom: tabbar.bottom } };
      });
      assert.ok(value.bodyWidth <= value.width, `${name} must have no horizontal scroll`);
      assert.ok(value.footer.top >= value.tabbar.bottom && value.footer.bottom <= value.height + 1, `${name} recovery footer must remain visible`);
      check(name, value);
    };

    const chrome = await page.evaluate(() => {
      const header = document.querySelector('.page-header');
      const region = node => getComputedStyle(node).getPropertyValue('-webkit-app-region');
      return { header: region(header), controls: [...document.querySelectorAll('[data-window-control]')].map(button => ({
        action: button.dataset.windowControl, region: region(button), text: button.textContent.trim(),
        label: button.getAttribute('aria-label'),
        visibleIcons: [...button.querySelectorAll('svg')].filter(svg => { const rect = svg.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(svg).visibility !== 'hidden'; }).length,
      })) };
    });
    assert.equal(chrome.header, 'drag', 'Frameless header must provide a native drag region');
    assert.deepEqual(chrome.controls.map(button => button.action).sort(), ['close', 'minimize', 'toggle-maximize']);
    for (const button of chrome.controls) {
      assert.equal(button.region, 'no-drag', `${button.action} must remain clickable inside the drag header`);
      assert.equal(button.text, '', `${button.action} must show an SVG icon without visible label text`);
      assert.equal(button.visibleIcons, 1, `${button.action} must show exactly one visible icon`);
    }
    assert.deepEqual(chrome.controls.map(button => button.label), ['最小化', '最大化', '关闭']);
    const maximizeButton = page.locator('[data-window-control="toggle-maximize"]');
    const verifyMaximized = async maximized => {
      assert.equal(await maximizeButton.getAttribute('data-maximized'), String(maximized));
      assert.equal(await maximizeButton.getAttribute('aria-label'), maximized ? '还原' : '最大化');
      assert.equal(await maximizeButton.getAttribute('title'), maximized ? '还原' : '最大化');
      assert.equal(await maximizeButton.locator('.restore-icon').isVisible(), maximized);
      assert.equal(await maximizeButton.locator('.maximize-icon').isVisible(), !maximized);
    };
    await verifyMaximized(false);
    await page.locator('[data-window-control="minimize"]').click();
    await maximizeButton.click(); await verifyMaximized(true);
    await maximizeButton.click(); await verifyMaximized(false);
    await page.locator('[data-window-control="close"]').click();
    const expectedWindowCalls = ['minimize', 'toggle-maximize', 'toggle-maximize', 'close'];
    assert.deepEqual(await page.evaluate(() => window.__settingsQA.windowControls), expectedWindowCalls);
    await page.evaluate(() => window.elysiaSettings.getState());
    assert.deepEqual(calls.filter(call => call.method === 'windowControl').map(call => call.value), expectedWindowCalls);
    assert.deepEqual(snapshot().settings, DEFAULT_SETTINGS);
    check('frameless titlebar is draggable; three visible SVG controls are no-drag and route minimize/maximize/restore/close', chrome);
    // Native titlebar double-clicks and OS window events arrive through this channel.
    await page.evaluate(() => window.__settingsQA.publishWindowState({ maximized: true })); await verifyMaximized(true);
    await page.evaluate(() => window.__settingsQA.publishWindowState({ maximized: false })); await verifyMaximized(false);
    assert.deepEqual(await page.evaluate(() => window.__settingsQA.windowControls), expectedWindowCalls);
    assert.deepEqual(snapshot().settings, DEFAULT_SETTINGS);
    check('external window-state events switch maximize/restore icon and accessible label without changing preferences or sending commands');

    assert.equal(await page.locator('.choice[data-action="expression"]').count(), 10);
    assert.equal(await page.locator('.choice[data-action="pose"]').count(), 4);
    assert.deepEqual(await page.locator('[role=tab]').evaluateAll(tabs=>tabs.map(tab=>tab.dataset.tab)), ['appearance','animation','desktop','interaction','voice']);
    await layout('default window layout'); await capture('appearance-default');
    await choose('pose', 'tea');
    for (const expression of EXPRESSIONS) { await choose('expression', expression.id); assert.equal(pet.pose, 'tea'); }
    await page.locator('[data-action="neutral"]').click(); await settled(); assert.equal(pet.expression, null); assert.equal(pet.pose, 'tea');
    await toggle('cat', true); await toggle('glasses', true);
    for (const pose of POSES) { await choose('pose', pose.id); assert.equal(pet.cat, true); assert.equal(pet.glasses, true); }
    await choose('expression', 'heart');
    check('all 10 expressions and 4 poses route independently; skins remain simultaneously enabled');
    await capture('appearance-selected');

    // Exercise the same state notification used after hotkeys and pet actions.
    applyAction(pet, { type: 'expression', id: 'smile' });
    await page.evaluate(state => window.__settingsQA.publish(state), snapshot());
    await selected('expression', 'smile'); await selected('pose', 'tea');
    assert.equal(await page.locator('[name="cat"]').isChecked(), true);
    check('external hotkey state notification updates selected face without resetting pose or skins');
    await page.locator('[data-action="reset"]').click(); await settled();
    assert.deepEqual(snapshot().appearance, { expression: null, pose: 'idle', cat: false, glasses: false });
    check('appearance reset clears only expression, skins and pose');

    await tab('animation');
    if (process.platform === 'darwin') {
      assert.equal(await page.locator('#typing-permission').isVisible(),true);
      await page.locator('#typing-permission').click(); await settled();
      assert.equal(await page.locator('#typing-permission').isVisible(),false);
      assert.match(await page.locator('#typing-status').textContent(),/已启用/);
      check('Mac keyboard permission status and explicit retry');
    }
    await toggle('eyeTracking', false); await number('eyeWarpStrength', 0, 0); await number('eyeWarpStrength', 200, 2); await number('eyeWarpStrength', 137, 1.37);
    await toggle('eyeTracking', true);
    await number('motionAmplitude', 0, 0); await number('motionAmplitude', 200, 2); await number('motionAmplitude', 85, .85);
    await number('motionSpeed', .25); await number('motionSpeed', 3); await number('motionSpeed', 1.35);
    await toggle('hairMotion', false); await toggle('hairMotion', true); await toggle('keyDisplay', false); await toggle('keyDisplay', true);
    // Dispatch the actual input event consistently in Edge and macOS Chrome.
    await page.locator('[name="motionAmplitude"]').evaluate(async input => {
      input.value = '113'; input.dispatchEvent(new Event('input',{bubbles:true}));
      const deadline = performance.now() + 5000;
      while ((await window.elysiaSettings.getState()).settings.motionAmplitude !== 1.13) {
        if (performance.now() > deadline) throw Error('Slider update did not reach host');
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    });
    await settled(); assert.equal(settings.motionAmplitude, 1.13);
    check('sliders and numeric fields route percentage and speed values, extrema and independent toggles');
    await capture('animation-controls');
    await page.getByRole('button', { name: '恢复默认眼睛跟随幅度', exact: true }).click();
    await page.getByRole('button', { name: '恢复默认摆动幅度', exact: true }).click();
    await page.getByRole('button', { name: '恢复默认摆动速度', exact: true }).click(); await settled();
    assert.deepEqual([settings.eyeWarpStrength, settings.motionAmplitude, settings.motionSpeed], [1, 1, 1]);
    check('individual defaults restore each animation parameter');

    await tab('desktop');
    await page.locator('[name="taskbarInFront"][value="true"]').check(); await settled(); assert.equal(settings.taskbarInFront, true);
    await toggle('alwaysOnTop', false); assert.equal(await page.locator('[name="taskbarInFront"]').first().isDisabled(), true);
    await toggle('alwaysOnTop', true); assert.equal(await page.locator('[name="taskbarInFront"]').first().isDisabled(), false);
    await page.locator('[name="taskbarInFront"][value="false"]').check(); await settled(); assert.equal(settings.taskbarInFront, false);
    await toggle('legacyHotkeys', false); await toggle('alternateHotkeys', true);
    await toggle('clickThrough', true);
    await page.locator('[data-recover="false"]').click(); await settled(); assert.equal(settings.clickThrough, false);
    check('taskbar order, topmost, shortcuts and recovery remain usable after click-through');

    for (const [percent, expected] of [[1, .01], [123.5, 1.235], [100000, 1000]]) {
      await page.locator('#scale-percent').fill(String(percent)); await page.locator('#size-form [type="submit"]').click(); await settled(); assert.equal(settings.scale, expected);
    }
    await page.locator('[data-scale="2"]').click(); await settled(); assert.equal(settings.scale, 2);
    await page.locator('[data-resize-factor="1.1"]').click(); await settled(); assert.equal(settings.scale, 2.2);
    await page.locator('[data-resize-factor="0.9090909090909091"]').click(); await settled(); assert.equal(settings.scale, 2);
    await page.locator('[data-recover="true"]').click(); await settled(); assert.equal(settings.scale, 1);
    check('size accepts 1%, fractional and 100000%; presets, adjustments and restore route correctly');
    await capture('desktop-controls');

    await tab('interaction');
    assert.equal(await page.locator('[name="interactionsEnabled"]').isChecked(),true);
    assert.equal(await page.locator('[name="cursorTrailEnabled"]').isChecked(),true);
    const appearanceBeforeInteraction=snapshot().appearance;
    const desktopBeforeInteraction={scale:settings.scale,clickThrough:settings.clickThrough,alwaysOnTop:settings.alwaysOnTop};
    await toggle('interactionsEnabled',false);assert.equal(settings.cursorTrailEnabled,true);
    await toggle('cursorTrailEnabled',false);assert.equal(settings.interactionsEnabled,false);
    await toggle('interactionsEnabled',true);assert.equal(settings.cursorTrailEnabled,false);
    await toggle('cursorTrailEnabled',true);assert.equal(settings.interactionsEnabled,true);
    assert.deepEqual(snapshot().appearance,appearanceBeforeInteraction);
    assert.deepEqual({scale:settings.scale,clickThrough:settings.clickThrough,alwaysOnTop:settings.alwaysOnTop},desktopBeforeInteraction);
    check('interaction and cursor-trail switches default on, save independently, and preserve appearance and desktop settings');

    assert.equal(await page.locator('[name="cursorTrailStyle"]').count(),3);
    assert.equal(await page.locator('[name="cursorTrailStyle"][value="pink"]').isChecked(),true);
    await toggle('cursorTrailEnabled',false); await toggle('interactionsEnabled',false);
    for (const style of ['ribbon','stardust','pink']) {
      const radio=page.locator(`[name="cursorTrailStyle"][value="${style}"]`);
      assert.equal(await radio.isEnabled(),true,'Styles remain selectable while the trail is off');
      await radio.check(); await settled(); assert.equal(settings.cursorTrailStyle,style);
      assert.equal(await page.locator('[name="cursorTrailStyle"]:checked').count(),1);
      assert.equal(settings.cursorTrailEnabled,false);assert.equal(settings.interactionsEnabled,false);
    }
    await page.locator('[name="cursorTrailStyle"][value="pink"]').focus();await page.keyboard.press('ArrowRight');await settled();
    assert.equal(settings.cursorTrailStyle,'ribbon');
    await toggle('cursorTrailEnabled',true);assert.equal(settings.cursorTrailStyle,'ribbon');assert.equal(settings.interactionsEnabled,false);
    await toggle('interactionsEnabled',true);
    assert.deepEqual(snapshot().appearance,appearanceBeforeInteraction);
    check('three trail styles save independently, support keyboard selection while disabled, and survive re-enabling the trail');
    const durationField=page.locator('[name="cursorTrailDurationValue"]');
    assert.equal(await durationField.inputValue(),'0.6');
    assert.equal(await durationField.getAttribute('min'),'0.1');
    assert.equal(await durationField.getAttribute('max'),'5');
    assert.equal(await durationField.getAttribute('step'),'0.1');
    await toggle('cursorTrailEnabled',false);
    assert.equal(await durationField.isEnabled(),true,'Duration remains editable while cursor trail is off');
    await durationField.fill('1.4');await durationField.press('Enter');await settled();assert.equal(settings.cursorTrailDuration,1.4);
    for(const value of [.1,5,1.7])await number('cursorTrailDuration',value);
    await number('cursorTrailDuration',0,.1);await number('cursorTrailDuration',9,5);
    await durationField.fill('');await durationField.press('Tab');await settled();
    assert.equal(await durationField.inputValue(),'5');assert.equal(settings.cursorTrailDuration,5);
    await page.getByRole('button',{name:'恢复默认轨迹保留时间'}).click();await settled();
    assert.equal(settings.cursorTrailDuration,.6);assert.equal(await durationField.inputValue(),'0.6');
    await page.locator('[name="cursorTrailDuration"]').evaluate(slider=>{slider.value='1.3';slider.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    await settled();assert.equal(settings.cursorTrailDuration,1.3);
    assert.equal(settings.cursorTrailEnabled,false);assert.equal(settings.interactionsEnabled,true);assert.equal(settings.cursorTrailStyle,'ribbon');
    await page.reload();await page.waitForSelector('html[data-ready="true"]');await tab('interaction');
    assert.equal(await durationField.inputValue(),'1.3');assert.equal(await page.locator('[name="cursorTrailEnabled"]').isChecked(),false);
    assert.equal(await page.locator('[name="cursorTrailStyle"]:checked').inputValue(),'ribbon');
    await toggle('cursorTrailEnabled',true);assert.equal(settings.cursorTrailDuration,1.3);
    check('trail duration accepts decimals and bounds, restores 0.6 by default, presets while disabled, and survives reopening without changing style or switches');
    await capture('interaction-controls');
    await tab('desktop');

    rejectNext = true;
    await page.locator('[data-scale="2"]').click();
    await page.waitForSelector('#error-message:not([hidden])');
    assert.match(await page.locator('#error-message').textContent(), /simulated save failure/);
    assert.equal(settings.scale, 1);
    await page.locator('[data-scale="2"]').click(); await settled(); assert.equal(settings.scale, 2);
    assert.equal(await page.locator('#error-message').isHidden(), true);
    check('failed save displays error and next valid command recovers');

    settings = sanitizeSettings({ motionAmplitude: .72, motionSpeed: 1.8, eyeWarpStrength: .63, scale: 1.25 }, settings);
    await page.locator('h1').click();
    await page.evaluate(state => window.__settingsQA.publish(state), snapshot());
    assert.equal(await page.locator('#scale-percent').inputValue(), '125');
    await tab('animation');
    assert.equal(await page.locator('[name="motionAmplitudeValue"]').inputValue(), '72');
    assert.equal(await page.locator('[name="motionSpeedValue"]').inputValue(), '1.8');
    assert.equal(await page.locator('[name="eyeWarpStrengthValue"]').inputValue(), '63');
    check('external preference broadcasts keep inactive controls synchronized');

    await tab('voice');
    await page.waitForSelector('html[data-voice-ready="true"]');
    assert.equal(await page.locator('[data-voice-play], [data-voice-simulate], #voice-sample-tools, #voice-category').count(),0);
    assert.deepEqual(await page.evaluate(()=>[typeof window.elysiaSettings.playVoice,typeof window.elysiaSettings.simulateVoice]),['undefined','undefined']);
    assert.doesNotMatch(await page.locator('#panel-voice').textContent(),/试听|模拟触发|本地样本/);
    assert.equal(await page.locator('#voice-stop').isDisabled(),true);
    check('production voice settings have no audition, simulation, sample panel or corresponding bridge');
    await page.locator('#voice-enabled').uncheck();await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().settings.enabled===false);
    assert.match(await page.locator('#voice-playback-status').textContent(),/自动问候已关闭/);
    await page.locator('#voice-dnd').check();await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().settings.dnd===true);
    assert.match(await page.locator('#voice-playback-status').textContent(),/勿扰/);
    await page.locator('#voice-volume').evaluate(input=>{input.value='37';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().settings.volume===.37);
    assert.equal(await page.locator('#voice-volume-value').textContent(),'37%');
    check('normal automatic greeting, DND and volume controls save independently');
    await page.locator('#voice-birthday-month').fill('2');await page.locator('#voice-birthday-day').fill('29');
    await page.locator('#voice-birthday-form [type=submit]').click();await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().settings.birthday==='02-29');
    assert.match(await page.locator('#voice-birthday-hint').textContent(),/闰年/);
    await page.locator('#voice-birthday-day').fill('30');await page.locator('#voice-birthday-form [type=submit]').click();
    assert.equal(await page.locator('#voice-error').isVisible(),true);assert.equal(await page.evaluate(()=>window.__settingsQA.voiceSnapshot().settings.birthday),'02-29');
    await page.locator('#voice-clear-birthday').click();await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().settings.birthday==='');
    assert.equal(await page.locator('#voice-error').isHidden(),true);
    check('birthday accepts leap day, rejects invalid dates without saving, and can be cleared');
    await page.evaluate(()=>window.__settingsQA.publishVoice({playback:{kind:'automatic',status:'playing',lineId:'01-1',text:'早上好，新的一天开始了。'}}));
    assert.match(await page.locator('#voice-playback-status').textContent(),/自动问候/);
    assert.equal(await page.locator('#voice-playback-line').textContent(),'早上好，新的一天开始了。');
    for(const textOnly of [false,true]){
      await page.evaluate(textOnly=>window.__settingsQA.publishVoice({playback:{kind:'interaction',status:'playing',textOnly,text:'嗯，轻轻的就好啦。'}}),textOnly);
      assert.match(await page.locator('#voice-playback-status').textContent(),textOnly?/互动字幕/:/互动语音/);
    }
    await page.locator('#voice-stop').click();await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().playback.status==='idle');
    assert.equal(await page.locator('#voice-stop').isDisabled(),true);
    await page.evaluate(()=>window.__settingsQA.publishVoice({queuedInteraction:{kind:'poke-annoyed',expiresAt:Date.now()+1000}}));
    assert.match(await page.locator('#voice-playback-status').textContent(),/稍后回应/);assert.equal(await page.locator('#voice-stop').isEnabled(),true);
    await page.locator('#voice-stop').click();await page.waitForFunction(()=>window.__settingsQA.voiceSnapshot().queuedInteraction===null);
    check('normal playback displays host text without a catalog; stopping clears active speech and queued interactions');
    await page.evaluate(()=>window.__settingsQA.publishVoice({settings:{enabled:true,dnd:false,volume:.8,birthday:''},interactionAvailable:false,interactionError:'互动录音暂不可用，文字回应保留。'}));
    assert.equal(await page.locator('#voice-interaction-error').isVisible(),true);
    await page.evaluate(()=>window.__settingsQA.publishVoice({interactionAvailable:true,interactionError:null,environment:{monitorReady:false}}));
    assert.equal(await page.locator('#voice-interaction-error').isHidden(),true);assert.match(await page.locator('#voice-playback-status').textContent(),/暂未就绪/);
    for(const [field,description] of [['locked','锁屏'],['suspended','休眠'],['fullscreen','全屏']]){
      await page.evaluate(field=>window.__settingsQA.publishVoice({environment:{monitorReady:true,[field]:true}}),field);
      assert.match(await page.locator('#voice-playback-status').textContent(),new RegExp(description));
    }
    await page.evaluate(()=>window.__settingsQA.publishVoice({environment:{monitorReady:true,locked:false,suspended:false,fullscreen:false}}));
    check('normal voice status explains quiet desktop states and missing interaction recordings without test actions');
    await capture('voice-controls');

    await page.locator('[data-tab="animation"]').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-tab="desktop"]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('[data-tab="interaction"]').getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('[data-tab="voice"]').getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('[data-tab="appearance"]').getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('[data-tab="voice"]').getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home'); assert.equal(await page.locator('[data-tab="appearance"]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End'); assert.equal(await page.locator('[data-tab="voice"]').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('[role=tab][tabindex="0"]').count(),1);
    assert.equal(await page.locator('[role=tabpanel]:visible').count(),1);
    check('five-tab keyboard navigation supports both arrows, wraparound, Home and End with one active panel');

    await page.setViewportSize({ width: 500, height: 500 });
    for (const name of ['appearance', 'animation', 'desktop', 'interaction', 'voice']) { await tab(name); await layout(`minimum client layout: ${name}`); await capture(`${name}-compact`); }
    await tab('interaction');
    await page.locator('.trail-styles').scrollIntoViewIfNeeded();
    const compactStyleCards=await page.locator('.trail-style-card').evaluateAll(cards=>cards.map(card=>({right:card.getBoundingClientRect().right,contentWidth:card.scrollWidth,width:card.clientWidth})));
    for(const card of compactStyleCards){assert.ok(card.right<=500);assert.ok(card.contentWidth<=card.width);}
    await capture('interaction-trail-styles-compact',false);
    check('all three preview cards fit the 500px settings window');
    await page.locator('.trail-duration').scrollIntoViewIfNeeded();
    const compactDuration=await page.locator('.trail-duration').evaluate(node=>({right:node.getBoundingClientRect().right,contentWidth:node.scrollWidth,width:node.clientWidth}));
    assert.ok(compactDuration.right<=500&&compactDuration.contentWidth<=compactDuration.width);
    assert.equal(await durationField.isVisible(),true);await capture('interaction-trail-duration-compact',false);
    check('duration number field, unit and slider fit the 500px settings window');
    await page.setViewportSize({ width: 900, height: 800 }); await tab('appearance'); await layout('large window layout'); await capture('appearance-large');
    assert.deepEqual(errors, []); check('no uncaught page errors');
    report.calls = calls; report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, screenshots: report.screenshots, error: report.error || null, report: path.join(output, 'report.json') }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });

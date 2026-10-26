'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

// Invoked only by the isolated, hidden --smoke-test profile. No global input.
async function checkSettingsWindow({ window: pet, getState, settingsFile, buildMenu, settingsWindow, updateSettings, action, ipcMain }) {
  assert.equal(pet.isVisible(), false, 'Settings smoke must keep the pet hidden');
  assert.match(path.basename(path.dirname(settingsFile)), /smoke/, 'Settings smoke may only write to an isolated smoke profile');
  const original = structuredClone(getState());
  const originalBounds = pet.getBounds(), originalUrl = pet.webContents.getURL(), originalId = pet.webContents.id;
  const appearanceOf = value => ({ expression:value.expression??null,pose:value.pose??'idle',cat:value.cat===true,glasses:value.glasses===true });
  const originalAppearance = appearanceOf(original.appearance || await pet.webContents.executeJavaScript('window.elysiaPreview.snapshot()'));
  await pet.webContents.executeJavaScript('window.__settingsSmokeCanvas = document.querySelector("#pet"); true');
  const records = [];
  let panel, observedUnsubscribe;
  const poll = async (description, read, matches) => {
    const deadline = Date.now() + 7000; let latest;
    do {
      assert.equal(pet.isVisible(), false, 'Settings checks must not reveal the hidden pet');
      latest = await read(); if (matches(latest)) return latest;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail(`${description} did not settle: ${JSON.stringify(latest)}`);
  };
  const readSaved = async () => {
    try { return JSON.parse(await fs.readFile(settingsFile, 'utf8')).settings; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const petSnapshot = () => pet.webContents.executeJavaScript(`(() => {
    const state=window.elysiaPreview.snapshot();
    return { settings:window.elysiaPreview.settings(), appearance:{expression:state.expression,pose:state.pose,cat:state.cat,glasses:state.glasses},
      sameCanvas:document.querySelector('#pet')===window.__settingsSmokeCanvas,canvasCount:document.querySelectorAll('canvas').length,
      settingsBridge:typeof window.elysiaSettings,node:typeof window.require };
  })()`);
  const verifyPet = async (description, compareAppearance = true, comparePosition = true) => {
    assert.equal(pet.isDestroyed(), false, `${description}: pet stays alive`);
    assert.equal(pet.webContents.id, originalId, `${description}: original pet webContents remains`);
    assert.equal(pet.webContents.getURL(), originalUrl, `${description}: pet never navigates to settings`);
    if (comparePosition) assert.deepEqual(pet.getBounds(), originalBounds, `${description}: settings window never moves or resizes the pet`);
    const value = await petSnapshot();
    assert.equal(value.sameCanvas, true, `${description}: original canvas remains mounted`);
    assert.equal(value.canvasCount, 1, `${description}: pet retains its single canvas`);
    assert.equal(value.settingsBridge, 'undefined', `${description}: settings bridge stays out of pet window`);
    assert.equal(value.node, 'undefined');
    if (compareAppearance) assert.deepEqual(value.appearance, originalAppearance, `${description}: opening or editing settings does not reset appearance`);
  };
  const preparePanel = async target => {
    panel = target;
    assert.equal(panel.isVisible(), false, 'Settings window stays hidden during smoke');
    await poll('settings UI initialization', () => panel.webContents.executeJavaScript(`({ready:document.documentElement.dataset.ready,bridge:typeof window.elysiaSettings})`),
      value => value.ready === 'true' && value.bridge === 'object');
    const preferences = panel.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    const isolation = await panel.webContents.executeJavaScript(`({petBridge:typeof window.elysiaDesktop,node:typeof window.require})`);
    assert.deepEqual(isolation, {petBridge:'undefined',node:'undefined'});
    const tabIds = await panel.webContents.executeJavaScript("[...document.querySelectorAll('[role=tab]')].map(tab=>tab.dataset.tab)");
    assert.deepEqual(tabIds, ['appearance','animation','desktop','interaction','voice'], 'Settings exposes five independent categories');
    const voiceSurface=await panel.webContents.executeJavaScript("({auditions:document.querySelectorAll('[data-voice-play], [data-voice-simulate], #voice-sample-tools, #voice-category').length,play:typeof window.elysiaSettings.playVoice,simulate:typeof window.elysiaSettings.simulateVoice,stop:typeof window.elysiaSettings.stopVoice,preferences:typeof window.elysiaSettings.setVoiceSettings})");
    assert.deepEqual(voiceSurface,{auditions:0,play:'undefined',simulate:'undefined',stop:'function',preferences:'function'},'Production voice UI retains preferences and stop without audition or simulation entrypoints');
    assert.equal(panel.isMovable(), true); assert.equal(panel.isResizable(), true); assert.equal(panel.getParentWindow(), null);
    const outer=panel.getBounds(),content=panel.getContentBounds();
    assert.ok(outer.height-content.height<=4,'Frameless settings must not reserve a native title bar');
    assert.ok(content.y-outer.y<=4,'Settings content begins without a native title bar');
    const windowState = await panel.webContents.executeJavaScript('window.elysiaSettings.getWindowState()');
    assert.deepEqual(windowState,{maximized:false},'Hidden settings exposes its real native maximized state');
    observedUnsubscribe = await panel.webContents.executeJavaScript(`(() => {
      window.__settingsSmokeState=null;
      window.__settingsSmokeUnsubscribe=window.elysiaSettings.onState(state=>{window.__settingsSmokeState=state;});
      window.__settingsSmokeWindowState=null;
      window.__settingsSmokeWindowUnsubscribe=window.elysiaSettings.onWindowState(state=>{window.__settingsSmokeWindowState=state;});
      return true;
    })()`);
  };
  const panelSnapshot = () => panel.webContents.executeJavaScript(`(async()=>({state:await window.elysiaSettings.getState(),observed:window.__settingsSmokeState}))()`);
  const request = (method, argument) => panel.webContents.executeJavaScript(`window.elysiaSettings.${method}(${JSON.stringify(argument)})`);
  const verifySettings = async (description, expected) => {
    await poll(`${description}: host`, () => getState().settings, value => isDeepStrictEqual(value, expected));
    await poll(`${description}: panel broadcast`, panelSnapshot, value => isDeepStrictEqual(value.state.settings, expected)
      && isDeepStrictEqual(value.observed?.settings, expected));
    await poll(`${description}: pet renderer`, petSnapshot, value => isDeepStrictEqual(value.settings, expected));
    await poll(`${description}: persisted preferences`, readSaved, value => isDeepStrictEqual(value, expected));
    assert.equal(panel.isVisible(), false, `${description}: hidden settings remains hidden`);
    records.push({description,settings:structuredClone(expected)});
  };
  const waitAppearance = async (description, expected) => {
    await poll(`${description}: pet appearance`, petSnapshot, value => isDeepStrictEqual(value.appearance, expected));
    await poll(`${description}: panel appearance`, panelSnapshot, value => isDeepStrictEqual(appearanceOf(value.state.appearance),expected)
      && value.observed?.appearance && isDeepStrictEqual(appearanceOf(value.observed.appearance),expected));
  };
  try {
    const menu = buildMenu();
    assert.deepEqual(menu.items.map(item => item.label), ['设置', '退出'], 'Native tray contains exactly settings and exit');
    assert.ok(menu.items.every(item => item.enabled && !item.submenu), 'Both tray actions are directly available');
    menu.items[0].click(menu.items[0], pet, {});
    await preparePanel(await settingsWindow.open());
    const firstId = panel.id;
    assert.equal((await settingsWindow.open()).id, firstId, 'Repeated open reuses one settings window');
    assert.equal(settingsWindow.getWindow().id, firstId);
    ipcMain.emit('settings:window-control',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame},'close');
    ipcMain.emit('settings:window-control',{sender:panel.webContents,senderFrame:{url:settingsWindow.url}},'close');
    ipcMain.emit('settings:window-control',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame},'toggle-maximize');
    ipcMain.emit('settings:window-control',{sender:panel.webContents,senderFrame:{url:settingsWindow.url}},'toggle-maximize');
    ipcMain.emit('settings:window-control',{sender:panel.webContents,senderFrame:panel.webContents.mainFrame},'quit');
    assert.equal(panel.isDestroyed(),false,'Pet, subframes and invalid commands cannot close the settings window');
    assert.equal(panel.isMaximized(),false,'Untrusted senders cannot maximize the settings window');
    await poll('window state broadcast on reopen',()=>panel.webContents.executeJavaScript('window.__settingsSmokeWindowState'),value=>value?.maximized===false);
    await verifyPet('open and reopen settings');
    const before = panel.getBounds();
    panel.setPosition(before.x + 37, before.y + 29, false);
    assert.ok(panel.getBounds().x !== before.x || panel.getBounds().y !== before.y, 'Independent settings window can move');
    await verifyPet('move independent settings');
    panel.setSize(before.width + 24, before.height + 24, false);
    await verifyPet('resize independent settings');

    let expected = {...getState().settings,motionAmplitude:.85,motionSpeed:1.25,eyeWarpStrength:1.5,eyeTracking:false,idleMoods:false,neglectMinutes:3,deviceIdleMinutes:7};
    const response = await request('setSettings',{motionAmplitude:.85,motionSpeed:1.25,eyeWarpStrength:1.5,eyeTracking:false,idleMoods:false,neglectMinutes:3,deviceIdleMinutes:7});
    assert.deepEqual(response.settings,expected,'Settings bridge returns accepted preferences');
    await verifySettings('settings bridge custom controls',expected);
    await verifyPet('change independent controls');
    expected={...expected,motionAmplitude:2,motionSpeed:3,eyeWarpStrength:0};
    updateSettings({motionAmplitude:2,motionSpeed:3,eyeWarpStrength:0});
    await verifySettings('external host preference broadcast',expected);

    await panel.webContents.executeJavaScript("document.querySelector('[data-tab=interaction]').click(); true");
    for (const patch of [
      {interactionsEnabled:false,cursorTrailEnabled:true},
      {interactionsEnabled:false,cursorTrailEnabled:false},
      {interactionsEnabled:true,cursorTrailEnabled:false},
    ]) {
      expected = {...expected,...patch};
      await panel.webContents.executeJavaScript(`(() => {
        const patch=${JSON.stringify(patch)};
        for (const [key,value] of Object.entries(patch)) {
          const input=document.querySelector('[data-setting="'+key+'"]');
          if(input.checked!==value)input.click();
        }
        return true;
      })()`);
      await verifySettings('interaction and cursor-trail switches save independently',expected);
      const checked = await panel.webContents.executeJavaScript("({interactionsEnabled:document.querySelector('[name=interactionsEnabled]').checked,cursorTrailEnabled:document.querySelector('[name=cursorTrailEnabled]').checked})");
      assert.deepEqual(checked,patch,'The settings controls reflect both independently saved values');
    }
    const styleChoices = await panel.webContents.executeJavaScript("[...document.querySelectorAll('[name=cursorTrailStyle]')].map(input=>({value:input.value,disabled:input.disabled}))");
    assert.deepEqual(styleChoices,[{value:'pink',disabled:false},{value:'ribbon',disabled:false},{value:'stardust',disabled:false}], 'All three styles stay selectable while cursor trail is off');
    for (const style of ['pink','ribbon','stardust']) {
      expected={...expected,cursorTrailStyle:style};
      await panel.webContents.executeJavaScript(`document.querySelector('[name="cursorTrailStyle"][value="${style}"]').click(); true`);
      await verifySettings('cursor-trail style saves while the trail is disabled',expected);
      assert.equal(getState().settings.cursorTrailEnabled,false,'Selecting a style does not enable cursor trail');
      assert.equal(getState().settings.interactionsEnabled,true,'Selecting a style does not change click interactions');
      const selectedStyle=await panel.webContents.executeJavaScript("document.querySelector('[name=cursorTrailStyle]:checked')?.value");
      assert.equal(selectedStyle,style);
    }
    const durationAttributes=await panel.webContents.executeJavaScript("(() => {const input=document.querySelector('[name=cursorTrailDurationValue]');return {disabled:input.disabled,min:input.min,max:input.max,step:input.step}})()");
    assert.deepEqual(durationAttributes,{disabled:false,min:'0.1',max:'5',step:'0.1'},'Trail duration accepts decimal seconds while the trail is off');
    for(const duration of [.1,5,1.7]) {
      expected={...expected,cursorTrailDuration:duration};
      await panel.webContents.executeJavaScript(`(() => {const input=document.querySelector('[name=cursorTrailDurationValue]');input.value='${duration}';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await verifySettings('cursor-trail duration saves through UI, IPC and disk',expected);
      assert.equal(getState().settings.cursorTrailEnabled,false);assert.equal(getState().settings.interactionsEnabled,true);assert.equal(getState().settings.cursorTrailStyle,'stardust');
    }
    await panel.webContents.executeJavaScript("document.querySelector('[aria-label=\"恢复默认轨迹保留时间\"]').click(); true");
    expected={...expected,cursorTrailDuration:.6};await verifySettings('duration default button restores 0.6 seconds',expected);
    await panel.webContents.executeJavaScript("(() => {const input=document.querySelector('[name=cursorTrailDurationValue]');input.value='1.3';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    expected={...expected,cursorTrailDuration:1.3};await verifySettings('decimal duration persists while the trail stays off',expected);
    await verifyPet('independent interaction settings');

    const tea={...originalAppearance,pose:'tea'};
    await request('action',{type:'pose',id:'tea'});await waitAppearance('settings action selects tea',tea);
    const heart={...tea,expression:'heart'};
    if(tea.expression==='heart')await request('action',{type:'expression',id:'heart'});
    await request('action',{type:'expression',id:'heart'});await waitAppearance('settings action selects heart',heart);
    const smile={...heart,expression:'smile'};
    action({type:'expression',id:'smile'});await waitAppearance('external hotkey action selects smile',smile);
    assert.equal((await panelSnapshot()).state.appearance.pose,'tea','Changing expression retains the selected pose');
    await verifyPet('expression actions',false);

    expected={...getState().settings,clickThrough:true};await request('setSettings',{clickThrough:true});
    await verifySettings('click-through enabled',expected);
    assert.equal(panel.isFocusable(),true,'Settings remains independently focusable while pet ignores clicks');
    expected={...expected,eyeTracking:true,eyeWarpStrength:2};await request('setSettings',{eyeTracking:true,eyeWarpStrength:2});
    await verifySettings('controls still work during click-through',expected);
    await request('recover',false);expected={...expected,clickThrough:false};
    await verifySettings('recover restores pet interaction',expected);
    await verifyPet('recover through settings',false,false);

    const closed = new Promise(resolve => panel.once('closed',resolve));
    // send(), rather than invoke(), lets the renderer close without waiting for a reply from its destroyed frame.
    await panel.webContents.executeJavaScript("window.elysiaSettings.windowControl('close'); true");
    await closed;
    assert.equal(settingsWindow.getWindow(),null,'Closing settings releases only its window');
    await verifyPet('close settings',false,false);
    await preparePanel(await settingsWindow.open());
    assert.notEqual(panel.id,firstId,'Closing and reopening creates one fresh settings window');
    assert.equal((await settingsWindow.open()).id,panel.id,'Reopened settings is still a singleton');
    assert.deepEqual((await panelSnapshot()).state.settings,expected,'Reopened settings retains saved controls');
    const reopenedInteractionSettings = await panel.webContents.executeJavaScript("({interactionsEnabled:document.querySelector('[name=interactionsEnabled]').checked,cursorTrailEnabled:document.querySelector('[name=cursorTrailEnabled]').checked})");
    assert.deepEqual(reopenedInteractionSettings,{interactionsEnabled:expected.interactionsEnabled,cursorTrailEnabled:expected.cursorTrailEnabled},'Reopened controls retain the independently saved interaction switches');
    assert.equal(await panel.webContents.executeJavaScript("document.querySelector('[name=cursorTrailStyle]:checked')?.value"),expected.cursorTrailStyle,'Reopening settings restores the saved trail style');
    assert.equal(await panel.webContents.executeJavaScript("document.querySelector('[name=cursorTrailDurationValue]').valueAsNumber"),expected.cursorTrailDuration,'Reopening settings restores the saved decimal trail duration');
    assert.deepEqual(appearanceOf((await panelSnapshot()).state.appearance),smile,'Reopened settings retains current pet appearance');
    records.push({description:'move/resize/close/reopen preserve the independent pet',firstId,reopenedId:panel.id});
  } finally {
    // Restore the smoke profile, including persisted skin choices changed by reset.
    if(panel&&!panel.isDestroyed()) {
      action('reset');
      await poll('restore base appearance',petSnapshot,value=>value.appearance.expression===null&&value.appearance.pose==='idle'&&!value.appearance.cat&&!value.appearance.glasses);
      if(originalAppearance.pose!=='idle')action({type:'pose',id:originalAppearance.pose});
      if(originalAppearance.expression)action({type:'expression',id:originalAppearance.expression});
      for(const id of ['cat','glasses'])if(originalAppearance[id])action({type:'toggle-skin',id});
      await poll('restore original appearance',petSnapshot,value=>isDeepStrictEqual(value.appearance,originalAppearance));
      updateSettings(original.settings);
      await verifySettings('restore original settings',original.settings);
      if(observedUnsubscribe)await panel.webContents.executeJavaScript('window.__settingsSmokeUnsubscribe?.(); window.__settingsSmokeWindowUnsubscribe?.(); true');
      const closed=new Promise(resolve=>panel.once('closed',resolve));panel.close();await closed;
    } else updateSettings(original.settings);
    assert.equal(pet.isDestroyed(),false);assert.equal(pet.isVisible(),false);
  }
  return {checks:records,trayOnlySettingsAndExit:true,independentMovableWindow:true,frameless:true,customCloseKeepsPet:true,windowControlSenderValidation:true,windowStateBridge:true,maximizeNotInvokedWhileHidden:true,singletonReopen:true,petCanvasAndUrlPreserved:true,
    isolatedSettingsBridge:true,ipcAndPersistence:true,interactionSwitchPersistence:true,cursorTrailStylePersistence:true,cursorTrailDurationPersistence:true,productionVoiceControlsOnly:true,fiveSettingsTabs:true,externalActionSync:true,clickThroughRecovery:true,hiddenThroughout:true,
    originalSettingsAndAppearanceRestored:true,syntheticGlobalInput:false};
}
module.exports={checkSettingsWindow};

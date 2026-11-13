// Independent transparent Electron host. Character animation lives entirely in the local renderer.
'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, globalShortcut, session, powerMonitor, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { DEFAULT_SETTINGS, EXPRESSION_KEYS, SKIN_KEYS, POSE_KEYS, sanitizeAppearance, sanitizeSettings, freeBounds, restoreBounds, recoverBounds, actionForKey, isLocalResource, sameWindowsDirectory } = require('./host-policy.cjs');
const { createTrayImage, createAppImage } = require('./tray-icon.cjs');
const {createDesktopPointer,POINTER_INTERVAL_MS,DRAG_INTERVAL_MS}=require('./desktop-pointer.cjs');
const {createDragLifecycle}=require('./drag-lifecycle.cjs');
const {createTopmostController}=require('./window-layer.cjs');
const {createWindowShape}=require('./window-shape.cjs');
const {virtualBounds,planViewport,viewportSnapshot,zoomAt,zoomFromSteps,sanitizeCharacterRegion,projectHitRegion}=require('./pet-viewport.cjs');
const {trayTemplate}=require('./tray-menu.cjs');
const {createViewportChannel}=require('./viewport-channel.cjs');
const {createTypedKeyListener}=require('./typed-key-listener.cjs');
const {createLegacyHotkeyListener}=require('./legacy-hotkey-listener.cjs');
const {createSettingsWindow}=require('./settings-window.cjs');
const {settingsAction,isSettingsSender}=require('./settings-policy.cjs');
const {createVoiceController}=require('./voice-controller.cjs');
const {createCursorTrail}=require('./cursor-trail.cjs');
const {migrateSampleProfile}=require('./profile-migration.cjs');
const {createChatService}=require('./chat-service.cjs');
const {createChatWindow}=require('./chat-window.cjs');
const {registerChatIpc}=require('./chat-ipc.cjs');
const {createChatSpeech,getChatSpeechBlockReason}=require('./chat-speech.cjs');
const {createModelSetup}=require('./model-setup.cjs');
const {registerModelSetupIpc}=require('./model-setup-ipc.cjs');
const {createVoiceSetup}=require('./voice-setup.cjs');
const {createFirstRunSetup,managedChatEndpoint}=require('./first-run-setup.cjs');
const {createQuickChatWindow}=require('./quick-chat-window.cjs');
const {createQuickChatShortcut}=require('./quick-chat-shortcut.cjs');
const {createQuickChatController,ensureQuickChatReady}=require('./quick-chat-controller.cjs');
const {registerQuickChatIpc}=require('./quick-chat-ipc.cjs');
const {createQuitCoordinator}=require('./quit-coordinator.cjs');
const {createRendererRecovery}=require('./renderer-recovery.cjs');

const root = path.resolve(__dirname, '..');
const rendererUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
const smokeNativeHotkeys = process.argv.includes('--smoke-native-hotkeys');
const isVoiceSmoke = process.argv.includes('--voice-smoke-test');
const isInteractionSmoke = process.argv.includes('--interaction-smoke-test');
const isChatSmoke = process.argv.includes('--chat-smoke-test');
const isQuickChatSmoke = process.argv.includes('--quick-chat-smoke-test');
const isLocalPreview = process.argv.includes('--local-preview');
const isPortableRelaunchSmoke = process.argv.includes('--portable-relaunch-smoke-test');
const isSmokeTest = process.argv.includes('--smoke-test') || smokeNativeHotkeys || isVoiceSmoke || isInteractionSmoke || isChatSmoke || isQuickChatSmoke || isPortableRelaunchSmoke;
const portableRelaunchInstances = [];
if (isSmokeTest) app.commandLine.appendSwitch('mute-audio');
if (isLocalPreview) { process.env.HF_HUB_OFFLINE = '1'; process.env.TRANSFORMERS_OFFLINE = '1'; }
const voiceTestHooks = isSmokeTest ? {} : undefined;
// Keep production preferences across upgrades; smoke tests use an isolated profile.
app.setName('爱莉希雅桌宠');
app.setAppUserModelId('io.actorf.elysia.standalonepet');
app.setPath('userData', isSmokeTest
  ? path.join(app.getPath('temp'), isQuickChatSmoke ? 'elysia-pet-quick-chat-smoke' : isPortableRelaunchSmoke ? 'elysia-pet-portable-relaunch-smoke' : isChatSmoke ? 'elysia-pet-chat-smoke' : isVoiceSmoke ? 'elysia-pet-voice-smoke' : isInteractionSmoke ? 'elysia-pet-interaction-smoke' : 'elysia-pet-host-smoke')
  : path.join(app.getPath('appData'), 'Elysia Desktop Pet'));
let voices, cursorTrail, chat, chatWindow, chatSpeech, chatSpeechTestHooks, modelSetup, voiceSetup, firstRunSetup;
let quickChat, quickChatWindow, quickChatShortcut, quickChatIpc, speechTarget = 'chat';
let lastChatSettings = null;
let pet, tray, settingsWindow, settingsFile, pointerTimer, saveTimer, desktopPointer, dragLifecycle, topmost, windowShape, legacyListener, typingListener, petRecovery;
let preferences = { ...DEFAULT_SETTINGS };
let appearance = sanitizeAppearance();
let savedPosition = null;
let settingsStorageError = null;
let protectedSettingsFile = false;
let characterBounds=null,viewport=null,logicalHitRegion=null,logicalHitRevision=0,projectedHitKey=null;
let lastNativeTargetKey=null;
const viewportChannel=createViewportChannel(payload=>send('pet:viewport',payload));
let quitting = false;
const hotkeys = { legacy: { active: false, error: null }, alternate: { active: false, failed: [] }, typing: { active: false, error: null }, recovery: false };

function state() { return { settings: { ...preferences }, appearance: { ...appearance }, hotkeys: structuredClone(hotkeys), viewport:viewport?{...viewport}:null, storageError: settingsStorageError }; }
function send(channel, data) {
  if (pet && !pet.isDestroyed() && !pet.webContents.isDestroyed() && !petRecovery?.isFailed()) pet.webContents.send(channel, data);
}
function publishSettings() { const snapshot=state();send('pet:settings',snapshot);settingsWindow?.publish(snapshot); }
function chatState() { return { ...chat.getState(), speech: chatSpeech?.getState() ?? { status: 'idle', error: null } }; }
function publishChat() {
  if (!chat) return;
  const snapshot = chatState();
  chatWindow?.publish(snapshot);
  quickChat?.changed();
  const panel = settingsWindow?.getWindow();
  if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('settings:chat-state', snapshot);
}
function action(typeOrAction) { send('pet:action', typeof typeOrAction === 'string' ? { type: typeOrAction } : typeOrAction); }
function pollPointer(dragging=false) {
  clearInterval(pointerTimer);
  if(quitting||!pet||pet.isDestroyed())return;
  // Capture turns between display frames; the trail still batches IPC at 16ms.
  const interval=dragging?DRAG_INTERVAL_MS:preferences.cursorTrailEnabled?8:POINTER_INTERVAL_MS;
  pointerTimer=setInterval(()=>{
    if(pet&&!pet.isDestroyed()) {
      const point=screen.getCursorScreenPoint();
      desktopPointer.sample(point);
      if(!isSmokeTest)cursorTrail?.sample({...point,sampledAt:Date.now()});
    }
  },interval);
}
function placePet(position) {
  // Keep the configured DIP size. Recycling getBounds() through setPosition()
  // can progressively enlarge a frameless window at fractional Windows DPI.
  characterBounds=virtualBounds(position,preferences.scale);
  const planned=planViewport(characterBounds,screen.getAllDisplays());
  const target=freeBounds(planned.native);
  const to=screen.getDisplayMatching(target),nativeKey=JSON.stringify([target,to.id,to.scaleFactor]);
  if(nativeKey!==lastNativeTargetKey){
    pet.setBounds(target,false);
    const actual=pet.getBounds(),from=screen.getDisplayMatching(actual);
    if(from.id!==to.id&&Math.abs(from.scaleFactor-to.scaleFactor)>.01
      &&(Math.abs(actual.x-target.x)>2||Math.abs(actual.y-target.y)>2)){
      // Electron can retain the previous monitor's DPI conversion at a seam.
      pet.setBounds(freeBounds({...target,x:target.x+2*(target.x-actual.x),y:target.y+2*(target.y-actual.y)}),false);
      pet.setBounds(target,false);
    }
    lastNativeTargetKey=nativeKey;
  }
  const content=pet.getContentBounds();
  const previous=viewport;
  viewport=viewportSnapshot(characterBounds,content,planned.clipped);
  if(!previous||['width','height','characterX','characterY','characterWidth','characterHeight','clipped'].some(key=>previous[key]!==viewport[key]))viewportChannel.publish(viewport);
  applyHitRegion();
  voices?.reposition();
}
function writeSettings() {
  if (!settingsFile || protectedSettingsFile) return;
  const previousError = settingsStorageError;
  try {
    const bounds = characterBounds ?? savedPosition;
    const payload = { settings: preferences, position: bounds ? { x: bounds.x, y: bounds.y } : null };
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(payload, null, 2));
    fs.renameSync(settingsFile + '.tmp', settingsFile);
    settingsStorageError = null;
  } catch {
    settingsStorageError = '设置已生效，但未能保存；请检查磁盘空间与用户目录权限，再调整设置重试。';
  }
  if (!quitting && previousError !== settingsStorageError) publishSettings();
}
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 120);
}
function loadSettings() {
  try {
    const stored = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(settingsFile)));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('invalid-settings');
    if (Object.hasOwn(stored, 'settings') && (!stored.settings || typeof stored.settings !== 'object' || Array.isArray(stored.settings))) throw new Error('invalid-settings');
    preferences = sanitizeSettings(stored.settings);
    if (stored.position && Number.isFinite(stored.position.x) && Number.isFinite(stored.position.y)) savedPosition = stored.position;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      protectedSettingsFile = true;
      settingsStorageError = '设置读取失败，原文件已保留且不会覆盖。当前调整仅本次生效；请修复用户目录中的 settings.json 后重新启动。';
    }
  }
  // A fresh launch is always interactive; the tray can re-enable click-through.
  preferences.clickThrough = false;
}
function recover(resetScale = false) {
  if (!pet || pet.isDestroyed() || quitting) return;
  if (petRecovery?.isFailed()) {
    const owner = pet;
    void petRecovery.recover().then(restored => { if (restored && pet === owner && !quitting) recover(resetScale); })
      .catch(error => console.error('Could not restore pet renderer:', error.message));
    return;
  }
  updateSettings({ clickThrough: false, ...(resetScale?{scale:1}:{}) });
  dragLifecycle?.cancelDrag();
  if (pet.isMinimized()) pet.restore();
  placePet(recoverBounds(characterBounds??pet.getBounds(), screen.getAllDisplays(),bounds=>bounds));
  if (!isSmokeTest) { pet.show(); pet.focus(); }
}
function updateSettings(patch, anchor) {
  const previous = preferences;
  preferences = sanitizeSettings(patch && typeof patch === 'object' ? patch : {}, preferences);
  if (pet && !pet.isDestroyed()) {
    // Store the chosen taskbar order before enabling topmost, including reloads.
    topmost?.setTaskbarInFront(preferences.taskbarInFront);
    topmost?.setEnabled(preferences.alwaysOnTop);
    if (preferences.clickThrough) dragLifecycle?.endDrag();
    pet.setIgnoreMouseEvents(preferences.clickThrough, { forward: true });
    if (preferences.scale !== previous.scale) {
      const old = characterBounds??pet.getBounds();
      const {bounds}=zoomAt(old,previous.scale,preferences.scale,anchor);
      dragLifecycle?.cancelDrag();
      placePet(bounds);
    }
  }
  if (preferences.legacyHotkeys !== previous.legacyHotkeys) configureLegacyHotkeys();
  if (preferences.alternateHotkeys !== previous.alternateHotkeys) configureAlternateHotkeys();
  if (preferences.keyDisplay !== previous.keyDisplay) configureTypedKeys();
  if (preferences.interactionsEnabled !== previous.interactionsEnabled) voices?.preferencesChanged();
  if (preferences.cursorTrailEnabled !== previous.cursorTrailEnabled) {
    cursorTrail?.setEnabled(preferences.cursorTrailEnabled);
    if (desktopPointer) pollPointer(desktopPointer.dragging);
  }
  if (preferences.cursorTrailStyle !== previous.cursorTrailStyle) cursorTrail?.setStyle(preferences.cursorTrailStyle);
  if (preferences.cursorTrailDuration !== previous.cursorTrailDuration) cursorTrail?.setDuration(preferences.cursorTrailDuration);
  saveSettings();
  publishSettings();
  voices?.reposition();
  return state();
}

function resizePet(scale) {
  const bounds=viewport?.clipped?pet?.getContentBounds():characterBounds;
  return updateSettings({scale},bounds?{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}:null);
}
function zoomPet(input) {
  if(!input||!Number.isFinite(input.steps)||!pet||pet.isDestroyed())return state();
  const bounds=pet.getContentBounds();
  const anchor=Number.isFinite(input.anchorX)&&Number.isFinite(input.anchorY)
    ?{x:bounds.x+input.anchorX,y:bounds.y+input.anchorY}:screen.getCursorScreenPoint();
  const next=zoomFromSteps(characterBounds??bounds,preferences.scale,input.steps,anchor);
  return updateSettings({scale:next.scale},anchor);
}

function applyHitRegion() {
  if(!logicalHitRegion||!viewport)return windowShape?.refresh();
  const key=JSON.stringify([logicalHitRevision,viewport.width,viewport.height,viewport.characterX,viewport.characterY,viewport.characterWidth,viewport.characterHeight]);
  if(projectedHitKey===key)return windowShape?.refresh();
  const applied=windowShape?.update(projectHitRegion(logicalHitRegion,viewport))??false;
  if(applied)projectedHitKey=key;
  return applied;
}

function configureTypedKeys() {
  if (!typingListener) {
    let script = path.join(__dirname, 'typed-keys.ps1');
    if (app.isPackaged) script = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    typingListener = createTypedKeyListener({
      spawn, script,
      onCharacter: character => { if (preferences.keyDisplay && !quitting) send('pet:typed-key', character); },
      onStatus: value => { hotkeys.typing = value; if (!quitting) publishSettings(); },
    });
  }
  typingListener.start(preferences.keyDisplay);
}

function configureLegacyHotkeys() {
  if (!legacyListener) {
    let script = path.join(__dirname, 'legacy-hotkeys.ps1');
    if (app.isPackaged) script = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    legacyListener = createLegacyHotkeyListener({ spawn, script,
      onAction: value => { if (preferences.legacyHotkeys && !quitting) action(value); },
      onStatus: value => { hotkeys.legacy = value; if (!quitting) publishSettings(); },
    });
  }
  legacyListener.start(preferences.legacyHotkeys);
}

const alternateBindings = [];
function configureAlternateHotkeys() {
  for (const binding of alternateBindings.splice(0)) globalShortcut.unregister(binding);
  hotkeys.alternate = { active: false, failed: [] };
  if (!preferences.alternateHotkeys) return;
  for (const key of [...Object.keys(EXPRESSION_KEYS), ...Object.keys(SKIN_KEYS), ...Object.keys(POSE_KEYS), 'Backspace']) {
    const accelerator = `CommandOrControl+Alt+${key}`;
    try {
      if (globalShortcut.register(accelerator, () => action(actionForKey(key)))) alternateBindings.push(accelerator);
      else hotkeys.alternate.failed.push(accelerator);
    } catch { hotkeys.alternate.failed.push(accelerator); }
  }
  hotkeys.alternate.active = alternateBindings.length > 0;
}

function requestQuit() {
  // release() synchronously clears the voice controller's external busy flag.
  // Preserve ongoing activity so stopping it to exit cannot start a farewell.
  let skipFarewell = true;
  finishEachCleanup([
    () => { skipFarewell = Boolean(chatSpeech?.isActive()); },
    () => quickChat?.interrupt(), () => chat?.cancel(), () => chatSpeech?.release(),
  ]);
  try { return voices ? voices.requestQuit({ skipFarewell }) : app.quit(); }
  catch (error) {
    console.error('Could not prepare farewell:', error?.message);
    return app.quit();
  }
}
function prepareSessionEnd() {
  // Windows can abandon shutdown after querying us. Stop current work without
  // permanently disposing services; session-end/before-quit owns final teardown.
  finishEachCleanup([
    () => quickChat?.interrupt(), () => chat?.cancel(), () => chatSpeech?.release(), () => voices?.stopVoice(),
    () => { clearTimeout(saveTimer); writeSettings(); },
  ]);
}
function finishEachCleanup(operations) {
  for (const operation of operations) {
    try { operation(); }
    catch (error) { console.error('Could not complete one shutdown operation:', error?.message); }
  }
}
function buildMenu() {
  return Menu.buildFromTemplate(trayTemplate({
    openSettings:()=>settingsWindow.open().catch(error=>console.error('Could not open settings:',error)),
    openChat:()=>chatWindow.open().catch(error=>console.error('Could not open chat:',error)),
    quit:requestQuit,
  }));
}

function registerIpc() {
  const trusted = (event) => pet && !pet.isDestroyed() && event.sender === pet.webContents && event.senderFrame === pet.webContents.mainFrame;
  ipcMain.handle('pet:get-state', (event) => trusted(event) ? state() : null);
  ipcMain.handle('pet:set-settings', (event, patch) => trusted(event) ? updateSettings(patch) : null);
  ipcMain.handle('pet:zoom-by', (event, input) => trusted(event) ? zoomPet(input) : null);
  ipcMain.handle('pet:interact', (event, kind) => trusted(event) ? voices?.interact(kind) : false);
  ipcMain.handle('pet:set-hit-region', (event, region) => {
    if(!trusted(event))return false;
    if(region?.space==='character'){
      const clean=sanitizeCharacterRegion(region);
      if(!clean)return false;
      logicalHitRegion=clean;logicalHitRevision++;return applyHitRegion();
    }
    logicalHitRegion=null;return windowShape?.update(region)??false;
  });
  ipcMain.on('pet:set-appearance', (event, value) => {
    if (trusted(event)) { appearance = sanitizeAppearance(value);settingsWindow?.publish(state()); }
  });
  ipcMain.on('pet:pointer-received', (event, sequence) => { if (trusted(event) && Number.isSafeInteger(sequence)) desktopPointer?.acknowledge(sequence); });
  ipcMain.on('pet:viewport-received',(event,sequence)=>{
    if(trusted(event)&&Number.isSafeInteger(sequence))viewportChannel.acknowledge(sequence);
  });
  ipcMain.on('pet:drag-start', (event) => { if (trusted(event) && (preferences.clickThrough||!dragLifecycle?.startDrag())) send('pet:drag-state',false); });
  ipcMain.on('pet:drag-end', (event) => { if (trusted(event)) dragLifecycle?.endDrag(); });
  ipcMain.on('pet:quit', (event) => { if (trusted(event)) requestQuit(); });
  const trustedSettings = event => isSettingsSender(event, settingsWindow?.getWindow(), settingsWindow?.url);
  ipcMain.handle('settings:voice-get', event => trustedSettings(event) ? voices?.getState() : null);
  ipcMain.handle('settings:voice-settings', (event, patch) => trustedSettings(event) ? voices?.setSettings(patch) : null);
  ipcMain.handle('settings:voice-stop', event => {
    if (!trustedSettings(event)) return null;
    quickChat?.interrupt(); chatSpeech?.stop(); return voices?.stopVoice();
  });
  ipcMain.on('settings:window-control', (event, value) => {
    if (trustedSettings(event)) settingsWindow.windowControl(value);
  });
  ipcMain.handle('settings:get-state', event => trustedSettings(event) ? state() : null);
  ipcMain.handle('settings:get-window-state', event => trustedSettings(event) ? settingsWindow.getWindowState() : null);
  ipcMain.handle('settings:set-settings', (event, patch) => trustedSettings(event) ? updateSettings(patch) : null);
  ipcMain.handle('settings:action', (event, value) => {
    const next = settingsAction(value);
    if (!trustedSettings(event) || !next || !pet || pet.isDestroyed()) return false;
    action(next);
    return true;
  });
  ipcMain.handle('settings:resize', (event, scale) => trustedSettings(event) && Number.isFinite(scale) ? resizePet(scale) : null);
  ipcMain.handle('settings:recover', (event, resetScale) => {
    if (!trustedSettings(event) || typeof resetScale !== 'boolean') return null;
    recover(resetScale);
    return state();
  });
  registerChatIpc({ ipcMain, chat, chatWindow, settingsWindow, speech: chatSpeech, clipboard, getState: chatState,
    onAction: channel => {
      const preserveWarmup = channel === 'chat:send' || channel === 'chat:read-aloud';
      quickChat?.interrupt(); chatSpeech?.stop({ preserveWarmup }); speechTarget = 'chat';
    } });
  registerModelSetupIpc({ ipcMain, settingsWindow, setup: modelSetup, voiceSetup, clipboard,
    getAppInfo: () => ({ version: app.getVersion(), mode: isLocalPreview ? 'local-preview' : app.isPackaged ? 'release' : 'development' }) });
  quickChatIpc = registerQuickChatIpc({ ipcMain, controller: quickChat, window: quickChatWindow, settingsWindow,
    shortcut: quickChatShortcut, speech: chatSpeech, isSpeechTarget: () => speechTarget === 'quick' });
}

async function createWindow() {
  const primary = screen.getPrimaryDisplay().workArea;
  const size = virtualBounds({},preferences.scale);
  const desired = { ...size, x: savedPosition?.x ?? primary.x + primary.width - size.width - 24, y: savedPosition?.y ?? primary.y + primary.height - size.height - 12 };
  characterBounds=restoreBounds(desired, screen.getAllDisplays(),bounds=>bounds);
  const planned=planViewport(characterBounds,screen.getAllDisplays());
  pet = new BrowserWindow({
    ...planned.native,
    show: false, frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: preferences.alwaysOnTop, skipTaskbar: true, hasShadow: false,
    title: '爱莉希雅桌宠', icon: createAppImage(nativeImage),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, devTools: !app.isPackaged },
  });
  petRecovery = createRendererRecovery(pet, rendererUrl);
  topmost=createTopmostController(pet,{enabled:preferences.alwaysOnTop,taskbarInFront:preferences.taskbarInFront,
    onLayerRestored:()=>voices?.reposition(),
    onError:error=>console.error('Could not update pet window layer:',error.message)});
  windowShape=createWindowShape(pet,{screen});
  viewport=viewportSnapshot(characterBounds,pet.getContentBounds(),planned.clipped);
  desktopPointer=createDesktopPointer({
    readCursor:()=>screen.getCursorScreenPoint(),getBounds:()=>characterBounds??pet.getBounds(),
    constrainBounds:bounds=>bounds,
    setPosition:(x,y)=>placePet({x,y}),
    sendPointer:payload=>{
      const bounds=pet.getContentBounds(),localX=payload.x-bounds.x,localY=payload.y-bounds.y;
      send('pet:pointer',{...payload,localX,localY,width:bounds.width,height:bounds.height,
        inside:localX>=0&&localY>=0&&localX<bounds.width&&localY<bounds.height});
    },onDragEnd:saveSettings,
    onDragState:active=>{send('pet:drag-state',active);pollPointer(active);},
  });
  dragLifecycle=createDragLifecycle({window:pet,pointer:desktopPointer,readCursor:()=>screen.getCursorScreenPoint()});
  pet.webContents.on('did-finish-load',()=>{desktopPointer?.reset();viewportChannel.reset();});
  pet.setMenu(null);
  pet.on('page-title-updated', event => event.preventDefault());
  pet.on('query-session-end', prepareSessionEnd);
  pet.on('session-end', () => app.quit());
  pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pet.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  pet.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // The tray opens a separate settings window. Right-button input on
  // the character belongs to the wheel-resize gesture in the renderer.
  pet.on('move', () => { if(!desktopPointer?.dragging)saveSettings(); });
  pet.on('resize', () => windowShape?.refresh());
  pet.on('closed', () => { petRecovery?.dispose();dragLifecycle?.dispose();windowShape?.dispose();topmost?.dispose();desktopPointer?.reset();pet = null; if (!quitting) app.quit(); });
  pet.once('ready-to-show', () => { if (!isSmokeTest) pet.showInactive(); });
  await pet.loadURL(rendererUrl);
  pollPointer();
  voices?.start();
  if (isSmokeTest) {
    await pet.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+15000;const timer=setInterval(()=>{if(document.documentElement.dataset.ready==='true'){clearInterval(timer);resolve(true)}else if(Date.now()>deadline){clearInterval(timer);reject(new Error('Renderer did not become ready'))}},50)})`);
    if (isPortableRelaunchSmoke) {
      const report = await require('./portable-relaunch-smoke.cjs').checkPortableRelaunchRuntime({
        app, pet, chatWindow, settingsWindow, root, directory: app.getPath('userData'),
        getSecondInstances: () => portableRelaunchInstances.slice(),
      });
      console.log(JSON.stringify(report));
      app.quit(); return;
    }
    if (isVoiceSmoke) {
      const report = await require('./voice-smoke.cjs').checkVoiceRuntime({ voices, voiceTestHooks, settingsWindow, pet, screen, placePet, root, ipcMain });
      console.log(JSON.stringify({ voiceSmoke: 'ok', ...report }));
      app.quit(); return;
    }
    if (isChatSmoke) {
      const report = await require('./chat-smoke.cjs').checkChatRuntime({ chat, chatWindow, chatSpeech, chatSpeechTestHooks, settingsWindow, pet, root, buildMenu, directory: app.getPath('userData') });
      console.log(JSON.stringify({ chatSmoke: 'ok', ...report }));
      app.quit(); return;
    }
    if (isQuickChatSmoke) {
      const report = await require('./quick-chat-smoke.cjs').checkQuickChatRuntime({ chat, quickChat, quickChatWindow, quickChatShortcut,
        chatWindow, settingsWindow, voices, chatSpeech, chatSpeechTestHooks, pet, screen, root, directory: app.getPath('userData') });
      console.log(JSON.stringify({ quickChatSmoke: 'ok', ...report }));
      app.quit(); return;
    }
    if (isInteractionSmoke) {
      const report = await require('./interaction-smoke.cjs').checkInteractionSettings({ pet, voices, voiceTestHooks, cursorTrail, settingsWindow,
        screen, root, getState:state, updateSettings, settingsFile, buildMenu, action, ipcMain });
      console.log(JSON.stringify({ interactionSmoke: 'ok', ...report }));
      app.quit(); return;
    }
    if (smokeNativeHotkeys) {
      const deadline = Date.now() + 10000;
      while (!hotkeys.legacy.active && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!hotkeys.legacy.active) throw new Error('Passive hotkey listener did not become ready');
      pet.show(); pet.focus();
      const handle = pet.getNativeWindowHandle();
      const nativeHandle = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      await new Promise((resolve, reject) => {
        const injector = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'smoke-hotkey-input.ps1'), '-ExpectedWindow', nativeHandle], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const timeout = setTimeout(() => { injector.kill(); reject(new Error('Native input test timed out')); }, 10000);
        injector.stderr.on('data', (chunk) => { output += chunk.toString(); });
        injector.on('error', (error) => { clearTimeout(timeout); reject(error); });
        injector.on('exit', (code) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`Native input test refused / failed: ${output}`)); });
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const expression = await pet.webContents.executeJavaScript('window.elysiaPreview.snapshot().expression');
      if (expression !== 'blush') throw new Error(`Native Space+1 did not toggle once: ${expression}`);
    }
    const renderer = await pet.webContents.executeJavaScript(`(async () => ({bridge:typeof window.elysiaDesktop, node:typeof window.require, title:document.title, rendering:window.elysiaPreview.rendering, state:await window.elysiaDesktop.getState()}))()`);
    const webPreferences = pet.webContents.getLastWebPreferences();
    if (!renderer.state?.settings || renderer.node !== 'undefined' || !webPreferences.sandbox || !webPreferences.contextIsolation || webPreferences.nodeIntegration) {
      throw new Error('Desktop host isolation / preload smoke check failed');
    }
    if (renderer.rendering?.mode !== 'mesh') {
      throw new Error('Desktop character mesh rendering smoke check failed');
    }
    const desktopChecks=smokeNativeHotkeys?null:require('./desktop-smoke.cjs').checkDesktopWindow({window:pet,getState:state,pointer:desktopPointer,topmost,place:placePet,displays:screen.getAllDisplays(),shape:windowShape,updateSettings});
    if(desktopChecks)desktopChecks.zoom=await require('./zoom-smoke.cjs').checkDesktopZoom({window:pet,getState:state,resize:resizePet,place:placePet,pointer:desktopPointer,shape:windowShape});
    if(desktopChecks)desktopChecks.settingsWindow=await require('./settings-window-smoke.cjs').checkSettingsWindow({window:pet,getState:state,settingsFile,buildMenu,settingsWindow,updateSettings,action,ipcMain});
    console.log(JSON.stringify({ smoke: 'ok', nativeSpaceChord: smokeNativeHotkeys ? 'passed-on-own-foreground-window' : 'not-requested', renderer, desktopChecks, bounds: pet.getBounds(), security: { sandbox: webPreferences.sandbox, contextIsolation: webPreferences.contextIsolation, nodeIntegration: webPreferences.nodeIntegration } }));
    app.quit();
  }
}

const hasInstanceLock = isPortableRelaunchSmoke
  ? app.requestSingleInstanceLock({ runtimeDirectory: path.dirname(process.execPath) })
  : app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
else {
  app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
    if (isPortableRelaunchSmoke) portableRelaunchInstances.push({ runtimeDirectory: additionalData?.runtimeDirectory });
    if (isLocalPreview && _argv.includes('--show-quick-chat')) void quickChatWindow?.open();
    else recover();
  });
  app.whenReady().then(async () => {
    // A second instance must not migrate or overwrite the active instance's profile.
    if (!isSmokeTest) migrateSampleProfile(app.getPath('appData'));
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    loadSettings();
    const firstChatSetup = !isSmokeTest && app.isPackaged && !fs.existsSync(path.join(app.getPath('userData'), 'chat-state.json'));
    firstRunSetup = createFirstRunSetup({ directory: app.getPath('userData'), firstRun: firstChatSetup, enabled: !isSmokeTest && !isLocalPreview && app.isPackaged });
    const windowIcon = createAppImage(nativeImage);
    settingsWindow=createSettingsWindow({BrowserWindow,screen,root,icon:windowIcon,isSmokeTest,isPackaged:app.isPackaged,getState:state});
    chat = createChatService({ directory: app.getPath('userData'), onChange: snapshot => {
      if (lastChatSettings?.readAloud && !snapshot.settings.readAloud) chatSpeech?.release();
      if (lastChatSettings && lastChatSettings.voiceProjectRoot !== snapshot.settings.voiceProjectRoot) { chatSpeech?.release(); chatSpeech?.clearCache(); }
      const enable = !lastChatSettings?.readAloud && snapshot.settings.readAloud;
      lastChatSettings = snapshot.settings;
      if (enable) chatSpeech?.warmup();
      publishChat();
    }, onReplyCompleted: reply => {
      if (quickChat?.completed(reply)) return;
      if (chat.getState().activeConversationId === reply.conversationId) { speechTarget = 'chat'; chatSpeech?.start(reply.text, { messageId: reply.messageId }); }
    } });
    lastChatSettings = chat.getState().settings;
    modelSetup = createModelSetup({ userData: app.getPath('userData'), allowDownloads: !isLocalPreview && !isSmokeTest, onChange: snapshot => {
      firstRunSetup.update('chat', snapshot);
      const panel = settingsWindow?.getWindow();
      if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('settings:model-setup-state', snapshot);
    } });
    voiceSetup = createVoiceSetup({ userData: app.getPath('userData'), allowDownloads: !isLocalPreview && !isSmokeTest,
      beforeRepair: async () => { chatSpeech?.release(); await chatSpeech?.whenReleased(); },
      resourcesPath: app.isPackaged ? process.resourcesPath : path.join(root, 'build-resources', 'voice-bootstrap'),
      assetDirectory: app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) : path.join(root, 'build-resources', 'voice-bootstrap'),
      onChange: snapshot => {
        firstRunSetup.update('voice', snapshot);
        chatSpeech?.refreshPermission();
        if (snapshot.phase === 'ready' && snapshot.ready) {
          const current = chat.getState().settings.voiceProjectRoot;
          if (sameWindowsDirectory(current, 'D:\\Elysia_AI') || sameWindowsDirectory(current, voiceSetup.getProjectRoot())) {
            if (!sameWindowsDirectory(current, voiceSetup.getProjectRoot())) chat.setSettings({ voiceProjectRoot: voiceSetup.getProjectRoot() });
          }
        }
        const panel = settingsWindow?.getWindow();
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('settings:voice-setup-state', snapshot);
      },
    });
    chatWindow = createChatWindow({ BrowserWindow, screen, root, icon:windowIcon, isSmokeTest, isPackaged: app.isPackaged, getState: chatState, onClosed: () => { if (speechTarget === 'chat') chatSpeech?.release(); } });
    quickChatWindow = createQuickChatWindow({ BrowserWindow, screen, root, icon:windowIcon, isSmokeTest, isPackaged: app.isPackaged, getState: () => quickChat?.getState() ?? { busy: false, error: null, storageError: null } });
    if (isChatSmoke || isQuickChatSmoke) chatSpeechTestHooks = require('./chat-speech-smoke.cjs').createChatSpeechSmokeWorker();
    const speechBlockReason = manual => getChatSpeechBlockReason(voices?.getState(), { manual,
      setupBusy: voiceSetup.getState().busy && sameWindowsDirectory(lastChatSettings.voiceProjectRoot, voiceSetup.getProjectRoot()) });
    chatSpeech = createChatSpeech({ root, ...(chatSpeechTestHooks ?? {}),
      getProjectRoot: () => chat.getState().settings.voiceProjectRoot,
      isEnabled: () => chat.getState().settings.readAloud === true && (!isSmokeTest || isChatSmoke || isQuickChatSmoke),
      isWindowOpen: () => !!(speechTarget === 'quick' ? quickChatWindow.getWindow() : chatWindow.getWindow()),
      getBlockReason: speechBlockReason,
      volume: () => voices?.getState().settings.volume ?? .8,
      sendAudio: packet => speechTarget === 'quick'
        ? quickChatWindow.getWindow()?.webContents.send('quick-chat:speech-audio', packet)
        : chatWindow.getWindow()?.webContents.send('chat:speech-audio', packet),
      stopAudio: packet => {
        chatWindow.getWindow()?.webContents.send('chat:speech-stop', packet);
        quickChatWindow.getWindow()?.webContents.send('quick-chat:speech-stop', packet);
      },
      claimAudio: value => voices?.setExternalSpeechBusy(value),
      onChange: publishChat,
    });
    voices = createVoiceController({ BrowserWindow, screen, ipcMain, powerMonitor, root,
      assetDirectory: app.isPackaged ? path.join(process.resourcesPath, 'voice') : undefined,
      interactionAssetDirectory: app.isPackaged ? path.join(process.resourcesPath, 'interaction-voice') : undefined,
      userData: app.getPath('userData'), getCharacterBounds: () => characterBounds,
      getPreferences: () => preferences, isSmokeTest, isPackaged: app.isPackaged, quit: () => app.quit(), testHooks: voiceTestHooks,
      publish: snapshot => {
        const environment = snapshot.environment;
        chatSpeech?.refreshPermission();
        quickChat?.changed();
        cursorTrail?.setBlocked(environment.locked || environment.suspended || environment.fullscreen || environment.monitorReady === false);
        const panel = settingsWindow?.getWindow();
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('settings:voice-state', snapshot);
      },
    });
    quickChat = createQuickChatController({ chat, window: quickChatWindow, voices, speech: chatSpeech,
      ensureReady: signal => ensureQuickChatReady(chat, modelSetup, signal), selectSpeechTarget: target => { speechTarget = target; },
      isSpeechTarget: () => speechTarget === 'quick', getSpeechBlockReason: () => speechBlockReason(false) });
    quickChatShortcut = createQuickChatShortcut({ globalShortcut, directory: app.getPath('userData'),
      onActivate: () => { void quickChatWindow.toggle().catch(error => console.error('Quick chat:', error.message)); },
      onChange: snapshot => {
        const panel = settingsWindow?.getWindow();
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('settings:quick-chat-state', snapshot);
      } });
    cursorTrail = createCursorTrail({ BrowserWindow, screen, root, isSmokeTest, isPackaged: app.isPackaged });
    cursorTrail.setStyle(preferences.cursorTrailStyle);
    cursorTrail.setDuration(preferences.cursorTrailDuration);
    cursorTrail.setEnabled(preferences.cursorTrailEnabled);
    const environment = voices.getState().environment;
    cursorTrail.setBlocked(environment.locked || environment.suspended || environment.fullscreen || environment.monitorReady === false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isLocalResource(details.url, root) && !voices?.allowsUrl(details.url) && !details.url.startsWith('data:') && !details.url.startsWith('blob:') });
    });
    registerIpc();
    tray = new Tray(createTrayImage(nativeImage));
    tray.setToolTip(`爱莉希雅桌宠 ${isLocalPreview ? '快捷聊天测试版' : app.getVersion()} · Ctrl+Alt+P 恢复操作`);
    tray.on('click', () => tray.popUpContextMenu(buildMenu()));
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    hotkeys.recovery = globalShortcut.register('CommandOrControl+Alt+P', () => recover());
    configureAlternateHotkeys();
    configureLegacyHotkeys();
    configureTypedKeys();
    await createWindow();
    if (isLocalPreview && !isSmokeTest) {
      if (managedChatEndpoint(chat.getState().settings.baseUrl)) modelSetup.ensureInstalledServer();
      void voiceSetup.inspect();
      if (process.argv.includes('--show-quick-chat')) await quickChatWindow.open();
    }
    if (firstRunSetup.start({ chat: modelSetup, voice: voiceSetup, chatBaseUrl: chat.getState().settings.baseUrl })) {
      const setupWindow = await settingsWindow.open();
      await setupWindow?.webContents.executeJavaScript('document.querySelector("[data-tab=chat]")?.click(); true');
    }
    const constrainToScreen = () => { if (pet && !pet.isDestroyed()) { dragLifecycle?.cancelDrag();placePet(restoreBounds(characterBounds??pet.getBounds(),screen.getAllDisplays(),bounds=>bounds));topmost?.refresh(); } };
    screen.on('display-removed', constrainToScreen);
    screen.on('display-metrics-changed', constrainToScreen);
  }).catch((error) => { console.error(error); app.exit(1); });
}
const quitCoordinator = createQuitCoordinator({ prepare: () => {
  quitting = true;
  // Each owner must get its shutdown request even if another native operation
  // fails. In particular, failures cannot skip model release or final settings.
  finishEachCleanup([
    () => quickChatIpc?.dispose(), () => quickChatShortcut?.dispose(), () => quickChat?.dispose(),
    () => chatSpeech?.dispose(), () => modelSetup?.dispose(), () => voiceSetup?.dispose(), () => chat?.dispose(),
    () => chatWindow?.dispose(), () => quickChatWindow?.dispose(), () => voices?.dispose(),
    () => cursorTrail?.dispose(), () => settingsWindow?.dispose(), () => clearInterval(pointerTimer),
    () => dragLifecycle?.dispose(), () => windowShape?.dispose(), () => petRecovery?.dispose(),
    () => topmost?.dispose(), () => desktopPointer?.reset(),
    // The pet may already be closed; retained logical bounds still belong here.
    () => { clearTimeout(saveTimer); writeSettings(); },
    () => legacyListener?.stop(), () => typingListener?.stop(),
    () => globalShortcut.unregisterAll(), () => tray?.destroy(),
  ]);
}, drain: () => chatSpeech?.whenReleased(), finish: () => app.quit(),
  onError: error => console.error('Could not complete graceful shutdown:', error?.message) });
app.on('before-quit', event => quitCoordinator.beforeQuit(event));
app.on('window-all-closed', () => app.quit());

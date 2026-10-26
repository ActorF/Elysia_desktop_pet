// Independent transparent Electron host. Character animation lives entirely in the local renderer.
'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, globalShortcut, session, powerMonitor, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { DEFAULT_SETTINGS, EXPRESSION_KEYS, SKIN_KEYS, POSE_KEYS, sanitizeAppearance, sanitizeSettings, freeBounds, restoreBounds, recoverBounds, actionForKey, isLocalResource } = require('./host-policy.cjs');
const { trayPng, createTrayImage } = require('./tray-icon.cjs');
const {createDesktopPointer,POINTER_INTERVAL_MS,DRAG_INTERVAL_MS}=require('./desktop-pointer.cjs');
const {createDragLifecycle}=require('./drag-lifecycle.cjs');
const {createTopmostController}=require('./window-layer.cjs');
const {createWindowShape}=require('./window-shape.cjs');
const {virtualBounds,planViewport,viewportSnapshot,zoomAt,zoomFromSteps,sanitizeCharacterRegion,projectHitRegion}=require('./pet-viewport.cjs');
const {trayTemplate}=require('./tray-menu.cjs');
const {createViewportChannel}=require('./viewport-channel.cjs');
const {createTypedKeyListener}=require('./typed-key-listener.cjs');
const {createSettingsWindow}=require('./settings-window.cjs');
const {settingsAction,isSettingsSender}=require('./settings-policy.cjs');
const {createVoiceController}=require('./voice-controller.cjs');
const {createCursorTrail}=require('./cursor-trail.cjs');
const {migrateSampleProfile}=require('./profile-migration.cjs');

const root = path.resolve(__dirname, '..');
const rendererUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
const smokeNativeHotkeys = process.argv.includes('--smoke-native-hotkeys');
const isVoiceSmoke = process.argv.includes('--voice-smoke-test');
const isInteractionSmoke = process.argv.includes('--interaction-smoke-test');
const isSmokeTest = process.argv.includes('--smoke-test') || smokeNativeHotkeys || isVoiceSmoke || isInteractionSmoke;
if (isSmokeTest) app.commandLine.appendSwitch('mute-audio');
const voiceTestHooks = isSmokeTest ? {} : undefined;
// Keep production preferences across upgrades; smoke tests use an isolated profile.
app.setName('爱莉希雅桌宠');
app.setAppUserModelId('io.actorf.elysia.standalonepet');
if (!isSmokeTest) migrateSampleProfile(app.getPath('appData'));
app.setPath('userData', isSmokeTest
  ? path.join(app.getPath('temp'), isVoiceSmoke ? 'elysia-pet-voice-smoke' : isInteractionSmoke ? 'elysia-pet-interaction-smoke' : 'elysia-pet-host-smoke')
  : path.join(app.getPath('appData'), 'Elysia Desktop Pet'));
let voices, cursorTrail;
let pet, tray, settingsWindow, settingsFile, pointerTimer, saveTimer, desktopPointer, dragLifecycle, topmost, windowShape, legacyProcess, typingListener;
let preferences = { ...DEFAULT_SETTINGS };
let appearance = sanitizeAppearance();
let savedPosition = null;
let characterBounds=null,viewport=null,logicalHitRegion=null,logicalHitRevision=0,projectedHitKey=null;
let lastNativeTargetKey=null;
const viewportChannel=createViewportChannel(payload=>send('pet:viewport',payload));
let quitting = false;
const hotkeys = { legacy: { active: false, error: null }, alternate: { active: false, failed: [] }, typing: { active: false, error: null }, recovery: false };

function state() { return { platform: process.platform, settings: { ...preferences }, appearance: { ...appearance }, hotkeys: structuredClone(hotkeys), viewport:viewport?{...viewport}:null }; }
function send(channel, data) {
  if (pet && !pet.isDestroyed() && !pet.webContents.isDestroyed()) pet.webContents.send(channel, data);
}
function publishSettings() { const snapshot=state();send('pet:settings',snapshot);settingsWindow?.publish(snapshot); }
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
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!settingsFile) return;
    try {
      const bounds = characterBounds ?? savedPosition;
      const payload = { settings: preferences, position: bounds ? { x: bounds.x, y: bounds.y } : null };
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(payload, null, 2));
      fs.renameSync(settingsFile + '.tmp', settingsFile);
    } catch (error) { console.error('Could not save pet preferences:', error.message); }
  }, 120);
}
function loadSettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    preferences = sanitizeSettings(stored.settings);
    if (stored.position && Number.isFinite(stored.position.x) && Number.isFinite(stored.position.y)) savedPosition = stored.position;
  } catch { /* First start or invalid preferences uses safe defaults. */ }
  // A fresh launch is always interactive; the tray can re-enable click-through.
  preferences.clickThrough = false;
}
function recover(resetScale = false) {
  if (!pet || pet.isDestroyed()) return;
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

function macTypedKeyExecutable() {
  return app.isPackaged ? path.join(process.resourcesPath, 'typed-keys-macos')
    : path.join(root, 'artifacts', 'native', `typed-keys-macos-${process.arch}`);
}
let typingPermissionPending = null, typingPermissionProcess = null;
function requestTypingPermission() {
  if (process.platform !== 'darwin' || isSmokeTest || quitting || !preferences.keyDisplay) return Promise.resolve(false);
  if (typingPermissionPending) return typingPermissionPending;
  // A button click may request OS consent; ordinary startup only checks it.
  // Coalesce repeated clicks and release this helper on app shutdown too.
  typingPermissionPending = new Promise(resolve => {
    let helper, output = '';
    try { helper = spawn(macTypedKeyExecutable(), ['--request-permission'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(false); return; }
    typingPermissionProcess = helper;
    helper.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-1024); });
    helper.once('error', () => resolve(false));
    helper.once('exit', () => {
      if (quitting || !preferences.keyDisplay) { resolve(false); return; }
      const granted = output.includes('PERMISSION:GRANTED');
      configureTypedKeys();
      if (!granted) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent').catch(console.error);
      resolve(granted);
    });
  }).finally(() => { typingPermissionPending = null; typingPermissionProcess = null; });
  return typingPermissionPending;
}

function configureTypedKeys() {
  if (!typingListener) {
    let script = path.join(__dirname, 'typed-keys.ps1');
    if (app.isPackaged) script = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    typingListener = createTypedKeyListener({
      spawn, script, macExecutable:macTypedKeyExecutable(),
      onCharacter: character => { if (preferences.keyDisplay && !quitting) send('pet:typed-key', character); },
      onStatus: value => { hotkeys.typing = value; if (!quitting) publishSettings(); },
    });
  }
  typingListener.start(preferences.keyDisplay && !(isSmokeTest && process.platform==='darwin'));
}

function configureLegacyHotkeys() {
  const previousProcess = legacyProcess;
  legacyProcess = null;
  if (previousProcess) previousProcess.kill();
  hotkeys.legacy = { active: false, error: null };
  if (!preferences.legacyHotkeys) { publishSettings(); return; }
  if (process.platform !== 'win32') {
    hotkeys.legacy.error = '原版 Space 组合键仅支持 Windows；可启用备用快捷键。';
    publishSettings(); return;
  }
  let script = path.join(__dirname, 'legacy-hotkeys.ps1');
  if (app.isPackaged) script = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentProcessId', String(process.pid)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  legacyProcess = child;
  let pending = '';
  let failure = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    if (legacyProcess !== child) return;
    pending += text;
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) {
      if (line.trim() === 'READY') {
        hotkeys.legacy = { active: true, error: null }; publishSettings(); continue;
      }
      const mapped = actionForKey(line.trim());
      if (mapped) action(mapped);
    }
    if (pending.length > 1024) pending = '';
  });
  child.stderr.on('data', (text) => { failure = (failure + text).slice(-2000); });
  child.on('error', () => {
    if (legacyProcess !== child) return;
    hotkeys.legacy = { active: false, error: '无法启动原版快捷键监听；可启用备用快捷键。' }; publishSettings();
  });
  child.on('exit', (code) => {
    if (legacyProcess !== child || quitting) return;
    legacyProcess = null;
    hotkeys.legacy = { active: false, error: `原版快捷键监听已停止（${code ?? 'unknown'}）${failure ? '，请启用备用快捷键。' : '。'}` };
    publishSettings();
  });
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

function buildMenu() {
  return Menu.buildFromTemplate(trayTemplate({openSettings:()=>settingsWindow.open().catch(error=>console.error('Could not open settings:',error)),quit:()=>voices?voices.requestQuit():app.quit()}));
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
  ipcMain.on('pet:quit', (event) => { if (trusted(event)) voices ? voices.requestQuit() : app.quit(); });
  const trustedSettings = event => isSettingsSender(event, settingsWindow?.getWindow(), settingsWindow?.url);
  // Permission requests use a fixed helper and the same main-frame guard as settings edits.
  ipcMain.handle('settings:typing-permission', event => trustedSettings(event) ? requestTypingPermission() : false);
  ipcMain.handle('settings:voice-get', event => trustedSettings(event) ? voices?.getState() : null);
  ipcMain.handle('settings:voice-settings', (event, patch) => trustedSettings(event) ? voices?.setSettings(patch) : null);
  ipcMain.handle('settings:voice-stop', event => trustedSettings(event) ? voices?.stopVoice() : null);
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
    title: '爱莉希雅桌宠', icon: nativeImage.createFromBuffer(trayPng()),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, devTools: !app.isPackaged },
  });
  topmost=createTopmostController(pet,{enabled:preferences.alwaysOnTop,taskbarInFront:preferences.taskbarInFront,
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
  pet.on('query-session-end', () => { voices?.dispose();cursorTrail?.dispose(); });
  pet.on('session-end', () => app.quit());
  pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pet.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  pet.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // The tray opens a separate settings window. Right-button input on
  // the character belongs to the wheel-resize gesture in the renderer.
  pet.on('move', () => { if(!desktopPointer?.dragging)saveSettings(); });
  pet.on('resize', () => windowShape?.refresh());
  pet.on('closed', () => { dragLifecycle?.dispose();windowShape?.dispose();topmost?.dispose();desktopPointer?.reset();pet = null; if (!quitting) app.quit(); });
  pet.once('ready-to-show', () => { if (!isSmokeTest) pet.showInactive(); });
  await pet.loadURL(rendererUrl);
  pollPointer();
  voices?.start();
  if (isSmokeTest) {
    await pet.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+15000;const timer=setInterval(()=>{if(document.documentElement.dataset.ready==='true'){clearInterval(timer);resolve(true)}else if(Date.now()>deadline){clearInterval(timer);reject(new Error('Renderer did not become ready'))}},50)})`);
    if (isVoiceSmoke) {
      const report = await require('./voice-smoke.cjs').checkVoiceRuntime({ voices, voiceTestHooks, settingsWindow, pet, screen, placePet, root, ipcMain });
      console.log(JSON.stringify({ voiceSmoke: 'ok', ...report }));
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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => recover());
  app.whenReady().then(async () => {
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    loadSettings();
    settingsWindow=createSettingsWindow({BrowserWindow,screen,root,isSmokeTest,isPackaged:app.isPackaged,getState:state});
    voices = createVoiceController({ BrowserWindow, screen, ipcMain, powerMonitor, root,
      assetDirectory: app.isPackaged ? path.join(process.resourcesPath, 'voice') : undefined,
      interactionAssetDirectory: app.isPackaged ? path.join(process.resourcesPath, 'interaction-voice') : undefined,
      userData: app.getPath('userData'), getCharacterBounds: () => characterBounds,
      getPreferences: () => preferences, isSmokeTest, isPackaged: app.isPackaged, quit: () => app.quit(), testHooks: voiceTestHooks,
      publish: snapshot => {
        const environment = snapshot.environment;
        cursorTrail?.setBlocked(environment.locked || environment.suspended || environment.fullscreen || environment.monitorReady === false);
        const panel = settingsWindow?.getWindow();
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('settings:voice-state', snapshot);
      },
    });
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
    tray.setToolTip(`爱莉希雅桌宠 ${app.getVersion()} · Ctrl+Alt+P 恢复操作`);
    tray.on('click', () => tray.popUpContextMenu(buildMenu()));
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    hotkeys.recovery = globalShortcut.register('CommandOrControl+Alt+P', () => recover());
    configureAlternateHotkeys();
    configureLegacyHotkeys();
    configureTypedKeys();
    await createWindow();
    const constrainToScreen = () => { if (pet && !pet.isDestroyed()) { dragLifecycle?.cancelDrag();placePet(restoreBounds(characterBounds??pet.getBounds(),screen.getAllDisplays(),bounds=>bounds));topmost?.refresh(); } };
    screen.on('display-removed', constrainToScreen);
    screen.on('display-metrics-changed', constrainToScreen);
  }).catch((error) => { console.error(error); app.exit(1); });
}
app.on('before-quit', () => {
  quitting = true;
  typingPermissionProcess?.kill();
  voices?.dispose();
  cursorTrail?.dispose();
  settingsWindow?.dispose();
  clearInterval(pointerTimer);
  dragLifecycle?.dispose();
  windowShape?.dispose();
  topmost?.dispose();
  desktopPointer?.reset();
  clearTimeout(saveTimer);
  if (pet && !pet.isDestroyed()) {
    try {
      const { x, y } = characterBounds??pet.getBounds();
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ settings: preferences, position: { x, y } }, null, 2));
    } catch { /* Shutdown must still release input listeners. */ }
  }
  if (legacyProcess) legacyProcess.kill();
  legacyProcess = null;
  typingListener?.stop();
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});
app.on('window-all-closed', () => app.quit());

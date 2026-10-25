'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BUBBLE_SIZE = Object.freeze({ width: 300, height: 108 });
const MAX_BUBBLE_SIZE = Object.freeze({ width: 430, height: 180 });
const validBox = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const overlap = (a, b) => ({
  x: Math.max(a.x, b.x), y: Math.max(a.y, b.y),
  width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
  height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
});

/** Work exclusively in Electron's DIP coordinates, including negative monitor origins. */
function speechBounds(character, displays = [], size = BUBBLE_SIZE) {
  const boxes = displays.map(display => ({ area: display.workArea ?? display.bounds ?? display, screen: display.bounds ?? display.workArea ?? display }))
    .filter(item => validBox(item.area) && validBox(item.screen));
  if (!boxes.length) boxes.push({ area: { x: 0, y: 0, width: 1920, height: 1080 }, screen: { x: 0, y: 0, width: 1920, height: 1080 } });
  const pet = validBox(character) ? character : { x: boxes[0].area.x, y: boxes[0].area.y, width: 420, height: 560 };
  const distance = area => Math.hypot(Math.max(0, area.x - pet.x - pet.width, pet.x - area.x - area.width), Math.max(0, area.y - pet.y - pet.height, pet.y - area.y - area.height));
  boxes.sort((a, b) => {
    const aa = overlap(pet, a.screen), bb = overlap(pet, b.screen);
    return bb.width * bb.height - aa.width * aa.height || distance(a.screen) - distance(b.screen);
  });
  const area = boxes[0].area, visible = overlap(pet, boxes[0].screen);
  const width = Math.round(Math.min(size.width, area.width)), height = Math.round(Math.min(size.height, area.height));
  const centerX = visible.width > 0 ? visible.x + visible.width / 2 : clamp(pet.x + pet.width / 2, area.x, area.x + area.width);
  const side = centerX >= area.x + area.width / 2 ? 'left' : 'right';
  const margin = Math.min(8, Math.max(0, (area.width - width) / 2), Math.max(0, (area.height - height) / 2));
  const anchorY = clamp(pet.y + pet.height * .27, area.y + 32, area.y + area.height - 32);
  const desiredX = side === 'left' ? pet.x - width + 4 : pet.x + pet.width - 4;
  const x = Math.round(clamp(desiredX, area.x + margin, area.x + area.width - width - margin));
  const y = Math.round(clamp(anchorY - height / 2, area.y + margin, area.y + area.height - height - margin));
  const tailInset = Math.min(36, height / 2);
  return { x, y, width, height, side, tailY: Math.round(clamp(anchorY - y, tailInset, height - tailInset)) };
}

function createSpeechWindow({ BrowserWindow, screen, ipcMain, root, getCharacterBounds, getPreferences = () => ({}), isSmokeTest = false, isPackaged = false, onStarted = () => {}, onFinished = () => {} }) {
  const url = pathToFileURL(path.join(root, 'renderer', 'speech.html')).href;
  let current = null, windowReady = null, active = null, displayedToken = null, disposed = false, serial = 0, hideTimer = null, watchdog = null, lastError = null;
  let measuredSize = { ...BUBBLE_SIZE };
  const getWindow = () => current && !current.isDestroyed() ? current : null;
  const getState = () => ({ token: active?.token ?? null, lineId: active?.line.id ?? null, kind: active?.kind ?? null, playing: active?.playing === true, visible: getWindow()?.isVisible() === true, error: lastError });
  const send = (channel, value) => { const window = getWindow(); if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, value); };
  const trusted = event => {
    const window = getWindow();
    return !!window && !window.webContents.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === url;
  };
  const limits = () => {
    const bounds = speechBounds(getCharacterBounds?.(), screen.getAllDisplays(), MAX_BUBBLE_SIZE);
    return { maxWidth: bounds.width, maxHeight: bounds.height };
  };
  function reposition(allowMeasure = true) {
    const window = getWindow();
    if (!window) return null;
    const placement = speechBounds(getCharacterBounds?.(), screen.getAllDisplays(), measuredSize);
    const { side, tailY, ...bounds } = placement;
    window.setBounds(bounds, false);
    const settings = getPreferences();
    window.setAlwaysOnTop(settings.alwaysOnTop !== false, settings.taskbarInFront === true ? 'floating' : 'screen-saver');
    send('speech:placement', { side, tailY });
    if (allowMeasure && active?.limits) {
      const next = limits();
      if (next.maxWidth !== active.limits.maxWidth || next.maxHeight !== active.limits.maxHeight) {
        active.limits = next; active.layoutRevision++; active.layoutReady = false;
        send('speech:measure', { token: active.token, revision: active.layoutRevision, ...next });
      }
    }
    return placement;
  }
  function clearTimers() { clearTimeout(hideTimer); clearTimeout(watchdog); hideTimer = null; watchdog = null; }
  function finish(status, error = null) {
    if (!active) return;
    const previous = active;
    active = null;
    clearTimers();
    if (error) lastError = error;
    if (status === 'ended' && previous.kind !== 'farewell' && !previous.textOnly) {
      hideTimer = setTimeout(() => { if (!active) { getWindow()?.hide(); displayedToken = null; } }, 1200);
      hideTimer.unref?.();
    } else if (status === 'error') {
      send('speech:error', { token: previous.token, error });
      getWindow()?.hide(); displayedToken = null;
    } else {
      if (previous.textOnly) send('speech:stop', { token: previous.token });
      getWindow()?.hide(); displayedToken = null;
    }
    onFinished({ token: previous.token, lineId: previous.line.id, kind: previous.kind, status, ...(error ? { error } : {}) });
  }
  function stop(reason = 'stopped') {
    send('speech:stop', { token: active?.token ?? null });
    finish(reason);
    clearTimers();
    getWindow()?.hide();
    displayedToken = null;
  }
  function setVolume(value) {
    if (!Number.isFinite(value) || !active || active.textOnly || disposed) return false;
    active.volume = clamp(value, 0, 1);
    send('speech:volume', { token: active.token, volume: active.volume });
    return true;
  }
  const receive = (event, value) => {
    if (!trusted(event)) return;
    if (!active && value?.type === 'skip' && displayedToken !== null && value.token === displayedToken) { stop(); return; }
    if (!active || value?.token !== active.token) return;
    if (value.type === 'prepared' && active.layoutReady && value.revision === active.layoutRevision) {
      if (!isSmokeTest) getWindow()?.showInactive();
      if (active.textOnly && !active.playing) {
        const request = active;
        request.playing = true;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { if (active === request && !disposed) finish('ended'); }, request.duration);
        watchdog.unref?.();
        onStarted({ token: request.token, lineId: request.line.id, kind: request.kind });
      }
    } else if (value.type === 'started' && !active.textOnly && active.hasLayout && !active.playing) {
      // A native playing event may arrive while another monitor's layout is
      // being measured. Its original valid layout still authorizes this start.
      const request = active;
      request.playing = true;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (active !== request || disposed) return;
        send('speech:stop', { token: request.token }); finish('error', '语音播放超时，请重试。');
      }, 60000);
      watchdog.unref?.();
      onStarted({ token: request.token, lineId: request.line.id, kind: request.kind });
    } else if (value.type === 'ended' && !active.textOnly) finish('ended');
    else if (value.type === 'error') finish('error', typeof value.error === 'string' ? value.error.slice(0, 240) : '语音暂时无法播放。');
    else if (value.type === 'skip') { send('speech:stop', { token: active.token }); finish('skipped'); }
  };
  const receiveLayout = (event, value) => {
    if (!trusted(event) || !active || value?.token !== active.token || value.revision !== active.layoutRevision
      || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0) return;
    const maximum = limits();
    // Renderer measurement is advisory; native bounds remain constrained by this monitor.
    measuredSize = {
      width: Math.round(clamp(value.width, Math.min(64, maximum.maxWidth), maximum.maxWidth)),
      height: Math.round(clamp(value.height, Math.min(64, maximum.maxHeight), maximum.maxHeight)),
    };
    active.layoutReady = true; active.hasLayout = true;
    const placement = reposition(false);
    send('speech:layout-ready', { token: active.token, revision: active.layoutRevision, ...placement });
  };
  ipcMain.on('speech:event', receive);
  ipcMain.on('speech:layout', receiveLayout);
  async function ensureWindow() {
    if (disposed) return null;
    if (!getWindow()) {
      const { side, tailY, ...bounds } = speechBounds(getCharacterBounds?.(), screen.getAllDisplays());
      const window = new BrowserWindow({
        ...bounds, show: false, frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
        resizable: false, maximizable: false, minimizable: false, fullscreenable: false, movable: false,
        focusable: false, skipTaskbar: true, hasShadow: false, title: '爱莉希雅 · 语音',
        alwaysOnTop: getPreferences().alwaysOnTop !== false,
        webPreferences: { preload: path.join(root, 'electron', 'speech-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', devTools: !isPackaged },
      });
      current = window;
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, value => value.preventDefault());
      window.on('page-title-updated', event => event.preventDefault());
      window.on('closed', () => { if (current === window) { current = null; windowReady = null; finish('error', '语音窗口已关闭。'); } });
      window.webContents.on('render-process-gone', () => {
        if (current !== window) return;
        // Clear the crashed window before notifying the owner. Its completion
        // callback is allowed to request the next line synchronously.
        current = null; windowReady = null;
        finish('error', '语音窗口意外停止。');
        if (!window.isDestroyed()) window.destroy();
      });
      windowReady = window.loadURL(url).then(() => { reposition(); return window; }).catch(error => { if (!window.isDestroyed()) window.destroy(); throw error; });
    }
    await windowReady;
    return getWindow();
  }
  async function present(line, options = {}, textOnly = false) {
    if (disposed) return { ok: false, error: '语音窗口已关闭。' };
    if (!line || typeof line.id !== 'string' || typeof line.text !== 'string'
      || (!textOnly && (typeof line.audioUrl !== 'string' || !line.audioUrl.startsWith('file:')))) return { ok: false, error: textOnly ? '字幕内容无效。' : '语音文件无效。' };
    if (active) stop('replaced');
    getWindow()?.hide();
    clearTimers(); lastError = null;
    const token = options.token ?? `speech-${++serial}`;
    const request = { token, line: textOnly ? { id: line.id, text: line.text } : { ...line }, kind: options.kind ?? (textOnly ? 'interaction' : 'manual'), textOnly,
      duration: Number.isFinite(options.duration) ? clamp(options.duration, 1, 30000) : 3200,
      playing: false, layoutReady: false, hasLayout: false, layoutRevision: 1, limits: limits(), volume: Number.isFinite(options.volume) ? clamp(options.volume, 0, 1) : 1 };
    active = request;
    try {
      const window = await ensureWindow();
      if (!window || active !== request || disposed) return { ok: false, token, error: '播放已被取消。' };
      const placement = reposition();
      displayedToken = token;
      send('speech:play', { token, line: request.line, kind: request.kind, textOnly, side: placement.side, tailY: placement.tailY, volume: request.volume, revision: request.layoutRevision, ...request.limits });
      watchdog = setTimeout(() => {
        if (active !== request || disposed) return;
        send('speech:stop', { token }); finish('error', textOnly ? '字幕未能显示，请重试。' : '语音未能开始播放，请检查本地录音文件。');
      }, 12000);
      watchdog.unref?.();
      return { ok: true, token };
    } catch (error) {
      if (active === request) finish('error', error.message);
      return { ok: false, token, error: error.message };
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    ipcMain.removeListener('speech:event', receive);
    ipcMain.removeListener('speech:layout', receiveLayout);
    getWindow()?.destroy();
    current = null;
  }
  return { play: (line, options) => present(line, options), showText: (line, options) => present(line, options, true), stop, setVolume, reposition, dispose, getWindow, getState, url };
}

module.exports = { createSpeechWindow, speechBounds, BUBBLE_SIZE };

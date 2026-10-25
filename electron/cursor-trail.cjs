'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TRAIL_LIFETIME_MS = 600;
const SAMPLE_INTERVAL_MS = 16;
const MAX_SAMPLE_GAP_MS = 180;
const MAX_PENDING_POINTS = 192;
const TRAIL_STYLES = Object.freeze(['pink', 'ribbon', 'stardust']);
const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const validBounds = bounds => bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0;
function trailDisplays(displays = []) {
  return displays.filter(display => validBounds(display.bounds ?? display.workArea)).map((display, index) => {
    const area = display.bounds ?? display.workArea;
    return { id: String(display.id ?? index), bounds: { x: Math.round(area.x), y: Math.round(area.y), width: Math.max(1, Math.round(area.width)), height: Math.max(1, Math.round(area.height)) }, scaleFactor: Number.isFinite(display.scaleFactor) ? display.scaleFactor : 1 };
  });
}
function displayForPoint(point, displays) {
  return validPoint(point) ? displays.find(({ bounds }) => point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height) ?? null : null;
}
const displaySignature = displays => JSON.stringify([...displays].sort((left, right) => left.id.localeCompare(right.id)));
function breaksTrail(previous, next) {
  if (!previous || previous.displayId !== next.displayId) return true;
  const elapsed = next.at - previous.at;
  return elapsed < 0 || elapsed > MAX_SAMPLE_GAP_MS;
}

/** One click-through surface per occupied monitor; all coordinates are DIPs. */
function createCursorTrail({ BrowserWindow, screen, root, isSmokeTest = false, isPackaged = false, now = Date.now }) {
  const url = pathToFileURL(path.join(root, 'renderer', 'cursor-trail.html')).href;
  const entries = new Map(), failedUntil = new Map();
  let enabled = true, blocked = false, disposed = false, style = 'pink', duration = TRAIL_LIFETIME_MS / 1000;
  let generation = 1, sequence = 0, lastPoint = null, lastError = null;
  let displays = trailDisplays(screen.getAllDisplays());
  const live = entry => !disposed && entries.get(entry.display.id) === entry && !entry.window.isDestroyed();
  const allowed = entry => live(entry) && enabled && !blocked;
  const send = (entry, channel, payload) => { if (live(entry) && !entry.window.webContents.isDestroyed()) entry.window.webContents.send(channel, payload); };
  function cancelTimers(entry) {
    clearTimeout(entry.flushTimer); clearTimeout(entry.idleTimer);
    entry.flushTimer = null; entry.idleTimer = null;
  }
  function clearEntry(entry) {
    entry.epoch++; cancelTimers(entry); entry.pending = []; entry.lastSentAt = -Infinity; entry.lastQueuedAt = -Infinity;
    send(entry, 'cursor-trail:clear', { generation });
    if (!entry.window.isDestroyed()) entry.window.hide();
  }
  function retire(entry) {
    clearEntry(entry); entries.delete(entry.display.id);
    if (!entry.window.isDestroyed()) entry.window.destroy();
  }
  function clearAll() {
    generation++; lastPoint = null;
    for (const entry of entries.values()) clearEntry(entry);
  }
  function prune(entry, at) {
    const before = entry.pending;
    entry.pending = before.filter(point => point.generation === generation && at >= point.at && at - point.at < duration * 1000);
    if (entry.pending.length && entry.pending[0] !== before[0]) entry.pending[0] = { ...entry.pending[0], break: true };
  }
  function append(entry, point, disconnected) {
    entry.pending.push({ ...point, generation, sequence: ++sequence, break: disconnected });
    // Thin the densest time interval while preserving both ends. Repeatedly
    // halving the whole buffer would leave seconds-long holes in a 5s history.
    if (entry.pending.length > MAX_PENDING_POINTS) {
      let removeIndex = 1, shortestSpan = Infinity;
      for (let index = 1; index < entry.pending.length - 1; index++) {
        const span = entry.pending[index + 1].at - entry.pending[index - 1].at;
        if (span < shortestSpan) { shortestSpan = span; removeIndex = index; }
      }
      entry.pending[removeIndex + 1].break ||= entry.pending[removeIndex].break;
      entry.pending.splice(removeIndex, 1);
    }
  }
  function flush(entry) {
    if (!allowed(entry) || !entry.ready) return;
    const at = now(); prune(entry, at);
    if (!entry.pending.length) return;
    const delay = SAMPLE_INTERVAL_MS - (at - entry.lastSentAt);
    if (delay > 0) {
      if (entry.flushTimer === null) {
        const epoch = entry.epoch;
        entry.flushTimer = setTimeout(() => {
          if (!live(entry) || entry.epoch !== epoch) return;
          entry.flushTimer = null; flush(entry);
        }, delay);
        entry.flushTimer.unref?.();
      }
      return;
    }
    const points = entry.pending.map(packet => ({ x: packet.x - entry.display.bounds.x, y: packet.y - entry.display.bounds.y,
      break: packet.break, age: at - packet.at, sequence: packet.sequence }));
    entry.pending = []; entry.lastSentAt = at;
    send(entry, 'cursor-trail:sample', { points, generation, style, duration });
    // showInactive preserves the foreground application's keyboard focus.
    if (!isSmokeTest && !entry.window.isVisible()) entry.window.showInactive();
  }
  function createEntry(display) {
    if (now() < (failedUntil.get(display.id) ?? 0)) return null;
    const window = new BrowserWindow({
      ...display.bounds, show: false, frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: '爱莉希雅 · 鼠标流光',
      webPreferences: { preload: path.join(root, 'electron', 'cursor-trail-preload.cjs'), contextIsolation: true,
        sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, backgroundThrottling: false, devTools: !isPackaged },
    });
    const entry = { display, window, ready: false, pending: [], lastSentAt: -Infinity, lastQueuedAt: -Infinity,
      flushTimer: null, idleTimer: null, idleSequence: 0, epoch: 0 };
    entries.set(display.id, entry);
    window.setMenu(null);
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, value => value.preventDefault());
    window.on('page-title-updated', event => event.preventDefault());
    window.on('closed', () => {
      entry.epoch++; cancelTimers(entry); entry.pending = [];
      if (entries.get(display.id) === entry) entries.delete(display.id);
    });
    window.webContents.on('render-process-gone', () => {
      if (!live(entry)) return;
      lastError = '鼠标流光窗口暂时停止。'; failedUntil.set(display.id, now() + 2000); retire(entry);
    });
    entry.loading = window.loadURL(url).then(() => {
      if (!live(entry)) return;
      entry.ready = true; lastError = null;
      send(entry, 'cursor-trail:style', { style, generation, duration });
      flush(entry);
    }).catch(error => {
      if (!live(entry)) return;
      lastError = error.message; failedUntil.set(display.id, now() + 2000); retire(entry);
    });
    return entry;
  }
  function sample(point) {
    if (disposed || !enabled || blocked) return false;
    if (!validPoint(point)) { lastPoint = null; return false; }
    const display = displayForPoint(point, displays);
    if (!display) { lastPoint = null; return false; }
    const next = { x: point.x, y: point.y, at: now(), displayId: display.id };
    if (lastPoint && next.at < lastPoint.at) clearAll();
    if (!lastPoint) {
      lastPoint = next;
      // Returning from a desktop gap or invalid cursor reading starts a new
      // segment even when this monitor still contains a recent visible stroke.
      const previousEntry = entries.get(display.id);
      if (previousEntry) previousEntry.lastQueuedAt = -Infinity;
      return false;
    }
    const previous = lastPoint; lastPoint = next;
    if (next.x === previous.x && next.y === previous.y && next.displayId === previous.displayId) return false;
    const disconnected = breaksTrail(previous, next);
    const entry = entries.get(display.id) ?? createEntry(display);
    if (!entry || !allowed(entry)) return false;
    prune(entry, next.at);
    const needsOrigin = !disconnected && next.at - entry.lastQueuedAt > MAX_SAMPLE_GAP_MS;
    if (needsOrigin) append(entry, previous, true);
    append(entry, next, disconnected || (!needsOrigin && entry.lastQueuedAt === -Infinity));
    entry.lastQueuedAt = next.at;
    clearTimeout(entry.idleTimer); const idleSequence = ++entry.idleSequence, epoch = entry.epoch;
    entry.idleTimer = setTimeout(() => {
      if (!live(entry) || entry.epoch !== epoch || entry.idleSequence !== idleSequence) return;
      clearEntry(entry);
    }, duration * 1000);
    entry.idleTimer.unref?.();
    if (entry.ready && entry.flushTimer === null) flush(entry);
    return true;
  }
  function refreshDisplays() {
    if (disposed) return;
    const next = trailDisplays(screen.getAllDisplays());
    // Chromium can report empty display-metrics-changed events during startup.
    // Preserve a pending first stroke unless the actual rendering geometry changed.
    if (displaySignature(next) === displaySignature(displays)) return;
    clearAll();
    const byId = new Map(next.map(display => [display.id, display]));
    for (const entry of [...entries.values()]) {
      const replacement = byId.get(entry.display.id);
      if (!replacement || JSON.stringify(replacement) !== JSON.stringify(entry.display)) retire(entry);
    }
    displays = next; lastPoint = null;
  }
  const events = ['display-added', 'display-removed', 'display-metrics-changed'];
  for (const event of events) screen.on?.(event, refreshDisplays);
  function setEnabled(value) {
    if (disposed || typeof value !== 'boolean' || enabled === value) return;
    enabled = value; clearAll();
  }
  function setBlocked(value) {
    if (disposed || typeof value !== 'boolean' || blocked === value) return;
    blocked = value; clearAll();
  }
  function setStyle(value) {
    if (disposed || !TRAIL_STYLES.includes(value) || style === value) return;
    style = value; clearAll();
    for (const entry of entries.values()) if (entry.ready) send(entry, 'cursor-trail:style', { style, generation, duration });
  }
  function setDuration(value) {
    if (disposed || typeof value !== 'number' || !Number.isFinite(value)) return;
    const next = Math.max(.1, Math.min(5, value));
    if (duration === next) return;
    duration = next; clearAll();
    for (const entry of entries.values()) if (entry.ready) send(entry, 'cursor-trail:duration', { duration, generation });
  }
  function dispose() {
    if (disposed) return;
    clearAll();
    for (const event of events) screen.removeListener?.(event, refreshDisplays);
    for (const entry of [...entries.values()]) retire(entry);
    disposed = true; failedUntil.clear();
  }
  return { sample, setEnabled, setBlocked, setStyle, setDuration, dispose,
    getWindows: () => [...entries.values()].filter(live).map(entry => entry.window),
    getState: () => ({ enabled, blocked, disposed, style, duration, generation, lastError,
      pending: [...entries.values()].filter(entry => entry.pending.length).map(entry => entry.display.id),
      windows: [...entries.values()].filter(live).map(entry => ({ displayId: entry.display.id, bounds: { ...entry.display.bounds }, ready: entry.ready, visible: entry.window.isVisible() })) }),
  };
}

module.exports = { createCursorTrail, trailDisplays, displayForPoint, breaksTrail, TRAIL_LIFETIME_MS, SAMPLE_INTERVAL_MS, MAX_SAMPLE_GAP_MS, MAX_PENDING_POINTS, TRAIL_STYLES };

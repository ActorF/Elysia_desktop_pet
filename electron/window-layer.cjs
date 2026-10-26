'use strict';

// Electron 43.8.0 implements moveTop() on Windows with SetWindowPos and
// SWP_NOACTIVATE. Never replace it with focus() or show().
// https://github.com/electron/electron/blob/v43.8.0/shell/browser/native_window_views.cc
// https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativelevel
const TOPMOST_LEVEL = 'screen-saver';
const BELOW_TASKBAR_LEVEL = 'floating';
const REASSERT_INTERVAL_MS = 750;
const controllers = new WeakMap();

/**
 * Keep a visible Windows pet above ordinary/topmost application windows without
 * taking keyboard focus. Reassertion cannot override the Windows secure desktop
 * or promise coverage over exclusive full-screen rendering or competing apps
 * that continuously reorder themselves.
 *
 * setEnabled(false) immediately stops maintenance and removes native topmost.
 * refresh() is useful after a display/layout change. dispose() releases every
 * listener/timer and topmost status; it is also called automatically on closed.
 * Repeated factory calls for the same live window return the existing owner.
 */
function createTopmostController(window, options = {}) {
  const existing = controllers.get(window);
  if (existing) return existing;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(500, Math.min(5000, options.intervalMs)) : REASSERT_INTERVAL_MS;
  let enabled = options.enabled !== false, disposed = false, timer = null, raising = false;
  let taskbarInFront = options.taskbarInFront === true;
  let taskbarOrderer = null, configuredLevel = null;

  const alive = () => !window.isDestroyed();
  const visible = () => alive() && window.isVisible() && !window.isMinimized();
  const level = () => taskbarInFront ? BELOW_TASKBAR_LEVEL : TOPMOST_LEVEL;
  function stopTimer() {
    if (timer !== null) { cancel(timer); timer = null; }
  }
  function stopMaintenance() {
    stopTimer();
    taskbarOrderer?.stop();
  }
  function report(error) {
    if (!alive()) { dispose(); return; }
    options.onError?.(error);
  }
  function refresh() {
    if (disposed) return false;
    if (!alive()) { dispose(); return false; }
    if (!enabled || !visible()) { stopMaintenance(); return false; }
    if (timer === null) {
      timer = schedule(refresh, intervalMs);
      timer?.unref?.();
    }
    if (raising) return false;
    raising = true;
    try {
      // Electron's floating level only handles Shell_TrayWnd. Once our helper
      // is ready it maintains order behind primary AND secondary taskbars.
      // Reapplying floating every tick would move us above a secondary bar.
      const targetLevel = level();
      if (!taskbarInFront || configuredLevel !== targetLevel || !taskbarOrderer?.running) {
        window.setAlwaysOnTop(true, targetLevel);
        configuredLevel = targetLevel;
      }
      if (taskbarInFront) taskbarOrderer?.start();
      else {
        taskbarOrderer?.stop();
        if (!disposed && enabled && visible()) window.moveTop();
      }
      return !disposed && enabled;
    } catch (error) {
      report(error);
      return false;
    } finally { raising = false; }
  }
  function enable() {
    if (!alive()) { dispose(); return; }
    // Setting the property is safe before first show, and makes preference
    // toggles observable even in a hidden smoke-test window. moveTop includes
    // SWP_SHOWWINDOW internally, so only refresh's visible guard may call it.
    if (!visible()) {
      try { window.setAlwaysOnTop(true, level()); configuredLevel = level(); } catch (error) { report(error); }
    }
    refresh();
  }
  function setEnabled(value) {
    if (disposed) return;
    const next = Boolean(value);
    if (enabled === next) return;
    enabled = next;
    if (enabled) { enable(); return; }
    configuredLevel = null;
    stopMaintenance();
    if (alive()) {
      try { window.setAlwaysOnTop(false); } catch (error) { report(error); }
    }
  }
  function setTaskbarInFront(value) {
    if (disposed) return;
    const next = value === true;
    if (taskbarInFront === next) return;
    taskbarInFront = next;
    if (enabled) enable();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; enabled = false; stopTimer(); taskbarOrderer?.dispose();
    for (const event of ['show', 'restore', 'focus', 'blur', 'leave-full-screen']) window.removeListener(event, refresh);
    for (const event of ['hide', 'minimize']) window.removeListener(event, stopMaintenance);
    window.removeListener('closed', dispose);
    controllers.delete(window);
    if (alive()) {
      try { window.setAlwaysOnTop(false); } catch (error) { options.onError?.(error); }
    }
  }
  const controller = { setEnabled, setTaskbarInFront, refresh, dispose,
    get enabled() { return enabled; }, get taskbarInFront() { return taskbarInFront; }, get disposed() { return disposed; } };
  controllers.set(window, controller);
  if (!alive()) { dispose(); return controller; }
  if (typeof window.getNativeWindowHandle === 'function' && (options.platform ?? process.platform) === 'win32') {
    const createOrderer = options.createTaskbarOrderer ?? require('./taskbar-order.cjs').createTaskbarOrderer;
    taskbarOrderer = createOrderer(window, { onError: report, onStopped() {
      // A helper can finish one native operation while it is being stopped.
      // Reapply the CURRENT policy after exit, never the mode it started with.
      if (disposed || !alive()) return;
      configuredLevel = null;
      if (enabled) enable();
      else { try { window.setAlwaysOnTop(false); } catch (error) { report(error); } }
      // The native batch also preserves our subtitle/trail windows. Its last
      // operation may have raced a preference change, so restore companions
      // only after the helper has exited and our current policy was reapplied.
      if (!disposed && alive()) {
        try { options.onLayerRestored?.(); } catch (error) { report(error); }
      }
    } });
  }
  for (const event of ['show', 'restore', 'focus', 'blur', 'leave-full-screen']) window.on(event, refresh);
  for (const event of ['hide', 'minimize']) window.on(event, stopMaintenance);
  window.once('closed', dispose);
  if (enabled) enable();
  else {
    try { window.setAlwaysOnTop(false); } catch (error) { report(error); }
  }
  return controller;
}

module.exports = { createTopmostController, TOPMOST_LEVEL, BELOW_TASKBAR_LEVEL, REASSERT_INTERVAL_MS };

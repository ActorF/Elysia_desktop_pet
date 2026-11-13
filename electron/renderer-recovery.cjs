'use strict';

/** Explicit recovery only: a repeatedly crashing page must not become a reload loop. */
function createRendererRecovery(window, url) {
  let failed = false, disposed = false, loading = null;
  const gone = () => { failed = true; };
  const loaded = () => { failed = false; };
  window.webContents.on('render-process-gone', gone);
  window.webContents.on('did-finish-load', loaded);
  const usable = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed();
  function recover() {
    if (!usable()) return Promise.resolve(false);
    if (loading) return loading;
    if (!failed) return Promise.resolve(true);
    loading = Promise.resolve().then(() => usable() ? window.loadURL(url) : null).then(() => usable() && !failed)
      .finally(() => { loading = null; });
    return loading;
  }
  function dispose() {
    if (disposed) return; disposed = true;
    window.webContents.removeListener('render-process-gone', gone);
    window.webContents.removeListener('did-finish-load', loaded);
  }
  return { recover, isFailed: () => failed, dispose };
}
module.exports = { createRendererRecovery };

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('elysiaSpeech', Object.freeze({
  onPlay: callback => subscribe('speech:play', callback),
  onStop: callback => subscribe('speech:stop', callback),
  onVolume: callback => subscribe('speech:volume', callback),
  onPlacement: callback => subscribe('speech:placement', callback),
  onError: callback => subscribe('speech:error', callback),
  onMeasure: callback => subscribe('speech:measure', callback),
  onLayoutReady: callback => subscribe('speech:layout-ready', callback),
  layout: value => {
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && Number.isSafeInteger(value.revision))
      ipcRenderer.send('speech:layout', { token: value.token, revision: value.revision, width: value.width, height: value.height });
  },
  report: value => {
    if (value && ['prepared', 'started', 'ended', 'error', 'skip'].includes(value.type)) ipcRenderer.send('speech:event', { type: value.type, token: value.token, ...(Number.isSafeInteger(value.revision) ? { revision: value.revision } : {}), ...(typeof value.error === 'string' ? { error: value.error.slice(0, 240) } : {}) });
  },
}));

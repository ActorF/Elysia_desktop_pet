'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// Deliberately one-way: this decoration cannot invoke host actions or input APIs.
contextBridge.exposeInMainWorld('elysiaCursorTrail', Object.freeze({
  onSample: callback => subscribe('cursor-trail:sample', callback),
  onClear: callback => subscribe('cursor-trail:clear', callback),
  onStyle: callback => subscribe('cursor-trail:style', callback),
  onDuration: callback => subscribe('cursor-trail:duration', callback),
}));

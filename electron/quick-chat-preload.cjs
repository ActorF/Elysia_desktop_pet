/** Fixed quick-composer IPC only; no history, filesystem, network or generic IPC. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('elysiaQuickChat', Object.freeze({
  getState: () => ipcRenderer.invoke('quick-chat:get-state'),
  send: text => ipcRenderer.invoke('quick-chat:send', text),
  cancel: () => ipcRenderer.invoke('quick-chat:cancel'),
  hide: () => ipcRenderer.invoke('quick-chat:hide'),
  onState: callback => subscribe('quick-chat:state', callback),
  onFocus: callback => subscribe('quick-chat:focus', callback),
  onSpeechAudio: callback => subscribe('quick-chat:speech-audio', callback),
  onSpeechStop: callback => subscribe('quick-chat:speech-stop', callback),
  reportSpeech: event => {
    if (event && typeof event.token === 'string' && event.token.length > 0 && event.token.length <= 100
      && ['started', 'ended', 'error'].includes(event.type)) {
      ipcRenderer.send('quick-chat:speech-report', { token: event.token, type: event.type });
    }
  },
}));

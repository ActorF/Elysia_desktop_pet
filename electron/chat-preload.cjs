/** Typed chat operations only; the renderer has no network, filesystem or generic IPC access. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('elysiaChat', Object.freeze({
  getState: () => ipcRenderer.invoke('chat:get-state'),
  send: text => ipcRenderer.invoke('chat:send', text),
  cancel: () => ipcRenderer.invoke('chat:cancel'),
  newConversation: () => ipcRenderer.invoke('chat:new-conversation'),
  openSettings: () => ipcRenderer.invoke('chat:open-settings'),
  copyMessage: reference => ipcRenderer.invoke('chat:copy-message', reference),
  readAloud: reference => ipcRenderer.invoke('chat:read-aloud', reference),
  getWindowState: () => ipcRenderer.invoke('chat:get-window-state'),
  windowControl: action => {
    if (['minimize', 'toggle-maximize', 'close'].includes(action)) ipcRenderer.send('chat:window-control', action);
  },
  onState: callback => subscribe('chat:state', callback),
  onWindowState: callback => subscribe('chat:window-state', callback),
  onSpeechAudio: callback => subscribe('chat:speech-audio', callback),
  onSpeechStop: callback => subscribe('chat:speech-stop', callback),
  reportSpeech: event => {
    if (event && typeof event.token === 'string' && event.token.length <= 100 && ['started', 'ended', 'error'].includes(event.type)) {
      ipcRenderer.send('chat:speech-report', { token: event.token, type: event.type });
    }
  },
}));

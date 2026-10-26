// This window receives only settings methods; no pet drag or arbitrary IPC access.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('elysiaSettings', Object.freeze({
  requestTypingPermission: () => ipcRenderer.invoke('settings:typing-permission'),
  getState: () => ipcRenderer.invoke('settings:get-state'),
  getWindowState: () => ipcRenderer.invoke('settings:get-window-state'),
  getVoiceState: () => ipcRenderer.invoke('settings:voice-get'),
  setVoiceSettings: patch => ipcRenderer.invoke('settings:voice-settings', patch),
  stopVoice: () => ipcRenderer.invoke('settings:voice-stop'),
  setSettings: patch => ipcRenderer.invoke('settings:set-settings', patch),
  action: value => ipcRenderer.invoke('settings:action', value),
  resize: scale => ipcRenderer.invoke('settings:resize', scale),
  recover: (resetScale = false) => ipcRenderer.invoke('settings:recover', resetScale),
  windowControl: action => {
    if (action === 'minimize' || action === 'toggle-maximize' || action === 'close') ipcRenderer.send('settings:window-control', action);
  },
  onState: callback => subscribe('settings:state', callback),
  onWindowState: callback => subscribe('settings:window-state', callback),
  onVoiceState: callback => subscribe('settings:voice-state', callback),
}));

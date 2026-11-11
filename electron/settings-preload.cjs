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
  getState: () => ipcRenderer.invoke('settings:get-state'),
  getWindowState: () => ipcRenderer.invoke('settings:get-window-state'),
  getVoiceState: () => ipcRenderer.invoke('settings:voice-get'),
  setVoiceSettings: patch => ipcRenderer.invoke('settings:voice-settings', patch),
  stopVoice: () => ipcRenderer.invoke('settings:voice-stop'),
  getChatState: () => ipcRenderer.invoke('settings:chat-get'),
  setChatSettings: patch => ipcRenderer.invoke('settings:chat-settings', patch),
  selectChatConversation: id => ipcRenderer.invoke('settings:chat-select', id),
  deleteChatConversation: id => ipcRenderer.invoke('settings:chat-delete', id),
  clearChatHistory: () => ipcRenderer.invoke('settings:chat-clear'),
  getModelSetup: () => ipcRenderer.invoke('settings:model-setup-get'),
  inspectModelSetup: () => ipcRenderer.invoke('settings:model-setup-inspect'),
  installChatModel: () => ipcRenderer.invoke('settings:model-setup-install'),
  cancelModelSetup: () => ipcRenderer.invoke('settings:model-setup-cancel'),
  getVoiceSetup: () => ipcRenderer.invoke('settings:voice-setup-get'),
  inspectVoiceSetup: () => ipcRenderer.invoke('settings:voice-setup-inspect'),
  copySetupDiagnostic: component => ipcRenderer.invoke('settings:setup-diagnostic-copy', component),
  installVoiceSetup: () => ipcRenderer.invoke('settings:voice-setup-install'),
  repairVoiceSetup: () => ipcRenderer.invoke('settings:voice-setup-repair'),
  cancelVoiceSetup: () => ipcRenderer.invoke('settings:voice-setup-cancel'),
  openChat: () => ipcRenderer.invoke('settings:chat-open'),
  getQuickChatSettings: () => ipcRenderer.invoke('settings:quick-chat-get'),
  setQuickChatSettings: patch => ipcRenderer.invoke('settings:quick-chat-set', patch),
  setQuickChatCapture: active => ipcRenderer.invoke('settings:quick-chat-capture', active),
  openQuickChat: () => ipcRenderer.invoke('settings:quick-chat-open'),
  onQuickChatSettings: callback => subscribe('settings:quick-chat-state', callback),
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
  onChatState: callback => subscribe('settings:chat-state', callback),
  onModelSetup: callback => subscribe('settings:model-setup-state', callback),
  onVoiceSetup: callback => subscribe('settings:voice-setup-state', callback),
}));

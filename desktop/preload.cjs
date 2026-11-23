// Narrow bridge for the dashboard, mini window and settings pages.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atm', {
  setAlwaysOnTop: (on) => ipcRenderer.invoke('atm:always-on-top', !!on),
  isAlwaysOnTop: () => ipcRenderer.invoke('atm:is-always-on-top'),
  openMini: () => ipcRenderer.invoke('atm:open-mini'),
  openSettings: () => ipcRenderer.invoke('atm:open-settings'),
  getSettings: () => ipcRenderer.invoke('atm:get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('atm:save-settings', s),
  providerStatus: () => ipcRenderer.invoke('atm:provider-status'),
});

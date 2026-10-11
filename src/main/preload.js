'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  getData: () => ipcRenderer.invoke('data:get'),
  sync: (force) => ipcRenderer.invoke('data:sync', { force }),
  onSyncProgress: (fn) => ipcRenderer.on('sync:progress', (_e, p) => fn(p)),
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (state) => ipcRenderer.invoke('state:set', state),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  rendered: () => ipcRenderer.send('ui:rendered'),
});

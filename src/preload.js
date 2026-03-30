const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadMapLibrary: () => ipcRenderer.invoke('load-map-library'),
  saveMapLibrary: (data) => ipcRenderer.invoke('save-map-library', data)
});

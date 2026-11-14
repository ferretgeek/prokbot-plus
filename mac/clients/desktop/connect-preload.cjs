const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', {
  locale: ipcRenderer.sendSync('grokbot-local:locale'),
  status: () => ipcRenderer.invoke('grokbot-local:status'),
  pair: (server, key, tailcat, edit = false) => ipcRenderer.invoke('grokbot-local:pair', { server, key, tailcat, edit }),
  disconnect: () => ipcRenderer.invoke('grokbot-local:disconnect'),
});

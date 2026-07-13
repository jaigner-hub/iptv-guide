'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The renderer is a normal web page served from our own localhost origin, so it
// talks to the backend over fetch(). This bridge only exposes the few things a
// web page genuinely cannot do.
contextBridge.exposeInMainWorld('native', {
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: url => ipcRenderer.invoke('app:openExternal', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  onStatus: cb => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('status', handler)
    return () => ipcRenderer.removeListener('status', handler)
  }
})

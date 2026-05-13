import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('fileAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),

  startScanStream: (folderPath) => {
    ipcRenderer.send('scan-folder-stream', folderPath)
  },

  onScanProgress: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('scan-folder-progress', handler)
    return () => ipcRenderer.removeListener('scan-folder-progress', handler)
  },

  onScanDone: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('scan-folder-done', handler)
    return () => ipcRenderer.removeListener('scan-folder-done', handler)
  },

  getThumbnailUrl: (imagePath) => ipcRenderer.invoke('get-thumbnail-url', imagePath),
  getFullImageUrl: (imagePath) => ipcRenderer.invoke('get-full-image-url', imagePath),
})

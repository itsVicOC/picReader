import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('fileAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),

  startScanStream: (scanId, folderPath) => {
    ipcRenderer.send('scan-folder-stream', { scanId, folderPath })
  },

  cancelScan: (scanId) => {
    ipcRenderer.send('cancel-scan', scanId)
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

  onScanError: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('scan-folder-error', handler)
    return () => ipcRenderer.removeListener('scan-folder-error', handler)
  },

  getThumbnailUrl: (imagePath) => ipcRenderer.invoke('get-thumbnail-url', imagePath),
  getFullImageUrl: (imagePath) => ipcRenderer.invoke('get-full-image-url', imagePath),
})

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PetApi, PetEvent } from '../shared/pet-event.ts'

// contextBridge 白名单:renderer 只能看到这里暴露的最小能力,
// 永远不把 ipcRenderer 或完整连接对象直接暴露出去。
const petApi: PetApi = {
  onPetEvent(handler) {
    const listener = (_event: IpcRendererEvent, payload: PetEvent): void => {
      handler(payload)
    }
    ipcRenderer.on('pet:event', listener)
    return () => {
      ipcRenderer.removeListener('pet:event', listener)
    }
  },
  getState: () => ipcRenderer.invoke('pet:get-state'),
  sendMessage: (text) => ipcRenderer.invoke('pet:send-message', text),
  dragStart: (x, y) => ipcRenderer.send('pet:drag-start', x, y),
  dragMove: (x, y) => ipcRenderer.send('pet:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
}

contextBridge.exposeInMainWorld('petApi', petApi)

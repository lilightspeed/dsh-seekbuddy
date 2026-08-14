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
  listSessions: () => ipcRenderer.invoke('pet:list-sessions'),
  debugReconnect: () => ipcRenderer.invoke('pet:debug-reconnect'),
}

contextBridge.exposeInMainWorld('petApi', petApi)

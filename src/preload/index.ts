import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PetApi, PetEvent } from '../shared/pet-event.ts'

/**
 * IPC 参数必须可序列化:undefined/NaN 会触发主进程
 * "Error processing argument at index N, conversion failure" 崩溃。
 * 统一在 preload 边界收敛成有限数值 —— 这是参数合法性的唯一防线。
 */
function toFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

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
  sendMessage: (text) => ipcRenderer.invoke('pet:send-message', String(text ?? '')),
  dragStart: (x, y) => ipcRenderer.send('pet:drag-start', toFinite(x), toFinite(y)),
  dragMove: (x, y) => ipcRenderer.send('pet:drag-move', toFinite(x), toFinite(y)),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
}

contextBridge.exposeInMainWorld('petApi', petApi)

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PetApi, PetApprovalRequest, PetCursorPosition, PetEvent } from '../shared/pet-event.ts'
import type { PetConfigUpdate } from '../shared/pet-config.ts'

/**
 * IPC 参数收敛(0004 纪律):undefined/NaN 过 IPC 会触发主进程
 * "Error processing argument at index N, conversion failure" 崩溃。
 * 所有参数在 preload 边界统一 String/toFinite,null 保留为 null。
 */
function toFinite(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function sanitizeApproval(request: PetApprovalRequest | undefined): PetApprovalRequest {
  return {
    rpcId: String(request?.rpcId ?? ''),
    sessionId: String(request?.sessionId ?? ''),
    approvalId: String(request?.approvalId ?? ''),
    outcome: request?.outcome === 'rejected' ? 'rejected' : 'allowed-once',
  }
}

/** 阶段 5:配置补丁收敛 —— 只放行白名单字段,标量全部 String/toFinite/Boolean。 */
function sanitizeConfigUpdate(patch: PetConfigUpdate | undefined): PetConfigUpdate {
  const out: PetConfigUpdate = {}
  if (patch?.dshBaseUrl !== undefined) out.dshBaseUrl = String(patch.dshBaseUrl ?? '')
  if (patch?.opacity !== undefined) out.opacity = toFinite(patch.opacity)
  // 0056:窗口尺寸(仅主进程 resize-end 写入;renderer 无设置入口,白名单保留)
  if (patch?.windowWidth !== undefined) out.windowWidth = toFinite(patch.windowWidth)
  if (patch?.windowHeight !== undefined) out.windowHeight = toFinite(patch.windowHeight)
  if (patch?.launchAtLogin !== undefined) out.launchAtLogin = Boolean(patch.launchAtLogin)
  // 宠物(Live2D)外观/手感(0017):toFinite 收敛
  if (patch?.petPositionX !== undefined) out.petPositionX = toFinite(patch.petPositionX)
  if (patch?.petPositionY !== undefined) out.petPositionY = toFinite(patch.petPositionY)
  if (patch?.petScale !== undefined) out.petScale = toFinite(patch.petScale)
  if (patch?.petHeadAmplitude !== undefined) out.petHeadAmplitude = toFinite(patch.petHeadAmplitude)
  if (patch?.petEyeAmplitude !== undefined) out.petEyeAmplitude = toFinite(patch.petEyeAmplitude)
  if (patch?.petDeadZone !== undefined) out.petDeadZone = toFinite(patch.petDeadZone)
  if (patch?.petDistance !== undefined) out.petDistance = toFinite(patch.petDistance)
  if (patch?.petResponse !== undefined) out.petResponse = toFinite(patch.petResponse)
  if (patch?.petPupilSensitivity !== undefined) out.petPupilSensitivity = toFinite(patch.petPupilSensitivity)
  if (patch?.petPupilMax !== undefined) out.petPupilMax = toFinite(patch.petPupilMax)
  if (patch?.petDragStrength !== undefined) out.petDragStrength = toFinite(patch.petDragStrength)
  if (patch?.petShowHitMesh !== undefined) out.petShowHitMesh = Boolean(patch.petShowHitMesh)
  if (patch?.petPatStrength !== undefined) out.petPatStrength = toFinite(patch.petPatStrength)
  // 思考表情阈值(0039,秒):toFinite 收敛
  if (patch?.petThinkExclaimAfterSec !== undefined) out.petThinkExclaimAfterSec = toFinite(patch.petThinkExclaimAfterSec)
  if (patch?.petThinkDizzyAfterSec !== undefined) out.petThinkDizzyAfterSec = toFinite(patch.petThinkDizzyAfterSec)
  // 入睡阈值(0058,秒):toFinite 收敛
  if (patch?.petSleepAfterSec !== undefined) out.petSleepAfterSec = toFinite(patch.petSleepAfterSec)
  // 唤醒加速度阈值(0059,px/s²):toFinite 收敛
  if (patch?.petWakeAccel !== undefined) out.petWakeAccel = toFinite(patch.petWakeAccel)
  return out
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
  onCursor(handler) {
    const listener = (_event: IpcRendererEvent, payload: PetCursorPosition): void => {
      handler({
        x: toFinite(payload?.x),
        y: toFinite(payload?.y),
        inside: Boolean(payload?.inside),
        dragDx: toFinite(payload?.dragDx),
        dragDy: toFinite(payload?.dragDy),
      })
    }
    ipcRenderer.on('pet:cursor', listener)
    return () => {
      ipcRenderer.removeListener('pet:cursor', listener)
    }
  },
  getState: () => ipcRenderer.invoke('pet:get-state'),
  sendMessage: (text) => ipcRenderer.invoke('pet:send-message', String(text ?? '')),
  reconnect: () => ipcRenderer.invoke('pet:reconnect'),
  stopTurn: () => ipcRenderer.invoke('pet:stop-turn'),
  listSessions: () => ipcRenderer.invoke('pet:list-sessions'),
  getHistory: (sessionId, beforeSeq, maxMessages) =>
    ipcRenderer.invoke(
      'pet:get-history',
      String(sessionId ?? ''),
      beforeSeq == null ? null : toFinite(beforeSeq),
      maxMessages == null ? null : toFinite(maxMessages),
    ),
  getHistorySummary: (sessionId, maxMessages) =>
    ipcRenderer.invoke('pet:get-history-summary', String(sessionId ?? ''), maxMessages == null ? null : toFinite(maxMessages)),
  selectSession: (sessionId) => ipcRenderer.invoke('pet:select-session', sessionId == null ? null : String(sessionId)),
  createSession: () => ipcRenderer.invoke('pet:create-session'),
  respondApproval: (request) => ipcRenderer.invoke('pet:respond-approval', sanitizeApproval(request)),
  getConfig: () => ipcRenderer.invoke('pet:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('pet:set-config', sanitizeConfigUpdate(patch)),
  listPlugins: () => ipcRenderer.invoke('pet:list-plugins'),
  // 0056 窗口边缘拖拽调整大小:edge 收敛为字符串(主进程白名单校验 8 个方向)
  resizeStart: (edge) => ipcRenderer.invoke('pet:resize-start', String(edge ?? '')),
  resizeEnd: () => ipcRenderer.invoke('pet:resize-end'),
  // 0057:主进程推送手动缩放手势状态(win32 原生路径的开始/结束信号)
  onResizeGesture(handler) {
    const listener = (_event: IpcRendererEvent, active: boolean): void => {
      handler(Boolean(active))
    }
    ipcRenderer.on('pet:resize-gesture', listener)
    return () => {
      ipcRenderer.removeListener('pet:resize-gesture', listener)
    }
  },
}

contextBridge.exposeInMainWorld('petApi', petApi)
